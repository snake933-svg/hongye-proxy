/**
 * api/twse-yield.js — 殖利率 / PE / PB（與 Goodinfo 完全同源）
 *
 * 資料來源：TWSE BWIBBU_d（上市）+ TPEX 本益比（上櫃）
 * 與 Goodinfo 殖利率資料完全一致
 *
 * 呼叫：GET /api/twse-yield
 * 回傳：{
 *   stocks: {
 *     '2330': { yield: 1.8, pe: 22.5, pb: 6.2 }
 *   }
 * }
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ua = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  function pn(s) {
    if (!s || s === '--' || s === '' || s === 'N/A') return 0;
    const v = parseFloat(String(s).replace(/,/g, ''));
    return isNaN(v) ? 0 : v;
  }

  // ── 上市：TWSE BWIBBU_d（殖利率、本益比、股價淨值比）──
  async function fetchTWSEYield() {
    try {
      const url = 'https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?response=json&selectType=ALL';
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return {};
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return {};

      const result = {};
      for (const row of j.data) {
        // 欄位：[代號, 名稱, 殖利率%, 股利年度, 本益比, 股價淨值比, 財報年/季]
        const code = row[0]?.trim();
        if (!code || !/^\d{4}$/.test(code)) continue;
        const yld = pn(row[2]);
        const pe  = pn(row[4]);
        const pb  = pn(row[5]);
        if (yld > 0 || pe > 0 || pb > 0) {
          result[code] = { yield: yld, pe, pb };
        }
      }
      return result;
    } catch (e) {
      console.error('[yield] TWSE BWIBBU_d 失敗:', e.message);
      return {};
    }
  }

  // ── 上櫃：TPEX 本益比資料 ──
  async function fetchTPEXYield() {
    try {
      const url = 'https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&o=json&charset=UTF-8';
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return {};
      const j = await r.json();
      if (!j.aaData?.length) return {};

      const result = {};
      for (const row of j.aaData) {
        // 欄位：[代號, 名稱, 本益比, 殖利率%, 股價淨值比]
        const code = row[0]?.trim();
        if (!code || !/^\d{4,5}$/.test(code)) continue;
        const pe  = pn(row[2]);
        const yld = pn(row[3]);
        const pb  = pn(row[4]);
        if (yld > 0 || pe > 0) {
          result[code] = { yield: yld, pe, pb };
        }
      }
      return result;
    } catch (e) {
      console.error('[yield] TPEX 失敗:', e.message);
      return {};
    }
  }

  try {
    const [twseStocks, tpexStocks] = await Promise.all([
      fetchTWSEYield(),
      fetchTPEXYield(),
    ]);

    const stocks = { ...tpexStocks, ...twseStocks }; // 上市覆蓋上櫃

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json({
      stocks,
      total: Object.keys(stocks).length,
      date: new Date().toISOString().slice(0, 10),
      source: 'TWSE_BWIBBU_d + TPEX',
    });

  } catch (err) {
    console.error('[yield] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
