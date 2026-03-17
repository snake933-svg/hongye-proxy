/**
 * 宏爺飆股選股器 — TWSE 三大法人代理 v2
 * 來源：台灣證交所 T86（官方，與 Goodinfo 相同資料來源）
 * 新增：同時追蹤外資 + 投信 連買/連賣天數
 *
 * T86 欄位：[0]代號 [1]名稱 [4]外陸資淨買進 [8]投信淨買進
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const days = Math.min(parseInt(req.query.days || '10'), 20);
  const ua   = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

  function getTradingDates(n) {
    const dates = [];
    const d = new Date();
    const twHour = new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false });
    if (parseInt(twHour) < 15) d.setDate(d.getDate() - 1);
    while (dates.length < n) {
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        dates.push(`${y}${m}${dd}`);
      }
      d.setDate(d.getDate() - 1);
    }
    return dates;
  }

  function parseNum(s) {
    if (!s || s.trim() === '--' || s.trim() === '') return 0;
    return parseInt(s.replace(/,/g, ''), 10) || 0;
  }

  async function fetchT86(dateStr) {
    const url = `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${dateStr}&selectType=ALL`;
    try {
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return null;
      const result = {};
      for (const row of j.data) {
        const id = row[0]?.trim();
        if (!id || !/^\d{4,6}$/.test(id)) continue;
        result[id] = {
          f:  Math.round(parseNum(row[4]) / 1000),  // 外資淨買（張）
          it: Math.round(parseNum(row[8]) / 1000),  // 投信淨買（張）
        };
      }
      return { date: dateStr, stocks: result };
    } catch { return null; }
  }

  try {
    const tradingDates = getTradingDates(days);
    const allDayData = [];
    for (let i = 0; i < tradingDates.length; i += 5) {
      const batch = tradingDates.slice(i, i + 5);
      const results = await Promise.all(batch.map(d => fetchT86(d)));
      for (const r of results) { if (r) allDayData.push(r); }
    }

    if (!allDayData.length) {
      return res.status(200).json({ stocks: {}, error: 'TWSE 無資料（可能為假日）' });
    }

    allDayData.sort((a, b) => a.date.localeCompare(b.date));

    const allIds = new Set();
    for (const day of allDayData) Object.keys(day.stocks).forEach(id => allIds.add(id));

    const stocks = {};
    for (const id of allIds) {
      const daily = allDayData.map(d => ({
        date: d.date,
        f:  d.stocks[id]?.f  ?? 0,
        it: d.stocks[id]?.it ?? 0,
      }));

      // 外資
      let foreignBuyDays = 0, foreignSellDays = 0;
      for (let i = daily.length - 1; i >= 0; i--) { if (daily[i].f > 0) foreignBuyDays++; else break; }
      for (let i = daily.length - 1; i >= 0; i--) { if (daily[i].f < 0) foreignSellDays++; else break; }
      const net5d      = daily.slice(-5).reduce((s, d) => s + d.f, 0);
      const netBuy20d  = daily.slice(-20).reduce((s, d) => s + Math.max(0, d.f), 0);
      const netSell20d = daily.slice(-20).reduce((s, d) => s + Math.max(0, -d.f), 0);
      const netBuy60d  = daily.slice(-Math.min(60, daily.length)).reduce((s, d) => s + Math.max(0, d.f), 0);

      // 投信
      let itBuyDays = 0, itSellDays = 0;
      for (let i = daily.length - 1; i >= 0; i--) { if (daily[i].it > 0) itBuyDays++; else break; }
      for (let i = daily.length - 1; i >= 0; i--) { if (daily[i].it < 0) itSellDays++; else break; }
      const itNet5d = daily.slice(-5).reduce((s, d) => s + d.it, 0);

      stocks[id] = {
        foreignBuyDays, foreignSellDays, net5d, netBuy20d, netSell20d, netBuy60d,
        itBuyDays, itSellDays, itNet5d,
      };
    }

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate');
    return res.status(200).json({ stocks, fetchedDays: allDayData.length, lastDate: allDayData[allDayData.length - 1]?.date });

  } catch (e) {
    return res.status(500).json({ stocks: {}, error: e.message });
  }
}
