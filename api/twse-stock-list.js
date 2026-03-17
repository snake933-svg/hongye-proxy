/**
 * 宏爺飆股選股器 — 全市場股票清單代理
 * 來源：
 *   上市：台灣證交所 STOCK_DAY_ALL（每日全市場收盤資料）
 *   上櫃：台灣櫃買中心 tpex_mainboard_daily_close_quotes
 *
 * 呼叫方式：/api/twse-stock-list
 * 回傳：{
 *   listed: ["2330","2317",...],   // 上市
 *   otc:    ["6547","3036",...],   // 上櫃
 *   all:    [...],                 // 合併去重
 *   prices: { "2330": { close:910, change:5, volume:28000 } }  // 今日收盤（bonus）
 * }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

  function parseNum(s) {
    if (!s || s === '--' || s === '') return 0;
    return parseFloat(String(s).replace(/,/g, '')) || 0;
  }

  /* ── 上市（TWSE）── */
  async function fetchListed() {
    try {
      const url = 'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json';
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return { ids: [], prices: {} };
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return { ids: [], prices: {} };

      const ids = [], prices = {};
      // 欄位：[代號, 名稱, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌(+/-), 漲跌價差, 本益比]
      for (const row of j.data) {
        const id = row[0]?.trim();
        if (!id || !/^\d{4}$/.test(id)) continue; // 只取4碼股票（排除ETF/特殊）
        const close  = parseNum(row[7]);
        const change = parseNum(row[9]) * (row[8]?.includes('-') ? -1 : 1);
        const volume = Math.round(parseNum(row[2]) / 1000); // 張
        if (close <= 0) continue;
        ids.push(id);
        prices[id] = { close, change, volume, name: row[1]?.trim() || id };
      }
      return { ids, prices };
    } catch { return { ids: [], prices: {} }; }
  }

  /* ── 上櫃（TPEX）── */
  async function fetchOTC() {
    try {
      const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return { ids: [], prices: {} };
      const j = await r.json();
      if (!Array.isArray(j) || !j.length) return { ids: [], prices: {} };

      const ids = [], prices = {};
      // 欄位：SecuritiesCompanyCode, CompanyName, Close, Change, Open, High, Low, Volumn...
      for (const row of j) {
        const id = row.SecuritiesCompanyCode?.trim();
        if (!id || !/^\d{4,5}$/.test(id)) continue;
        const close  = parseNum(row.Close);
        const change = parseNum(row.Change);
        const volume = Math.round(parseNum(row.Volumn || row.Volume) / 1000);
        if (close <= 0) continue;
        ids.push(id);
        prices[id] = { close, change, volume, name: row.CompanyName?.trim() || id };
      }
      return { ids, prices };
    } catch { return { ids: [], prices: {} }; }
  }

  try {
    const [listedRes, otcRes] = await Promise.all([fetchListed(), fetchOTC()]);

    const listed  = listedRes.ids;
    const otc     = otcRes.ids;
    const prices  = { ...listedRes.prices, ...otcRes.prices };

    // 合併去重，排除 ETF（代號5碼）和特殊股
    const all = [...new Set([...listed, ...otc])].filter(id => /^\d{4}$/.test(id));

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate'); // 快取30分鐘
    return res.status(200).json({
      listed,
      otc,
      all,
      prices,
      total: all.length,
      listedCount: listed.length,
      otcCount: otc.length,
    });

  } catch (e) {
    return res.status(500).json({ listed: [], otc: [], all: [], prices: {}, error: e.message });
  }
}
