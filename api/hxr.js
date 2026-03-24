/**
 * api/revenue.js — 月營收（MOPS 直取，與 Goodinfo 同源）
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const ua = { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://mops.twse.com.tw/' };
  function pn(s) { const v = parseFloat(String(s||'').replace(/,/g,'')); return isNaN(v)?0:v; }

  function parseMops(html) {
    const out = {};
    const rows = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    for (const tr of rows) {
      const tds = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(td => td.replace(/<[^>]+>/g,'').trim());
      if (tds.length < 7) continue;
      const code = tds[0]?.replace(/\s/g,'');
      if (!code || !/^\d{4,6}$/.test(code)) continue;
      const cur = pn(tds[2]), yoy = pn(tds[6]);
      if (cur > 0) out[code] = { revenue: Math.round(cur/1000*10)/10, yoy: Math.round(yoy*10)/10 };
    }
    return out;
  }

  async function fetchMops(rocYear, month, typek) {
    try {
      const body = new URLSearchParams({ encodeURIComponent:'1', step:'1', firstin:'1', off:'1', isQuery:'Y', TYPEK:typek, year:String(rocYear), month:String(month) });
      const r = await fetch('https://mops.twse.com.tw/mops/web/ajax_t05st10', { method:'POST', headers:ua, body:body.toString(), signal:AbortSignal.timeout(25000) });
      if (!r.ok) return {};
      return parseMops(await r.text());
    } catch { return {}; }
  }

  try {
    const now = new Date();
    const months = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now); d.setMonth(d.getMonth() - i);
      months.push({ rocYear: d.getFullYear()-1911, month: d.getMonth()+1, key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` });
    }

    const stocks = {};
    for (let i = 0; i < months.length; i += 2) {
      const batch = months.slice(i, i+2);
      const results = await Promise.all(batch.flatMap(({rocYear,month,key}) => [
        fetchMops(rocYear,month,'sii').then(d=>({key,d})),
        fetchMops(rocYear,month,'otc').then(d=>({key,d})),
      ]));
      for (const {key,d} of results) {
        for (const [code,info] of Object.entries(d)) {
          if (!stocks[code]) stocks[code] = [];
          if (!stocks[code].find(r=>r.date===key))
            stocks[code].push({ date:key, revenue:info.revenue, yoy:info.yoy });
        }
      }
      if (i + 2 < months.length) await new Promise(r=>setTimeout(r,200));
    }
    for (const c of Object.keys(stocks)) stocks[c].sort((a,b)=>b.date.localeCompare(a.date));

    res.setHeader('Cache-Control', 's-maxage=14400, stale-while-revalidate');
    return res.status(200).json({ stocks, total: Object.keys(stocks).length, source: 'MOPS' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
