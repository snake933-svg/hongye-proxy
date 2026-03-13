export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const { dataset, data_id, start_date } = req.query;
  if (!dataset || !data_id || !start_date) {
    res.status(400).json({ error: '缺少必要參數', data: [] }); return;
  }
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=${encodeURIComponent(dataset)}&data_id=${encodeURIComponent(data_id)}&start_date=${encodeURIComponent(start_date)}&token=`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) { res.status(200).json({ data: [] }); return; }
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
    res.status(200).json(data);
  } catch (e) { res.status(200).json({ data: [], error: e.message }); }
}
