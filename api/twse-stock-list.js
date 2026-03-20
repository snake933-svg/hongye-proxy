// api/twse-stock-list.js — 全市場股票清單（上市+上櫃）
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');

  try {
    // 同時抓上市(TWSE) + 上櫃(TPEX)
    const [twseRes, tpexRes] = await Promise.allSettled([
      fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', {
        headers: { 'Accept': 'application/json' }
      }),
      fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes', {
        headers: { 'Accept': 'application/json' }
      })
    ]);

    const stocks = [];

    // 上市股票
    if (twseRes.status === 'fulfilled' && twseRes.value.ok) {
      const twseData = await twseRes.value.json();
      for (const item of twseData) {
        const code = item['公司代號'] || item['Code'] || item['股票代號'];
        const name = item['公司簡稱'] || item['Name'] || item['股票名稱'];
        if (code && name && /^\d{4}$/.test(code.trim())) {
          stocks.push({ code: code.trim(), name: name.trim(), market: 'TWSE' });
        }
      }
    }

    // 上櫃股票
    if (tpexRes.status === 'fulfilled' && tpexRes.value.ok) {
      const tpexData = await tpexRes.value.json();
      for (const item of tpexData) {
        const code = item['SecuritiesCompanyCode'] || item['股票代號'];
        const name = item['CompanyName'] || item['股票名稱'];
        if (code && name && /^\d{4,5}$/.test(code.trim())) {
          stocks.push({ code: code.trim(), name: name.trim(), market: 'TPEX' });
        }
      }
    }

    // 備用：若兩個都失敗，用靜態清單（前100大市值）
    if (stocks.length === 0) {
      const fallback = [
        {code:'2330',name:'台積電',market:'TWSE'},{code:'2317',name:'鴻海',market:'TWSE'},
        {code:'2454',name:'聯發科',market:'TWSE'},{code:'2303',name:'聯電',market:'TWSE'},
        {code:'2308',name:'台達電',market:'TWSE'},{code:'2881',name:'富邦金',market:'TWSE'},
        {code:'2882',name:'國泰金',market:'TWSE'},{code:'2886',name:'兆豐金',market:'TWSE'},
        {code:'2891',name:'中信金',market:'TWSE'},{code:'2884',name:'玉山金',market:'TWSE'},
        {code:'1301',name:'台塑',market:'TWSE'},{code:'1303',name:'南亞',market:'TWSE'},
        {code:'1326',name:'台化',market:'TWSE'},{code:'2002',name:'中鋼',market:'TWSE'},
        {code:'2412',name:'中華電',market:'TWSE'},{code:'3711',name:'日月光投控',market:'TWSE'},
        {code:'2357',name:'華碩',market:'TWSE'},{code:'2382',name:'廣達',market:'TWSE'},
        {code:'2395',name:'研華',market:'TWSE'},{code:'2379',name:'瑞昱',market:'TWSE'},
        {code:'3034',name:'聯詠',market:'TWSE'},{code:'2327',name:'國巨',market:'TWSE'},
        {code:'2408',name:'南亞科',market:'TWSE'},{code:'2345',name:'智邦',market:'TWSE'},
        {code:'4938',name:'和碩',market:'TWSE'},{code:'2207',name:'和泰車',market:'TWSE'},
        {code:'1216',name:'統一',market:'TWSE'},{code:'2105',name:'正新',market:'TWSE'},
        {code:'2887',name:'台新金',market:'TWSE'},{code:'2890',name:'永豐金',market:'TWSE'},
        {code:'5880',name:'合庫金',market:'TWSE'},{code:'2883',name:'開發金',market:'TWSE'},
        {code:'2885',name:'元大金',market:'TWSE'},{code:'2892',name:'第一金',market:'TWSE'},
        {code:'2880',name:'華南金',market:'TWSE'},{code:'2888',name:'新光金',market:'TWSE'},
        {code:'1402',name:'遠東新',market:'TWSE'},{code:'1101',name:'台泥',market:'TWSE'},
        {code:'1102',name:'亞泥',market:'TWSE'},{code:'2353',name:'宏碁',market:'TWSE'},
        {code:'2356',name:'英業達',market:'TWSE'},{code:'2360',name:'致茂',market:'TWSE'},
        {code:'2376',name:'技嘉',market:'TWSE'},{code:'2388',name:'威盛',market:'TWSE'},
        {code:'2474',name:'可成',market:'TWSE'},{code:'3008',name:'大立光',market:'TWSE'},
        {code:'3045',name:'台灣大',market:'TWSE'},{code:'4904',name:'遠傳',market:'TWSE'},
        {code:'9904',name:'寶成',market:'TWSE'},{code:'9910',name:'豐泰',market:'TWSE'},
      ];
      return res.status(200).json({ stocks: fallback, total: fallback.length, source: 'fallback' });
    }

    // 過濾掉ETF、特別股等（代號不是純4位數字的）
    const filtered = stocks.filter(s => /^\d{4}$/.test(s.code));

    return res.status(200).json({
      stocks: filtered,
      total: filtered.length,
      source: 'live',
      twse: stocks.filter(s => s.market === 'TWSE').length,
      tpex: stocks.filter(s => s.market === 'TPEX').length,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
