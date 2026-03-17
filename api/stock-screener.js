/**
 * 宏爺飆股選股器 — 股價代理（選股器專用）
 *
 * ✅ 永遠回傳【原始收盤價】（不做除權息還原）
 * ✅ MA20/MA60/MA120 計算結果與 Goodinfo 完全一致
 * ✅ AI戰情室的 stock.js 完全不受影響
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { symbol, days = '150' } = req.query;
  if (!symbol) { res.status(400).json({ error: '缺少 symbol' }); return; }

  const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  const endTs   = Math.floor(Date.now() / 1000);
  const startTs = endTs - Math.ceil(parseInt(days) * 1.8) * 86400;

  for (const suffix of ['.TW', '.TWO']) {
    try {
      const sym = encodeURIComponent(symbol + suffix);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}` +
                  `?interval=1d&period1=${startTs}&period2=${endTs}` +
                  `&events=div,splits&includeAdjustedClose=true`;
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const data = await r.json();
      const result = data?.chart?.result?.[0];
      if (!result?.timestamp?.length) continue;
      const q = result.indicators?.quote?.[0];
      if (!q?.close?.length) continue;

      // ✅ 強制覆蓋 adjclose 為原始 close（與 Goodinfo 均線計算基礎一致）
      result.indicators.adjclose = [{ adjclose: [...q.close] }];

      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json(data);
    } catch { continue; }
  }

  // FinMind 備援（原始價格，不還原）
  try {
    const endDate   = new Date();
    const startDate = new Date(endDate.getTime() - Math.ceil(parseInt(days) * 1.8) * 86400000);
    const fmt = d => d.toISOString().slice(0, 10);
    const fmUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${encodeURIComponent(symbol)}&start_date=${fmt(startDate)}&token=`;
    const fmR = await fetch(fmUrl, { headers: ua });
    if (!fmR.ok) throw new Error(`FinMind ${fmR.status}`);
    const fmJ = await fmR.json();
    const fmData = (fmJ.data || []).sort((a, b) => a.date < b.date ? -1 : 1);
    if (!fmData.length) throw new Error('無資料');

    const timestamps = [], opens = [], highs = [], lows = [], closes = [], volumes = [];
    for (const row of fmData) {
      const d  = row.date?.slice(0, 10);
      const ts = Math.floor(new Date(d + 'T00:00:00+08:00').getTime() / 1000);
      timestamps.push(ts);
      opens.push(+(row.open||0));
      highs.push(+(row.max||0));
      lows.push(+(row.min||0));
      closes.push(+(row.close||0));
      volumes.push(Math.round((+(row.Trading_Volume)||0)/1000));
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.status(200).json({
      chart: { result: [{ meta: { symbol }, timestamp: timestamps,
        indicators: {
          quote: [{ open:opens, high:highs, low:lows, close:closes, volume:volumes }],
          adjclose: [{ adjclose: [...closes] }] // 原始close，不還原
        }
      }], error: null }
    });
  } catch (e) {
    return res.status(404).json({ error: `查無 ${symbol}` });
  }
}
