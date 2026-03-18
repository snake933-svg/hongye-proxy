/**
 * 宏爺飆股選股器 — 基本面資料代理
 * 策略八、九、十所需財務資料
 *
 * 資料來源：
 *   股本（億）      → FinMind TaiwanStockInfo
 *   董監持股%       → TWSE TWTAUU（大股東申報）
 *   連續配息年數    → FinMind TaiwanStockDividend
 *   利息保障倍數    → FinMind TaiwanStockFinancialStatements
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  const FM = 'https://api.finmindtrade.com/api/v4/data';
  const today = new Date().toISOString().slice(0, 10);

  const pf = s => (!s || s === '--') ? 0 : parseFloat(String(s).replace(/,/g, '')) || 0;

  /* 1. 股本（億元）— FinMind TaiwanStockInfo */
  async function fetchCapital() {
    try {
      const r = await fetch(`${FM}?dataset=TaiwanStockInfo&token=`, { headers: ua, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return {};
      const j = await r.json();
      const out = {};
      for (const d of (j.data || [])) {
        const id = d.stock_id?.trim();
        if (!id || !/^\d{4,6}$/.test(id)) continue;
        out[id] = pf(d.capital) / 1e8; // 元 → 億元
      }
      return out;
    } catch { return {}; }
  }

  /* 2. 董監持股%— TWSE TWTAUU（全市場彙總） */
  async function fetchDirectorPct() {
    try {
      const r = await fetch('https://www.twse.com.tw/rwd/zh/company/TWTAUU?response=json', { headers: ua, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return {};
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return {};
      const out = {};
      for (const row of j.data) {
        const id = row[0]?.trim();
        if (!id || !/^\d{4}$/.test(id)) continue;
        out[id] = pf(row[4]); // 董監持股%
      }
      return out;
    } catch { return {}; }
  }

  /* 3. 連續配息年數 — FinMind TaiwanStockDividend */
  async function fetchDividends() {
    try {
      const startDate = `${new Date().getFullYear() - 12}-01-01`;
      const r = await fetch(`${FM}?dataset=TaiwanStockDividend&start_date=${startDate}&token=`, { headers: ua, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return {};
      const j = await r.json();
      const byStock = {};
      for (const d of (j.data || [])) {
        const id = d.stock_id?.trim();
        if (!id) continue;
        if (!byStock[id]) byStock[id] = new Set();
        const yr = (d.date || d.ex_rights_date || '').slice(0, 4);
        const cash = pf(d.CashDividend || d.cash_dividend || 0);
        if (yr && cash > 0) byStock[id].add(yr);
      }
      const out = {};
      const curY = new Date().getFullYear();
      for (const [id, yrs] of Object.entries(byStock)) {
        let streak = 0;
        for (let y = curY; y >= curY - 12; y--) {
          if (yrs.has(String(y))) streak++; else break;
        }
        out[id] = streak;
      }
      return out;
    } catch { return {}; }
  }

  /* 4. 利息保障倍數 — FinMind TaiwanStockFinancialStatements */
  async function fetchInterestCover() {
    try {
      const startDate = `${new Date().getFullYear() - 2}-01-01`;
      const r = await fetch(`${FM}?dataset=TaiwanStockFinancialStatements&start_date=${startDate}&token=`, { headers: ua, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return {};
      const j = await r.json();
      const byStock = {};
      for (const d of (j.data || [])) {
        const id = d.stock_id?.trim();
        const type = d.type?.trim();
        const val = pf(d.value);
        if (!id || !type) continue;
        if (!byStock[id]) byStock[id] = {};
        if (!byStock[id][d.date]) byStock[id][d.date] = {};
        if (['OperatingIncome','營業利益'].includes(type)) byStock[id][d.date].ebit = val;
        if (['InterestExpense','利息費用'].includes(type)) byStock[id][d.date].interest = val;
      }
      const out = {};
      for (const [id, dates] of Object.entries(byStock)) {
        for (const dt of Object.keys(dates).sort().reverse()) {
          const { ebit, interest } = dates[dt];
          if (ebit !== undefined) {
            out[id] = (!interest || interest <= 0) ? 99 : ebit / interest;
            break;
          }
        }
      }
      return out;
    } catch { return {}; }
  }

  /* 並發抓取 */
  try {
    const [capMap, dirMap, divMap, intMap] = await Promise.all([
      fetchCapital(), fetchDirectorPct(), fetchDividends(), fetchInterestCover()
    ]);

    const allIds = new Set([...Object.keys(capMap), ...Object.keys(dirMap), ...Object.keys(divMap), ...Object.keys(intMap)]);
    const stocks = {};
    for (const id of allIds) {
      stocks[id] = {
        capital:         capMap[id] ?? 0,
        directorPct:     dirMap[id] ?? 0,
        consecDividends: divMap[id] ?? 0,
        interestCover:   intMap[id] ?? 0,
      };
    }

    res.setHeader('Cache-Control', 's-maxage=14400, stale-while-revalidate');
    return res.status(200).json({ stocks, total: Object.keys(stocks).length, date: today,
      sources: { capital: Object.keys(capMap).length, director: Object.keys(dirMap).length, dividend: Object.keys(divMap).length, interest: Object.keys(intMap).length }
    });
  } catch (e) {
    return res.status(500).json({ stocks: {}, error: e.message });
  }
}
