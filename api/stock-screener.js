/**
 * api/stock-screener.js — 選股器股價歷史（以 AI 戰情室 stock.js 為基礎）
 *
 * 在 stock.js 基礎上增加：
 *   1. TWT49U 除權息資料 → 計算還原收盤（adjclose）→ 均線與 Goodinfo 完全一致
 *   2. 回傳格式完全相同（chart.result[0]）
 *
 * 優先順序：TWSE → TPEX → Yahoo（與 stock.js 完全相同）
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const symbol = (req.query.symbol || '').trim().replace(/\.TW$/i, '');
  const days   = Math.min(parseInt(req.query.days) || 90, 365);
  const source = req.query.source || 'twse';

  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const ua = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  function pn(s) {
    if (!s || s === '--' || s === '') return 0;
    return parseFloat(String(s).replace(/,/g, '')) || 0;
  }

  function dateToTs(str) {
    const clean = String(str).replace(/[\/\-]/g, '');
    const y = clean.slice(0,4), m = clean.slice(4,6), d = clean.slice(6,8);
    return Math.floor(new Date(`${y}-${m}-${d}T08:00:00+08:00`).getTime() / 1000);
  }

  function rocToTs(rocStr) {
    const p = String(rocStr).trim().split('/');
    if (p.length !== 3) return 0;
    const y = parseInt(p[0]) + 1911;
    return Math.floor(new Date(`${y}-${p[1].padStart(2,'0')}-${p[2].padStart(2,'0')}T08:00:00+08:00`).getTime() / 1000);
  }

  function isOTC(id) {
    if (id.length === 5) return true;
    const n = parseInt(id);
    return n >= 6000 && n <= 6999;
  }

  // ── TWSE 上市歷史（與 stock.js 完全相同）──
  async function fetchTWSE(id, numDays) {
    const today = new Date();
    const records = [];
    const months = Math.ceil(numDays / 22) + 1;

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setMonth(d.getMonth() - i);
      const yyyymm = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}01`;

      try {
        const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${id}&date=${yyyymm}&response=json`;
        const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const j = await r.json();
        if (j.stat !== 'OK' || !j.data?.length) continue;

        for (const row of j.data) {
          const dateStr = row[0]?.trim();
          if (!dateStr) continue;
          const parts = dateStr.split('/');
          if (parts.length !== 3) continue;
          const ts = dateToTs(`${parseInt(parts[0])+1911}${parts[1]}${parts[2]}`);
          const volume = Math.round(pn(row[1])); // 股數（統一單位，toYahooFormat 處理）
          const open = pn(row[3]), high = pn(row[4]), low = pn(row[5]), close = pn(row[6]);
          if (close > 0) records.push({ ts, open, high, low, close, volume });
        }
      } catch { continue; }
    }
    return records;
  }

  // ── TPEX 上櫃歷史（與 stock.js 完全相同）──
  async function fetchTPEX(id, numDays) {
    const today = new Date();
    const records = [];
    const months = Math.ceil(numDays / 22) + 1;

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setMonth(d.getMonth() - i);
      const rocYear = d.getFullYear() - 1911;
      const mm = String(d.getMonth()+1).padStart(2,'0');

      try {
        const url = `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${rocYear}/${mm}&s=${id},asc,0&output=json`;
        const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const j = await r.json();
        if (!j.aaData?.length) continue;

        for (const row of j.aaData) {
          const dateStr = row[0]?.trim();
          if (!dateStr) continue;
          const parts = dateStr.split('/');
          if (parts.length !== 3) continue;
          const ts = dateToTs(`${parseInt(parts[0])+1911}${parts[1]}${parts[2]}`);
          const volume = Math.round(pn(row[1]) * 1000); // 仟股→股數
          const open = pn(row[3]), high = pn(row[4]), low = pn(row[5]), close = pn(row[6]);
          if (close > 0) records.push({ ts, open, high, low, close, volume });
        }
      } catch { continue; }
    }
    return records;
  }

  // ── Yahoo 備援（與 stock.js 完全相同）──
  async function fetchYahoo(id, numDays) {
    const suffix = id.length <= 4 ? '.TW' : '.TWO';
    const end = Math.floor(Date.now() / 1000);
    const start = end - numDays * 86400 * 1.4;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${id}${suffix}?period1=${start}&period2=${end}&interval=1d&includePrePost=false`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { headers: { ...ua }, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const j = await r.json();
        const result = j?.chart?.result?.[0];
        if (result) return result;
      } catch {}
    }
    return null;
  }

  // ── ★ TWT49U 除權息資料（Goodinfo 還原收盤同算法）──
  async function fetchExRights(id) {
    try {
      const end = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const start = (() => { const d = new Date(); d.setFullYear(d.getFullYear()-3); return d.toISOString().slice(0,10).replace(/-/g,''); })();
      const url = `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json&strDate=${start}&endDate=${end}&stockNo=${id}`;
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return [];
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return [];

      return j.data.map(row => ({
        ts:        rocToTs(row[0]),
        prevClose: pn(row[3]),
        refPrice:  pn(row[4]) || pn(row[5]),
      })).filter(r => r.ts > 0 && r.prevClose > 0 && r.refPrice > 0);
    } catch { return []; }
  }

  // ── ★ 計算還原收盤（與 Goodinfo 完全相同算法）──
  function calcAdjClose(records, exRights) {
    if (!exRights.length) return records.map(r => r.close);

    const sorted = [...records].sort((a,b) => a.ts - b.ts);
    const exSorted = [...exRights].sort((a,b) => a.ts - b.ts);

    // 每次除權息的調整因子 = 除息參考價 / 除息前收盤
    const factors = exSorted.map(ex => ({
      ts: ex.ts,
      factor: ex.prevClose > 0 ? ex.refPrice / ex.prevClose : 1,
    }));

    // 對每筆歷史資料，乘以其之後所有除權息的調整因子（往回調整）
    return sorted.map(rec => {
      let adj = rec.close;
      for (const f of factors) {
        if (f.ts > rec.ts) adj *= f.factor;
      }
      return Math.round(adj * 100) / 100;
    });
  }

  // ── 轉 Yahoo 格式（與 stock.js 格式完全相同）──
  function toYahooFormat(records, adjCloses, id) {
    const sorted = [...records].sort((a,b) => a.ts - b.ts).slice(-days);
    if (!sorted.length) return null;

    // adjCloses 與 sorted records 對應
    const allSorted = [...records].sort((a,b) => a.ts - b.ts);
    const adjMap = {};
    allSorted.forEach((r,i) => { adjMap[r.ts] = adjCloses[i] ?? r.close; });

    return {
      meta: { symbol: `${id}.TW`, currency: 'TWD', exchangeName: 'TPE', dataSource: 'TWSE+TWT49U' },
      timestamps: sorted.map(r => r.ts),
      indicators: {
        quote: [{
          open:   sorted.map(r => r.open),
          high:   sorted.map(r => r.high),
          low:    sorted.map(r => r.low),
          close:  sorted.map(r => r.close),
          volume: sorted.map(r => r.volume), // 股數（screener /1000 = 張）
        }],
        adjclose: [{
          adjclose: sorted.map(r => adjMap[r.ts] ?? r.close), // ★ 還原收盤
        }],
      },
    };
  }

  // ── 主邏輯 ──
  try {
    let result = null;
    let dataSource = 'unknown';

    if (source !== 'yahoo') {
      try {
        let records, adjCloses;

        if (isOTC(symbol)) {
          records = await fetchTPEX(symbol, days);
          adjCloses = records.map(r => r.close); // TPEX 先用 close
          dataSource = 'TPEX';
        } else {
          // 並行抓股價 + 除權息
          const [recs, exRights] = await Promise.all([
            fetchTWSE(symbol, days),
            fetchExRights(symbol),
          ]);
          records = recs;
          adjCloses = calcAdjClose(records, exRights); // ★ 還原收盤
          dataSource = exRights.length > 0 ? 'TWSE+TWT49U' : 'TWSE';
        }

        if (records.length >= 5) {
          result = toYahooFormat(records, adjCloses, symbol);
        }
      } catch (e) {
        console.error(`[screener] TWSE/TPEX 失敗 (${symbol}):`, e.message);
      }
    }

    // Yahoo 備援
    if (!result && source !== 'twse') {
      const yahooResult = await fetchYahoo(symbol, days);
      if (yahooResult) {
        result = yahooResult;
        dataSource = 'Yahoo';
      }
    }

    if (!result) {
      return res.status(404).json({ error: `無法取得 ${symbol} 資料`, symbol });
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({
      chart: { result: [result], error: null },
      _source: dataSource,
      _symbol: symbol,
    });

  } catch (err) {
    console.error('[screener] 錯誤:', err);
    return res.status(500).json({ error: err.message, symbol });
  }
}
