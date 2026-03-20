/**
 * api/live-quote.js — 全市場即時/最新收盤報價
 *
 * 資料來源（與 Goodinfo 完全同源）：
 *   上市：TWSE openapi STOCK_DAY_ALL → 今日收盤價、漲跌、成交量
 *   上櫃：TPEX openapi tpex_mainboard_quotes → 今日收盤價
 *
 * 收盤後（15:30後）：當日收盤
 * 盤中：前一日收盤（TWSE 盤中行情需另外的 mis API）
 *
 * 呼叫：GET /api/live-quote
 * 回傳：{
 *   stocks: {
 *     '2330': { close:1000, change:15, changePct:1.52, volume:25000, name:'台積電', market:'TWSE' }
 *   },
 *   total: 1700,
 *   time: '2025-03-20T15:30:00'
 * }
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ua = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  function pn(s) {
    if (!s || s === '--' || s === '' || s === 'N/A') return 0;
    const v = parseFloat(String(s).replace(/,/g, ''));
    return isNaN(v) ? 0 : v;
  }

  // ── 上市：TWSE OpenAPI STOCK_DAY_ALL ──
  async function fetchTWSEQuotes() {
    try {
      // 方法1：OpenAPI（最穩定）
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
        { headers: ua, signal: AbortSignal.timeout(20000) }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!Array.isArray(data) || !data.length) throw new Error('空資料');

      const result = {};
      for (const item of data) {
        const code = (item.Code || item['股票代號'])?.trim();
        const name = (item.Name || item['股票名稱'])?.trim();
        if (!code || !/^\d{4}$/.test(code)) continue;

        const close  = pn(item.ClosingPrice  || item['收盤價']);
        const change = pn(item.Change        || item['漲跌價差']);
        const vol    = Math.round(pn(item.TradeVolume || item['成交股數']) / 1000); // 股→張
        if (close <= 0) continue;

        const prev    = close - change;
        const changePct = prev > 0 ? (change / prev) * 100 : 0;

        result[code] = {
          close,
          change: Math.round(change * 100) / 100,
          changePct: Math.round(changePct * 100) / 100,
          volume: vol,
          name: name || code,
          market: 'TWSE',
        };
      }
      return result;
    } catch (e) {
      console.error('[live-quote] TWSE OpenAPI 失敗:', e.message);
      return await fetchTWSEFallback();
    }
  }

  // 備援：TWSE STOCK_DAY_ALL（rwd）
  async function fetchTWSEFallback() {
    try {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const yyyymm = today.slice(0, 6) + '01';
      const r = await fetch(
        `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json&date=${yyyymm}`,
        { headers: ua, signal: AbortSignal.timeout(15000) }
      );
      if (!r.ok) return {};
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return {};

      const result = {};
      for (const row of j.data) {
        const code = row[0]?.trim();
        if (!code || !/^\d{4}$/.test(code)) continue;
        const close  = pn(row[6]); // 收盤價
        const change = pn(row[7]); // 漲跌（+/-前綴）
        const vol    = Math.round(pn(row[2]) / 1000);
        if (close <= 0) continue;
        const prev = close - change;
        result[code] = {
          close,
          change: Math.round(change * 100) / 100,
          changePct: prev > 0 ? Math.round((change / prev) * 10000) / 100 : 0,
          volume: vol,
          name: row[1]?.trim() || code,
          market: 'TWSE',
        };
      }
      return result;
    } catch { return {}; }
  }

  // ── 上櫃：TPEX OpenAPI mainboard_quotes ──
  async function fetchTPEXQuotes() {
    try {
      const r = await fetch(
        'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
        { headers: ua, signal: AbortSignal.timeout(20000) }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!Array.isArray(data) || !data.length) return {};

      const result = {};
      for (const item of data) {
        const code = (item.SecuritiesCompanyCode || item['股票代號'])?.trim();
        const name = (item.CompanyName || item['股票名稱'])?.trim();
        if (!code || !/^\d{4,5}$/.test(code)) continue;

        const close  = pn(item.Close || item['收盤價'] || item.ClosingPrice);
        const change = pn(item.Change || item['漲跌']);
        const vol    = Math.round(pn(item.TradingShares || item['成交股數'] || 0) / 1000);
        if (close <= 0) continue;

        const prev = close - change;
        result[code] = {
          close,
          change: Math.round(change * 100) / 100,
          changePct: prev > 0 ? Math.round((change / prev) * 10000) / 100 : 0,
          volume: vol,
          name: name || code,
          market: 'TPEX',
        };
      }
      return result;
    } catch (e) {
      console.error('[live-quote] TPEX 失敗:', e.message);
      return {};
    }
  }

  try {
    // 上市 + 上櫃 並發
    const [twseStocks, tpexStocks] = await Promise.all([
      fetchTWSEQuotes(),
      fetchTPEXQuotes(),
    ]);

    const stocks = { ...twseStocks, ...tpexStocks };
    const total = Object.keys(stocks).length;

    if (total < 100) {
      return res.status(503).json({ error: '資料不足，TWSE/TPEX API 可能暫時無法使用', total });
    }

    // 盤後快取 15 分鐘，盤中快取 1 分鐘
    const now  = new Date();
    const hour = now.getUTCHours() + 8; // 台灣時間
    const isAfterClose = hour >= 16 || hour < 8;
    const cacheTTL = isAfterClose ? 900 : 60;

    res.setHeader('Cache-Control', `s-maxage=${cacheTTL}, stale-while-revalidate`);
    return res.status(200).json({
      stocks,
      total,
      time: new Date().toISOString(),
      twse:  Object.values(stocks).filter(s => s.market === 'TWSE').length,
      tpex:  Object.values(stocks).filter(s => s.market === 'TPEX').length,
    });

  } catch (err) {
    console.error('[live-quote] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
