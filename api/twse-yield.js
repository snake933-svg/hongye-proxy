/**
 * 宏爺飆股選股器 — TWSE 殖利率/本益比/股價淨值比代理
 * 來源：台灣證交所 BWIBBU_d（官方，與 Goodinfo 相同資料來源）
 * 用途：取得即時殖利率（策略三存股選股核心條件）
 *
 * 呼叫方式：/api/twse-yield
 * 回傳：{ stocks: { "2330": { yield: 2.5, pe: 18.2, pb: 3.1 } } }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

  /* 產生候選日期（今天往回找，最多找 5 天） */
  function getCandidateDates() {
    const dates = [];
    const d = new Date();
    const twHour = new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false });
    if (parseInt(twHour) < 15) d.setDate(d.getDate() - 1);
    for (let i = 0; i < 7 && dates.length < 5; i++) {
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

  /* 解析 TWSE 數字（移除逗號、處理 "--"） */
  function parseFloat2(s) {
    if (!s || s.trim() === '--' || s.trim() === '') return null;
    return parseFloat(s.replace(/,/g, '')) || null;
  }

  /* 主邏輯：依序嘗試日期直到取得資料 */
  const candidates = getCandidateDates();

  for (const dateStr of candidates) {
    try {
      const url = `https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?response=json&date=${dateStr}&selectType=ALL`;
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) continue;

      // 每列：[代號, 名稱, 殖利率(%), 股利年度, 本益比, 股價淨值比, 財報年/季]
      const stocks = {};
      for (const row of j.data) {
        const id = row[0]?.trim();
        if (!id || !/^\d{4,6}$/.test(id)) continue;
        const yieldPct = parseFloat2(row[2]);
        const pe       = parseFloat2(row[4]);
        const pb       = parseFloat2(row[5]);
        stocks[id] = {
          yield: yieldPct,  // 殖利率（%）
          pe,               // 本益比
          pb,               // 股價淨值比
        };
      }

      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate'); // 快取1小時
      return res.status(200).json({ stocks, date: dateStr, total: Object.keys(stocks).length });

    } catch { continue; }
  }

  // 全部失敗
  return res.status(200).json({ stocks: {}, error: 'TWSE 殖利率資料暫時無法取得' });
}
