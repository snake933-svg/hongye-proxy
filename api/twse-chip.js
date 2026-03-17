/**
 * 宏爺飆股選股器 — TWSE 三大法人代理
 * 來源：台灣證交所 T86（官方，與 Goodinfo 相同資料來源）
 * 用途：取得外資連買/連賣天數、淨買超張數
 *
 * 呼叫方式：/api/twse-chip?days=10
 * 回傳：{ stocks: { "2330": { foreignBuyDays, foreignSellDays, net5d, daily:[...] } } }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const days = Math.min(parseInt(req.query.days || '10'), 20);
  const ua   = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

  /* 產生近 N 個交易日日期（往回推，跳過週末） */
  function getTradingDates(n) {
    const dates = [];
    const d = new Date();
    // 若今天 < 15:00 台灣時間，從昨天開始
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
    return dates; // 由新到舊
  }

  /* 解析 TWSE 數字格式（移除逗號、處理 "--" 與負號） */
  function parseNum(s) {
    if (!s || s.trim() === '--' || s.trim() === '') return 0;
    return parseInt(s.replace(/,/g, ''), 10) || 0;
  }

  /* 抓單日 T86 */
  async function fetchT86(dateStr) {
    const url = `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${dateStr}&selectType=ALL`;
    try {
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return null;
      // 每列：[代號, 名稱, 外陸資買, 外陸資賣, 外陸資淨, ...佔發行%, 投信買, 投信賣, 投信淨, 自營買, 自營賣, 自營淨, 自營避險買, 自營避險賣, 自營避險淨, 三大法人合計淨]
      const result = {};
      for (const row of j.data) {
        const id      = row[0]?.trim();
        if (!id || !/^\d{4,6}$/.test(id)) continue;
        const foreignNet = parseNum(row[4]); // 外陸資淨買進股數（單位：股）
        result[id] = Math.round(foreignNet / 1000); // 轉換為張（1張=1000股）
      }
      return { date: dateStr, stocks: result };
    } catch { return null; }
  }

  /* 主邏輯 */
  try {
    const tradingDates = getTradingDates(days);

    // 並發抓取（最多 5 天同時，避免 TWSE 限流）
    const allDayData = [];
    for (let i = 0; i < tradingDates.length; i += 5) {
      const batch = tradingDates.slice(i, i + 5);
      const results = await Promise.all(batch.map(d => fetchT86(d)));
      for (const r of results) { if (r) allDayData.push(r); }
    }

    if (!allDayData.length) {
      return res.status(200).json({ stocks: {}, error: 'TWSE 無資料（可能為假日）' });
    }

    // 依日期由舊到新排序
    allDayData.sort((a, b) => a.date.localeCompare(b.date));

    // 彙整每支股票的資料
    const stocks = {};

    // 收集所有出現過的股票代號
    const allIds = new Set();
    for (const day of allDayData) Object.keys(day.stocks).forEach(id => allIds.add(id));

    for (const id of allIds) {
      // 每日外資淨買進（張），由舊到新
      const daily = allDayData.map(d => ({ date: d.date, net: d.stocks[id] ?? 0 }));

      // 連買天數（從最新一天往前數連續 > 0）
      let foreignBuyDays = 0;
      for (let i = daily.length - 1; i >= 0; i--) {
        if (daily[i].net > 0) foreignBuyDays++;
        else break;
      }

      // 連賣天數（從最新一天往前數連續 < 0）
      let foreignSellDays = 0;
      for (let i = daily.length - 1; i >= 0; i--) {
        if (daily[i].net < 0) foreignSellDays++;
        else break;
      }

      // 近5日外資淨買超（張）
      const net5d = daily.slice(-5).reduce((s, d) => s + d.net, 0);

      // 近20日外資總買超（用於計算月買超佔比）
      const netBuy20d  = daily.slice(-20).reduce((s, d) => s + Math.max(0, d.net), 0);
      const netSell20d = daily.slice(-20).reduce((s, d) => s + Math.max(0, -d.net), 0);

      // 近60日（季）外資總買超
      const netBuy60d  = daily.slice(-Math.min(60, daily.length)).reduce((s, d) => s + Math.max(0, d.net), 0);

      stocks[id] = { foreignBuyDays, foreignSellDays, net5d, netBuy20d, netSell20d, netBuy60d, daily };
    }

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate'); // 快取15分鐘
    return res.status(200).json({ stocks, fetchedDays: allDayData.length, lastDate: allDayData[allDayData.length - 1]?.date });

  } catch (e) {
    return res.status(500).json({ stocks: {}, error: e.message });
  }
}
