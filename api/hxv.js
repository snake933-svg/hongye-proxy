/**
 * api/yield.js — 殖利率/PE/PB（TWSE BWIBBU_d + TPEX）
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const ua = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
  function pn(s) { const v = parseFloat(String(s||'').replace(/,/g,'')); return isNaN(v)?0:v; }

  try {
    const [twse, tpex] = await Promise.all([
      fetch('https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?response=json&selectType=ALL', { headers: ua, signal: AbortSignal.timeout(20000) }),
      fetch('https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&o=json&charset=UTF-8', { headers: ua, signal: AbortSignal.timeout(20000) }),
    ]);
    const stocks = {};
    if (twse.ok) {
      const j = await twse.json();
      for (const row of (j.data || [])) {
        const code = row[0]?.trim();
        if (!code || !/^\d{4}$/.test(code)) continue;
        const y = pn(row[2]), pe = pn(row[4]), pb = pn(row[5]);
        if (y > 0 || pe > 0) stocks[code] = { yield: y, pe, pb };
      }
    }
    if (tpex.ok) {
      const j = await tpex.json();
      for (const row of (j.aaData || [])) {
        const code = row[0]?.trim();
        if (!code || !/^\d{4,5}$/.test(code) || stocks[code]) continue;
        const pe = pn(row[2]), y = pn(row[3]), pb = pn(row[4]);
        if (y > 0 || pe > 0) stocks[code] = { yield: y, pe, pb };
      }
    }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json({ stocks, total: Object.keys(stocks).length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
