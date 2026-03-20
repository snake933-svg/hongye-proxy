// api/twse-fundamental.js — 股本、董監持股、連續配息（TWSE + FinMind）
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');

  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code required' });

  const FINMIND_TOKEN = process.env.FINMIND_TOKEN || '';
  const baseUrl = 'https://api.finmindtrade.com/api/v4/data';

  try {
    const today = new Date();
    const fiveYearsAgo = new Date(today);
    fiveYearsAgo.setFullYear(today.getFullYear() - 5);
    const startDate = fiveYearsAgo.toISOString().slice(0, 10);
    const endDate = today.toISOString().slice(0, 10);

    const headers = { 'Content-Type': 'application/json' };

    // 1. 股本 — TWSE 公開資訊觀測站
    let capital = null;
    try {
      const capRes = await fetch(
        `https://mops.twse.com.tw/mops/web/ajax_t05st03?encodeURIComponent=1&step=1&firstin=1&off=1&keyword4=&code1=&TYPEK=sii&type1=&type2=&company_id=${code}&B_ROC_ID=`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      // TWSE MOPS 有時不穩，備用 FinMind
    } catch (e) {}

    // 改用 FinMind 股本
    const capParams = new URLSearchParams({
      dataset: 'TaiwanStockInfo',
      data_id: code,
      token: FINMIND_TOKEN,
    });
    const capRes2 = await fetch(`${baseUrl}?${capParams}`, { headers });
    if (capRes2.ok) {
      const capData = await capRes2.json();
      if (capData.data && capData.data.length > 0) {
        const info = capData.data[0];
        capital = parseFloat(info.capital || info.total_shares || 0) / 1e8; // 轉成億
      }
    }

    // 2. 董監持股 — FinMind
    let directorShare = null;
    try {
      const dirParams = new URLSearchParams({
        dataset: 'TaiwanStockDirectorShareholding',
        data_id: code,
        start_date: startDate,
        end_date: endDate,
        token: FINMIND_TOKEN,
      });
      const dirRes = await fetch(`${baseUrl}?${dirParams}`, { headers });
      if (dirRes.ok) {
        const dirData = await dirRes.json();
        if (dirData.data && dirData.data.length > 0) {
          // 取最新一筆
          const latest = dirData.data[dirData.data.length - 1];
          directorShare = parseFloat(latest.director_shareholding_ratio || latest.ratio || 0);
        }
      }
    } catch (e) {}

    // 3. 連續配息 — FinMind TaiwanStockDividend
    let consecutiveDividends = 0;
    let dividendYears = [];
    try {
      const divParams = new URLSearchParams({
        dataset: 'TaiwanStockDividend',
        data_id: code,
        start_date: `${today.getFullYear() - 10}-01-01`,
        end_date: endDate,
        token: FINMIND_TOKEN,
      });
      const divRes = await fetch(`${baseUrl}?${divParams}`, { headers });
      if (divRes.ok) {
        const divData = await divRes.json();
        if (divData.data && divData.data.length > 0) {
          // 統計每年是否有配息
          const yearMap = {};
          for (const d of divData.data) {
            const year = d.date ? d.date.slice(0, 4) : d.year;
            const cash = parseFloat(d.cash_earnings_distribution || d.CashEarningsDistribution || 0);
            const stock = parseFloat(d.stock_earnings_distribution || d.StockEarningsDistribution || 0);
            if (cash + stock > 0) {
              yearMap[year] = true;
            }
          }
          dividendYears = Object.keys(yearMap).sort().reverse();
          // 計算連續配息年數（從今年往回數）
          const currentYear = today.getFullYear();
          for (let y = currentYear; y >= currentYear - 10; y--) {
            if (yearMap[String(y)] || yearMap[String(y - 1)]) { // 考慮財報時間差
              consecutiveDividends++;
            } else {
              break;
            }
          }
        }
      }
    } catch (e) {}

    // 4. 利息保障倍數 — FinMind 財務指標
    let interestCoverage = null;
    try {
      const finParams = new URLSearchParams({
        dataset: 'TaiwanStockFinancialStatements',
        data_id: code,
        start_date: `${today.getFullYear() - 2}-01-01`,
        end_date: endDate,
        token: FINMIND_TOKEN,
      });
      const finRes = await fetch(`${baseUrl}?${finParams}`, { headers });
      if (finRes.ok) {
        const finData = await finRes.json();
        if (finData.data && finData.data.length > 0) {
          // 找利息保障倍數
          const icItem = finData.data.filter(d =>
            d.type === 'InterestCoverageRatio' || d.type === '利息保障倍數'
          );
          if (icItem.length > 0) {
            interestCoverage = parseFloat(icItem[icItem.length - 1].value);
          }
        }
      }
    } catch (e) {}

    return res.status(200).json({
      code,
      capital,           // 億元
      directorShare,     // %
      consecutiveDividends, // 年數
      dividendYears,
      interestCoverage,  // 倍
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, code });
  }
}
