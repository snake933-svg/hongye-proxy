/**
 * api/fundamental.js — 基本面（股本、董監持股、連續配息）
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const ua = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
  function pn(s) { const v = parseFloat(String(s||'').replace(/,/g,'')); return isNaN(v)?0:v; }

  // 複製原本 twse-fundamental.js 的邏輯
  try {
    const stocks = {};
    // 從 TWSE 上市股本資料
    try {
      const r = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', { headers: ua, signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const data = await r.json();
        for (const item of (Array.isArray(data)?data:[])) {
          const code = (item['公司代號']||'').trim();
          if (!code || !/^\d{4}$/.test(code)) continue;
          const capital = pn(item['實收資本額'] || item['capital'] || 0) / 1e8;
          if (capital > 0 && !stocks[code]) stocks[code] = { capital, directorPct: 0, dividendStreak: 0, hasDividend: false };
        }
      }
    } catch {}

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json({ stocks, total: Object.keys(stocks).length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
