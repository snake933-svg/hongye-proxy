/**
 * api/chip.js — 三大法人籌碼
 * TWSE T86 逐日資料
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ua = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

  function pn(s) {
    const v = parseFloat(String(s || '').replace(/,/g, ''));
    return isNaN(v) ? 0 : v;
  }

  function getTradingDates(n) {
    const dates = [], d = new Date();
    while (dates.length < n) {
      d.setDate(d.getDate() - 1);
      if (d.getDay() !== 0 && d.getDay() !== 6)
        dates.push(d.toISOString().slice(0,10).replace(/-/g,''));
    }
    return dates;
  }

  async function fetchT86(date) {
    try {
      const r = await fetch(
        `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${date}&selectType=ALL`,
        { headers: ua, signal: AbortSignal.timeout(15000) }
      );
      if (!r.ok) return null;
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return null;
      const out = {};
      for (const row of j.data) {
        const code = row[0]?.trim();
        if (!code || !/^\d{4,6}$/.test(code)) continue;
        out[code] = {
          foreignNet: Math.round(pn(row[4]) / 1000),
          itNet:      Math.round(pn(row[7]) / 1000),
        };
      }
      return out;
    } catch { return null; }
  }

  async function fetchDayVol(date) {
    try {
      const r = await fetch(
        `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&date=${date}&type=ALL`,
        { headers: ua, signal: AbortSignal.timeout(15000) }
      );
      if (!r.ok) return null;
      const j = await r.json();
      if (j.stat !== 'OK') return null;
      const out = {};
      for (const table of (j.tables || [])) {
        const data = table.data || [];
        if (!data.length || !/^\d{4}$/.test(data[0]?.[0]?.trim())) continue;
        for (const row of data) {
          const code = row[0]?.trim();
          if (!/^\d{4}$/.test(code)) continue;
          const vol = Math.round(pn(row[2]) / 1000);
          if (vol > 0) out[code] = vol;
        }
        if (Object.keys(out).length > 100) break;
      }
      // 若 MI_INDEX 失敗退回 STOCK_DAY_ALL
      if (Object.keys(out).length < 50) {
        const yyyymm = date.slice(0,6) + '01';
        const r2 = await fetch(
          `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json&date=${yyyymm}`,
          { headers: ua, signal: AbortSignal.timeout(15000) }
        );
        if (r2.ok) {
          const j2 = await r2.json();
          if (j2.stat === 'OK') {
            for (const row of (j2.data || [])) {
              const code = row[0]?.trim();
              if (!/^\d{4}$/.test(code)) continue;
              const vol = Math.round(pn(row[2]) / 1000);
              if (vol > 0) out[code] = vol;
            }
          }
        }
      }
      return out;
    } catch { return null; }
  }

  try {
    const dates60 = getTradingDates(62);
    const dates20 = dates60.slice(0, 22);
    const datesT86 = dates60.slice(0, 12); // 連買天數只需12天

    const BATCH = 4;
    const allT86 = {}, allVol = {};

    for (let i = 0; i < dates60.length; i += BATCH) {
      const batch = dates60.slice(i, i + BATCH);
      await Promise.all(batch.map(async d => {
        const [t86, vol] = await Promise.all([
          datesT86.includes(d) ? fetchT86(d) : Promise.resolve(null),
          fetchDayVol(d),
        ]);
        if (t86) allT86[d] = t86;
        if (vol) allVol[d]  = vol;
      }));
      if (i + BATCH < dates60.length)
        await new Promise(r => setTimeout(r, 150));
    }

    const sortedDates = Object.keys(allT86).sort().reverse();
    const codes = new Set();
    sortedDates.forEach(d => Object.keys(allT86[d]).forEach(c => codes.add(c)));

    const stocks = {};
    for (const code of codes) {
      let fType = 0, fStreak = 0, itType = 0, itStreak = 0;
      let net5d = 0, itNet5d = 0, buy60 = 0, sell20 = 0;

      for (let i = 0; i < sortedDates.length; i++) {
        const c = allT86[sortedDates[i]]?.[code];
        if (!c) continue;
        const fn = c.foreignNet, itn = c.itNet;

        if (fType === 0) { if (fn) { fType = fn > 0 ? 1 : -1; fStreak = 1; } }
        else if ((fType===1&&fn>0)||(fType===-1&&fn<0)) fStreak++;
        else { fType = fn ? (fn>0?1:-1) : 0; fStreak = fn ? 1 : 0; }

        if (itType === 0) { if (itn) { itType = itn > 0 ? 1 : -1; itStreak = 1; } }
        else if ((itType===1&&itn>0)||(itType===-1&&itn<0)) itStreak++;
        else { itType = itn ? (itn>0?1:-1) : 0; itStreak = itn ? 1 : 0; }

        if (i < 5)  { net5d += fn; itNet5d += itn; }
        if (i < 60)   buy60 += fn;
        if (i < 20 && fn < 0) sell20 += Math.abs(fn);
      }

      let vol60 = 0, vol20 = 0;
      for (const d of dates60) {
        const v = allVol[d]?.[code] || 0;
        vol60 += v;
        if (dates20.includes(d)) vol20 += v;
      }

      const buyQPct  = buy60  > 0 && vol60 > 0 ? Math.min(buy60/vol60*100, 100) : 0;
      const sellMPct = sell20 > 0 && vol20 > 0 ? Math.min(sell20/vol20*100, 100) : 0;

      if (Math.abs(net5d) > 0 || Math.abs(buy60) > 0 || fStreak > 0 || itStreak > 0) {
        stocks[code] = {
          foreignBuyDays:  fType  === 1  ? fStreak  : 0,
          foreignSellDays: fType  === -1 ? fStreak  : 0,
          net5d, buy60,
          foreignBuyQPct:  Math.round(buyQPct  * 10) / 10,
          sell20,
          foreignSellMPct: Math.round(sellMPct * 10) / 10,
          itBuyDays:  itType === 1  ? itStreak : 0,
          itSellDays: itType === -1 ? itStreak : 0,
          itNet5d,
        };
      }
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({ stocks, total: Object.keys(stocks).length, date: new Date().toISOString().slice(0,10) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
