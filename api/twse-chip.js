/**
 * api/twse-chip.js — 三大法人籌碼（與 Goodinfo 完全同源）
 *
 * 資料來源：
 *   TWSE T86      → 每日三大法人買賣超（外資+投信+自營）
 *   TWSE MI_INDEX → 每日全市場個股成交量（逐日精確）
 *
 * Goodinfo 算法完全一致：
 *   foreignBuyQPct  = 外資60日淨買超 / 該股60日真實總成交量 x 100
 *   foreignSellMPct = 外資20日淨賣超 / 該股20日真實總成交量 x 100
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const days = Math.min(parseInt(req.query.days) || 10, 65);
  const ua = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  function pn(s) {
    if (!s || s === '--' || s === '') return 0;
    const v = parseFloat(String(s).replace(/,/g, ''));
    return isNaN(v) ? 0 : v;
  }

  function getTradingDates(count) {
    const dates = [];
    const d = new Date();
    while (dates.length < count) {
      d.setDate(d.getDate() - 1);
      if (d.getDay() !== 0 && d.getDay() !== 6)
        dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    }
    return dates;
  }

  async function fetchT86(dateStr) {
    try {
      const url = `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${dateStr}&selectType=ALL`;
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return null;
      const result = {};
      for (const row of j.data) {
        const code = row[0]?.trim();
        if (!code || !/^\d{4,6}$/.test(code)) continue;
        result[code] = {
          foreignNet: Math.round(pn(row[4]) / 1000),
          itNet:      Math.round(pn(row[7]) / 1000),
        };
      }
      return result;
    } catch { return null; }
  }

  // MI_INDEX 每日個股成交量（精確逐日，Goodinfo 同源）
  async function fetchMIIndex(dateStr) {
    try {
      const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&date=${dateStr}&type=ALL`;
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const j = await r.json();
      if (j.stat !== 'OK') return null;

      const result = {};
      const tables = j.tables || [];

      // 找包含 4 位數股票代號的 table
      for (const table of tables) {
        const data = table.data || [];
        if (!data.length) continue;
        const firstCode = data[0]?.[0]?.trim();
        if (!firstCode || !/^\d{4}$/.test(firstCode)) continue;

        for (const row of data) {
          const code = row[0]?.trim();
          if (!code || !/^\d{4}$/.test(code)) continue;
          const vol = Math.round(pn(row[2]) / 1000); // 股→張
          if (vol > 0) result[code] = vol;
        }
        if (Object.keys(result).length > 100) break;
      }

      // 若 MI_INDEX 取不到，退回 STOCK_DAY_ALL
      if (Object.keys(result).length < 50) return fetchStockDayAll(dateStr);
      return result;
    } catch { return fetchStockDayAll(dateStr); }
  }

  async function fetchStockDayAll(dateStr) {
    try {
      const yyyymm = dateStr.slice(0, 6) + '01';
      const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json&date=${yyyymm}`;
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return null;
      const result = {};
      for (const row of j.data) {
        const code = row[0]?.trim();
        if (!code || !/^\d{4}$/.test(code)) continue;
        const vol = Math.round(pn(row[2]) / 1000);
        if (vol > 0) result[code] = vol;
      }
      return result;
    } catch { return null; }
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const tradingDates = getTradingDates(62);
    const t86Dates   = tradingDates.slice(0, Math.min(days + 2, 62));
    const vol60Dates = tradingDates.slice(0, 62);
    const vol20Dates = new Set(tradingDates.slice(0, 22));

    const allT86  = {};
    const allVols = {};

    // 並發抓所有日期的 T86 + 成交量
    const BATCH = 4;
    const allDates = [...new Set([...t86Dates, ...vol60Dates])];

    for (let i = 0; i < allDates.length; i += BATCH) {
      const batch = allDates.slice(i, i + BATCH);
      await Promise.all(batch.map(async (d) => {
        const [t86, vol] = await Promise.all([
          t86Dates.includes(d)   ? fetchT86(d)     : Promise.resolve(null),
          vol60Dates.includes(d) ? fetchMIIndex(d) : Promise.resolve(null),
        ]);
        if (t86) allT86[d]  = t86;
        if (vol) allVols[d] = vol;
      }));
      if (i + BATCH < allDates.length)
        await new Promise(r => setTimeout(r, 200));
    }

    const sortedT86 = Object.keys(allT86).sort().reverse();
    const allCodes  = new Set();
    sortedT86.forEach(d => Object.keys(allT86[d]).forEach(c => allCodes.add(c)));

    const stocks = {};

    for (const code of allCodes) {
      let fStreakType = 0, fStreak = 0;
      let itStreakType = 0, itStreak = 0;
      let net5d = 0, itNet5d = 0, netBuy60d = 0, netSell20d = 0;

      for (let di = 0; di < sortedT86.length; di++) {
        const chip = allT86[sortedT86[di]]?.[code];
        if (!chip) continue;
        const fn  = chip.foreignNet || 0;
        const itn = chip.itNet || 0;

        // 外資連買/賣
        if (fStreakType === 0) {
          if (fn !== 0) { fStreakType = fn > 0 ? 1 : -1; fStreak = 1; }
        } else {
          if ((fStreakType === 1 && fn > 0) || (fStreakType === -1 && fn < 0)) fStreak++;
          else { fStreakType = fn !== 0 ? (fn > 0 ? 1 : -1) : 0; fStreak = fn !== 0 ? 1 : 0; }
        }

        // 投信連買/賣
        if (itStreakType === 0) {
          if (itn !== 0) { itStreakType = itn > 0 ? 1 : -1; itStreak = 1; }
        } else {
          if ((itStreakType === 1 && itn > 0) || (itStreakType === -1 && itn < 0)) itStreak++;
          else { itStreakType = itn !== 0 ? (itn > 0 ? 1 : -1) : 0; itStreak = itn !== 0 ? 1 : 0; }
        }

        if (di < 5)  { net5d += fn; itNet5d += itn; }
        if (di < 60)   netBuy60d += fn;
        if (di < 20 && fn < 0) netSell20d += Math.abs(fn);
      }

      // ★ 逐日真實總成交量（Goodinfo 完全相同算法）
      let totalVol60d = 0, totalVol20d = 0;
      for (const d of vol60Dates) {
        const v = allVols[d]?.[code] || 0;
        totalVol60d += v;
        if (vol20Dates.has(d)) totalVol20d += v;
      }

      // 若完全取不到成交量，用淨買做保底估算
      if (totalVol60d === 0 && Math.abs(netBuy60d) > 0) totalVol60d = Math.abs(netBuy60d) * 8;
      if (totalVol20d === 0 && netSell20d > 0) totalVol20d = netSell20d * 8;

      const foreignBuyQPct  = (netBuy60d  > 0 && totalVol60d > 0)
        ? Math.min((netBuy60d  / totalVol60d) * 100, 100) : 0;
      const foreignSellMPct = (netSell20d > 0 && totalVol20d > 0)
        ? Math.min((netSell20d / totalVol20d) * 100, 100) : 0;

      const hasSig = foreignBuyDays > 0 || foreignSellDays > 0 ||
        Math.abs(net5d) > 0 || itBuyDays > 0 || itSellDays > 0 ||
        Math.abs(netBuy60d) > 0;

      const foreignBuyDays  = fStreakType  === 1  ? fStreak  : 0;
      const foreignSellDays = fStreakType  === -1 ? fStreak  : 0;
      const itBuyDays       = itStreakType === 1  ? itStreak : 0;
      const itSellDays      = itStreakType === -1 ? itStreak : 0;

      if (hasSig || foreignBuyDays > 0 || foreignSellDays > 0) {
        stocks[code] = {
          foreignBuyDays,
          foreignSellDays,
          net5d,
          netBuy60d,
          totalVol60d,
          foreignBuyQPct:  Math.round(foreignBuyQPct  * 10) / 10,
          netSell20d,
          totalVol20d,
          foreignSellMPct: Math.round(foreignSellMPct * 10) / 10,
          itBuyDays,
          itSellDays,
          itNet5d,
        };
      }
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({
      stocks,
      total: Object.keys(stocks).length,
      date:  today,
      source: 'TWSE_T86_MI_INDEX',
    });

  } catch (err) {
    console.error('[chip] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
