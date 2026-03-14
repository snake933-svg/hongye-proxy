/**
 * 宏爺 AI 股市戰情室 — 股價代理
 * 完全遵照 data_loader.py 三層備援邏輯：
 *  1. Yahoo Finance .TW  (上市, auto_adjust=還原K線)
 *  2. Yahoo Finance .TWO (上櫃, auto_adjust=還原K線)
 *  3. FinMind TaiwanStockPrice 備援 + Yahoo adjclose 還原
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { symbol, days = '250' } = req.query;
  if (!symbol) { res.status(400).json({ error: '缺少 symbol' }); return; }

  const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  const endTs   = Math.floor(Date.now() / 1000);
  const startTs = endTs - Math.ceil(parseInt(days) * 1.8) * 86400;

  // ── 層1 & 層2：Yahoo Finance .TW / .TWO ──────────────────────
  for (const suffix of ['.TW', '.TWO']) {
    try {
      const sym = encodeURIComponent(symbol + suffix);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}` +
                  `?interval=1d&period1=${startTs}&period2=${endTs}` +
                  `&events=div,splits&includeAdjustedClose=true`;
      const r = await fetch(url, { headers: ua });
      if (!r.ok) continue;
      const data = await r.json();
      const result = data?.chart?.result?.[0];
      if (!result?.timestamp?.length) continue;
      // 補齊 adjclose（若 Yahoo 沒給，用 close 代替）
      if (!result.indicators?.adjclose?.[0]?.adjclose) {
        result.indicators.adjclose = [{ adjclose: result.indicators.quote[0].close }];
      }
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json(data);
    } catch (e) { continue; }
  }

  // ── 層3：FinMind TaiwanStockPrice 備援（同宏爺 taiwan_stock_daily）─
  try {
    const endDate   = new Date();
    const startDate = new Date(endDate.getTime() - Math.ceil(parseInt(days) * 1.8) * 86400000);
    const fmt = d => d.toISOString().slice(0, 10);

    const fmUrl = `https://api.finmindtrade.com/api/v4/data` +
                  `?dataset=TaiwanStockPrice&data_id=${encodeURIComponent(symbol)}` +
                  `&start_date=${fmt(startDate)}&token=`;
    const fmR = await fetch(fmUrl, { headers: ua });
    if (!fmR.ok) throw new Error(`FinMind HTTP ${fmR.status}`);
    const fmJ = await fmR.json();
    const fmData = (fmJ.data || []).sort((a, b) => a.date < b.date ? -1 : 1);
    if (!fmData.length) throw new Error('FinMind 查無資料');

    // 嘗試從 Yahoo 取得 adjclose 比例（同宏爺還原K線邏輯）
    let adjRatioMap = {};
    for (const suffix of ['.TW', '.TWO']) {
      try {
        const sym2 = encodeURIComponent(symbol + suffix);
        const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${sym2}` +
                     `?interval=1d&period1=${startTs}&period2=${endTs}` +
                     `&events=div,splits&includeAdjustedClose=true`;
        const yR = await fetch(yUrl, { headers: ua });
        if (!yR.ok) continue;
        const yJ = await yR.json();
        const yRes = yJ?.chart?.result?.[0];
        if (!yRes?.timestamp?.length) continue;
        const ts    = yRes.timestamp;
        const close = yRes.indicators?.quote?.[0]?.close || [];
        const adj   = yRes.indicators?.adjclose?.[0]?.adjclose || [];
        for (let i = 0; i < ts.length; i++) {
          const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
          if (close[i] && adj[i]) adjRatioMap[d] = adj[i] / close[i];
        }
        if (Object.keys(adjRatioMap).length > 0) break;
      } catch (e) { continue; }
    }

    // 轉換成 Yahoo chart 相容格式
    const timestamps = [], opens = [], highs = [], lows = [], closes = [], volumes = [], adjcloses = [];

    for (const row of fmData) {
      const d     = row.date?.slice(0, 10);
      const ts    = Math.floor(new Date(d + 'T00:00:00+08:00').getTime() / 1000);
      const ratio = adjRatioMap[d] ?? 1;
      const rawO = +(row.open || 0), rawH = +(row.max || 0);
      const rawL = +(row.min || 0),  rawC = +(row.close || 0);
      timestamps.push(ts);
      opens.push(+(rawO * ratio).toFixed(2));
      highs.push(+(rawH * ratio).toFixed(2));
      lows.push(+(rawL  * ratio).toFixed(2));
      closes.push(+(rawC * ratio).toFixed(2));
      adjcloses.push(+(rawC * ratio).toFixed(2));
      volumes.push(Math.round((+(row.Trading_Volume) || 0) / 1000));
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.status(200).json({
      chart: {
        result: [{
          meta: { symbol, longName: symbol, shortName: symbol, currency: 'TWD' },
          timestamp: timestamps,
          indicators: {
            quote: [{ open: opens, high: highs, low: lows, close: closes, volume: volumes }],
            adjclose: [{ adjclose: adjcloses }]
          }
        }],
        error: null
      }
    });

  } catch (e) {
    return res.status(404).json({
      error: `查無股票代碼 ${symbol}，請確認為台灣上市/上櫃股票`
    });
  }
}
