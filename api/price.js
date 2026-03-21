/**
 * api/price.js — 股價歷史資料代理（選股器用）
 *
 * 資料來源優先順序：
 *   1. TWSE 官方（source=twse 或預設）
 *      上市：TWSE STOCK_DAY → 精確收盤價 + 精確張數（與 Goodinfo 同源）
 *      上櫃：TPEX 每日收盤 → 同樣精確
 *   2. Yahoo Finance（備援，TWSE 失敗時自動切換）
 *
 * 回傳格式：相容 Yahoo Finance chart API
 *   { chart: { result: [{ timestamps, indicators: { quote: [{ open, high, low, close, volume }] } }] } }
 *
 * 呼叫方式：
 *   /api/stock?symbol=2330&days=90            → TWSE 優先，自動備援
 *   /api/stock?symbol=2330&days=90&source=twse → 強制 TWSE
 *   /api/stock?symbol=2330&days=90&source=yahoo → 強制 Yahoo
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const symbol = (req.query.symbol || '').trim().replace(/\.TW$/i, '');
  const days   = Math.min(parseInt(req.query.days) || 90, 365);
  const source = req.query.source || 'twse'; // 預設 TWSE

  if (!symbol) {
    return res.status(400).json({ error: 'symbol required' });
  }

  const ua = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  // ── 工具函數 ──
  function pn(s) {
    if (!s || s === '--' || s === '' || s === 'N/A') return 0;
    return parseFloat(String(s).replace(/,/g, '')) || 0;
  }

  function dateToTs(str) {
    // 'YYYY/MM/DD' 或 'YYYYMMDD' 或 'YYYY-MM-DD' → Unix timestamp (秒)
    const clean = String(str).replace(/[\/\-]/g, '');
    const y = clean.slice(0, 4), m = clean.slice(4, 6), d = clean.slice(6, 8);
    return Math.floor(new Date(`${y}-${m}-${d}T08:00:00+08:00`).getTime() / 1000);
  }

  // ── 判斷是否為上市 or 上櫃 ──
  function isOTC(id) {
    // 上櫃：代號 5碼、或 6xxx、或部分 3xxx-4xxx 範圍
    if (id.length === 5) return true;
    const n = parseInt(id);
    if (n >= 6000 && n <= 6999) return true;
    return false;
  }

  // ════════════════════════════════════════
  // 來源1：TWSE 上市股票歷史 STOCK_DAY
  // 每次只能抓單月，需要多次請求
  // ════════════════════════════════════════
  async function fetchTWSE(id, numDays) {
    const today = new Date();
    const records = [];

    // 計算需要抓幾個月
    const months = Math.ceil(numDays / 22) + 1;

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setMonth(d.getMonth() - i);
      const yyyymm = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;

      try {
        const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${id}&date=${yyyymm}&response=json`;
        const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const j = await r.json();
        if (j.stat !== 'OK' || !j.data?.length) continue;

        // 欄位：[日期, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌(+/-), 漲跌價差, 本益比]
        for (const row of j.data) {
          const dateStr = row[0]?.trim(); // 'YYYY/MM/DD' 格式
          if (!dateStr) continue;

          // TWSE 日期是民國年 → 轉西元
          const parts = dateStr.split('/');
          if (parts.length === 3) {
            const rocYear = parseInt(parts[0]);
            const westernYear = rocYear + 1911;
            const isoDate = `${westernYear}/${parts[1]}/${parts[2]}`;
            const ts = dateToTs(isoDate);

            const volume = Math.round(pn(row[1]) / 1000); // 股→張
            const open   = pn(row[3]);
            const high   = pn(row[4]);
            const low    = pn(row[5]);
            const close  = pn(row[6]);

            if (close > 0) {
              records.push({ ts, open, high, low, close, volume });
            }
          }
        }
      } catch (e) {
        // 單月失敗繼續下一月
        continue;
      }
    }

    return records;
  }

  // ════════════════════════════════════════
  // 來源2：TPEX 上櫃股票歷史
  // ════════════════════════════════════════
  async function fetchTPEX(id, numDays) {
    const today = new Date();
    const records = [];
    const months = Math.ceil(numDays / 22) + 1;

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setMonth(d.getMonth() - i);
      // TPEX 用民國年
      const rocYear = d.getFullYear() - 1911;
      const mm = String(d.getMonth() + 1).padStart(2, '0');

      try {
        const url = `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${rocYear}/${mm}&s=${id},asc,0&output=json`;
        const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const j = await r.json();
        if (!j.aaData?.length) continue;

        for (const row of j.aaData) {
          // 欄位：[日期, 成交仟股, 成交金額仟元, 開盤, 最高, 最低, 收盤, 漲跌, 成交筆數]
          const dateStr = row[0]?.trim();
          if (!dateStr) continue;

          const parts = dateStr.split('/');
          if (parts.length === 3) {
            const westernYear = parseInt(parts[0]) + 1911;
            const isoDate = `${westernYear}/${parts[1]}/${parts[2]}`;
            const ts = dateToTs(isoDate);

            const volume = Math.round(pn(row[1]) * 1000 / 1000); // 仟股→張（近似）
            const open   = pn(row[3]);
            const high   = pn(row[4]);
            const low    = pn(row[5]);
            const close  = pn(row[6]);

            if (close > 0) {
              records.push({ ts, open, high, low, close, volume });
            }
          }
        }
      } catch (e) {
        continue;
      }
    }

    return records;
  }

  // ════════════════════════════════════════
  // 來源3：Yahoo Finance（備援）
  // ════════════════════════════════════════
  async function fetchYahoo(id, numDays) {
    const suffix = id.length <= 4 ? '.TW' : '.TWO';
    const symbol = `${id}${suffix}`;
    const end   = Math.floor(Date.now() / 1000);
    const start = end - numDays * 86400 * 1.4; // 多取 40% 覆蓋假日

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${start}&period2=${end}&interval=1d&includePrePost=false`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, {
          headers: { ...ua, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(12000)
        });
        if (!r.ok) continue;
        const j = await r.json();
        const result = j?.chart?.result?.[0];
        if (result) return result; // 直接回傳 Yahoo 原始格式
      } catch {}
    }
    return null;
  }

  // ════════════════════════════════════════
  // ★ 除權息資料（TWT49U）→ 還原收盤
  // ════════════════════════════════════════
  async function fetchExRights(id) {
    try {
      const end = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const d3y = new Date(); d3y.setFullYear(d3y.getFullYear()-3);
      const start = d3y.toISOString().slice(0,10).replace(/-/g,'');
      const r = await fetch(
        `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json&strDate=${start}&endDate=${end}&stockNo=${id}`,
        { headers: ua, signal: AbortSignal.timeout(10000) }
      );
      if (!r.ok) return [];
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return [];
      return j.data.map(row => {
        const p = String(row[0]||'').split('/');
        if (p.length !== 3) return null;
        const ts = Math.floor(new Date(`${parseInt(p[0])+1911}-${p[1].padStart(2,'0')}-${p[2].padStart(2,'0')}T08:00:00+08:00`).getTime()/1000);
        return { ts, prevClose: pn(row[3]), refPrice: pn(row[4])||pn(row[5]) };
      }).filter(r => r && r.ts > 0 && r.prevClose > 0 && r.refPrice > 0);
    } catch { return []; }
  }

  function calcAdjClose(records, exRights) {
    if (!exRights.length) return records.map(r => r.close);
    const sorted = [...records].sort((a,b) => a.ts - b.ts);
    const exSorted = [...exRights].sort((a,b) => a.ts - b.ts);
    const factors = exSorted.map(ex => ({ ts: ex.ts, factor: ex.prevClose > 0 ? ex.refPrice / ex.prevClose : 1 }));
    return sorted.map(rec => {
      let adj = rec.close;
      for (const f of factors) if (f.ts > rec.ts) adj *= f.factor;
      return Math.round(adj * 100) / 100;
    });
  }

  // ════════════════════════════════════════
  // 把 TWSE/TPEX records 轉換成 Yahoo 格式
  // ════════════════════════════════════════
  function toYahooFormat(records, id, adjCloses) {
    // 排序並只取最近 N 天
    const allSorted = [...records].sort((a,b) => a.ts - b.ts);
    const sorted = allSorted.slice(-days);
    if (!sorted.length) return null;

    return {
      meta: {
        symbol: `${id}.TW`,
        currency: 'TWD',
        exchangeName: 'TPE',
        dataSource: 'TWSE',
      },
      timestamps: sorted.map(r => r.ts),
      indicators: {
        quote: [{
          open:   sorted.map(r => r.open),
          high:   sorted.map(r => r.high),
          low:    sorted.map(r => r.low),
          close:  sorted.map(r => r.close),
          volume: sorted.map(r => r.volume), // 單位：張（與 Goodinfo 一致）
        }],
        adjclose: [{
          adjclose: adjCloses
          ? sorted.map(r => { const i = allSorted.findIndex(s=>s.ts===r.ts); return adjCloses[i]??r.close; })
          : sorted.map(r => r.close),
        }],
      },
    };
  }

  // ════════════════════════════════════════
  // 主邏輯
  // ════════════════════════════════════════
  try {
    let result = null;
    let dataSource = 'unknown';

    if (source !== 'yahoo') {
      // ── 嘗試 TWSE/TPEX ──
      try {
        let records, adjCloses = null;
        if (isOTC(symbol)) {
          records = await fetchTPEX(symbol, days);
          adjCloses = null; // TPEX 用 Yahoo adjclose
          dataSource = 'TPEX';
        } else {
          const [recs, exRights] = await Promise.all([fetchTWSE(symbol, days), fetchExRights(symbol)]);
          records = recs;
          adjCloses = calcAdjClose(records, exRights);
          dataSource = exRights.length > 0 ? 'TWSE+TWT49U' : 'TWSE';
        }

        if (records.length >= 5) {
          result = toYahooFormat(records, symbol, adjCloses);
        }
      } catch (e) {
        console.error(`[stock] TWSE/TPEX 失敗 (${symbol}):`, e.message);
      }
    }

    if (!result && source !== 'twse') {
      // ── 備援 Yahoo ──
      const yahooResult = await fetchYahoo(symbol, days);
      if (yahooResult) {
        result = yahooResult;
        dataSource = 'Yahoo';
      }
    }

    if (!result) {
      return res.status(404).json({
        error: `無法取得 ${symbol} 的股價資料`,
        symbol,
        triedSources: source === 'yahoo' ? ['Yahoo'] : ['TWSE/TPEX', 'Yahoo'],
      });
    }

    // 快取：TWSE 資料每天更新，Yahoo 同樣
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');

    return res.status(200).json({
      chart: {
        result: [result],
        error: null,
      },
      _source: dataSource,
      _symbol: symbol,
    });

  } catch (err) {
    console.error('[stock] 主流程錯誤:', err);
    return res.status(500).json({ error: err.message, symbol });
  }
}
