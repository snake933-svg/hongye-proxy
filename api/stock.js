export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const { symbol, days = '250' } = req.query;
  if (!symbol) { res.status(400).json({ error: '缺少 symbol' }); return; }
  const sym = encodeURIComponent(symbol + '.TW');
  const end = Math.floor(Date.now() / 1000);
  const start = end - Math.ceil(parseInt(days) * 1.8) * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${start}&period2=${end}&events=div,splits&includeAdjustedClose=true`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!r.ok) { res.status(r.status).json({ error: `Yahoo Finance 錯誤 (${r.status})` }); return; }
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
}
