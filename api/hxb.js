/**
 * api/hxb.js — 基本面（股本、董監持股、連續配息）v2
 *
 * 資料來源：
 *   股本   → TWSE openapi t187ap03_L（上市）+ TPEX openapi（上櫃）
 *   董監持股 → TWSE openapi t187ap04_L（上市股東結構）
 *   配息年數 → TWT49U 近5年除息記錄統計
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const ua = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
  function pn(s) { const v = parseFloat(String(s||'').replace(/,/g,'')); return isNaN(v) ? 0 : v; }

  try {
    const stocks = {};

    // ── 1. 上市股本（t187ap03_L）──
    try {
      const r = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', { headers: ua, signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const data = await r.json();
        for (const item of (Array.isArray(data) ? data : [])) {
          const code = (item['公司代號']||item['Code']||'').trim();
          if (!code || !/^\d{4}$/.test(code)) continue;
          const capital = pn(item['實收資本額']||item['PaidinCapital']||0) / 1e8; // 億
          if (capital > 0) {
            if (!stocks[code]) stocks[code] = {};
            stocks[code].capital = Math.round(capital * 10) / 10;
          }
        }
      }
    } catch(e) { console.error('[hxb] t187ap03_L:', e.message); }

    // ── 2. 上市董監持股（t187ap04_L）──
    try {
      const r = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap04_L', { headers: ua, signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const data = await r.json();
        for (const item of (Array.isArray(data) ? data : [])) {
          const code = (item['公司代號']||item['Code']||'').trim();
          if (!code || !/^\d{4}$/.test(code)) continue;
          // 欄位：董監持股合計 or 董監持股比例
          const dirPct = pn(
            item['董監持股比例'] || item['董監持股%'] ||
            item['DirectorAndSupervisorHoldingRatio'] || 0
          );
          if (!stocks[code]) stocks[code] = {};
          if (dirPct > 0) stocks[code].directorPct = Math.round(dirPct * 10) / 10;
        }
      }
    } catch(e) { console.error('[hxb] t187ap04_L:', e.message); }

    // ── 3. 連續配息年數（TWT49U 近5年除息記錄）──
    // 批量抓全市場除息：以年份為單位，查近5年
    try {
      const now = new Date();
      const yearDivs = {}; // { code: Set<year> }

      for (let y = 0; y < 5; y++) {
        const year = now.getFullYear() - y;
        const rocYear = year - 1911;
        // TWT49U 用月份查，每年只查一次（取1月到12月全年）
        const strDate = `${year}0101`;
        const endDate = y === 0
          ? now.toISOString().slice(0,10).replace(/-/g,'')
          : `${year}1231`;

        try {
          const r = await fetch(
            `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json&strDate=${strDate}&endDate=${endDate}`,
            { headers: ua, signal: AbortSignal.timeout(20000) }
          );
          if (!r.ok) continue;
          const j = await r.json();
          if (j.stat !== 'OK' || !j.data?.length) continue;

          for (const row of j.data) {
            const code = (row[1]||'').trim();
            if (!code || !/^\d{4,6}$/.test(code)) continue;
            // 只計算現金股利（row[5] 現金股利 > 0）
            const cashDiv = pn(row[5]);
            if (cashDiv > 0) {
              if (!yearDivs[code]) yearDivs[code] = new Set();
              yearDivs[code].add(year);
            }
          }
        } catch { continue; }

        await new Promise(r => setTimeout(r, 100));
      }

      // 計算連續配息年數（從今年往回算連續有配息的年數）
      for (const [code, years] of Object.entries(yearDivs)) {
        let streak = 0;
        for (let y = 0; y < 5; y++) {
          if (years.has(now.getFullYear() - y)) streak++;
          else break;
        }
        if (streak > 0) {
          if (!stocks[code]) stocks[code] = {};
          stocks[code].dividendStreak = streak;
        }
      }
    } catch(e) { console.error('[hxb] TWT49U:', e.message); }

    // ── 4. 補齊預設值 ──
    for (const code of Object.keys(stocks)) {
      if (!stocks[code].capital)       stocks[code].capital = 0;
      if (!stocks[code].directorPct)   stocks[code].directorPct = 0;
      if (!stocks[code].dividendStreak) stocks[code].dividendStreak = 0;
    }

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json({ stocks, total: Object.keys(stocks).length, source: 'TWSE-openapi' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
