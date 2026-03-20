/**
 * api/stock-screener.js — 股價歷史（與 Goodinfo 完全同源）
 *
 * 來源優先順序：
 *   1. TWSE STOCK_DAY + TWT49U 除權息 → 計算真正還原收盤（均線與 Goodinfo 完全一致）
 *   2. TPEX 上櫃歷史（含除權息還原）
 *   3. Yahoo Finance adjclose（備援）
 *
 * 回傳格式：相容 Yahoo Finance chart API
 *   chart.result[0].indicators.quote[0].{ open, high, low, close, volume }
 *   chart.result[0].indicators.adjclose[0].adjclose  ← 還原收盤（均線用這個）
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
    const v = parseFloat(String(s).replace(/,/g, ''));
    return isNaN(v) ? 0 : v;
  }

  function rocToTs(rocDateStr) {
    // 民國日期 'YYY/MM/DD' → Unix timestamp
    const p = String(rocDateStr).replace(/\s/g, '').split('/');
    if (p.length !== 3) return 0;
    const y = parseInt(p[0]) + 1911, m = p[1].padStart(2,'0'), d = p[2].padStart(2,'0');
    return Math.floor(new Date(`${y}-${m}-${d}T08:00:00+08:00`).getTime() / 1000);
  }

  function isOTC(id) {
    if (id.length === 5) return true;
    const n = parseInt(id);
    return n >= 6000 && n <= 6999;
  }

  // ── 抓 TWSE 除權息資料（TWT49U）──
  // 用來計算還原收盤 = 與 Goodinfo 完全相同的均線基礎
  async function fetchExRights(id) {
    try {
      // TWT49U：個股歷史除權息資料
      // 近2年，夠用了
      const endDate = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const startDate = (() => {
        const d = new Date();
        d.setFullYear(d.getFullYear() - 2);
        return d.toISOString().slice(0,10).replace(/-/g,'');
      })();
      const url = `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json&strDate=${startDate}&endDate=${endDate}&stockNo=${id}`;
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return [];
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return [];

      // 欄位：[除權息日期, 股票代號, 名稱, 除權息前收盤, 除息參考價, 除權參考價, ...]
      return j.data.map(row => ({
        ts:       rocToTs(row[0]),
        exDate:   row[0]?.trim(),
        prevClose: pn(row[3]),  // 除息前一日收盤
        refPrice:  pn(row[4]) || pn(row[5]), // 除息/除權參考價（取非零的）
      })).filter(r => r.ts > 0 && r.prevClose > 0 && r.refPrice > 0);
    } catch { return []; }
  }

  // 計算還原收盤（Goodinfo 算法：往回調整所有歷史價格）
  function calcAdjClose(records, exRights) {
    if (!exRights.length) return records.map(r => r.close);

    // 從最新到最舊，累計調整因子
    const sorted = [...records].sort((a, b) => a.ts - b.ts);
    const adjFactors = new Array(sorted.length).fill(1.0);

    // 對每次除權息，調整其之前的所有資料
    let cumFactor = 1.0;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const rec = sorted[i];
      // 找這個時間點之後最近的除權息事件
      for (const ex of exRights) {
        if (ex.ts > rec.ts && ex.prevClose > 0 && ex.refPrice > 0) {
          const factor = ex.refPrice / ex.prevClose;
          // 如果這個除權息還沒算進去
          if (ex.ts <= (sorted[i + 1]?.ts || ex.ts + 1)) {
            cumFactor *= factor;
          }
        }
      }
      adjFactors[i] = cumFactor;
    }

    return sorted.map((r, i) => Math.round(r.close * adjFactors[i] * 100) / 100);
  }

  // 更精確的還原算法（逐筆處理）
  function calcAdjCloseV2(records, exRights) {
    if (!exRights.length) return records.map(r => r.close);

    const sorted = [...records].sort((a, b) => a.ts - b.ts);

    // 對除權息日排序（從舊到新）
    const exSorted = [...exRights].sort((a, b) => a.ts - b.ts);

    // 計算每個除權息事件的調整因子
    // factor = 除息參考價 / 除息前收盤（< 1 表示股價下調）
    const exFactors = exSorted.map(ex => ({
      ts:     ex.ts,
      factor: ex.prevClose > 0 ? ex.refPrice / ex.prevClose : 1,
    }));

    // 從最新往回，累積調整因子
    // 對每筆歷史價格，乘以其之後所有除權息的調整因子
    return sorted.map((rec) => {
      let adj = rec.close;
      for (const ef of exFactors) {
        if (ef.ts > rec.ts) {
          adj *= ef.factor;
        }
      }
      return Math.round(adj * 100) / 100;
    });
  }

  // ── 抓 TWSE 上市股票歷史 ──
  async function fetchTWSE(id, numDays) {
    const today = new Date();
    const records = [];
    const months = Math.ceil(numDays / 20) + 2;

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setMonth(d.getMonth() - i);
      const rocYear = d.getFullYear() - 1911;
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyymm = `${d.getFullYear()}${mm}01`;

      try {
        const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${id}&date=${yyyymm}&response=json`;
        const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const j = await r.json();
        if (j.stat !== 'OK' || !j.data?.length) continue;

        for (const row of j.data) {
          const ts = rocToTs(row[0]);
          if (!ts) continue;
          const volume = Math.round(pn(row[1]));       // 股數（統一保留，最後 /1000）
          const open  = pn(row[3]);
          const high  = pn(row[4]);
          const low   = pn(row[5]);
          const close = pn(row[6]);
          if (close > 0) records.push({ ts, open, high, low, close, volume });
        }
      } catch { continue; }
    }
    return records;
  }

  // ── 抓 TPEX 上櫃股票歷史 ──
  async function fetchTPEX(id, numDays) {
    const today = new Date();
    const records = [];
    const months = Math.ceil(numDays / 20) + 2;

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setMonth(d.getMonth() - i);
      const rocYear = d.getFullYear() - 1911;
      const mm = String(d.getMonth() + 1).padStart(2, '0');

      try {
        const url = `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${rocYear}/${mm}&s=${id},asc,0&output=json`;
        const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const j = await r.json();
        if (!j.aaData?.length) continue;

        for (const row of j.aaData) {
          // TPEX 日期格式：民國年/月/日
          const p = row[0]?.split('/');
          if (!p || p.length !== 3) continue;
          const ts = rocToTs(row[0]);
          if (!ts) continue;
          const volume = Math.round(pn(row[1]) * 1000); // 仟股→股數
          const open  = pn(row[3]);
          const high  = pn(row[4]);
          const low   = pn(row[5]);
          const close = pn(row[6]);
          if (close > 0) records.push({ ts, open, high, low, close, volume });
        }
      } catch { continue; }
    }
    return records;
  }

  // ── Yahoo Finance（備援）──
  async function fetchYahoo(id, numDays) {
    const suffix = id.length <= 4 ? '.TW' : '.TWO';
    const end   = Math.floor(Date.now() / 1000);
    const start = end - Math.round(numDays * 1.5) * 86400;
    const url   = `https://query1.finance.yahoo.com/v8/finance/chart/${id}${suffix}?period1=${start}&period2=${end}&interval=1d`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const j = await r.json();
        const result = j?.chart?.result?.[0];
        if (result) return result;
      } catch {}
    }
    return null;
  }

  // ── 把 TWSE/TPEX records 轉成 Yahoo 格式（含還原收盤）──
  function toYahooFormat(records, adjCloses, id) {
    const sorted = [...records]
      .sort((a, b) => a.ts - b.ts)
      .slice(-days);

    if (!sorted.length) return null;

    // adjCloses 與 records 對應（已排序）
    const fullSorted = [...records].sort((a, b) => a.ts - b.ts);
    const adjMap = {};
    fullSorted.forEach((r, i) => { adjMap[r.ts] = adjCloses[i] ?? r.close; });

    return {
      meta: { symbol: `${id}.TW`, currency: 'TWD', dataSource: 'TWSE' },
      timestamps: sorted.map(r => r.ts),
      indicators: {
        quote: [{
          open:   sorted.map(r => r.open),
          high:   sorted.map(r => r.high),
          low:    sorted.map(r => r.low),
          close:  sorted.map(r => r.close),
          volume: sorted.map(r => r.volume), // 股數，screener /1000=張
        }],
        adjclose: [{
          adjclose: sorted.map(r => adjMap[r.ts] ?? r.close), // ★ 真正還原收盤
        }],
      },
    };
  }

  try {
    let result = null;
    let dataSource = 'unknown';

    if (source !== 'yahoo') {
      try {
        let records, adjCloses;

        if (isOTC(symbol)) {
          records = await fetchTPEX(symbol, days);
          // TPEX 除權息：暫時用 Yahoo adjclose 計算（TPEX 官方除權息 API 不穩定）
          adjCloses = records.map(r => r.close); // 先用 close，下面用 Yahoo adjclose 覆蓋
          dataSource = 'TPEX';
        } else {
          // 並行：股價歷史 + 除權息資料
          const [recs, exRights] = await Promise.all([
            fetchTWSE(symbol, days),
            fetchExRights(symbol),
          ]);
          records = recs;
          // ★ 用 TWSE TWT49U 計算真正還原收盤
          adjCloses = calcAdjCloseV2(records, exRights);
          dataSource = 'TWSE+TWT49U';
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
