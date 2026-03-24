/**
 * api/quote.js — 全市場即時收盤報價（TWSE + TPEX）
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const ua = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
  function pn(s) { const v = parseFloat(String(s||'').replace(/,/g,'')); return isNaN(v)?0:v; }

  try {
    const [twse, tpex] = await Promise.all([
      fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { headers: ua, signal: AbortSignal.timeout(20000) }),
      fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes', { headers: ua, signal: AbortSignal.timeout(20000) }),
    ]);

    const stocks = {};
    if (twse.ok) {
      const data = await twse.json();
      for (const item of (Array.isArray(data) ? data : [])) {
        const code = (item.Code || item['股票代號'])?.trim();
        if (!code || !/^\d{4}$/.test(code)) continue;
        const close  = pn(item.ClosingPrice  || item['收盤價']);
        const change = pn(item.Change        || item['漲跌價差']);
        const vol    = Math.round(pn(item.TradeVolume || item['成交股數']) / 1000);
        const name   = (item.Name || item['股票名稱'])?.trim() || code;
        if (close <= 0) continue;
        const prev = close - change;
        stocks[code] = {
          close, change: Math.round(change*100)/100,
          changePct: prev > 0 ? Math.round(change/prev*10000)/100 : 0,
          volume: vol, name, market: 'TWSE',
        };
      }
    }
    if (tpex.ok) {
      const data = await tpex.json();
      for (const item of (Array.isArray(data) ? data : [])) {
        const code = (item.SecuritiesCompanyCode || item['股票代號'])?.trim();
        if (!code || !/^\d{4,5}$/.test(code) || stocks[code]) continue;
        const close  = pn(item.Close || item['收盤價']);
        const change = pn(item.Change || item['漲跌']);
        const vol    = Math.round(pn(item.TradingShares || 0) / 1000);
        const name   = (item.CompanyName || item['股票名稱'])?.trim() || code;
        if (close <= 0) continue;
        const prev = close - change;
        stocks[code] = {
          close, change: Math.round(change*100)/100,
          changePct: prev > 0 ? Math.round(change/prev*10000)/100 : 0,
          volume: vol, name, market: 'TPEX',
        };
      }
    }

    if (Object.keys(stocks).length < 100)
      return res.status(503).json({ error: 'TWSE/TPEX 暫時無法取得', total: Object.keys(stocks).length });

    const h = (new Date().getUTCHours() + 8) % 24;
    res.setHeader('Cache-Control', `s-maxage=${h>=16||h<8?900:60}, stale-while-revalidate`);
    return res.status(200).json({ stocks, total: Object.keys(stocks).length, time: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
