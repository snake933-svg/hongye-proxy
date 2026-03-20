/**
 * api/twse-revenue.js — 月營收資料（MOPS 直取，與 Goodinfo 完全同源）
 *
 * 資料來源：公開資訊觀測站 MOPS
 *   上市：https://mops.twse.com.tw/mops/web/ajax_t05st10 (TYPEK=sii)
 *   上櫃：https://mops.twse.com.tw/mops/web/ajax_t05st10 (TYPEK=otc)
 *   上興：https://mops.twse.com.tw/mops/web/ajax_t05st10 (TYPEK=rotc)
 *
 * 一次抓全市場所有公司的當月+前13個月營收
 *
 * 呼叫：GET /api/twse-revenue?months=14
 * 回傳：{
 *   stocks: {
 *     '2330': [
 *       { date:'2025-02', revenue:2576.6, yoy:38.5 }, // 億元, 年增率%
 *       ...最近14個月
 *     ]
 *   },
 *   total: 1600,
 *   date: '2025-03-10'
 * }
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const months = Math.min(parseInt(req.query.months) || 14, 24);

  const ua = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': 'https://mops.twse.com.tw/mops/web/t05st10',
  };

  function pn(s) {
    if (!s || s === '--' || s === '' || s === 'N/A') return 0;
    return parseFloat(String(s).replace(/,/g, '')) || 0;
  }

  // 取得需要抓的年月列表（民國年）
  function getMonthList(count) {
    const list = [];
    const now = new Date();
    // 營收在次月10日公告，往前多取一個月確保有最新資料
    for (let i = 0; i < count; i++) {
      const d = new Date(now);
      d.setMonth(d.getMonth() - i);
      const rocYear = d.getFullYear() - 1911;
      const month = d.getMonth() + 1;
      list.push({ rocYear, month, key: `${d.getFullYear()}-${String(month).padStart(2,'0')}` });
    }
    return list;
  }

  // 解析 MOPS HTML 回傳
  function parseMopsHtml(html) {
    const result = {};
    if (!html || html.length < 100) return result;

    // 找所有 <tr> 裡的資料
    // 格式: <tr><td>代號</td><td>名稱</td><td>當月營收</td><td>上月營收</td><td>去年同月</td>...
    const trMatches = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];

    for (const tr of trMatches) {
      const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
      if (tds.length < 7) continue;

      // 提取純文字
      const vals = tds.map(td => td.replace(/<[^>]+>/g, '').trim());

      const code = vals[0]?.replace(/\s/g, '');
      if (!code || !/^\d{4,6}$/.test(code)) continue;

      const curRevenue  = pn(vals[2]); // 當月營收（千元）
      const prevRevenue = pn(vals[3]); // 上月營收（千元）
      const yoyRevenue  = pn(vals[4]); // 去年同月（千元）
      const momChg      = pn(vals[5]); // 上月比較增減%
      const yoyChg      = pn(vals[6]); // 去年同期比較增減%

      if (curRevenue > 0) {
        result[code] = {
          curRevenue: curRevenue / 1000, // 千元→百萬元
          yoyChg,
          momChg,
        };
      }
    }
    return result;
  }

  // 抓單月全市場營收
  async function fetchMonthRevenue(rocYear, month, typek) {
    const body = new URLSearchParams({
      encodeURIComponent: '1',
      step: '1',
      firstin: '1',
      off: '1',
      isQuery: 'Y',
      TYPEK: typek,
      year: String(rocYear),
      month: String(month),
    });

    try {
      const r = await fetch('https://mops.twse.com.tw/mops/web/ajax_t05st10', {
        method: 'POST',
        headers: ua,
        body: body.toString(),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) return {};
      const html = await r.text();
      return parseMopsHtml(html);
    } catch (e) {
      console.error(`[revenue] MOPS ${typek} ${rocYear}/${month} 失敗:`, e.message);
      return {};
    }
  }

  try {
    const monthList = getMonthList(months);
    const stocksRevenue = {}; // { '2330': [{date, revenue, yoy}] }

    // 並發抓最近 N 個月（上市+上櫃同時）
    // 每次最多並發 4 個月，避免 MOPS 限流
    const CONCURRENT = 3;

    for (let i = 0; i < monthList.length; i += CONCURRENT) {
      const batch = monthList.slice(i, i + CONCURRENT);

      const batchResults = await Promise.all(
        batch.flatMap(({ rocYear, month, key }) => [
          fetchMonthRevenue(rocYear, month, 'sii').then(d => ({ key, data: d, type: 'sii' })),
          fetchMonthRevenue(rocYear, month, 'otc').then(d => ({ key, data: d, type: 'otc' })),
        ])
      );

      for (const { key, data } of batchResults) {
        for (const [code, info] of Object.entries(data)) {
          if (!stocksRevenue[code]) stocksRevenue[code] = [];
          // 避免重複
          if (!stocksRevenue[code].find(r => r.date === key)) {
            stocksRevenue[code].push({
              date: key,
              revenue: Math.round(info.curRevenue * 10) / 10, // 百萬元，1位小數
              yoy: Math.round(info.yoyChg * 10) / 10,         // 年增率%
              mom: Math.round(info.momChg * 10) / 10,         // 月增率%
            });
          }
        }
      }

      // 短暫延遲避免 MOPS 限流
      if (i + CONCURRENT < monthList.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // 對每支股票的月份資料排序（最新在前）
    for (const code of Object.keys(stocksRevenue)) {
      stocksRevenue[code].sort((a, b) => b.date.localeCompare(a.date));
    }

    const total = Object.keys(stocksRevenue).length;
    const today = new Date().toISOString().slice(0, 10);

    // 快取 4 小時
    res.setHeader('Cache-Control', 's-maxage=14400, stale-while-revalidate');

    return res.status(200).json({
      stocks: stocksRevenue,
      total,
      date: today,
      months: monthList.length,
      source: 'MOPS',
    });

  } catch (err) {
    console.error('[revenue] 主流程錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
