// ============================================================
// THEHATON ENGINE — motor único y compartido de Fortress Terminal
// Usado por: la web (Analizar, Watchlist, Comparar, Modo Cazador, panel
// TheHaton) Y el bot de Telegram/GitHub Actions. Es el MISMO archivo en
// los dos lugares: no hay dos cerebros ni dos lógicas distintas.
//
// Memoria compartida: el parámetro `sharedMemory` que recibe computeScore()
// viene siempre del mismo state.json (el que actualiza el bot y que la web
// lee vía GitHub raw). Es una única memoria para toda la plataforma.
//
// Funciona tanto importado con `import` (Node, bot) como con
// <script type="module"> (navegador) — es el mismo estándar ES Modules
// en los dos lados, sin duplicar código.
// ============================================================

const BINANCE = 'https://api.binance.com';
const FUTURES = 'https://fapi.binance.com';
const GECKO = 'https://api.geckoterminal.com/api/v2';

// MEXC futuros usa nombres de intervalo propios, distintos al spot
const MEXC_FUT_TF = { '15m':'Min15', '1h':'Min60', '4h':'Hour4', '1d':'Day1', '1mo':'Month1' };

const TF_MAP = {
  '15m': {binance:'15m', okx:'15m', bybit:'15', mexc:'15m', gate:'15m', kucoin:'15min', kucoinSec:900,  gecko:{timeframe:'minute', aggregate:15}},
  '1h':  {binance:'1h',  okx:'1H',  bybit:'60', mexc:'60m', gate:'1h',  kucoin:'1hour', kucoinSec:3600, gecko:{timeframe:'hour',   aggregate:1}},
  '4h':  {binance:'4h',  okx:'4H',  bybit:'240', mexc:'4h', gate:'4h',  kucoin:'4hour', kucoinSec:14400, gecko:{timeframe:'hour',   aggregate:4}},
  '1d':  {binance:'1d',  okx:'1D',  bybit:'D',  mexc:'1d', gate:'1d',  kucoin:'1day',  kucoinSec:86400, gecko:{timeframe:'day',    aggregate:1}},
  '1mo': {binance:'1M',  okx:'1M',  bybit:'M',  mexc:'1M', gate:'30d', kucoin:'1month', kucoinSec:2592000, gecko:{timeframe:'day',    aggregate:30}},
};

const CORS_PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  url => `https://proxy.corsfix.com/?${url}`, // formato correcto: subdominio "proxy.", antes lo tenía mal (por eso daba 404 siempre)
  url => `https://api.cors.lol/url=${url}`,
];

async function fetchJSON(url){
  try{
    const r = await fetch(url);
    if(!r.ok) throw new Error('HTTP '+r.status); // error de la API misma: reintentar por proxy no sirve
    return await r.json();
  }catch(e){
    const isNetworkFailure = e instanceof TypeError || /failed to fetch/i.test(e.message||'');
    if(!isNetworkFailure) throw e;
    // Prueba varios proxies gratuitos en cadena (uno solo no es confiable: se cae o tarda seguido)
    for(const buildProxyUrl of CORS_PROXIES){
      try{
        const r2 = await fetch(buildProxyUrl(url));
        if(!r2.ok) continue;
        return await r2.json();
      }catch(e2){ /* probamos el siguiente proxy */ }
    }
    throw e; // ningún proxy funcionó: devolvemos el error original
  }
}

async function tryBinance(symbolRaw, tf, variante){
  const sym = variante?.sym ?? normalizarSimbolo(symbolRaw);
  const quote = variante?.quote ?? 'USDT';
  const pair = sym.endsWith(quote) ? sym : sym + quote;
  const interval = TF_MAP[tf].binance;
  const klines = await fetchJSON(`${BINANCE}/api/v3/klines?symbol=${pair}&interval=${interval}&limit=220`);
  const ticker = await fetchJSON(`${BINANCE}/api/v3/ticker/24hr?symbol=${pair}`);
  let funding = null;
  try{
    const prem = await fetchJSON(`${FUTURES}/fapi/v1/premiumIndex?symbol=${pair}`);
    funding = parseFloat(prem.lastFundingRate);
  }catch(e){}
  // El campo 9 es el volumen de quien COMPRÓ agrediendo el libro (taker buy). Restándolo del
  // volumen total sale el volumen vendedor agresivo. Es flujo de órdenes real, viene gratis en
  // cada vela y hasta ahora se estaba descartando.
  const candles = klines.map(k=>({
    t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5],
    vc: +k[9] || 0,                        // volumen comprador agresivo
    vv: Math.max(0, (+k[5]||0) - (+k[9]||0)), // volumen vendedor agresivo
    ops: +k[8] || 0,                       // cantidad de operaciones
  }));
  return {
    source:'Binance', symbol: pair, displayName: sym.replace('USDT',''),
    price: parseFloat(ticker.lastPrice), change24h: parseFloat(ticker.priceChangePercent),
    vol24h: parseFloat(ticker.quoteVolume), candles, funding, oi:null, dexUrl:null, contract:null,
  };
}

// ---------- Market Context Matrix: OI + Precio + Funding, combinados (no aislados) ----------
// Solo disponible para símbolos de Binance: es la única fuente gratis con historial de Open Interest.
const OI_PERIOD_MAP = { '15m':'15m', '1h':'1h', '4h':'4h', '1d':'1d', '1mo':'1d' }; // Binance no tiene período nativo mensual para Open Interest — se usa 1d, el más grande disponible

function classifyTrend(values, tolPct=2){
  if(!values || values.length<2) return null;
  const first = values[0], last = values.at(-1);
  if(first===0) return 'STABLE';
  const pctChange = ((last-first)/Math.abs(first))*100;
  if(pctChange > tolPct) return 'RISING';
  if(pctChange < -tolPct) return 'FALLING';
  return 'STABLE';
}

async function fetchOpenInterestTrend(symbolRaw, tf){
  const sym = normalizarSimbolo(symbolRaw);
  const pair = sym.endsWith('USDT') ? sym : sym + 'USDT';
  const period = OI_PERIOD_MAP[tf] || '4h';
  try{
    const rows = await fetchJSON(`${FUTURES}/futures/data/openInterestHist?symbol=${pair}&period=${period}&limit=8`);
    if(!Array.isArray(rows) || rows.length<2) return null;
    const values = rows.map(r=>parseFloat(r.sumOpenInterest));
    return { trend: classifyTrend(values, 3), values, fuente:'Binance' };
  }catch(e){
    // Si Binance no la lista, se prueba MEXC futuros
    return await fetchOpenInterestMEXC(symbolRaw);
  } // el símbolo puede no tener mercado de futuros -> sin dato, no rompe nada
}

// ═══ FUNDING DESDE MEXC (respaldo cuando la moneda no está en Binance) ═══
// Muchas monedas chicas solo cotizan en MEXC futuros. Antes, para esas, el funding y el interés
// abierto simplemente no existían y el Dios Derivados quedaba sin datos.
async function fetchFundingMEXC(symbolRaw){
  const sym = normalizarSimbolo(symbolRaw);
  const pair = `${sym}_USDT`;
  try{
    // MEXC devuelve el histórico de funding paginado, de más reciente a más antiguo
    const res = await fetchJSON(`https://contract.mexc.com/api/v1/contract/funding_rate/history?symbol=${pair}&page_num=1&page_size=6`);
    const lista = res?.data?.resultList;
    if(!Array.isArray(lista) || lista.length < 2) return null;
    const values = lista.map(r=>parseFloat(r.fundingRate)).filter(Number.isFinite).reverse();
    if(values.length < 2) return null;
    const actual = values.at(-1);
    const previo = values.slice(0,-1).reduce((a,b)=>a+b,0)/(values.length-1);
    return {
      current: actual,
      trend: actual > previo*1.15 ? 'RISING' : actual < previo*0.85 ? 'FALLING' : 'STABLE',
      values,
      fuente: 'MEXC',
    };
  }catch(e){ return null; }
}

// Interés abierto desde MEXC, mismo motivo que el funding
async function fetchOpenInterestMEXC(symbolRaw){
  const sym = normalizarSimbolo(symbolRaw);
  const pair = `${sym}_USDT`;
  try{
    const res = await fetchJSON(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${pair}`);
    const oi = res?.data?.holdVol;
    return oi != null ? { value: parseFloat(oi), fuente: 'MEXC' } : null;
  }catch(e){ return null; }
}

async function fetchFundingTrend(symbolRaw){
  const sym = normalizarSimbolo(symbolRaw);
  const pair = sym.endsWith('USDT') ? sym : sym + 'USDT';
  try{
    const rows = await fetchJSON(`${FUTURES}/fapi/v1/fundingRate?symbol=${pair}&limit=6`);
    if(!Array.isArray(rows) || rows.length<2) return null;
    const values = rows.map(r=>parseFloat(r.fundingRate));
    return { trend: classifyTrend(values, 15), values, fuente:'Binance' }; // funding se mueve en % muy chicos, tolerancia relativa más amplia
  }catch(e){
    // Si Binance no lista la moneda, se prueba MEXC futuros: ahí están casi todas las chicas.
    return await fetchFundingMEXC(symbolRaw);
  }
}

// Ratio Long/Short de los "top traders" (posiciones grandes) — dato real de Binance Futures, gratis, sin key.
async function fetchTopTraderRatio(symbolRaw, period='1h'){
  const sym = normalizarSimbolo(symbolRaw);
  const pair = sym.endsWith('USDT') ? sym : sym + 'USDT';
  try{
    const rows = await fetchJSON(`${FUTURES}/futures/data/topLongShortPositionRatio?symbol=${pair}&period=${period}&limit=1`);
    if(!Array.isArray(rows) || !rows.length) return null;
    const r = rows[0];
    return { ratio: parseFloat(r.longShortRatio), longPct: parseFloat(r.longAccount)*100, shortPct: parseFloat(r.shortAccount)*100 };
  }catch(e){ return null; }
}

// Ratio Open Interest / Market Cap: un OI muy alto respecto al tamaño real de la moneda es señal
// de apalancamiento excesivo (más riesgo de liquidaciones en cadena). Es "best effort": si no se
// puede mapear el símbolo a un ID de CoinGecko, devuelve null sin romper el resto del análisis.
async function fetchOIToMarketCapRatio(symbolRaw, currentPrice){
  const sym = normalizarSimbolo(symbolRaw);
  const pair = sym.endsWith('USDT') ? sym : sym + 'USDT';
  try{
    const oiRes = await fetchJSON(`${FUTURES}/fapi/v1/openInterest?symbol=${pair}`);
    const oiUsd = parseFloat(oiRes.openInterest) * currentPrice;
    const searchRes = await fetchJSON(`https://api.coingecko.com/api/v3/search?query=${sym}`);
    const match = (searchRes.coins||[])[0];
    if(!match) return null;
    const mcRes = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${match.id}&vs_currencies=usd&include_market_cap=true`);
    const marketCap = mcRes?.[match.id]?.usd_market_cap;
    if(!marketCap) return null;
    return { oiUsd, marketCap, ratio: oiUsd/marketCap };
  }catch(e){ return null; } // sin dato disponible, no rompe nada — el resto del análisis sigue igual
}

// Flujo spot vs futuros: si el volumen de futuros crece fuerte mientras el spot queda plano, el
// movimiento viene de apalancamiento (posiciones), no de demanda/oferta real — información valiosa
// que un solo "volumen total" no distingue.
async function fetchSpotFuturesFlow(symbolRaw, tf='15m'){
  const sym = normalizarSimbolo(symbolRaw);
  const pair = sym.endsWith('USDT') ? sym : sym + 'USDT';
  try{
    const [spotRows, futRows] = await Promise.all([
      fetchJSON(`${BINANCE}/api/v3/klines?symbol=${pair}&interval=${tf}&limit=10`),
      fetchJSON(`${FUTURES}/fapi/v1/klines?symbol=${pair}&interval=${tf}&limit=10`),
    ]);
    if(!Array.isArray(spotRows) || !Array.isArray(futRows) || spotRows.length<4 || futRows.length<4) return null;
    const half = Math.floor(spotRows.length/2);
    const spotChangePct = (spotRows.slice(half).reduce((s,r)=>s+ +r[5],0) / (spotRows.slice(0,half).reduce((s,r)=>s+ +r[5],0)||1) - 1) * 100;
    const futChangePct = (futRows.slice(half).reduce((s,r)=>s+ +r[5],0) / (futRows.slice(0,half).reduce((s,r)=>s+ +r[5],0)||1) - 1) * 100;
    const leverageDriven = futChangePct > 30 && futChangePct > spotChangePct*2; // futuros creciendo mucho más que el spot
    return { spotChangePct, futChangePct, leverageDriven };
  }catch(e){ return null; }
}

// Las 27 combinaciones (OI x Precio x Funding), fieles a la matriz que compartiste.
// signal: -1..1 (dirección y fuerza). flag: true = "algo grande puede venir" (alta incertidumbre, no es ni claramente alcista ni bajista).
const MARKET_CONTEXT_TABLE = {
  'RISING_RISING_RISING':   {outlook:'PUMP', note:'Todos compran y piden prestado para comprar. Riesgo de squeeze en etapa tardía.', signal:0.3, flag:false},
  'RISING_RISING_STABLE':   {outlook:'PUMP', note:'Compradores tranquilos y sostenidos. LONG sano.', signal:0.7, flag:false},
  'RISING_RISING_FALLING':  {outlook:'SOMETHING BIG COMING', note:'Sube el precio y el OI, pero el funding cae: se está armando una pelea (divergencia).', signal:0, flag:true},
  'FALLING_RISING_RISING':  {outlook:'PUMP', note:'Precio caro y fondeado por deuda: frágil.', signal:0.2, flag:false},
  'FALLING_RISING_STABLE':  {outlook:'STABLE', note:'Rebote débil, riesgo de que se apague.', signal:-0.1, flag:false},
  'FALLING_RISING_FALLING': {outlook:'STABLE', note:'El rally está perdiendo fuerza.', signal:-0.1, flag:false},
  'STABLE_RISING_RISING':   {outlook:'PUMP', note:'Subida suave, poca convicción.', signal:0.2, flag:false},
  'STABLE_RISING_STABLE':   {outlook:'STABLE', note:'Mercado fino, propenso a revertir.', signal:-0.1, flag:false},
  'STABLE_RISING_FALLING':  {outlook:'SOMETHING BIG COMING', note:'Divergencia: sube el precio pero el funding cae.', signal:0, flag:true},
  'RISING_FALLING_RISING':  {outlook:'SOMETHING BIG COMING', note:'Shorts amontonados con funding subiendo: riesgo de short squeeze.', signal:0.2, flag:true},
  'RISING_FALLING_STABLE':  {outlook:'DUMP', note:'Tendencia bajista sana.', signal:-0.7, flag:false},
  'RISING_FALLING_FALLING': {outlook:'SOMETHING BIG COMING', note:'Se está armando una pelea entre compradores y vendedores.', signal:0, flag:true},
  'FALLING_FALLING_RISING': {outlook:'SOMETHING BIG COMING', note:'Señal mixta: OI cae pero funding sube.', signal:0, flag:true},
  'FALLING_FALLING_STABLE': {outlook:'DUMP', note:'La bajada está perdiendo fuerza.', signal:-0.4, flag:false},
  'FALLING_FALLING_FALLING':{outlook:'SOMETHING BIG COMING', note:'Cobertura de shorts dentro de la debilidad (posible rebote temporal).', signal:-0.1, flag:true},
  'STABLE_FALLING_RISING':  {outlook:'SOMETHING BIG COMING', note:'Longs tercos con riesgo de ser barridos.', signal:-0.2, flag:true},
  'STABLE_FALLING_STABLE':  {outlook:'DUMP', note:'Bajada débil, poca convicción.', signal:-0.2, flag:false},
  'STABLE_FALLING_FALLING': {outlook:'DUMP', note:'Control silencioso de los vendedores.', signal:-0.5, flag:false},
  'RISING_STABLE_RISING':   {outlook:'SOMETHING BIG COMING', note:'Posible armado de squeeze al alza.', signal:0.2, flag:true},
  'RISING_STABLE_STABLE':   {outlook:'SOMETHING BIG COMING', note:'Dirección poco clara todavía.', signal:0, flag:true},
  'RISING_STABLE_FALLING':  {outlook:'SOMETHING BIG COMING', note:'Posible armado de squeeze a la baja.', signal:-0.2, flag:true},
  'FALLING_STABLE_RISING':  {outlook:'SOMETHING BIG COMING', note:'Frágil, riesgo de desarme.', signal:-0.1, flag:true},
  'FALLING_STABLE_STABLE':  {outlook:'STABLE', note:'Desarme silencioso.', signal:-0.1, flag:false},
  'FALLING_STABLE_FALLING': {outlook:'SOMETHING BIG COMING', note:'Indecisión del mercado.', signal:0, flag:true},
  'STABLE_STABLE_RISING':   {outlook:'SOMETHING BIG COMING', note:'Mercado enroscándose con sesgo alcista.', signal:0.15, flag:true},
  'STABLE_STABLE_STABLE':   {outlook:'STABLE', note:'Verdadero equilibrio, sin sesgo.', signal:0, flag:false},
  'STABLE_STABLE_FALLING':  {outlook:'SOMETHING BIG COMING', note:'Mercado enroscándose con sesgo bajista.', signal:-0.15, flag:true},
};

function marketContextMatrix(oiTrend, priceTrend, fundingTrend){
  if(!oiTrend || !priceTrend || !fundingTrend) return null;
  const key = `${oiTrend}_${priceTrend}_${fundingTrend}`;
  const row = MARKET_CONTEXT_TABLE[key];
  if(!row) return null;
  return { ...row, oiTrend, priceTrend, fundingTrend };
}

async function tryGecko(query, tf){
  const search = await fetchJSON(`${GECKO}/search/pools?query=${encodeURIComponent(query)}&page=1`);
  const pools = search?.data;
  if(!pools || !pools.length) throw new Error('No se encontró en GeckoTerminal');
  // descarta pools sin la estructura esperada (a veces GeckoTerminal devuelve resultados incompletos bajo rate-limit)
  const validPools = pools.filter(p => p?.relationships?.network?.data?.id && p?.attributes?.address);
  if(!validPools.length) throw new Error('GeckoTerminal devolvió resultados sin datos completos (posible rate limit)');
  validPools.sort((a,b)=> (parseFloat(b.attributes.reserve_in_usd)||0) - (parseFloat(a.attributes.reserve_in_usd)||0));
  const pool = validPools[0];
  const network = pool.relationships.network.data.id;
  const poolAddr = pool.attributes.address;
  const g = TF_MAP[tf].gecko;
  const ohlcv = await fetchJSON(`${GECKO}/networks/${network}/pools/${poolAddr}/ohlcv/${g.timeframe}?aggregate=${g.aggregate}&limit=220`);
  const list = ohlcv?.data?.attributes?.ohlcv_list;
  if(!list || !list.length) throw new Error('GeckoTerminal no devolvió velas para esta pool');
  const candles = list.reverse().map(r=>({t:r[0]*1000,o:r[1],h:r[2],l:r[3],c:r[4],v:r[5]}));
  const attrs = pool.attributes;
  const baseTokenName = attrs.name.split('/')[0].trim();
  return {
    source:'GeckoTerminal', symbol: attrs.name, displayName: baseTokenName,
    price: parseFloat(attrs.base_token_price_usd || candles.at(-1).c),
    change24h: parseFloat(attrs.price_change_percentage?.h24 || 0),
    vol24h: parseFloat(attrs.volume_usd?.h24 || 0), candles, funding:null, oi:null,
    dexUrl: `https://www.geckoterminal.com/${network}/pools/${poolAddr}`,
    contract: pool.relationships.base_token?.data?.id?.split('_').pop() || null,
    network,  // hace falta para consultar la actividad on-chain de ese token
  };
}

async function tryOKX(symbolRaw, tf, variante){
  const sym = variante?.sym ?? normalizarSimbolo(symbolRaw);
  const quote = variante?.quote ?? 'USDT';
  const instId = `${sym}-${quote}`;
  const bar = TF_MAP[tf].okx;
  const res = await fetchJSON(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=220`);
  if(!res.data || !res.data.length) throw new Error('OKX sin datos');
  const candles = res.data.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]})).sort((a,b)=>a.t-b.t);
  const tick = await fetchJSON(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`);
  const t = tick.data?.[0];
  return {
    source:'OKX', symbol: instId, displayName: sym,
    price: parseFloat(t?.last || candles.at(-1).c),
    change24h: t ? ((parseFloat(t.last)-parseFloat(t.open24h))/parseFloat(t.open24h))*100 : 0,
    vol24h: parseFloat(t?.volCcy24h || 0), candles, funding:null, oi:null, dexUrl:null, contract:null,
  };
}
async function tryBybit(symbolRaw, tf, variante){
  const sym = variante?.sym ?? normalizarSimbolo(symbolRaw);
  const quote = variante?.quote ?? 'USDT';
  const pair = `${sym}${quote}`;
  const interval = TF_MAP[tf].bybit;
  const res = await fetchJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair}&interval=${interval}&limit=200`);
  const list = res.result?.list;
  if(!list || !list.length) throw new Error('Bybit sin datos');
  const candles = list.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]})).sort((a,b)=>a.t-b.t);
  const tick = await fetchJSON(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair}`);
  const t = tick.result?.list?.[0];
  return {
    source:'Bybit', symbol: pair, displayName: sym,
    price: parseFloat(t?.lastPrice || candles.at(-1).c),
    change24h: t ? parseFloat(t.price24hPcnt)*100 : 0,
    vol24h: parseFloat(t?.turnover24h || 0), candles, funding:null, oi:null, dexUrl:null, contract:null,
  };
}
async function tryMEXC(symbolRaw, tf, variante){
  const sym = variante?.sym ?? normalizarSimbolo(symbolRaw);
  const quote = variante?.quote ?? 'USDT';
  const pair = `${sym}${quote}`;
  const interval = TF_MAP[tf].mexc;
  const klines = await fetchJSON(`https://api.mexc.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=220`);
  if(!Array.isArray(klines) || !klines.length) throw new Error('MEXC sin datos');
  const candles = klines.map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})).sort((a,b)=>a.t-b.t);
  const ticker = await fetchJSON(`https://api.mexc.com/api/v3/ticker/24hr?symbol=${pair}`);
  return {
    source:'MEXC', symbol: pair, displayName: sym,
    price: parseFloat(ticker.lastPrice || candles.at(-1).c),
    change24h: parseFloat(ticker.priceChangePercent||0),
    vol24h: parseFloat(ticker.quoteVolume||0), candles, funding:null, oi:null, dexUrl:null, contract:null,
  };
}
// ═══ MEXC FUTUROS ═══
// El spot de MEXC (api.mexc.com) NO tiene muchas de las monedas chicas: están solo en el mercado
// de futuros perpetuos (contract.mexc.com), que es donde se opera de verdad.
// Por eso una moneda que existe en MEXC podía no encontrarse: se buscaba en el mercado equivocado.
// Además esta fuente trae el FUNDING, que Binance no puede dar para monedas que no lista.
async function tryMEXCFutures(symbolRaw, tf, variante){
  const sym = variante?.sym ?? normalizarSimbolo(symbolRaw);
  const quote = variante?.quote ?? 'USDT';
  const pair = `${sym}_${quote}`;               // los futuros usan guion bajo: BTC_USDT
  const interval = MEXC_FUT_TF[tf] || 'Hour4';
  const ahora = Math.floor(Date.now()/1000);
  const segundos = { '15m':900, '1h':3600, '4h':14400, '1d':86400, '1mo':2592000 }[tf] || 14400;
  const desde = ahora - segundos*220;

  const res = await fetchJSON(`https://contract.mexc.com/api/v1/contract/kline/${pair}?interval=${interval}&start=${desde}&end=${ahora}`);
  const d = res?.data;
  // La respuesta viene en columnas paralelas (time[], open[], high[]...), no en filas
  if(!d || !Array.isArray(d.time) || d.time.length < 20) throw new Error('MEXC futuros sin datos');
  const candles = d.time.map((t,i)=>({
    t: t*1000, o:+d.open[i], h:+d.high[i], l:+d.low[i], c:+d.close[i], v:+(d.vol?.[i] ?? 0),
  })).filter(v=>Number.isFinite(v.c)).sort((a,b)=>a.t-b.t);
  if(candles.length < 20) throw new Error('MEXC futuros con muy pocas velas');

  // Datos del contrato: precio actual, variación y funding
  let price = candles.at(-1).c, change24h = 0, funding = null, oi = null;
  try{
    const tk = await fetchJSON(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${pair}`);
    const t = tk?.data;
    if(t){
      price = parseFloat(t.lastPrice ?? price);
      change24h = parseFloat(t.riseFallRate ?? 0) * 100;  // viene como fracción
      funding = t.fundingRate != null ? parseFloat(t.fundingRate) : null;
      oi = t.holdVol != null ? parseFloat(t.holdVol) : null;
    }
  }catch(e){ /* sin ticker se usan los datos de las velas */ }

  return {
    source:'MEXC Futuros', symbol: pair, displayName: sym,
    price, change24h,
    vol24h: candles.slice(-24).reduce((s,v)=>s+v.v,0),
    candles, funding, oi, dexUrl:null, contract:null,
  };
}

// ═══ PERPETUOS: OKX, BYBIT, BINANCE Y BITUNIX SPOT ═══
// EL BUG QUE ARREGLAN: muchas monedas existen SOLO como contrato perpetuo, no como par spot.
// El caso CRCLUSDT lo muestra claro: en TradingView aparece en OKX, Bybit, Bitget y KuCoin,
// pero todos como "Perpetual Contract". El código buscaba únicamente en los mercados SPOT de
// esas casas, así que no la encontraba en ninguna aunque estuviera en todas.

// OKX perpetuo: el identificador lleva -SWAP al final
async function tryOKXPerp(symbolRaw, tf, variante){
  const sym = variante?.sym ?? normalizarSimbolo(symbolRaw);
  const quote = variante?.quote ?? 'USDT';
  const instId = `${sym}-${quote}-SWAP`;
  const bar = ({ '15m':'15m','1h':'1H','4h':'4H','1d':'1D','1mo':'1M' })[tf] || '4H';
  const res = await fetchJSON(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=220`);
  const filas = res?.data;
  if(!Array.isArray(filas) || filas.length < 20) throw new Error('OKX perpetuo sin datos');
  // OKX no publica el volumen comprador agresivo. Se aproxima por dónde cerró la vela dentro
  // de su rango: si cerró cerca del máximo, dominaron los compradores. Es una estimación, no el
  // dato real — pero es mejor que dejar la capa de flujo en null.
  const candles = filas.map(k=>{
    const o=+k[1], h=+k[2], l=+k[3], cl=+k[4], v=+k[5];
    const rango = h-l;
    const pctComp = rango > 0 ? (cl-l)/rango : 0.5;
    return { t:+k[0], o, h, l, c:cl, v, vc: v*pctComp, vv: v*(1-pctComp), estimado:true };
  }).filter(v=>Number.isFinite(v.c)).sort((a,b)=>a.t-b.t);
  if(candles.length < 20) throw new Error('OKX perpetuo con pocas velas');
  let price = candles.at(-1).c, change24h = 0, funding = null;
  try{
    const t = await fetchJSON(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`);
    const d = t?.data?.[0];
    if(d){ price = parseFloat(d.last) || price;
      const ab = parseFloat(d.open24h) || 0;
      if(ab > 0) change24h = (price-ab)/ab*100; }
  }catch(e){}
  try{
    const fr = await fetchJSON(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`);
    const v = fr?.data?.[0]?.fundingRate;
    if(v != null) funding = parseFloat(v);
  }catch(e){}
  return { source:'OKX Perpetuo', symbol:instId, displayName:sym, price, change24h,
           vol24h: candles.slice(-24).reduce((s,v)=>s+v.v,0), candles, funding, oi:null, dexUrl:null, contract:null };
}

// Bybit perpetuo: mismo endpoint que spot pero con category=linear
async function tryBybitPerp(symbolRaw, tf, variante){
  const sym = variante?.sym ?? normalizarSimbolo(symbolRaw);
  const quote = variante?.quote ?? 'USDT';
  const pair = `${sym}${quote}`;
  const interval = ({ '15m':'15','1h':'60','4h':'240','1d':'D','1mo':'M' })[tf] || '240';
  const res = await fetchJSON(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${pair}&interval=${interval}&limit=200`);
  const filas = res?.result?.list;
  if(!Array.isArray(filas) || filas.length < 20) throw new Error('Bybit perpetuo sin datos');
  // Bybit tampoco publica el volumen comprador: misma estimación que en OKX.
  const candles = filas.map(k=>{
    const o=+k[1], h=+k[2], l=+k[3], cl=+k[4], v=+k[5];
    const rango = h-l;
    const pctComp = rango > 0 ? (cl-l)/rango : 0.5;
    return { t:+k[0], o, h, l, c:cl, v, vc: v*pctComp, vv: v*(1-pctComp), estimado:true };
  }).filter(v=>Number.isFinite(v.c)).sort((a,b)=>a.t-b.t);
  if(candles.length < 20) throw new Error('Bybit perpetuo con pocas velas');
  let price = candles.at(-1).c, change24h = 0, funding = null, oi = null;
  try{
    const t = await fetchJSON(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${pair}`);
    const d = t?.result?.list?.[0];
    if(d){ price = parseFloat(d.lastPrice) || price;
      change24h = parseFloat(d.price24hPcnt || 0) * 100;
      funding = d.fundingRate != null ? parseFloat(d.fundingRate) : null;
      oi = d.openInterest != null ? parseFloat(d.openInterest) : null; }
  }catch(e){}
  return { source:'Bybit Perpetuo', symbol:pair, displayName:sym, price, change24h,
           vol24h: candles.slice(-24).reduce((s,v)=>s+v.v,0), candles, funding, oi, dexUrl:null, contract:null };
}

// Binance Futures: muchas monedas están en futuros y no en spot
async function tryBinanceFutures(symbolRaw, tf, variante){
  const sym = variante?.sym ?? normalizarSimbolo(symbolRaw);
  const quote = variante?.quote ?? 'USDT';
  const pair = `${sym}${quote}`;
  const interval = TF_MAP[tf] || '4h';
  const klines = await fetchJSON(`${FUTURES}/fapi/v1/klines?symbol=${pair}&interval=${interval}&limit=220`);
  if(!Array.isArray(klines) || klines.length < 20) throw new Error('Binance Futures sin datos');
  // El campo 9 es el volumen comprador agresivo, igual que en spot
  const candles = klines.map(k=>({ t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5],
    vc:+k[9]||0, vv: Math.max(0,(+k[5]||0)-(+k[9]||0)), ops:+k[8]||0 }));
  let price = candles.at(-1).c, change24h = 0, funding = null;
  try{
    const t = await fetchJSON(`${FUTURES}/fapi/v1/ticker/24hr?symbol=${pair}`);
    if(t){ price = parseFloat(t.lastPrice) || price; change24h = parseFloat(t.priceChangePercent) || 0; }
  }catch(e){}
  try{
    const pr = await fetchJSON(`${FUTURES}/fapi/v1/premiumIndex?symbol=${pair}`);
    if(pr?.lastFundingRate != null) funding = parseFloat(pr.lastFundingRate);
  }catch(e){}
  return { source:'Binance Futures', symbol:pair, displayName:sym, price, change24h,
           vol24h: candles.slice(-24).reduce((s,v)=>s+v.v,0), candles, funding, oi:null, dexUrl:null, contract:null };
}

// Bitunix SPOT: el mercado al contado, aparte del de futuros que ya estaba
async function tryBitunixSpot(symbolRaw, tf, variante){
  const sym = variante?.sym ?? normalizarSimbolo(symbolRaw);
  const quote = variante?.quote ?? 'USDT';
  const pair = `${sym}${quote}`;
  const interval = ({ '15m':'15m','1h':'1h','4h':'4h','1d':'1d','1mo':'1M' })[tf] || '4h';
  const res = await fetchJSON(`https://openapi.bitunix.com/api/spot/v1/market/kline?symbol=${pair}&interval=${interval}&limit=200`);
  const filas = res?.data;
  if(!Array.isArray(filas) || filas.length < 20) throw new Error('Bitunix spot sin datos');
  const candles = filas.map(k => Array.isArray(k)
      ? { t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }
      : { t:+(k.time??k.t), o:+(k.open??k.o), h:+(k.high??k.h), l:+(k.low??k.l), c:+(k.close??k.c), v:+(k.baseVol??k.vol??0) })
    .filter(v=>Number.isFinite(v.c) && Number.isFinite(v.t)).sort((a,b)=>a.t-b.t);
  if(candles.length < 20) throw new Error('Bitunix spot con pocas velas');
  return { source:'Bitunix Spot', symbol:pair, displayName:sym, price:candles.at(-1).c, change24h:0,
           vol24h: candles.slice(-24).reduce((s,v)=>s+v.v,0), candles, funding:null, oi:null, dexUrl:null, contract:null };
}

// ═══ BITUNIX FUTUROS ═══
// Es el exchange donde David opera de verdad, así que los precios de acá son los que realmente
// va a ver al abrir la posición. Además ya se usaba para filtrar qué monedas son operables:
// tiene sentido que también sea fuente de velas.
//
// DOS DETALLES DE SU API:
//  · Máximo 200 velas por pedido (el motor pide 220). Se traen dos tandas y se juntan.
//  · Devuelve objetos {open,high,low,close,time,baseVol}, no arrays como Binance.
async function tryBitunix(symbolRaw, tf, variante){
  const sym = variante?.sym ?? normalizarSimbolo(symbolRaw);
  const quote = variante?.quote ?? 'USDT';
  const pair = `${sym}${quote}`;
  const interval = ({ '15m':'15m', '1h':'1h', '4h':'4h', '1d':'1d', '1mo':'1M' })[tf] || '4h';
  const msPorVela = ({ '15m':900e3, '1h':3600e3, '4h':14400e3, '1d':86400e3, '1mo':2592000e3 })[tf] || 14400e3;
  const BITUNIX = 'https://fapi.bitunix.com/api/v1/futures/market';

  const traer = (endTime) => {
    const q = `symbol=${pair}&interval=${interval}&limit=200${endTime ? `&endTime=${endTime}` : ''}`;
    return fetchJSON(`${BITUNIX}/kline?${q}`);
  };
  const normalizar = (arr) => (Array.isArray(arr) ? arr : []).map(k => ({
    t: Number(k.time), o:+k.open, h:+k.high, l:+k.low, c:+k.close, v:+(k.baseVol ?? k.quoteVol ?? 0),
  })).filter(v => Number.isFinite(v.c) && Number.isFinite(v.t));

  const res1 = await traer();
  if(res1?.code !== 0 && res1?.code !== '0') throw new Error('Bitunix: ' + (res1?.msg || 'sin datos'));
  let candles = normalizar(res1.data).map(v => {
    // Bitunix no publica volumen comprador: se estima por dónde cerró la vela en su rango
    const rango = v.h - v.l;
    const pctComp = rango > 0 ? (v.c - v.l)/rango : 0.5;
    return { ...v, vc: v.v*pctComp, vv: v.v*(1-pctComp), estimado:true };
  });
  if(candles.length < 20) throw new Error('Bitunix sin velas suficientes');

  // Segunda tanda hacia atrás, para llegar a las 220 que necesitan los indicadores largos
  if(candles.length >= 200){
    try{
      const masViejo = Math.min(...candles.map(v=>v.t));
      const res2 = await traer(masViejo - msPorVela);
      const previas = normalizar(res2?.data);
      if(previas.length){
        const vistos = new Set(candles.map(v=>v.t));
        candles = previas.filter(v=>!vistos.has(v.t)).concat(candles);
      }
    }catch(e){ /* con 200 velas ya alcanza para la mayoría de los indicadores */ }
  }
  candles.sort((a,b)=>a.t-b.t);

  // Ticker: precio actual, variación y funding — Bitunix los da en el mismo lugar
  let price = candles.at(-1).c, change24h = 0, funding = null;
  try{
    const tk = await fetchJSON(`${BITUNIX}/tickers?symbols=${pair}`);
    const t = Array.isArray(tk?.data) ? tk.data[0] : null;
    if(t){
      price = parseFloat(t.lastPrice ?? t.last ?? price);
      const abre = parseFloat(t.open ?? 0);
      if(abre > 0) change24h = (price - abre)/abre*100;
    }
  }catch(e){ /* sin ticker se usan los datos de las velas */ }
  try{
    const fr = await fetchJSON(`${BITUNIX}/funding_rate?symbol=${pair}`);
    const v = fr?.data?.fundingRate ?? fr?.data?.[0]?.fundingRate;
    if(v != null) funding = parseFloat(v);
  }catch(e){ /* el funding es opcional */ }

  return {
    source:'Bitunix', symbol: pair, displayName: sym,
    price, change24h,
    vol24h: candles.slice(-24).reduce((s,v)=>s+v.v, 0),
    candles, funding, oi:null, dexUrl:null, contract:null,
  };
}

async function tryKuCoin(symbolRaw, tf, variante){
  const sym = variante?.sym ?? normalizarSimbolo(symbolRaw);
  const quote = variante?.quote ?? 'USDT';
  const pair = `${sym}-${quote}`;
  const type = TF_MAP[tf].kucoin;
  const secPerCandle = TF_MAP[tf].kucoinSec;
  const endAt = Math.floor(Date.now()/1000);
  const startAt = endAt - secPerCandle*220; // KuCoin requiere rango de fechas explícito (a diferencia de los otros); lo calculamos según la temporalidad
  const res = await fetchJSON(`https://api.kucoin.com/api/v1/market/candles?symbol=${pair}&type=${type}&startAt=${startAt}&endAt=${endAt}`);
  const rows = res.data;
  if(!Array.isArray(rows) || !rows.length) throw new Error('KuCoin sin datos');
  // Formato KuCoin: [time, open, close, high, low, volumen, turnover] (¡el orden de close/high/low es distinto al habitual!)
  const candles = rows.map(r=>({t:+r[0]*1000,o:+r[1],c:+r[2],h:+r[3],l:+r[4],v:+r[5]})).sort((a,b)=>a.t-b.t);
  const stats = await fetchJSON(`https://api.kucoin.com/api/v1/market/stats?symbol=${pair}`).catch(()=>null);
  return {
    source:'KuCoin', symbol: pair, displayName: sym,
    price: stats?.data?.last ? parseFloat(stats.data.last) : candles.at(-1).c,
    change24h: stats?.data?.changeRate ? parseFloat(stats.data.changeRate)*100 : 0,
    vol24h: stats?.data?.volValue ? parseFloat(stats.data.volValue) : 0,
    candles, funding:null, oi:null, dexUrl:null, contract:null,
  };
}

// ═══ MONITOR DE APIs ═══
// Registra qué fuente respondió y cuál falló, para saber si una señal salió con datos completos.
// Se alimenta solo, desde los intentos que ya hace fetchTokenData: no agrega ningún pedido extra.
const _saludAPIs = {};
function registrarAPI(nombre, ok, ms, motivo){
  if(!_saludAPIs[nombre]) _saludAPIs[nombre] = { intentos:0, exitos:0, fallos:0, msTotal:0, ultimoError:null };
  const s = _saludAPIs[nombre];
  s.intentos++;
  if(ok){ s.exitos++; s.msTotal += (ms||0); }
  else { s.fallos++; s.ultimoError = motivo || 'error desconocido'; }
}
function getSaludAPIs(){
  return Object.entries(_saludAPIs).map(([nombre,s])=>{
    const pct = s.intentos ? (s.exitos/s.intentos*100) : 0;
    return {
      nombre,
      disponibilidad: +pct.toFixed(1),
      estado: pct>=95 ? '🟢' : pct>=70 ? '🟡' : '🔴',
      intentos: s.intentos,
      msPromedio: s.exitos ? Math.round(s.msTotal/s.exitos) : null,
      ultimoError: s.ultimoError,
    };
  }).sort((a,b)=>a.disponibilidad-b.disponibilidad);
}

// Normaliza lo que escribe la persona a un símbolo limpio.
// Antes cada fuente hacía .replace(/[^A-Z0-9]/g,'') y después le pegaba 'USDT' — así que si
// escribías "BICOUSDT" o "BICO/USDT" terminaba buscando "BICOUSDTUSDT", que no existe en ningún
// exchange, y el resultado era "moneda no encontrada" aunque la moneda estuviera perfectamente.
function normalizarSimbolo(entrada){
  let s = String(entrada||'').trim().toUpperCase();

  // Sufijos de perpetuo que usan TradingView y varios exchanges. Hay que sacarlos ANTES de
  // limpiar los símbolos, porque ".P" se convertiría en "P" y quedaría pegado al nombre:
  // LABUSDT.P terminaría buscándose como "LABUSDTP", que no existe en ningún lado.
  s = s.replace(/\.(P|PERP)$/i, '')      // LABUSDT.P → LABUSDT
       .replace(/[-_]?PERP$/i, '')        // LAB-PERP  → LAB
       .replace(/[-_]?SWAP$/i, '')        // LAB-SWAP  → LAB
       .replace(/^(BINANCE|BYBIT|MEXC|OKX|KUCOIN|BITUNIX|GATEIO|COINBASE):/i, ''); // prefijo de exchange

  s = s.replace(/[^A-Z0-9]/g,'');

  // Se saca la moneda de cotización del final, si queda algo antes
  for(const sufijo of ['USDT','USDC','BUSD','USD']){
    if(s.endsWith(sufijo) && s.length > sufijo.length){ s = s.slice(0, -sufijo.length); break; }
  }
  return s;
}

// Corre una promesa con límite de tiempo. Sin esto, una fuente que cuelga bloquea a todas las que
// vienen después: el buscador prueba 6 exchanges en fila, y cada uno puede reintentar con 4 proxies
// de 10 segundos — o sea que una moneda podía tardar minutos o directamente no cargar nunca.
function conTiempoLimite(promesa, ms, etiqueta){
  return Promise.race([
    promesa,
    new Promise((_,rej)=>setTimeout(()=>rej(new Error(`${etiqueta}: se agotó el tiempo (${ms}ms)`)), ms)),
  ]);
}

async function fetchTokenData(query, tf){
  // Volvimos a probar cada exchange UNA POR VEZ, en fila — lo probé en paralelo (Promise.allSettled)
  // pensando que sería más rápido, pero fue al revés: esa función espera a que TODAS terminen (ganen
  // o pierdan) antes de decidir, así que si Binance respondía rápido pero las demás fallaban y cada
  // una reintentaba con 4 proxies (10s cada uno), la espera total terminaba siendo la de la MÁS LENTA
  // en fallar del todo, no la de la primera en responder bien. Orden actualizado: Binance primero
  // (la más completa), MEXC segundo (mejor cobertura de altcoins chicas), después el resto.
  // ═══ VARIANTES DEL SÍMBOLO ═══
  // Antes se buscaba SOLO el par contra USDT y con el nombre exacto. Eso dejaba afuera:
  //   · monedas que cotizan únicamente contra USDC (cada vez más comunes)
  //   · las que el exchange lista con prefijo numérico: 1000PEPE, 1000SATS, 1MBABYDOGE
  // Ahora se prueban las variantes antes de darla por inexistente.
  const symBase = normalizarSimbolo(query);
  const variantes = [
    { sym: symBase, quote: 'USDT' },
    { sym: symBase, quote: 'USDC' },
    { sym: '1000' + symBase, quote: 'USDT' },
    { sym: '1000000' + symBase, quote: 'USDT' },
  ];

  // MEXC Futuros va temprano: es donde están las monedas chicas que el spot no tiene.
  // Bitunix va segundo: es donde David opera de verdad, así que sus precios son los que va a
  // ver al abrir la posición. Gate.io se sacó a pedido suyo.
  const sources = [tryBinance, tryBitunix, tryMEXCFutures, tryMEXC, tryOKX, tryBybit, tryKuCoin];
  const fallos = [];
  // ═══ BÚSQUEDA EN PARALELO ═══
  // Antes se probaba fuente por fuente en fila: si la moneda estaba en la última, había que
  // esperar a que las seis anteriores agotaran su límite de 9 segundos (hasta 54 segundos).
  // Ahora se lanzan en tandas paralelas y gana la primera que responda con datos válidos.
  //   Tanda 1: Binance + Bitunix + MEXC Futuros  → cubre la enorme mayoría
  //   Tanda 2: el resto, solo si la primera no encontró nada
  // Peor caso: de ~54 segundos a ~18.
  // Cada tanda mezcla SPOT y PERPETUOS a propósito: muchas monedas existen solo como contrato
  // perpetuo (el caso CRCLUSDT) y otras solo al contado. Buscando en ambos a la vez se cubren
  // las dos sin agregar tiempo, porque las tandas van en paralelo.
  const tandas = [
    [tryBinance, tryBinanceFutures, tryBitunix, tryBitunixSpot, tryMEXCFutures],
    [tryOKXPerp, tryBybitPerp, tryMEXC, tryOKX, tryBybit, tryKuCoin],
  ];

  const intentar = async (src, variante) => {
    const esPrincipal = (variante === variantes[0]);
    const etiqueta = esPrincipal ? src.name : `${src.name} (${variante.sym}/${variante.quote})`;
    const t0 = Date.now();
    const data = await conTiempoLimite(src(query, tf, variante), 9000, etiqueta);
    if(!data?.candles || data.candles.length < 20) throw new Error(`${src.name}: sin velas suficientes`);
    if(data.candles.length < 60) data.pocasVelas = true;
    if(variante.quote !== 'USDT') data.parAlternativo = `${variante.sym}/${variante.quote}`;
    if(variante.sym !== symBase) data.simboloReal = variante.sym;
    registrarAPI(src.name, true, Date.now()-t0);
    return data;
  };

  for(const tanda of tandas){
    // Dentro de cada tanda: todas las fuentes con la variante principal, a la vez.
    // Promise.any devuelve la PRIMERA que funcione, sin esperar a las demás.
    try{
      return await Promise.any(tanda.map(src => intentar(src, variantes[0])));
    }catch(errores){
      // AggregateError: fallaron todas las de esta tanda con el símbolo normal
      for(const src of tanda) fallos.push(`${src.name}: no encontró ${symBase}USDT`);
    }
    // Si el símbolo normal falló, se prueban las variantes (USDC, 1000XXX) también en paralelo
    const alternativas = variantes.slice(1);
    if(alternativas.length){
      try{
        const intentos = [];
        for(const src of tanda) for(const v of alternativas) intentos.push(intentar(src, v));
        return await Promise.any(intentos);
      }catch(e){ /* ninguna variante funcionó en esta tanda, se pasa a la siguiente */ }
    }
  }

  // ninguna fuente de exchanges centralizados lo tiene -> probamos DEXs (GeckoTerminal)
  try{
    return await conTiempoLimite(tryGecko(query, tf), 8000, 'GeckoTerminal');
  }catch(e){
    fallos.push(`GeckoTerminal: ${e.message}`);
    // Error que dice QUÉ pasó en cada fuente, en vez de un "no encontrada" a secas. Una API caída
    // no es lo mismo que una moneda inexistente.
    const err = new Error(`No se pudo obtener datos de "${query}". Intentos: ${fallos.join(' | ')}`);
    err.detalleFuentes = fallos;
    throw err;
  }
}

// Tendencia macro (4h, EMA200) usada como filtro: no se opera contra la tendencia mayor sin confluencia extrema
async function fetchMacroTrend(query){
  try{
    const d = await fetchTokenData(query, '4h');
    if(!d.candles || d.candles.length < 60) return null;
    const closesArr = d.candles.map(c=>c.c);
    const periodoUsado = Math.min(200, closesArr.length-1);
    const e200arr = ema(closesArr, periodoUsado);
    const e200 = e200arr.at(-1);
    const price = closesArr.at(-1);
    // Si la moneda no tiene 200 velas de historia, este "e200" en realidad es una EMA más corta
    // (a veces EMA60) — sigue siendo útil como referencia de tendencia, pero no es lo mismo que una
    // EMA200 real, así que se marca para que quien lo use sepa que hay menos confianza acá.
    return { bias: price>e200 ? 'bull':'bear', price, e200, confiable: periodoUsado>=200 };
  }catch(e){ return null; }
}

// Referencia de BTC para el Dios de Fuerza Relativa: % de cambio de BTC en la misma temporalidad/ventana.
async function fetchBTCReference(tf){
  try{
    const btc = await fetchTokenData('BTC', tf);
    if(!btc.candles || btc.candles.length<9) return null;
    const closes = btc.candles.map(c=>c.c);
    const lookback = Math.min(8, closes.length-1);
    const pctChange = ((closes.at(-1)-closes[closes.length-1-lookback])/closes[closes.length-1-lookback])*100;
    return { pctChange };
  }catch(e){ return null; }
}

// ---------- Indicators ----------
function ema(values, period){
  const k = 2/(period+1); const out=[]; let prev;
  values.forEach((v,i)=>{ prev = i===0? v : v*k+prev*(1-k); out.push(prev); });
  return out;
}
function sma(values, period){
  return values.map((_,i)=>{ if(i<period-1) return null; let s=0; for(let j=i-period+1;j<=i;j++) s+=values[j]; return s/period; });
}
function rsi(values, period=14){
  const out = new Array(values.length).fill(null);
  let gains=0, losses=0;
  for(let i=1;i<values.length;i++){
    const diff = values[i]-values[i-1];
    if(i<=period){
      if(diff>=0) gains+=diff; else losses-=diff;
      if(i===period){ let rs=gains/period/(losses/period||1e-9); out[i]=100-100/(1+rs); }
    } else {
      const g=Math.max(diff,0), l=Math.max(-diff,0);
      gains=(gains*(period-1)+g)/period; losses=(losses*(period-1)+l)/period;
      const rs=gains/(losses||1e-9); out[i]=100-100/(1+rs);
    }
  }
  return out;
}
function macd(values){
  const e12=ema(values,12), e26=ema(values,26);
  const line = values.map((_,i)=> e12[i]-e26[i]);
  const signal = ema(line,9);
  const hist = line.map((v,i)=> v-signal[i]);
  return {line, signal, hist};
}
function bollinger(values, period=20, mult=2){
  const mid = sma(values,period);
  return values.map((_,i)=>{
    if(mid[i]==null) return {mid:null,upper:null,lower:null};
    let sumSq=0; for(let j=i-period+1;j<=i;j++) sumSq += Math.pow(values[j]-mid[i],2);
    const sd = Math.sqrt(sumSq/period);
    return {mid:mid[i], upper:mid[i]+mult*sd, lower:mid[i]-mult*sd};
  });
}
function atr(candles, period=14){
  const trs = candles.map((c,i)=> i===0? c.h-c.l : Math.max(c.h-c.l, Math.abs(c.h-candles[i-1].c), Math.abs(c.l-candles[i-1].c)));
  return ema(trs, period);
}

// ---- Keltner Channel + squeeze (Bollinger dentro de Keltner = compresión, posible ruptura fuerte cerca) ----
function keltnerChannel(candles, period=20, mult=1.5){
  const closes = candles.map(c=>c.c);
  const mid = ema(closes, period).at(-1);
  const atrLast = atr(candles, period).at(-1);
  return { mid, upper: mid+mult*atrLast, lower: mid-mult*atrLast };
}
function detectSqueeze(candles, bb){
  if(!bb || bb.upper==null) return null;
  const kelt = keltnerChannel(candles, 20, 1.5);
  const squeezeOn = bb.upper < kelt.upper && bb.lower > kelt.lower;
  return { squeezeOn, bb, keltner: kelt };
}

// ---- Score de Confluencia (para confirmar entrada en 15m sin depender solo de un BOS estricto) ----
// La idea: no exigir SIEMPRE una ruptura de estructura para confirmar. Si el momentum (MACD acelerando)
// + el Stochastic saliendo recién de una zona extrema (no ya agotado adentro) + velas con cuerpo fuerte
// coinciden, es una entrada razonable — y más temprana que esperar el BOS (que suele confirmar tarde,
// cuando el impulso ya corrió bastante).
function confluenceScore15m(candles){
  if(!candles || candles.length<30) return {bullConfluence:0, bearConfluence:0};
  const closes = candles.map(c=>c.c);
  const rsiArr = rsi(closes,14);
  const stoch = stochRsi(rsiArr,14).filter(v=>v!=null);
  const macdData = macd(closes);
  const lastStoch = stoch.at(-1), prevStoch = stoch.at(-2);
  const lastHist = macdData.hist.at(-1), prevHist = macdData.hist.at(-2);

  const macdAccelerating = lastHist!=null && prevHist!=null && Math.abs(lastHist) > Math.abs(prevHist);
  const macdBull = lastHist>0 && macdAccelerating;
  const macdBear = lastHist<0 && macdAccelerating;

  // Sale de sobreventa (no ya en sobrecompra) / sale de sobrecompra (no ya en sobreventa): evita entrar agotado.
  const stochBull = lastStoch!=null && prevStoch!=null && prevStoch<30 && lastStoch>prevStoch && lastStoch<65;
  const stochBear = lastStoch!=null && prevStoch!=null && prevStoch>70 && lastStoch<prevStoch && lastStoch>35;

  const last3 = candles.slice(-3);
  const strongBullCandles = last3.filter(c=> (c.c-c.o)>0 && (c.c-c.o)/((c.h-c.l)||1e-9) > 0.5).length;
  const strongBearCandles = last3.filter(c=> (c.o-c.c)>0 && (c.o-c.c)/((c.h-c.l)||1e-9) > 0.5).length;

  // Volumen: el impulso de las últimas velas tiene que venir acompañado de volumen real, no ser "hueco".
  const vols = candles.map(c=>c.v);
  const avgVol20 = vols.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,vols.length);
  const lastVol = vols.at(-1);
  const volumeConfirms = lastVol > avgVol20*1.15;

  // Fuerza de tendencia real (ADX): sin esto, un cruce de MACD en un mercado sin tendencia (ADX bajo) es ruido.
  const adxVal = adx(candles,14);
  const adxStrong = adxVal!=null && adxVal>=20;

  const bullConfluence = [macdBull, stochBull, strongBullCandles>=2, volumeConfirms, adxStrong].filter(Boolean).length;
  const bearConfluence = [macdBear, stochBear, strongBearCandles>=2, volumeConfirms, adxStrong].filter(Boolean).length;
  // Nota: se probó divergencia RSI acá (peso reducido, +0.5), con backtest real — dio EXACTAMENTE
  // igual en los 3 períodos (nunca fue la diferencia entre confirmar o no una entrada). Se revirtió
  // porque además es redundante con el Dios CVD, que ya detecta "el precio se mueve pero el volumen
  // real no acompaña" de forma más directa (flujo de volumen, no un oscilador que lo aproxima).

  // ---- Entrada temprana de MACD (histograma "aclarándose") — arreglada con 2 filtros extra ----
  // La técnica original (Aspray, 1986): el histograma achicándose HACIA CERO anticipa el cruce real,
  // antes de que la barra cambie de color. Un estudio real (Chio, 2022, backtest de todo el Dow/Nasdaq/
  // S&P500) encontró que esta entrada gana MÁS SEGUIDO, pero cuando pierde, pierde MÁS GRANDE — el MACD
  // solo, sin nada más, gana menos del 50% de las veces. Por eso acá NUNCA se usa sola: solo cuenta si
  // además (1) el ADX confirma que hay una tendencia real (no ruido de mercado lateral) y (2) el
  // Estocástico está alineado (recuperándose desde su propia zona, no ya agotado en el sentido contrario).
  // Exigimos 2 velas seguidas de achicamiento (no solo 1) para la confirmación de pendiente real.
  const h1=macdData.hist.at(-1), h2=macdData.hist.at(-2), h3=macdData.hist.at(-3);
  const histShrinkingBull = h1!=null && h2!=null && h3!=null && h1<0 && h2<0 && h1>h2 && h2>=h3; // menos negativo cada vez
  const histShrinkingBear = h1!=null && h2!=null && h3!=null && h1>0 && h2>0 && h1<h2 && h2<=h3; // menos positivo cada vez
  const stochAlignedBull = lastStoch!=null && lastStoch>25 && lastStoch<70; // recuperándose, no ya agotado arriba
  const stochAlignedBear = lastStoch!=null && lastStoch<75 && lastStoch>30; // cayendo, no ya agotado abajo
  const macdEarlyBull = histShrinkingBull && adxStrong && stochAlignedBull;
  const macdEarlyBear = histShrinkingBear && adxStrong && stochAlignedBear;

  return { bullConfluence, bearConfluence, macdBull, macdBear, stochBull, stochBear, strongBullCandles, strongBearCandles, volumeConfirms, adxStrong, adxVal, lastStoch, macdEarlyBull, macdEarlyBear };
}

// ---- Fear & Greed (para el filtro macro suave) ----
async function fetchFearGreedIndex(){
  try{
    const res = await fetchJSON('https://api.alternative.me/fng/?limit=1');
    return parseInt(res?.data?.[0]?.value, 10) || null;
  }catch(e){ return null; }
}

// ---- Calendario FOMC (fechas reales publicadas por la Reserva Federal, no inventadas) ----
// El anuncio de tasas sale a las 14:00 hora del Este (ET) el segundo día de cada reunión.
// Horarios ya convertidos a UTC (considerando horario de verano en EE.UU. donde corresponde).
// NOTA: hay que actualizar esta lista cuando la Fed publique el calendario de 2027 (normalmente
// lo anuncia a mediados del año anterior).
const FOMC_ANNOUNCEMENTS_UTC = [
  '2026-01-28T19:00:00Z', // EST (UTC-5)
  '2026-03-18T18:00:00Z', // EDT (UTC-4, ya en horario de verano)
  '2026-04-29T18:00:00Z',
  '2026-06-17T18:00:00Z',
  '2026-07-29T18:00:00Z',
  '2026-09-16T18:00:00Z',
  '2026-10-28T18:00:00Z',
  '2026-12-09T19:00:00Z', // EST de nuevo (UTC-5)
];
// ═══ CALENDARIO MACRO CON FECHAS REALES ═══
// Estos datos mueven el precio más que cualquier indicador técnico, y las fechas son públicas
// y predecibles: no hace falta pagar una API.
//   · FOMC: el calendario se publica con un año de anticipación
//   · Peticiones de desempleo: TODOS los jueves a las 13:30 UTC, sin excepción
//   · CPI: alrededor del día 10-13, a las 13:30 UTC
//   · PMI: alrededor del 22-24
//   · Inventarios de petróleo: miércoles 15:30 UTC
//
// Se marca lo que es fecha EXACTA y lo que es ventana estimada, para no dar por seguro
// algo que no lo es.
const FOMC_2026 = [   // fechas oficiales publicadas por la Reserva Federal
  '2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29','2026-09-16','2026-11-04','2026-12-16',
];
// Las minutas salen 3 semanas después de cada reunión
const MINUTAS_2026 = FOMC_2026.map(d => {
  const x = new Date(d + 'T19:00:00Z'); x.setUTCDate(x.getUTCDate() + 21); return x.toISOString().slice(0,10);
});

export function calendarioMacro(ahora = new Date()){
  const eventos = [];
  const hoy = new Date(ahora);
  const iso = d => d.toISOString().slice(0,10);
  const enHoras = (fecha, h, m=0) => {
    const d = new Date(fecha + `T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00Z`);
    return (d - hoy) / 3600000;
  };

  // Próximos 10 días
  for(let i = 0; i <= 10; i++){
    const d = new Date(hoy); d.setUTCDate(d.getUTCDate() + i);
    const fecha = iso(d), dia = d.getUTCDay(), diaMes = d.getUTCDate();

    if(FOMC_2026.includes(fecha)) eventos.push({
      fecha, hora:'19:00 UTC', nombre:'Decisión de tasas de la Fed (FOMC)', impacto:'MUY ALTO', exacta:true,
      horas: enHoras(fecha,19),
      queEs:'La Fed anuncia si sube, baja o mantiene las tasas. Es el evento que más mueve todo: dólar, oro, acciones y cripto.' });

    if(MINUTAS_2026.includes(fecha)) eventos.push({
      fecha, hora:'19:00 UTC', nombre:'Minutas de la Fed', impacto:'ALTO', exacta:true,
      horas: enHoras(fecha,19),
      queEs:'El detalle de qué discutieron en la última reunión. Cambia las expectativas sobre las próximas tasas y suele sacudir al dólar, al oro y a BTC.' });

    if(dia === 4) eventos.push({   // jueves
      fecha, hora:'13:30 UTC', nombre:'Peticiones de subsidio por desempleo', impacto:'MEDIO', exacta:true,
      horas: enHoras(fecha,13,30),
      queEs:'Mide la solidez del empleo en Estados Unidos. Si salen peores de lo esperado hay más margen para una Fed flexible (bueno para riesgo); si salen mejores, lo contrario.' });

    if(dia === 3) eventos.push({   // miércoles
      fecha, hora:'15:30 UTC', nombre:'Inventarios de petróleo', impacto:'MEDIO', exacta:true,
      horas: enHoras(fecha,15,30),
      queEs:'Mueve fuerte al sector energético y de ahí puede arrastrar al resto del mercado.' });

    if(diaMes >= 10 && diaMes <= 13 && dia >= 1 && dia <= 5) eventos.push({
      fecha, hora:'13:30 UTC', nombre:'CPI — inflación de EE.UU.', impacto:'MUY ALTO', exacta:false,
      horas: enHoras(fecha,13,30),
      queEs:'La inflación. Es el dato que más define qué va a hacer la Fed con las tasas.' });

    if(diaMes >= 22 && diaMes <= 24 && dia >= 1 && dia <= 5) eventos.push({
      fecha, hora:'14:45 UTC', nombre:'PMI (actividad económica)', impacto:'ALTO', exacta:false,
      horas: enHoras(fecha,14,45),
      queEs:'Mide la actividad de las empresas. Importa sobre todo cuando el dato real se aparta mucho de lo que se esperaba.' });
  }

  eventos.sort((a,b)=>a.horas-b.horas);
  const proximos = eventos.filter(e => e.horas > -2);
  const inminente = proximos.find(e => e.horas <= 24 && (e.impacto === 'MUY ALTO' || e.impacto === 'ALTO'));
  const enCurso = eventos.find(e => e.horas <= 0.5 && e.horas > -2);

  return {
    proximos: proximos.slice(0, 6),
    inminente: inminente || null,
    enCurso: enCurso || null,
    // El aviso concreto: si hay algo grande en las próximas horas, conviene no abrir posiciones
    aviso: enCurso
      ? `🔴 ${enCurso.nombre} está saliendo AHORA. El mercado puede moverse de forma violenta e impredecible en los próximos minutos.`
      : inminente
      ? `⚠️ ${inminente.nombre} en ${inminente.horas < 1 ? 'menos de una hora' : `${inminente.horas.toFixed(0)} horas`}${inminente.exacta ? '' : ' (fecha estimada)'}. ${inminente.queEs}`
      : null,
  };
}

function getFOMCWindow(bufferHours=3){
  const now = Date.now();
  for(const iso of FOMC_ANNOUNCEMENTS_UTC){
    const t = new Date(iso).getTime();
    const diffHours = (t-now)/(3600*1000);
    if(Math.abs(diffHours) <= bufferHours){
      return { isNear:true, hoursUntil: diffHours, announcementTime: iso };
    }
  }
  return { isNear:false, hoursUntil:null, announcementTime:null };
}

// ---- Filtro macro AMPLIADO: no solo FOMC, también los datos de EE.UU. que más mueven el mercado ----
// NFP (empleo, primer viernes del mes) y peticiones de desempleo semanales (todos los jueves) tienen
// fecha exacta y se pueden calcular. CPI real varía año a año dentro del BLS (no hay una regla fija
// simple) — acá usamos una ventana aproximada (día 10 al 15 del mes) como aviso de precaución, no
// como fecha exacta confirmada; es mejor que nada, pero no reemplaza un calendario económico real.
function getHighImpactMacroWindow(bufferHours=2){
  const fomc = getFOMCWindow(bufferHours);
  if(fomc.isNear) return { ...fomc, kind:'FOMC (anuncio de tasas)' };

  const now = new Date();
  const targetUTCHour = 13; // 8:30am ET en horario de verano (la mayor parte del año que corre el bot)

  // NFP: primer viernes del mes
  const year = now.getUTCFullYear(), month = now.getUTCMonth();
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const firstFridayDate = 1 + ((5 - firstOfMonth.getUTCDay() + 7) % 7);
  const nfpTime = new Date(Date.UTC(year, month, firstFridayDate, targetUTCHour, 30));
  const nfpDiff = (nfpTime.getTime()-now.getTime())/(3600*1000);
  if(Math.abs(nfpDiff) <= bufferHours) return { isNear:true, hoursUntil:nfpDiff, announcementTime:nfpTime.toISOString(), kind:'NFP (reporte de empleo)' };

  // Peticiones de desempleo semanales: todos los jueves
  const dayOfWeek = now.getUTCDay(); // 4 = jueves
  const daysToThursday = (4 - dayOfWeek + 7) % 7;
  const thursdayTime = new Date(Date.UTC(year, month, now.getUTCDate()+daysToThursday, targetUTCHour, 30));
  const claimsDiff = (thursdayTime.getTime()-now.getTime())/(3600*1000);
  if(Math.abs(claimsDiff) <= bufferHours) return { isNear:true, hoursUntil:claimsDiff, announcementTime:thursdayTime.toISOString(), kind:'Peticiones de desempleo semanales' };

  // ISM Manufacturero: primer día HÁBIL del mes, 10:00am ET (15:00 UTC en verano).
  // Del video de análisis de BTC: un ISM/PMI fuerte le quita urgencia a la Fed para bajar tasas,
  // fortalece al dólar y presiona a la baja a los activos de riesgo como cripto.
  const ismHourUTC = 15;
  let primerHabil = 1;
  for(let d=1; d<=5; d++){
    const dia = new Date(Date.UTC(year, month, d)).getUTCDay();
    if(dia!==0 && dia!==6){ primerHabil = d; break; }
  }
  const ismTime = new Date(Date.UTC(year, month, primerHabil, ismHourUTC, 0));
  const ismDiff = (ismTime.getTime()-now.getTime())/(3600*1000);
  if(Math.abs(ismDiff) <= bufferHours) return { isNear:true, hoursUntil:ismDiff, announcementTime:ismTime.toISOString(), kind:'ISM Manufacturero' };

  // ISM de Servicios: tercer día hábil del mes, misma hora. Pesa incluso más que el manufacturero
  // porque los servicios son la mayor parte de la economía de EE.UU.
  let habiles = 0, tercerHabil = 3;
  for(let d=1; d<=7; d++){
    const dia = new Date(Date.UTC(year, month, d)).getUTCDay();
    if(dia!==0 && dia!==6){ habiles++; if(habiles===3){ tercerHabil = d; break; } }
  }
  const ismServTime = new Date(Date.UTC(year, month, tercerHabil, ismHourUTC, 0));
  const ismServDiff = (ismServTime.getTime()-now.getTime())/(3600*1000);
  if(Math.abs(ismServDiff) <= bufferHours) return { isNear:true, hoursUntil:ismServDiff, announcementTime:ismServTime.toISOString(), kind:'ISM de Servicios' };

  // PMI preliminar de S&P Global: alrededor del día 22-24, 9:45am ET (13:45 UTC).
  // La fecha exacta varía, así que es una ventana de precaución, no un dato confirmado.
  const diaMes = now.getUTCDate();
  if(diaMes>=22 && diaMes<=24 && now.getUTCHours()>=13 && now.getUTCHours()<=15){
    return { isNear:true, hoursUntil:0, announcementTime:now.toISOString(), kind:'PMI preliminar (ventana aproximada)' };
  }

  // CPI: ventana aproximada (día 10-15), no fecha exacta confirmada — aviso más suave
  const dayOfMonth = now.getUTCDate();
  if(dayOfMonth>=10 && dayOfMonth<=15 && now.getUTCHours()===targetUTCHour){
    return { isNear:true, hoursUntil:0, announcementTime:now.toISOString(), kind:'Posible CPI (ventana aproximada, no fecha exacta)' };
  }

  return { isNear:false, hoursUntil:null, announcementTime:null, kind:null };
}

// ---- Capital Flow real (DeFiLlama: 100% gratis, sin key, sin límite) ----
// Compara el total circulante de stablecoins y el TVL global de los últimos ~7 días.
// Ambos en alza = suele leerse como "hay pólvora seca / capital fluyendo hacia cripto".
// ---- Calendario de desbloqueos de tokens (DefiLlama, gratis y sin API key) ----
// Este es el catalizador principal que usa David en sus señales: cuando se libera un lote grande
// de tokens (vesting de equipo/inversores), aparece oferta programada que suele presionar el precio
// a la baja. Es información que NO se puede deducir del gráfico — hay que consultar el calendario.
// Se cachea por 6 horas porque el calendario cambia lento y son 339 protocolos.
let _unlocksCache = { data: null, ts: 0 };
async function fetchTokenUnlocks(){
  const AHORA = Date.now();
  if(_unlocksCache.data && (AHORA - _unlocksCache.ts) < 6*3600*1000) return _unlocksCache.data;
  try{
    const raw = await fetchJSON('https://api.llama.fi/emissions');
    if(!Array.isArray(raw)) return null;
    _unlocksCache = { data: raw, ts: AHORA };
    return raw;
  }catch(e){ return null; }
}

// Busca si una moneda tiene un desbloqueo grande cerca. Devuelve null si no hay nada relevante.
async function fetchUnlockRisk(symbol){
  const lista = await fetchTokenUnlocks();
  if(!lista) return null;
  const sym = (symbol||'').toUpperCase().replace('USDT','').replace('USD','');
  const match = lista.find(x =>
    (x.token||'').toUpperCase() === sym ||
    (x.symbol||'').toUpperCase() === sym ||
    (x.name||'').toUpperCase() === sym
  );
  if(!match) return null;

  // El evento de desbloqueo más cercano en el futuro
  const eventos = (match.events||[]).filter(e => e.timestamp*1000 > Date.now());
  if(!eventos.length) return null;
  eventos.sort((a,b) => a.timestamp - b.timestamp);
  const prox = eventos[0];
  const horasFaltan = (prox.timestamp*1000 - Date.now()) / 3600000;
  // Solo interesa si está dentro de los próximos 7 días
  if(horasFaltan > 168) return null;

  const cantidad = Array.isArray(prox.noOfTokens) ? prox.noOfTokens.reduce((s,n)=>s+n,0) : (prox.noOfTokens||0);
  const circulante = match.circSupply || match.maxSupply || 0;
  const pctDelFloat = circulante>0 ? (cantidad/circulante*100) : null;

  return {
    horasFaltan,
    diasFaltan: horasFaltan/24,
    cantidad,
    pctDelFloat,
    categoria: prox.category || 'sin categoría',
    // El riesgo es serio si libera más del 2% del circulante en menos de 3 días
    riesgoAlto: pctDelFloat!=null && pctDelFloat >= 2 && horasFaltan <= 72,
    descripcion: pctDelFloat!=null
      ? `desbloqueo de ${pctDelFloat.toFixed(2)}% del circulante en ${horasFaltan<24 ? Math.round(horasFaltan)+' horas' : Math.round(horasFaltan/24)+' días'} (${prox.category||'vesting'})`
      : `desbloqueo programado en ${Math.round(horasFaltan/24)} días`,
  };
}

// ═══ FUERZA DEL DÓLAR (proxy de DXY) ═══
// El motor YA usaba mc.usdStrength para calcular la señal de mercado, pero el bot nunca se lo
// pasaba — o sea que ese componente valía 0 siempre. Acá se calcula de verdad.
// Por qué importa: dólar fuerte = presión bajista sobre activos de riesgo como cripto. Es la
// relación inversa clásica del módulo 6 del Máster en Microestructura.
// Se usa EUR/USD y GBP/USD como proxy (juntos son ~70% del índice DXY real) desde exchangerate.host,
// que es gratis y sin clave. Si falla, devuelve null y el motor sigue funcionando igual que antes.
let _usdCache = { valor: null, ts: 0 };
async function fetchUsdStrength(){
  const AHORA = Date.now();
  // El dólar se mueve lento: con actualizar cada 6 horas alcanza y no se castiga la API.
  if(_usdCache.valor !== null && (AHORA - _usdCache.ts) < 6*3600*1000) return _usdCache.valor;
  try{
    const hoy = new Date();
    const hace7 = new Date(AHORA - 7*24*3600*1000);
    const iso = d => d.toISOString().slice(0,10);
    const [actual, previo] = await Promise.all([
      fetchJSON(`https://api.exchangerate.host/${iso(hoy)}?base=USD&symbols=EUR,GBP`),
      fetchJSON(`https://api.exchangerate.host/${iso(hace7)}?base=USD&symbols=EUR,GBP`),
    ]);
    const eurAhora = actual?.rates?.EUR, gbpAhora = actual?.rates?.GBP;
    const eurAntes = previo?.rates?.EUR, gbpAntes = previo?.rates?.GBP;
    if(!eurAhora || !eurAntes || !gbpAhora || !gbpAntes) return null;
    // Si USD/EUR sube, el dólar se fortalece. Promedio de las dos monedas.
    const cambioEur = (eurAhora-eurAntes)/eurAntes*100;
    const cambioGbp = (gbpAhora-gbpAntes)/gbpAntes*100;
    const fuerza = +((cambioEur+cambioGbp)/2).toFixed(3);
    _usdCache = { valor: fuerza, ts: AHORA };
    return fuerza;
  }catch(e){ return null; }
}

async function fetchCapitalFlowContext(){
  try{
    const [stableRes, tvlRes] = await Promise.all([
      fetchJSON('https://stablecoins.llama.fi/stablecoincharts/all'),
      fetchJSON('https://api.llama.fi/v2/historicalChainTvl'),
    ]);
    const stableVals = stableRes.slice(-8).map(r=> r.totalCirculating?.peggedUSD || 0).filter(v=>v>0);
    const tvlVals = tvlRes.slice(-8).map(r=>r.tvl).filter(v=>v>0);
    return {
      stablecoinTrend: classifyTrend(stableVals, 1),
      tvlTrend: classifyTrend(tvlVals, 2),
    };
  }catch(e){ return null; } // DeFiLlama puede estar caído puntualmente; no rompe el análisis
}

// ---- Indicadores adicionales para el panel "Estado de indicadores" ----
function stochRsi(rsiArr, period=14){
  const out = new Array(rsiArr.length).fill(null);
  for(let i=period; i<rsiArr.length; i++){
    const window = rsiArr.slice(i-period+1, i+1).filter(v=>v!=null);
    if(window.length<period) continue;
    const minR = Math.min(...window), maxR = Math.max(...window);
    out[i] = maxR>minR ? ((rsiArr[i]-minR)/(maxR-minR))*100 : 50;
  }
  return out;
}
// Estocástico clásico (%K/%D), a diferencia de stochRsi de arriba que es Estocástico DE RSI —
// este usa directamente los máximos/mínimos de precio, que es "el estocástico" que la mayoría
// de los traders conoce y pide.
function stochasticOscillator(candles, period=14, smoothK=3, smoothD=3){
  const rawK = new Array(candles.length).fill(null);
  for(let i=period-1; i<candles.length; i++){
    const window = candles.slice(i-period+1, i+1);
    const lowestLow = Math.min(...window.map(c=>c.l));
    const highestHigh = Math.max(...window.map(c=>c.h));
    rawK[i] = highestHigh>lowestLow ? ((candles[i].c-lowestLow)/(highestHigh-lowestLow))*100 : 50;
  }
  function sma(arr, n){
    return arr.map((v,i)=>{
      if(i<n-1) return null;
      const w = arr.slice(i-n+1,i+1).filter(x=>x!=null);
      return w.length===n ? w.reduce((a,b)=>a+b,0)/n : null;
    });
  }
  const k = sma(rawK, smoothK);
  const d = sma(k, smoothD);
  return { k, d };
}
// Perfil de liquidez (mismo algoritmo que "Liquidity Pro Map [ChartPrime]", MPL 2.0, portado):
// solo la parte matemática (dominancia + POC), sin dibujar nada — así el bot puede usar el mismo
// cálculo que ya se ve en la pestaña Liquidez de la web, sin duplicar lógica.
// Probabilidad Alcista/Bajista por Volumen (idea de David, basada en un script de Pine): compara
// el volumen acumulado de velas verdes vs rojas en las últimas N velas — si el lado que sube trae
// más volumen que el que baja, hay más probabilidad de continuación en esa dirección. Vive acá (no
// solo en la web) para que el bot pueda usarlo como una señal más el día que haga falta, igual que
// el perfil de liquidez de abajo.
function computeVolumeProbability(candles, lookback=20){
  if(!candles || candles.length<lookback) return null;
  const recent = candles.slice(-lookback);
  let volUp=0, volDown=0;
  recent.forEach(c => { if(c.c>c.o) volUp+=c.v; else if(c.c<c.o) volDown+=c.v; });
  const totalVol = volUp+volDown;
  const probUp = totalVol>0 ? (volUp/totalVol)*100 : 50;
  const window100 = candles.slice(-100);
  const centerPrice = (Math.max(...window100.map(c=>c.h)) + Math.min(...window100.map(c=>c.l))) / 2;
  return { probUp, probDown: 100-probUp, centerPrice };
}

// Detección de pico de volumen anómalo: solo describe lo que el número realmente dice (esta vela
// tuvo X veces el volumen promedio de las anteriores) — sin interpretar "por qué" pasó, porque el
// motivo real (ballenas, un exchange acumulando, alguien liquidando) no se puede saber con este dato solo.
// Detecta divergencia entre precio e indicadores (RSI + MACD juntos, no solo uno).
// Backtesteado en 4 períodos de BTC: la versión que exige AMBOS indicadores de acuerdo da Profit
// Factor 1.07-1.43 y nunca pierde en ningún período, mientras que exigir solo uno da resultados
// muy inconsistentes (PF 0.29 a 1.42). Por eso se exige que RSI y MACD coincidan.
function encontrarPivotes(arr, ventana=5, tipo='min'){
  const pivotes = [];
  for(let i=ventana; i<arr.length-ventana; i++){
    const centro = arr[i];
    if(centro==null) continue;
    let esPivote = true;
    for(let j=i-ventana; j<=i+ventana; j++){
      if(j===i || arr[j]==null) continue;
      if(tipo==='min' && arr[j] < centro){ esPivote=false; break; }
      if(tipo==='max' && arr[j] > centro){ esPivote=false; break; }
    }
    if(esPivote) pivotes.push({idx:i, valor:centro});
  }
  return pivotes;
}

function detectDivergencia(candles, lookback=60){
  if(!candles || candles.length < lookback+10) return null;
  const ventana = candles.slice(-lookback);
  const closes = ventana.map(c=>c.c);
  const lows = ventana.map(c=>c.l);
  const highs = ventana.map(c=>c.h);
  const rsiArr = rsi(closes, 14);
  const histArr = macd(closes).hist;

  const pivotesMin = encontrarPivotes(lows, 5, 'min');
  if(pivotesMin.length >= 2){
    const ult = pivotesMin[pivotesMin.length-1], ant = pivotesMin[pivotesMin.length-2];
    if(ult.valor < ant.valor){
      const rsiUlt=rsiArr[ult.idx], rsiAnt=rsiArr[ant.idx];
      const histUlt=histArr[ult.idx], histAnt=histArr[ant.idx];
      if(rsiUlt!=null && rsiAnt!=null && histUlt!=null && histAnt!=null && rsiUlt>rsiAnt && histUlt>histAnt){
        return { tipo:'alcista', descripcion:'el precio marcó un mínimo más bajo, pero RSI y MACD marcaron mínimos más altos — la caída viene perdiendo fuerza' };
      }
    }
  }
  const pivotesMax = encontrarPivotes(highs, 5, 'max');
  if(pivotesMax.length >= 2){
    const ult = pivotesMax[pivotesMax.length-1], ant = pivotesMax[pivotesMax.length-2];
    if(ult.valor > ant.valor){
      const rsiUlt=rsiArr[ult.idx], rsiAnt=rsiArr[ant.idx];
      const histUlt=histArr[ult.idx], histAnt=histArr[ant.idx];
      if(rsiUlt!=null && rsiAnt!=null && histUlt!=null && histAnt!=null && rsiUlt<rsiAnt && histUlt<histAnt){
        return { tipo:'bajista', descripcion:'el precio marcó un máximo más alto, pero RSI y MACD marcaron máximos más bajos — la subida viene perdiendo fuerza' };
      }
    }
  }
  return null;
}

// Detecta triángulos de compresión: el precio se va apretando entre máximos que bajan y mínimos
// que suben (o uno de los dos plano). Es una señal de que se acumula energía antes de una ruptura,
// sin decir para qué lado va a romper — eso lo define el resto del análisis.
// LIQUIDEZ CERCANA vs DE TEMPORALIDAD MAYOR.
// La liquidez cercana (equal highs/lows recientes, swings locales, bordes de rango chico) es la
// que el precio busca PRIMERO — provoca las reacciones de corto plazo. Una vez consumida, el
// precio suele ir a buscar la liquidez de temporalidad mayor, que está más lejos y mueve más.
// Distinguir entre las dos importa: apuntar a liquidez ya barrida es apuntar a nada.
function detectLiquidezPorHorizonte(candles, lookbackCercano=40, lookbackLejano=200){
  if(!candles || candles.length < 50) return null;
  const precio = candles.at(-1).c;
  const tol = 0.004; // 0,4% de tolerancia para considerar dos niveles "iguales"

  function buscarNiveles(v){
    const arriba = [], abajo = [];
    const maximos = [], minimos = [];
    for(let i=3; i<v.length-3; i++){
      let esMax = true, esMin = true;
      for(let j=i-3; j<=i+3; j++){
        if(j===i) continue;
        if(v[j].h > v[i].h) esMax = false;
        if(v[j].l < v[i].l) esMin = false;
      }
      if(esMax) maximos.push({ precio: v[i].h, idx: i });
      if(esMin) minimos.push({ precio: v[i].l, idx: i });
    }
    // Agrupo niveles parecidos: cuantas más veces se tocó, más liquidez acumulada hay ahí
    function agrupar(lista){
      const grupos = [];
      for(const n of lista){
        const g = grupos.find(x => Math.abs(x.precio - n.precio)/n.precio < tol);
        if(g){ g.toques++; g.ultimoIdx = Math.max(g.ultimoIdx, n.idx); }
        else grupos.push({ precio: n.precio, toques: 1, ultimoIdx: n.idx });
      }
      return grupos.filter(g => g.toques >= 2);
    }
    agrupar(maximos).forEach(g => { if(g.precio > precio) arriba.push(g); });
    agrupar(minimos).forEach(g => { if(g.precio < precio) abajo.push(g); });
    return { arriba, abajo };
  }

  const cercana = buscarNiveles(candles.slice(-lookbackCercano));
  const lejana  = buscarNiveles(candles.slice(-Math.min(lookbackLejano, candles.length)));

  // La liquidez cercana se considera CONSUMIDA si el precio ya la atravesó recientemente
  const ultimas10 = candles.slice(-10);
  const maxReciente = Math.max(...ultimas10.map(c=>c.h));
  const minReciente = Math.min(...ultimas10.map(c=>c.l));

  const masCercana = (arr, esArriba) => arr.length
    ? arr.reduce((a,b) => Math.abs(b.precio-precio) < Math.abs(a.precio-precio) ? b : a)
    : null;

  const cercanaArriba = masCercana(cercana.arriba, true);
  const cercanaAbajo  = masCercana(cercana.abajo, false);
  const lejanaArriba  = masCercana(lejana.arriba.filter(g => !cercana.arriba.some(c => Math.abs(c.precio-g.precio)/g.precio < tol)), true);
  const lejanaAbajo   = masCercana(lejana.abajo.filter(g => !cercana.abajo.some(c => Math.abs(c.precio-g.precio)/g.precio < tol)), false);

  return {
    cercanaArriba: cercanaArriba ? { ...cercanaArriba, consumida: maxReciente >= cercanaArriba.precio, distPct: (cercanaArriba.precio-precio)/precio*100 } : null,
    cercanaAbajo:  cercanaAbajo  ? { ...cercanaAbajo,  consumida: minReciente <= cercanaAbajo.precio,  distPct: (precio-cercanaAbajo.precio)/precio*100 } : null,
    lejanaArriba:  lejanaArriba  ? { ...lejanaArriba,  distPct: (lejanaArriba.precio-precio)/precio*100 } : null,
    lejanaAbajo:   lejanaAbajo   ? { ...lejanaAbajo,   distPct: (precio-lejanaAbajo.precio)/precio*100 } : null,
  };
}

// ZONAS DE OFERTA / DEMANDA (la "caja gris"): el rango de precios desde donde el mercado ya
// reaccionó con fuerza antes. No es un nivel fino sino una ZONA — el precio suele volver a
// reaccionar al entrar ahí. Se detectan por velas de rechazo fuerte (mecha larga contra el cuerpo)
// seguidas de un movimiento decidido en la dirección contraria.
function detectZonasOfertaDemanda(candles, lookback=100, maxZonas=2){
  if(!candles || candles.length < 30) return { oferta: [], demanda: [] };
  const v = candles.slice(-Math.min(lookback, candles.length));
  const precioActual = candles.at(-1).c;
  const oferta = [], demanda = [];

  for(let i = 3; i < v.length - 3; i++){
    const c = v[i];
    const cuerpo = Math.abs(c.c - c.o);
    const rango = c.h - c.l;
    if(rango <= 0) continue;
    const mechaArriba = c.h - Math.max(c.o, c.c);
    const mechaAbajo = Math.min(c.o, c.c) - c.l;

    // OFERTA: subió hasta acá, fue rechazado con fuerza y cayó. Zona = mecha de rechazo.
    if(mechaArriba > cuerpo*1.2 && mechaArriba/rango > 0.35 && v[i+1].c < c.l && v[i+2].c < c.l){
      const piso = Math.max(c.o, c.c);
      if(piso > precioActual) oferta.push({ techo: c.h, piso, fuerza: mechaArriba/rango });
    }
    // DEMANDA: bajó hasta acá, fue comprado con fuerza y subió.
    if(mechaAbajo > cuerpo*1.2 && mechaAbajo/rango > 0.35 && v[i+1].c > c.h && v[i+2].c > c.h){
      const techo = Math.min(c.o, c.c);
      if(techo < precioActual) demanda.push({ techo, piso: c.l, fuerza: mechaAbajo/rango });
    }
  }
  const cercanas = (arr, ref) => arr
    .sort((a,b) => Math.abs(a[ref]-precioActual) - Math.abs(b[ref]-precioActual))
    .slice(0, maxZonas);
  return { oferta: cercanas(oferta,'piso'), demanda: cercanas(demanda,'techo') };
}

// Máximos y mínimos estructurales. El MÁS IMPORTANTE no es el último sino el más extremo: ahí es
// donde hay más stops acumulados, y si el precio lo barre y revierte, esa operación pesa más que
// una ruptura cualquiera.
function detectNivelesEstructurales(candles, lookback=120){
  if(!candles || candles.length < 30) return { maximos: [], minimos: [], maxImportante: null, minImportante: null };
  const v = candles.slice(-Math.min(lookback, candles.length));
  const pivotes = (arr, tipo, ventana=5) => {
    const out = [];
    for(let i=ventana; i<arr.length-ventana; i++){
      let ok = true;
      for(let j=i-ventana; j<=i+ventana; j++){
        if(j===i) continue;
        if(tipo==='max' && arr[j] > arr[i]){ ok=false; break; }
        if(tipo==='min' && arr[j] < arr[i]){ ok=false; break; }
      }
      if(ok) out.push({ valor: arr[i], idx: i });
    }
    return out;
  };
  const maximos = pivotes(v.map(c=>c.h), 'max');
  const minimos = pivotes(v.map(c=>c.l), 'min');
  return {
    maximos: maximos.slice(-4),
    minimos: minimos.slice(-4),
    maxImportante: maximos.length ? maximos.reduce((a,b)=> b.valor>a.valor?b:a) : null,
    minImportante: minimos.length ? minimos.reduce((a,b)=> b.valor<a.valor?b:a) : null,
  };
}

// ═══ MARKET PHASE ═══
// Clasifica en qué etapa del ciclo está la moneda. Un mismo score de 8 significa cosas muy
// distintas según la fase: comprar en expansión temprana no es lo mismo que comprar en clímax.
// Caso concreto: BICO tenía Tendencia+Momentum+SmartMoney a favor y el bot dio LONG — pero venía
// de +674%, o sea fase de clímax/distribución, el peor momento posible para comprar.
// NO suma ni resta al score: es contexto para leer el score con criterio.
function detectMarketPhase(candles){
  if(!candles || candles.length < 100) return { fase:'DESCONOCIDA', motivo:'Historial insuficiente para clasificar.' };
  const closes = candles.map(c=>c.c);
  const precio = closes.at(-1);
  const adxVal = adx(candles);
  const v100 = candles.slice(-100);
  const max100 = Math.max(...v100.map(c=>c.h));
  const min100 = Math.min(...v100.map(c=>c.l));
  const rango = (max100-min100)/min100*100;
  const posicion = (precio-min100)/(max100-min100||1); // 0 = piso, 1 = techo

  // Subida acumulada reciente: distingue expansión sana de movimiento parabólico
  const v24 = candles.slice(-96);
  const minReciente = Math.min(...v24.map(c=>c.l));
  const subidaReciente = (precio-minReciente)/minReciente*100;

  // Volumen: creciente indica participación real, decreciente indica agotamiento
  const volPrimera = v100.slice(0,50).reduce((s,c)=>s+c.v,0)/50;
  const volUltima = v100.slice(-50).reduce((s,c)=>s+c.v,0)/50;
  const volCreciendo = volUltima > volPrimera*1.15;
  const volCayendo = volUltima < volPrimera*0.85;

  const e50 = ema(closes,50).at(-1), e200 = ema(closes, Math.min(200, closes.length-1)).at(-1);
  const enTendenciaAlcista = precio > e50 && e50 > e200;
  const enTendenciaBajista = precio < e50 && e50 < e200;

  // CLÍMAX: subida vertical con volumen que ya no acompaña — el movimiento se agota
  if(subidaReciente >= 60 && posicion > 0.8){
    return { fase:'CLÍMAX', emoji:'🔥', motivo:`Subió ${subidaReciente.toFixed(0)}% en 24hs y está en la parte alta del rango. El movimiento ya se hizo; comprar acá es comprar el techo.`, favorable:'ninguna', riesgoLong:true };
  }
  // CAPITULACIÓN: caída vertical
  if(posicion < 0.2 && enTendenciaBajista){
    const caida = (max100-precio)/max100*100;
    if(caida >= 40) return { fase:'CAPITULACIÓN', emoji:'🩸', motivo:`Cayó ${caida.toFixed(0)}% desde el máximo y está en el piso del rango. Vender acá es vender el piso.`, favorable:'ninguna', riesgoShort:true };
  }
  // DISTRIBUCIÓN: arriba del rango, sin fuerza y con volumen cayendo
  if(posicion > 0.7 && volCayendo && (adxVal==null || adxVal < 25)){
    return { fase:'DISTRIBUCIÓN', emoji:'🟠', motivo:'Precio en la parte alta del rango pero el volumen viene cayendo y la tendencia perdió fuerza: puede estar repartiéndose la posición antes de una caída.', favorable:'SHORT' };
  }
  // ACUMULACIÓN: abajo del rango, lateral, volumen apareciendo
  if(posicion < 0.35 && (adxVal==null || adxVal < 22)){
    return { fase:'ACUMULACIÓN', emoji:'🟡', motivo:`Precio en la parte baja de un rango de ${rango.toFixed(0)}% sin tendencia definida${volCreciendo?', con volumen empezando a aparecer':''}: puede estarse armando una posición antes de una subida.`, favorable:'LONG' };
  }
  // EXPANSIÓN: tendencia clara con fuerza
  if(adxVal!=null && adxVal >= 25){
    if(enTendenciaAlcista) return { fase:'EXPANSIÓN ALCISTA', emoji:'🟢', motivo:`Tendencia alcista con fuerza (ADX ${adxVal.toFixed(0)})${volCreciendo?' y volumen acompañando':''}. Los retrocesos suelen ser oportunidad de compra.`, favorable:'LONG' };
    if(enTendenciaBajista) return { fase:'MARKDOWN', emoji:'🔴', motivo:`Tendencia bajista con fuerza (ADX ${adxVal.toFixed(0)}). Los rebotes suelen ser oportunidad de venta.`, favorable:'SHORT' };
  }
  return { fase:'RANGO', emoji:'⚪', motivo:`Sin tendencia definida (ADX ${adxVal!=null?adxVal.toFixed(0):'—'}), moviéndose dentro de un rango de ${rango.toFixed(0)}%. Conviene operar los bordes, no el medio.`, favorable:'bordes del rango' };
}

function detectTrianguloCompresion(candles, lookback=50){
  if(!candles || candles.length < lookback) return null;
  const ventana = candles.slice(-lookback);
  const highs = ventana.map(c=>c.h);
  const lows = ventana.map(c=>c.l);

  const pivotesMax = encontrarPivotes(highs, 4, 'max');
  const pivotesMin = encontrarPivotes(lows, 4, 'min');
  if(pivotesMax.length < 2 || pivotesMin.length < 2) return null;

  const maxUlt = pivotesMax[pivotesMax.length-1], maxAnt = pivotesMax[pivotesMax.length-2];
  const minUlt = pivotesMin[pivotesMin.length-1], minAnt = pivotesMin[pivotesMin.length-2];

  const techoBaja = maxUlt.valor < maxAnt.valor;
  const pisoSube = minUlt.valor > minAnt.valor;
  const techoPlano = Math.abs(maxUlt.valor-maxAnt.valor)/maxAnt.valor < 0.01;
  const pisoPlano = Math.abs(minUlt.valor-minAnt.valor)/minAnt.valor < 0.01;

  // El rango tiene que estar realmente achicándose para llamarlo compresión
  const rangoAntes = maxAnt.valor - minAnt.valor;
  const rangoAhora = maxUlt.valor - minUlt.valor;
  if(rangoAntes<=0 || rangoAhora >= rangoAntes*0.85) return null;

  const compresionPct = (1 - rangoAhora/rangoAntes) * 100;
  let tipo = null;
  if(techoBaja && pisoSube) tipo = 'simétrico';
  else if(techoPlano && pisoSube) tipo = 'ascendente';
  else if(techoBaja && pisoPlano) tipo = 'descendente';
  if(!tipo) return null;

  return {
    tipo, compresionPct,
    techo: maxUlt.valor, piso: minUlt.valor,
    descripcion: tipo==='simétrico'
      ? `triángulo simétrico: los máximos vienen bajando y los mínimos subiendo, el rango se comprimió un ${compresionPct.toFixed(0)}% — se está acumulando energía, pero todavía no define para qué lado rompe`
      : tipo==='ascendente'
      ? `triángulo ascendente: el techo se mantiene plano (~$${fmtPrecio(maxUlt.valor)}) mientras los mínimos suben — presión compradora empujando contra una resistencia fija`
      : `triángulo descendente: el piso se mantiene plano (~$${fmtPrecio(minUlt.valor)}) mientras los máximos bajan — presión vendedora empujando contra un soporte fijo`
  };
}

// Analiza hacia dónde es más probable que rompa un patrón de compresión, combinando 3 cosas
// medibles: dónde está la liquidez (el precio tiende a ir a buscarla), qué fuerza muestra el
// volumen de cada lado, y si el volumen viene subiendo (energía acumulándose para la ruptura).
// IMPORTANTE: esto da una probabilidad, no una certeza — un triángulo puede romper para
// cualquier lado, y el objetivo es medir hacia dónde se inclinan las señales, no adivinar.
function analizarRupturaCompresion(candles, triangulo){
  if(!triangulo || !candles || candles.length<60) return null;

  const señales = [];
  let puntajeArriba = 0, puntajeAbajo = 0;

  // 1) LIQUIDEZ: dónde está concentrada — el precio suele ir a buscarla
  const precio = candles.at(-1).c;
  const liq = computeLiquidityProfile(candles, precio, 100);
  if(liq){
    if(liq.domUpPct > liq.domDownPct + 10){
      puntajeArriba += 1;
      señales.push(`la liquidez está concentrada arriba (${liq.domUpPct.toFixed(0)}% vs ${liq.domDownPct.toFixed(0)}%), y el precio tiende a ir a buscarla`);
    } else if(liq.domDownPct > liq.domUpPct + 10){
      puntajeAbajo += 1;
      señales.push(`la liquidez está concentrada abajo (${liq.domDownPct.toFixed(0)}% vs ${liq.domUpPct.toFixed(0)}%), y el precio tiende a ir a buscarla`);
    }
  }

  // 2) FUERZA: qué lado domina el volumen de las últimas velas
  const volProb = computeVolumeProbability(candles, 20);
  if(volProb){
    if(volProb.probUp >= 58){
      puntajeArriba += 1;
      señales.push(`la fuerza del volumen viene del lado comprador (${volProb.probUp.toFixed(0)}%)`);
    } else if(volProb.probDown >= 58){
      puntajeAbajo += 1;
      señales.push(`la fuerza del volumen viene del lado vendedor (${volProb.probDown.toFixed(0)}%)`);
    }
  }

  // 3) VOLUMEN CRECIENTE: energía acumulándose (no dice el lado, pero sí que la ruptura se acerca)
  const vols = candles.slice(-20).map(c=>c.v);
  const volPrimeraMitad = vols.slice(0,10).reduce((s,v)=>s+v,0)/10;
  const volSegundaMitad = vols.slice(10).reduce((s,v)=>s+v,0)/10;
  const volumenCreciendo = volSegundaMitad > volPrimeraMitad*1.2;
  if(volumenCreciendo) señales.push(`el volumen viene creciendo (${(volSegundaMitad/volPrimeraMitad).toFixed(1)}x), señal de que la ruptura puede estar cerca`);

  // 4) El tipo de triángulo también inclina la balanza — pero SOLO el ascendente, no el descendente.
  // Probado contra 3 períodos reales de BTC: el ascendente acierta 65.2% y el simétrico 62.3%,
  // pero el descendente solo 45% (peor que tirar una moneda). O sea, la regla clásica de "el
  // triángulo descendente rompe hacia abajo" NO se sostiene con datos. Sacándole ese sesgo
  // automático, la precisión general sube de 59.4% a 63.2% — el descendente se decide solo por
  // liquidez, fuerza y volumen, que sí son medibles.
  if(triangulo.tipo==='ascendente'){ puntajeArriba += 1; señales.push('el triángulo ascendente (techo plano, mínimos subiendo) suele romper hacia arriba'); }

  const total = puntajeArriba + puntajeAbajo;
  let sesgo = 'indefinido', confianza = 0;
  if(total>0){
    if(puntajeArriba > puntajeAbajo){ sesgo='arriba'; confianza = Math.round(puntajeArriba/total*100); }
    else if(puntajeAbajo > puntajeArriba){ sesgo='abajo'; confianza = Math.round(puntajeAbajo/total*100); }
    else { sesgo='parejo'; confianza = 50; }
  }

  return {
    sesgo, confianza, señales, volumenCreciendo,
    nivelRupturaArriba: triangulo.techo,
    nivelRupturaAbajo: triangulo.piso,
    resumen: sesgo==='indefinido' || sesgo==='parejo'
      ? `las señales están parejas — no hay una inclinación clara hacia ningún lado todavía. Conviene esperar a que rompa de verdad ${triangulo.techo?`$${fmtPrecio(triangulo.techo)}`:'el techo'} o ${triangulo.piso?`$${fmtPrecio(triangulo.piso)}`:'el piso'} antes de tomar posición.`
      : `las señales se inclinan hacia una ruptura ${sesgo} (${confianza}% de las señales apuntan ahí): ${señales.join('; ')}. El nivel a vigilar es ${sesgo==='arriba'?`$${fmtPrecio(triangulo.techo)}`:`$${fmtPrecio(triangulo.piso)}`} — recién con una ruptura real de ese nivel se confirmaría.`
  };
}

function detectVolumeSpike(candles, lookback=30, umbralMultiplo=5){
  if(!candles || candles.length < lookback+1) return null;
  const previas = candles.slice(-lookback-1, -1);
  const actual = candles[candles.length-1];
  const promedioPrevio = previas.reduce((s,c)=>s+c.v, 0) / previas.length;
  if(promedioPrevio<=0) return null;
  const multiplo = actual.v / promedioPrevio;
  if(multiplo < umbralMultiplo) return null;
  const movimientoPrecioPct = Math.abs(actual.c-actual.o)/actual.o*100;
  return { multiplo, volumenActual: actual.v, promedioPrevio, movimientoPrecioPct, precioEstable: movimientoPrecioPct < 2 };
}

function computeLiquidityProfile(candles, price, lookback=200){
  const recent = candles.slice(-Math.min(lookback, candles.length));
  const closes = candles.map(c=>c.c);
  function stdevAt(idx){
    const w = closes.slice(Math.max(0,idx-24), idx+1);
    if(w.length<2) return 0;
    const mean = w.reduce((a,b)=>a+b,0)/w.length;
    return Math.sqrt(w.reduce((a,b)=>a+(b-mean)**2,0)/w.length);
  }
  const priceRefs = recent.map((c,i)=>{
    const globalIdx = closes.length - recent.length + i;
    const dev = stdevAt(globalIdx) * 2;
    return c.c > c.o ? c.l - dev : c.h + dev;
  });
  const minP = Math.min(...priceRefs), maxP = Math.max(...priceRefs);
  const nBins = 90; // subido de 60 a 90 para más detalle/resolución en el perfil de volumen
  const priceStep = (maxP-minP)/nBins || 1;
  const bins = Array.from({length:nBins},()=>0);
  recent.forEach((c,i)=>{
    const bin = Math.min(nBins-1, Math.max(0, Math.floor((priceRefs[i]-minP)/priceStep)));
    const binMid = minP + bin*priceStep + priceStep/2;
    if(Math.abs(price-binMid) < priceStep*2) return;
    bins[bin] += c.v;
  });
  let sellTotal=0, buyTotal=0, pocSell=null, pocBuy=null;
  for(let b=0;b<nBins;b++){
    const binMid = minP + b*priceStep + priceStep/2;
    if(binMid > price){ sellTotal+=bins[b]; if(!pocSell || bins[b]>pocSell.v) pocSell={price:binMid,v:bins[b],bin:b}; }
    else { buyTotal+=bins[b]; if(!pocBuy || bins[b]>pocBuy.v) pocBuy={price:binMid,v:bins[b],bin:b}; }
  }
  const totalVol = sellTotal+buyTotal || 1;

  // Toques reales por nivel: cuántas velas distintas (de las últimas 200) tocaron cada uno de los
  // 90 niveles — una frecuencia de toques real, más fina que solo Equal Highs/Lows/Order Blocks
  // nombrados. Antes esto vivía solo en la web (para el color del histograma); ahora es parte del
  // motor compartido, así el bot también puede usarlo como señal, no solo la web para dibujar.
  const touchCount = Array.from({length:nBins},()=>0);
  recent.forEach(c=>{
    const binLowIdx = Math.max(0, Math.floor((c.l-minP)/priceStep));
    const binHighIdx = Math.min(nBins-1, Math.floor((c.h-minP)/priceStep));
    for(let bi=binLowIdx; bi<=binHighIdx; bi++) touchCount[bi]++;
  });

  // ---- Área de Valor: VAH / VAL / POC global ----
  // Definición estándar del Volume Profile: el Área de Valor es el rango de precios donde se negoció
  // el 70% del volumen total. Se arranca del POC (el nivel de MÁS volumen de todos) y se va sumando
  // hacia arriba y hacia abajo, tomando siempre el lado con más volumen, hasta llegar al 70%.
  // - Dentro del Área de Valor el precio se mueve lento (mucha negociación, HVN).
  // - Fuera, en los huecos de bajo volumen (LVN), el precio suele moverse rápido.
  let pocGlobalIdx = 0;
  for(let b=1;b<nBins;b++){ if(bins[b] > bins[pocGlobalIdx]) pocGlobalIdx = b; }
  let volAcumulado = bins[pocGlobalIdx];
  let idxArriba = pocGlobalIdx, idxAbajo = pocGlobalIdx;
  const objetivo70 = totalVol * 0.7;
  while(volAcumulado < objetivo70 && (idxAbajo > 0 || idxArriba < nBins-1)){
    const volSiguienteArriba = idxArriba < nBins-1 ? bins[idxArriba+1] : -1;
    const volSiguienteAbajo  = idxAbajo > 0 ? bins[idxAbajo-1] : -1;
    if(volSiguienteArriba >= volSiguienteAbajo && idxArriba < nBins-1){ idxArriba++; volAcumulado += bins[idxArriba]; }
    else if(idxAbajo > 0){ idxAbajo--; volAcumulado += bins[idxAbajo]; }
    else break;
  }
  const pocPrice = minP + (pocGlobalIdx+0.5)*priceStep;
  const vah = minP + (idxArriba+1)*priceStep;
  const val = minP + idxAbajo*priceStep;
  // Nodos de bajo volumen (LVN): bins con menos del 20% del volumen del POC — zonas donde el precio
  // suele atravesar rápido porque casi no hubo negociación ahí.
  const lvnLevels = [];
  for(let b=0;b<nBins;b++){
    if(bins[b] > 0 && bins[b] < bins[pocGlobalIdx]*0.2){
      lvnLevels.push(minP + (b+0.5)*priceStep);
    }
  }

  return {
    domUpPct: sellTotal/totalVol*100, domDownPct: buyTotal/totalVol*100,
    pocAbove: pocSell, pocBelow: pocBuy,
    // Área de Valor (Volume Profile clásico): POC global, VAH, VAL y nodos de bajo volumen.
    poc: pocPrice, vah, val,
    dentroDelAreaDeValor: price >= val && price <= vah,
    posicionRelativa: price > vah ? 'sobre el VAH (caro respecto al área de valor)' : price < val ? 'bajo el VAL (barato respecto al área de valor)' : 'dentro del área de valor',
    lvnLevels,
    // Se exponen también los bins crudos (con su rango de precio) para que quien necesite DIBUJAR
    // el perfil (como la pestaña Liquidez de la web) use esta misma función en vez de recalcular
    // todo de nuevo por su cuenta — antes la web tenía una copia duplicada de este cálculo.
    bins, minP, maxP, priceStep, nBins, touchCount,
  };
}
function mfi(candles, period=14){
  const typical = candles.map(c=>(c.h+c.l+c.c)/3);
  const mf = typical.map((t,i)=> i===0?0:t*candles[i].v);
  let posFlow=0, negFlow=0;
  const start = Math.max(1, candles.length-period);
  for(let i=start;i<candles.length;i++){
    if(typical[i]>typical[i-1]) posFlow+=mf[i]; else if(typical[i]<typical[i-1]) negFlow+=mf[i];
  }
  if(negFlow===0) return 100;
  const mr = posFlow/negFlow;
  return 100 - (100/(1+mr));
}
function obvSeries(candles){
  const out=[0];
  for(let i=1;i<candles.length;i++){
    const prev = out[i-1];
    out.push(candles[i].c>candles[i-1].c ? prev+candles[i].v : candles[i].c<candles[i-1].c ? prev-candles[i].v : prev);
  }
  return out;
}
function adx(candles, period=14){
  if(candles.length<period*2) return null;
  const plusDM=[], minusDM=[], trArr=[];
  for(let i=1;i<candles.length;i++){
    const upMove = candles[i].h-candles[i-1].h, downMove = candles[i-1].l-candles[i].l;
    plusDM.push(upMove>downMove && upMove>0 ? upMove : 0);
    minusDM.push(downMove>upMove && downMove>0 ? downMove : 0);
    trArr.push(Math.max(candles[i].h-candles[i].l, Math.abs(candles[i].h-candles[i-1].c), Math.abs(candles[i].l-candles[i-1].c)));
  }
  const smooth = arr => ema(arr, period);
  const trSm = smooth(trArr), plusSm = smooth(plusDM), minusSm = smooth(minusDM);
  const dx = trSm.map((tr,i)=>{
    const pdi = tr? (plusSm[i]/tr)*100 : 0, mdi = tr? (minusSm[i]/tr)*100 : 0;
    const sum = pdi+mdi;
    return sum? (Math.abs(pdi-mdi)/sum)*100 : 0;
  });
  return ema(dx, period).at(-1);
}
function cci(candles, period=20){
  const typical = candles.map(c=>(c.h+c.l+c.c)/3);
  const smaT = sma(typical, period);
  const last = smaT.at(-1);
  if(last==null) return null;
  const window = typical.slice(-period);
  const meanDev = window.reduce((s,v)=>s+Math.abs(v-last),0)/period;
  return meanDev? (typical.at(-1)-last)/(0.015*meanDev) : 0;
}
function roc(values, period=12){
  if(values.length<=period) return null;
  const prev = values[values.length-1-period];
  return prev? ((values.at(-1)-prev)/prev)*100 : 0;
}

function findSupportResistance(candles, lookback=40){
  const recent = candles.slice(-lookback);
  return { support: Math.min(...recent.map(c=>c.l)), resistance: Math.max(...recent.map(c=>c.h)) };
}

// Complementa a findSupportResistance: esa función agarra el máximo/mínimo de TODA la ventana,
// lo que puede saltarse una zona de oferta/demanda más chica pero más CERCANA al precio actual
// (como una resistencia reciente de rango, no el techo histórico de 40 velas). Acá buscamos el
// pivot más cercano al precio actual, dando prioridad a "cerca" por sobre "el extremo absoluto".
function findNearbyLevel(pivots, price, type, recentPivotsCount=8){
  const candidates = (pivots||[]).filter(p=>p.type===type).slice(-recentPivotsCount);
  if(!candidates.length) return null;
  const relevant = type==='high' ? candidates.filter(p=>p.price>=price) : candidates.filter(p=>p.price<=price);
  const pool = relevant.length ? relevant : candidates; // si no hay ninguno del lado correcto, usamos el más reciente igual
  return pool.reduce((closest, p) => Math.abs(p.price-price) < Math.abs(closest.price-price) ? p : closest);
}
// Cuenta cuántas veces el precio "tocó" un nivel (dentro de una tolerancia) en el historial reciente -> fuerza del nivel
function levelStrength(candles, level, lookback=80, tolPct=0.006){
  const recent = candles.slice(-lookback);
  const tol = level*tolPct;
  let touches = 0;
  recent.forEach(c=>{ if(Math.abs(c.h-level)<=tol || Math.abs(c.l-level)<=tol) touches++; });
  return {touches, score: Math.min(100, touches*18)};
}

// Patrón de "fuerza en tests sucesivos": cuenta cada vez que el precio tocó un nivel (resistencia o
// soporte) y mide qué tan fuerte fue el rechazo cada vez. Si el rechazo se va debilitando test tras
// test, el nivel probablemente rompa pronto. Si se va fortaleciendo, el nivel está sólido.
function analyzeLevelTests(candles, level, isResistance, lookback=80, tolPct=0.006){
  const recent = candles.slice(-lookback);
  const tol = level*tolPct;
  const touches = [];
  for(const c of recent){
    const touched = isResistance ? Math.abs(c.h-level)<=tol : Math.abs(c.l-level)<=tol;
    if(!touched) continue;
    // Rechazo: qué tan lejos cerró la vela del nivel, en la dirección "defendida" por el nivel.
    const rejection = isResistance ? Math.max(0, (level-c.c)/level) : Math.max(0, (c.c-level)/level);
    touches.push(rejection);
  }
  if(touches.length<2) return {testCount:touches.length, weakening:false, strengthening:false};
  let weakening=true, strengthening=true;
  for(let i=1;i<touches.length;i++){
    if(touches[i] >= touches[i-1]) weakening=false;
    if(touches[i] <= touches[i-1]) strengthening=false;
  }
  return {testCount:touches.length, weakening, strengthening, lastRejection:touches.at(-1)};
}

// ---- Patrón compuesto: Acumulación + Test Pumps + Bear Trap ("Buy here") ----
// El patrón: el precio pasa mucho tiempo en un rango (acumulación), testea la resistencia varias
// veces SIN romperla ("test pumps" fallidos), y recién ahí aparece una barrida por debajo del
// soporte del rango (bear trap) que rechaza fuerte — ESE es el punto de entrada, no un sweep
// aislado cualquiera. Es más específico y más confiable que un bear trap suelto, porque confirma
// que hubo un rango real construyéndose antes.
function detectAccumulationBearTrap(candles){
  const lookback = Math.min(150, candles.length);
  if(lookback<40) return {patternDetected:false};
  const recent = candles.slice(-lookback);
  const preSweep = recent.slice(0, -15); // el rango se mide ANTES de la barrida reciente, para no inflarlo con la propia mecha
  if(preSweep.length<25) return {patternDetected:false};
  const rangeHigh = Math.max(...preSweep.map(c=>c.h));
  const rangeLow = Math.min(...preSweep.map(c=>c.l));
  const rangeWidthPct = (rangeHigh-rangeLow)/rangeLow;
  const isAccumulation = rangeWidthPct < 0.35; // rango relativamente angosto sostenido en el tiempo

  const testPumps = analyzeLevelTests(candles, rangeHigh, true, lookback, 0.02); // tests fallidos contra la resistencia del rango
  const sweep = detectLiquiditySweep(candles, 15); // barrida reciente

  const patternDetected = isAccumulation && testPumps.testCount>=2 && sweep.sweptDown;
  return { patternDetected, isAccumulation, rangeHigh, rangeLow, rangeWidthPct, testPumpCount: testPumps.testCount, sweep };
}

// Espejo para SHORT: Distribución (rango) + varios "test dumps" fallidos contra el soporte +
// un Bull Trap (barrida por encima de la resistencia del rango) = señal de venta.
function detectDistributionBullTrap(candles){
  const lookback = Math.min(150, candles.length);
  if(lookback<40) return {patternDetected:false};
  const recent = candles.slice(-lookback);
  const preSweep = recent.slice(0, -15);
  if(preSweep.length<25) return {patternDetected:false};
  const rangeHigh = Math.max(...preSweep.map(c=>c.h));
  const rangeLow = Math.min(...preSweep.map(c=>c.l));
  const rangeWidthPct = (rangeHigh-rangeLow)/rangeLow;
  const isDistribution = rangeWidthPct < 0.35;

  const testDumps = analyzeLevelTests(candles, rangeLow, false, lookback, 0.02);
  const sweep = detectLiquiditySweep(candles, 15);

  const patternDetected = isDistribution && testDumps.testCount>=2 && sweep.sweptUp;
  return { patternDetected, isDistribution, rangeHigh, rangeLow, rangeWidthPct, testDumpCount: testDumps.testCount, sweep };
}

// ---------- Market structure (SMC) engine ----------
function findPivots(candles, k=3){
  const pivots = [];
  for(let i=k;i<candles.length-k;i++){
    const windowSlice = candles.slice(i-k,i+k+1);
    const isHigh = candles[i].h === Math.max(...windowSlice.map(c=>c.h));
    const isLow = candles[i].l === Math.min(...windowSlice.map(c=>c.l));
    if(isHigh) pivots.push({i, price:candles[i].h, type:'high'});
    else if(isLow) pivots.push({i, price:candles[i].l, type:'low'});
  }
  return pivots;
}

function labelSwings(pivots){
  let lastHigh=null, lastLow=null;
  return pivots.map(p=>{
    let label='';
    if(p.type==='high'){ label = (lastHigh!=null && p.price>lastHigh) ? 'HH' : (lastHigh!=null? 'LH':'H'); lastHigh=p.price; }
    else { label = (lastLow!=null && p.price>lastLow) ? 'HL' : (lastLow!=null? 'LL':'L'); lastLow=p.price; }
    return {...p, label};
  });
}

function detectStructureEvents(candles, labeledPivots){
  const highs = labeledPivots.filter(p=>p.type==='high');
  const lows = labeledPivots.filter(p=>p.type==='low');
  const lastHighs = highs.slice(-2), lastLows = lows.slice(-2);
  let trendStructure = 'range';
  if(lastHighs.length===2 && lastLows.length===2){
    const bull = lastHighs[1].label==='HH' && lastLows[1].label==='HL';
    const bear = lastHighs[1].label==='LH' && lastLows[1].label==='LL';
    trendStructure = bull ? 'bull' : bear ? 'bear' : 'range';
  }
  const price = candles.at(-1).c;
  const lastSwingHigh = highs.at(-1)?.price ?? null;
  const lastSwingLow = lows.at(-1)?.price ?? null;
  let bos=null, choch=null;
  if(trendStructure==='bull' && lastSwingHigh!=null && price>lastSwingHigh) bos='bullish';
  if(trendStructure==='bear' && lastSwingLow!=null && price<lastSwingLow) bos='bearish';
  if(trendStructure==='bull' && lastSwingLow!=null && price<lastSwingLow) choch='bearish';
  if(trendStructure==='bear' && lastSwingHigh!=null && price>lastSwingHigh) choch='bullish';
  return {trendStructure, bos, choch, lastSwingHigh, lastSwingLow};
}

function detectOrderBlocks(candles, atrArr, lookback=60){
  const start = Math.max(1, candles.length-lookback);
  let bullishOB=null, bearishOB=null;
  for(let i=start;i<candles.length;i++){
    const c = candles[i], prev = candles[i-1];
    const atrV = atrArr[i] || 1e-9;
    const displacement = Math.abs(c.c-c.o);
    if(displacement > atrV*1.5){
      if(c.c>c.o && prev.c<prev.o){ bullishOB = {idx:i-1, top:prev.h, bottom:prev.l}; }
      if(c.c<c.o && prev.c>prev.o){ bearishOB = {idx:i-1, top:prev.h, bottom:prev.l}; }
    }
  }
  return {bullishOB, bearishOB};
}

// Doble Techo / Doble Suelo (Mind Math Money): 2 toques cerca del mismo nivel, separados en el
// tiempo. Probado con backtest real hoy: funciona bien A FAVOR de la tendencia dominante del
// período (profit factor 1.4-1.7), y mal en contra (0.7-0.9) — por eso el motor lo usa como señal
// de estructura nomás, y es el filtro de tendencia macro (EMA200) el que decide si pesa a favor o
// se ignora, no esta función.
function detectDoubleTopBottom(candles, tolerancia=0.015, lookback=40, minSeparacion=5){
  if(candles.length<lookback+1) return {dobleTecho:false, dobleSuelo:false};
  const window = candles.slice(-lookback-1, -1); // sin contar la última vela (todavía en formación)
  const maxH = Math.max(...window.map(c=>c.h));
  const minL = Math.min(...window.map(c=>c.l));
  const toquesArriba = window.map((c,i)=>({i,ok:Math.abs(c.h-maxH)/maxH<tolerancia})).filter(x=>x.ok).map(x=>x.i);
  const toquesAbajo = window.map((c,i)=>({i,ok:Math.abs(c.l-minL)/minL<tolerancia})).filter(x=>x.ok).map(x=>x.i);
  const dobleTecho = toquesArriba.length>=2 && (toquesArriba.at(-1)-toquesArriba[0])>=minSeparacion;
  const dobleSuelo = toquesAbajo.length>=2 && (toquesAbajo.at(-1)-toquesAbajo[0])>=minSeparacion;
  return {dobleTecho, dobleSuelo, nivelTecho:maxH, nivelSuelo:minL};
}


function detectFVG(candles, lookback=60){
  const start = Math.max(2, candles.length-lookback);
  const gaps = [];
  for(let i=start;i<candles.length;i++){
    const c1=candles[i-2], c3=candles[i];
    if(c1.h < c3.l){ gaps.push({type:'bull', top:c3.l, bottom:c1.h, idx:i-1}); }
    if(c1.l > c3.h){ gaps.push({type:'bear', top:c1.l, bottom:c3.h, idx:i-1}); }
  }
  const price = candles.at(-1).c;
  const unfilled = gaps.filter(g=>{
    for(let j=g.idx+1;j<candles.length;j++){
      if(candles[j].l <= g.top && candles[j].h >= g.bottom) return false;
    }
    return true;
  });
  return unfilled.slice(-2);
}

// IFVG (Inverse Fair Value Gap): cuando un imbalance es ATRAVESADO por completo, cambia de rol.
// Un FVG alcista que el precio perfora hacia abajo deja de ser soporte y pasa a ser resistencia —
// los que compraron ahí quedaron atrapados y venden al volver al nivel. Y al revés para el bajista.
// Es de las zonas más confiables porque hay órdenes atrapadas defendiéndola.
function detectIFVG(candles, lookback=80){
  if(!candles || candles.length < 10) return [];
  const start = Math.max(2, candles.length-lookback);
  const gaps = [];
  for(let i=start;i<candles.length;i++){
    const c1=candles[i-2], c3=candles[i];
    if(c1.h < c3.l) gaps.push({type:'bull', top:c3.l, bottom:c1.h, idx:i-1});
    if(c1.l > c3.h) gaps.push({type:'bear', top:c1.l, bottom:c3.h, idx:i-1});
  }
  const price = candles.at(-1).c;
  const invertidos = [];
  for(const g of gaps){
    // ¿Alguna vela POSTERIOR cerró completamente del otro lado del gap?
    let violado = false, idxViolacion = null;
    for(let j=g.idx+2; j<candles.length; j++){
      if(g.type==='bull' && candles[j].c < g.bottom){ violado = true; idxViolacion = j; break; }
      if(g.type==='bear' && candles[j].c > g.top){ violado = true; idxViolacion = j; break; }
    }
    if(!violado) continue;
    // Ya invertido: ahora funciona al revés. Solo interesa si el precio todavía no volvió a testearlo
    // desde el nuevo lado (si ya lo testeó y lo perforó otra vez, perdió validez).
    const rolNuevo = g.type==='bull' ? 'resistencia' : 'soporte';
    const relevante = g.type==='bull' ? (price < g.bottom) : (price > g.top);
    if(!relevante) continue;
    const distPct = g.type==='bull'
      ? (g.bottom - price)/price*100
      : (price - g.top)/price*100;
    invertidos.push({
      tipoOriginal: g.type,
      rolNuevo,
      top: g.top, bottom: g.bottom,
      distPct: Math.abs(distPct),
      idxViolacion,
    });
  }
  // Los más cercanos al precio primero
  return invertidos.sort((a,b)=>a.distPct-b.distPct).slice(0,2);
}

// Detección de CLUSTERS de liquidez (no solo pares): agrupa todos los pivots que caen dentro de la
// tolerancia entre sí. Un cluster de 3+ toques es un pool de liquidez mucho más fuerte que uno de 2.
function detectEqualLevels(labeledPivots, tolerancePct=0.0015){
  function clusterOf(pivots){
    const pts = pivots.map(p=>p.price);
    let best = null;
    for(let i=0;i<pts.length;i++){
      const group = pts.filter(p => Math.abs(p-pts[i])/pts[i] < tolerancePct);
      if(group.length>=2 && (!best || group.length>best.count)){
        best = { level: group.reduce((a,b)=>a+b,0)/group.length, count: group.length };
      }
    }
    return best;
  }
  const highs = labeledPivots.filter(p=>p.type==='high').slice(-10);
  const lows = labeledPivots.filter(p=>p.type==='low').slice(-10);
  const highCluster = clusterOf(highs);
  const lowCluster = clusterOf(lows);
  return {
    eqHighs: highCluster?.level ?? null, eqHighsCount: highCluster?.count ?? 0,
    eqLows: lowCluster?.level ?? null, eqLowsCount: lowCluster?.count ?? 0,
  };
}

// Barrida de liquidez RECIENTE: no es "dónde descansa la liquidez" (eso ya lo hace detectEqualLevels/EQH-EQL),
// es "¿ya se barrió una mecha agresiva y el precio rechazó?" — la trampa alcista/bajista que se arma
// justo antes de girar. Mirar las últimas ~10 velas alcanza para esto (no hace falta todo el historial).
function detectLiquiditySweep(candles, lookback=30){
  const recent = candles.slice(-lookback);
  if(recent.length<3) return {sweptUp:false, sweptDown:false, strengthUp:0, strengthDown:0};
  let sweptUp=false, sweptDown=false, strengthUp=0, strengthDown=0;
  for(let i=1;i<recent.length;i++){
    const c = recent[i], prev = recent[i-1];
    if(c.h > prev.h*1.015 && c.c < c.o){
      sweptUp = true;
      strengthUp = Math.max(strengthUp, ((c.h/prev.h)-1)*100); // % que se pasó del máximo previo: más grande = mecha más agresiva
    }
    if(c.l < prev.l*0.985 && c.c > c.o){
      sweptDown = true;
      strengthDown = Math.max(strengthDown, (1-(c.l/prev.l))*100);
    }
  }
  // Rango comprimido: señal propia (no solo un extra del sweep) — coiling cerca de liquidez conocida ya es informativo.
  const rangePct = (Math.max(...recent.map(c=>c.h)) - Math.min(...recent.map(c=>c.l))) / recent.at(-1).c;
  return {sweptUp, sweptDown, strengthUp, strengthDown, compressed: rangePct < 0.018};
}

// Swing Failure Pattern (SFP): más riguroso que detectLiquiditySweep de arriba — ese mira "¿la vela
// anterior nomás?", este mira si se barrió un nivel REAL (Equal High/Low, no cualquier mecha), con
// volumen elevado de verdad (no solo una vela roja/verde), y si las velas siguientes ya muestran un
// cambio de estructura a favor de la reversión (no solo "cerró adentro", sino "y después siguió").
// Investigación: esto es el concepto SMC con mejor evidencia práctica (aunque de fuentes de traders,
// no papers revisados por pares) para usar como GATILLO de entrada, no solo como filtro.
function detectSFP(candles, eqHighs, eqLows, lookback=12){
  const result = { bullish:false, bearish:false, bullishNote:null, bearishNote:null };
  if(candles.length < lookback+25) return result;
  const atrSeries = atr(candles, 14);
  const atrVal = atrSeries?.at?.(-1);
  if(!atrVal) return result;
  const avgVolWindow = candles.slice(-(lookback+20), -lookback);
  const avgVol = avgVolWindow.reduce((s,c)=>s+c.v,0) / Math.max(1,avgVolWindow.length);
  const window = candles.slice(-lookback);

  if(eqLows){
    for(let i=0;i<window.length-1;i++){
      const c = window[i];
      const sweepDepth = eqLows - c.l; // cuánto se metió la mecha por debajo del nivel
      const closedBackInside = c.c > eqLows;
      const volOk = avgVol>0 && c.v >= avgVol*1.5;
      if(sweepDepth >= atrVal*0.25 && closedBackInside && c.c > c.o && volOk){
        // Confirmación: ¿las velas después ya vienen formando estructura alcista (siguen subiendo, no vuelven a caer bajo el nivel)?
        const after = window.slice(i+1);
        const siguioSubiendo = after.length>0 && after.every(a=>a.l > eqLows*0.997) && after.at(-1).c > c.c;
        if(after.length===0 || siguioSubiendo){
          result.bullish = true;
          result.bullishNote = `Swing Failure Pattern alcista: mecha barrió Equal Lows (~$${fmt(eqLows)}) por ${((sweepDepth/atrVal)).toFixed(2)}x ATR, cerró adentro con volumen ${(c.v/avgVol).toFixed(1)}x el promedio, y la estructura siguió confirmando la reversión.`;
          break;
        }
      }
    }
  }
  if(eqHighs){
    for(let i=0;i<window.length-1;i++){
      const c = window[i];
      const sweepDepth = c.h - eqHighs;
      const closedBackInside = c.c < eqHighs;
      const volOk = avgVol>0 && c.v >= avgVol*1.5;
      if(sweepDepth >= atrVal*0.25 && closedBackInside && c.c < c.o && volOk){
        const after = window.slice(i+1);
        const siguioBajando = after.length>0 && after.every(a=>a.h < eqHighs*1.003) && after.at(-1).c < c.c;
        if(after.length===0 || siguioBajando){
          result.bearish = true;
          result.bearishNote = `Swing Failure Pattern bajista: mecha barrió Equal Highs (~$${fmt(eqHighs)}) por ${((sweepDepth/atrVal)).toFixed(2)}x ATR, cerró adentro con volumen ${(c.v/avgVol).toFixed(1)}x el promedio, y la estructura siguió confirmando la reversión.`;
          break;
        }
      }
    }
  }
  return result;
}

function fibLevels(labeledPivots){
  if(!labeledPivots || labeledPivots.length < 2) return null;
  // ANTES tomaba los ÚLTIMOS DOS pivotes sin más (slice(-2)), y eso ponía el Fibonacci sobre
  // cualquier movimiento insignificante — por eso quedaba mal ubicado. Ahora se busca el swing
  // REAL: el máximo más alto y el mínimo más bajo del tramo reciente, que es sobre lo que un
  // analista traza el Fibonacci de verdad.
  const recientes = labeledPivots.slice(-12);
  let maxPiv = recientes[0], minPiv = recientes[0];
  for(const p of recientes){
    if(p.price > maxPiv.price) maxPiv = p;
    if(p.price < minPiv.price) minPiv = p;
  }
  if(maxPiv === minPiv) return null;
  const hi = maxPiv.price, lo = minPiv.price;
  const range = hi - lo;
  if(range <= 0) return null;
  // La dirección la marca cuál de los dos extremos ocurrió DESPUÉS: si el máximo es más reciente
  // que el mínimo, el swing fue alcista y los retrocesos se miden desde arriba.
  const idxMax = recientes.indexOf(maxPiv), idxMin = recientes.indexOf(minPiv);
  const up = idxMax > idxMin;
  return {
    dir: up?'bull':'bear',
    swingHigh: hi, swingLow: lo,
    l236: up? hi-range*0.236 : lo+range*0.236,
    l382: up? hi-range*0.382 : lo+range*0.382,
    l500: up? hi-range*0.5   : lo+range*0.5,
    l618: up? hi-range*0.618 : lo+range*0.618,
    l786: up? hi-range*0.786 : lo+range*0.786,
    ext1272: up? hi+range*0.272 : lo-range*0.272,
    ext1618: up? hi+range*0.618 : lo-range*0.618,
  };
}

// ---- VWAP (Volume Weighted Average Price) + bandas de desviación ----
// El nivel que usan de verdad los institucionales para ejecutar sus órdenes — por eso funciona como
// soporte/resistencia dinámico real, no solo un promedio más. Cripto es 24/7 (sin sesión de apertura
// como las acciones), así que anclamos a una ventana fija (por defecto ~200 velas) en vez de "desde
// la apertura del día". Devuelve el VWAP actual + bandas de ±1 y ±2 desviaciones estándar.
function computeVWAP(candles, lookback=200){
  const recent = candles.slice(-Math.min(lookback, candles.length));
  let cumPV = 0, cumVol = 0;
  const vwapSeries = [];
  for(const c of recent){
    const typical = (c.h+c.l+c.c)/3;
    cumPV += typical*c.v; cumVol += c.v;
    vwapSeries.push(cumVol>0 ? cumPV/cumVol : typical);
  }
  const lastVwap = vwapSeries.at(-1);
  let sumSqDiff = 0;
  recent.forEach((c,i)=>{ const typical=(c.h+c.l+c.c)/3; sumSqDiff += c.v*Math.pow(typical-vwapSeries[i],2); });
  const stdev = cumVol>0 ? Math.sqrt(sumSqDiff/cumVol) : 0;
  return {
    vwap: lastVwap,
    upper1: lastVwap+stdev, lower1: lastVwap-stdev,
    upper2: lastVwap+stdev*2, lower2: lastVwap-stdev*2,
  };
}

// ---- CVD aproximado (Cumulative Volume Delta) ----
// El dato real necesita saber quién fue el agresor en cada operación (comprador pegándole al ask,
// o vendedor pegándole al bid) — eso requiere trades tick-por-tick, no las velas OHLC que ya tenemos,
// y pedirlo agregaría muchas llamadas nuevas a las APIs. En su lugar usamos una aproximación conocida:
// dónde cierra la vela dentro de su propio rango alto-bajo estima qué tan "comprador" o "vendedor" fue
// el volumen de esa vela. No es tan preciso como un footprint real, pero es gratis y no rompe nada.
function computeCVD(candles, lookback=50){
  const recent = candles.slice(-Math.min(lookback, candles.length));
  let cvd = 0;
  const series = [];
  for(const c of recent){
    const range = (c.h-c.l) || 1e-9;
    const buyRatio = (c.c-c.l)/range; // 1 = cerró en el máximo (todo comprador), 0 = cerró en el mínimo (todo vendedor)
    const delta = c.v*(buyRatio*2-1); // escala a -volumen..+volumen
    cvd += delta;
    series.push(cvd);
  }
  // Divergencia: precio hace un máximo/mínimo nuevo pero el CVD no lo acompaña -> ruptura débil, sospechosa.
  const priceCloses = recent.map(c=>c.c);
  const lastPrice = priceCloses.at(-1);
  const maxPriceIdx = priceCloses.indexOf(Math.max(...priceCloses));
  const minPriceIdx = priceCloses.indexOf(Math.min(...priceCloses));
  const bearishDivergence = maxPriceIdx===priceCloses.length-1 && series.at(-1) < Math.max(...series.slice(0,-5));
  const bullishDivergence = minPriceIdx===priceCloses.length-1 && series.at(-1) > Math.min(...series.slice(0,-5));
  return { cvd: series.at(-1), series, bearishDivergence, bullishDivergence };
}

function detectCandlePattern(candles){
  const c = candles.at(-1), p = candles.at(-2), p2 = candles.at(-3);
  const body = Math.abs(c.c-c.o), range = c.h-c.l || 1e-9;
  const upperWick = c.h - Math.max(c.o,c.c), lowerWick = Math.min(c.o,c.c) - c.l;

  // Los patrones de 3 velas van PRIMERO porque son más específicos y confiables que los de 1 sola
  // vela — si detectáramos primero un Doji, nunca llegaríamos a ver que ese Doji era en realidad
  // parte de una Estrella de la Mañana, que dice mucho más.
  if(p && p2){
    const pBody = Math.abs(p.c-p.o), p2Body = Math.abs(p2.c-p2.o);
    const pRange = p.h-p.l || 1e-9;

    // Estrella de la Mañana: vela bajista fuerte → vela chica (indecisión) → vela alcista fuerte.
    // Señal clásica de piso: la venta se agotó y los compradores tomaron control.
    if(p2.c<p2.o && p2Body/(p2.h-p2.l||1e-9)>0.5 && pBody/pRange<0.4 && c.c>c.o && body/range>0.5 && c.c > (p2.o+p2.c)/2){
      return 'Estrella de la Mañana (reversal alcista de 3 velas)';
    }
    // Estrella de la Tarde: lo inverso — señal clásica de techo.
    if(p2.c>p2.o && p2Body/(p2.h-p2.l||1e-9)>0.5 && pBody/pRange<0.4 && c.c<c.o && body/range>0.5 && c.c < (p2.o+p2.c)/2){
      return 'Estrella de la Tarde (reversal bajista de 3 velas)';
    }
    // Tres Soldados Blancos: 3 velas alcistas seguidas, cada una cerrando más arriba.
    if(p2.c>p2.o && p.c>p.o && c.c>c.o && p.c>p2.c && c.c>p.c && body/range>0.5 && pBody/pRange>0.5){
      return 'Tres Soldados Blancos (tendencia alcista confirmada)';
    }
    // Tres Cuervos Negros: lo inverso.
    if(p2.c<p2.o && p.c<p.o && c.c<c.o && p.c<p2.c && c.c<p.c && body/range>0.5 && pBody/pRange>0.5){
      return 'Tres Cuervos Negros (tendencia bajista confirmada)';
    }
  }

  if(p){
    const pBody = Math.abs(p.c-p.o);
    // Engulfing (envolvente): una vela se "come" completa a la anterior.
    if(c.c>c.o && p.c<p.o && c.c>p.o && c.o<p.c) return 'Bullish Engulfing';
    if(c.c<c.o && p.c>p.o && c.o>p.c && c.c<p.o) return 'Bearish Engulfing';

    // Harami: la vela actual queda ENTERA dentro del cuerpo de la anterior — pérdida de impulso.
    if(pBody>0 && body < pBody*0.6){
      const dentroDelCuerpo = Math.max(c.o,c.c) < Math.max(p.o,p.c) && Math.min(c.o,c.c) > Math.min(p.o,p.c);
      if(dentroDelCuerpo){
        if(p.c<p.o) return 'Harami alcista (la caída pierde impulso)';
        if(p.c>p.o) return 'Harami bajista (la subida pierde impulso)';
      }
    }

    // Pinzas (Tweezers): dos velas que tocan casi exactamente el mismo máximo o mínimo — señal de
    // que ese nivel está siendo defendido con fuerza.
    const tolerancia = range*0.05;
    if(Math.abs(c.l-p.l)<tolerancia && c.c>c.o && p.c<p.o) return 'Pinza de piso (nivel defendido, posible reversal alcista)';
    if(Math.abs(c.h-p.h)<tolerancia && c.c<c.o && p.c>p.o) return 'Pinza de techo (nivel defendido, posible reversal bajista)';
  }

  // Patrones de 1 sola vela (los menos específicos, van al final)
  if(body/range < 0.1) return 'Doji';
  if(lowerWick > body*2 && upperWick < body*0.5) return c.c>c.o ? 'Hammer (posible reversal alcista)' : 'Hammer';
  if(upperWick > body*2 && lowerWick < body*0.5) return 'Shooting Star (posible reversal bajista)';
  if(body/range > 0.9) return c.c>c.o ? 'Marubozu alcista' : 'Marubozu bajista';
  return null;
}

function computeStructure(candles, atrArr){
  const pivots = labelSwings(findPivots(candles,3));
  const events = detectStructureEvents(candles, pivots);
  const {bullishOB, bearishOB} = detectOrderBlocks(candles, atrArr);
  const fvgs = detectFVG(candles);


  const {eqHighs, eqHighsCount, eqLows, eqLowsCount} = detectEqualLevels(pivots);
  const fib = fibLevels(pivots);
  const candlePattern = detectCandlePattern(candles);
  const liquiditySweep = detectLiquiditySweep(candles);
  const doubleTopBottom = detectDoubleTopBottom(candles);

  let score=10, notes=[];

  // ═══ IMBALANCES (FVG) CON PESO REAL EN EL SCORE ═══
  // Antes se detectaban pero no sumaban nada. El concepto: un movimiento agresivo deja una zona
  // sin negociar, y el precio vuelve a buscarla con precisión para rellenarla antes de continuar.
  // Cuando el precio se acerca a un imbalance sin rellenar, esa es una zona de reacción probable.
  const precioFvg = candles.at(-1).c;
  for(const g of fvgs){
    const dentro = precioFvg >= g.bottom*0.998 && precioFvg <= g.top*1.002;
    const cerca = !dentro && Math.abs((g.type==='bull' ? g.top : g.bottom) - precioFvg)/precioFvg < 0.02;
    if(!dentro && !cerca) continue;
    if(g.type==='bull'){
      score += dentro ? 3 : 1;
      notes.push(`📊 Imbalance alcista sin rellenar en $${fmt(g.bottom)}–$${fmt(g.top)}${dentro?' y el precio está adentro':' cerca del precio'}. El mercado suele volver a estas zonas a buscar eficiencia y reaccionar desde ahí.`);
    } else {
      score -= dentro ? 3 : 1;
      notes.push(`📊 Imbalance bajista sin rellenar en $${fmt(g.bottom)}–$${fmt(g.top)}${dentro?' y el precio está adentro':' cerca del precio'}. El mercado suele volver a estas zonas a buscar eficiencia y reaccionar desde ahí.`);
    }
  }

  // ═══ IFVG: imbalances INVERTIDOS ═══
  // Un imbalance atravesado cambia de rol: el alcista roto pasa a ser resistencia (los que
  // compraron ahí quedaron atrapados y venden al volver), el bajista roto pasa a ser soporte.
  // Son zonas fuertes justamente porque hay órdenes atrapadas defendiéndolas.
  const ifvgs = detectIFVG(candles);
  for(const g of ifvgs){
    if(g.distPct > 2.5) continue; // solo los que están cerca del precio
    if(g.rolNuevo === 'resistencia'){
      score -= 2;
      notes.push(`🔀 IFVG bajista: había un imbalance alcista en $${fmt(g.bottom)}–$${fmt(g.top)} que el precio perforó. Ahora funciona como resistencia — los que compraron ahí quedaron atrapados y suelen vender al volver al nivel.`);
    } else {
      score += 2;
      notes.push(`🔀 IFVG alcista: había un imbalance bajista en $${fmt(g.bottom)}–$${fmt(g.top)} que el precio superó. Ahora funciona como soporte — los que vendieron ahí quedaron atrapados y suelen recomprar al volver.`);
    }
  }

  const bias = events.trendStructure;
  notes.push(bias==='bull' ? 'Estructura HH-HL: tendencia alcista intacta.' : bias==='bear' ? 'Estructura LH-LL: tendencia bajista intacta.' : 'Estructura sin secuencia clara (rango).');
  if(events.bos){ score+=5; notes.push(`BOS ${events.bos==='bullish'?'alcista':'bajista'}: continuación confirmada rompiendo el swing previo.`); }
  if(events.choch){ score-=6; notes.push(`⚠️ CHoCH ${events.choch==='bullish'?'alcista':'bajista'}: posible cambio de carácter, la tendencia previa está en duda.`); }
  const price = candles.at(-1).c;
  if(bullishOB && price > bullishOB.bottom && price < bullishOB.top*1.05 && bias!=='bear'){ score+=2; notes.push(`Order Block alcista sin mitigar cerca de precio ($${bullishOB.bottom.toFixed? bullishOB.bottom.toFixed(4):bullishOB.bottom}-$${bullishOB.top}).`); }
  if(bearishOB && price < bearishOB.top && price > bearishOB.bottom*0.95 && bias!=='bull'){ score-=2; notes.push('Order Block bajista actuando como resistencia cerca de precio.'); }
  const bullFVG = fvgs.find(g=>g.type==='bull');
  const bearFVG = fvgs.find(g=>g.type==='bear');
  if(bullFVG){ score+=1; notes.push(`FVG alcista sin mitigar ($${fmt(bullFVG.bottom)}-$${fmt(bullFVG.top)}) puede actuar de soporte.`); }
  if(bearFVG){ score-=1; notes.push(`FVG bajista sin mitigar ($${fmt(bearFVG.bottom)}-$${fmt(bearFVG.top)}) puede actuar de resistencia.`); }
  if(eqHighs){ const fuerte = eqHighsCount>=3; notes.push(`Equal Highs (EQH) — cluster de ${eqHighsCount} toques ~$${fmt(eqHighs)}${fuerte?' 🔥 cluster FUERTE':''}: liquidez compradora (buy-side) reposando ahí, ${fuerte?'objetivo muy probable':'posible objetivo'} de un liquidity sweep (el precio puede ser atraído hacia ahí antes de girar).`); }
  if(eqLows){ const fuerte = eqLowsCount>=3; notes.push(`Equal Lows (EQL) — cluster de ${eqLowsCount} toques ~$${fmt(eqLows)}${fuerte?' 🔥 cluster FUERTE':''}: liquidez vendedora (sell-side) reposando ahí, ${fuerte?'objetivo muy probable':'posible objetivo'} de un liquidity sweep (el precio puede ser atraído hacia ahí antes de girar).`); }
  if(liquiditySweep.sweptUp){ const impact = Math.min(6, 2+liquiditySweep.strengthUp); score-=impact; notes.push(`🚨 Barrida de liquidez alcista reciente (mecha ${liquiditySweep.strengthUp.toFixed(1)}% por encima del máximo previo, cerró débil): posible trampa a compradores, cuidado entrando en LONG ahora mismo.`); }
  if(liquiditySweep.sweptDown){ const impact = Math.min(6, 2+liquiditySweep.strengthDown); score-=impact; notes.push(`🚨 Barrida de liquidez bajista reciente (mecha ${liquiditySweep.strengthDown.toFixed(1)}% por debajo del mínimo previo, cerró fuerte): posible trampa a vendedores, cuidado entrando en SHORT ahora mismo.`); }
  if(liquiditySweep.compressed){
    if(eqHighs || eqLows){
      const clusterFuerte = eqHighsCount>=3 || eqLowsCount>=3;
      score -= clusterFuerte ? 5 : 3;
      notes.push(`Rango comprimido justo cerca de liquidez conocida${clusterFuerte?' (cluster FUERTE)':''}: el riesgo de un movimiento brusco en cualquier dirección es ${clusterFuerte?'mucho':''} mayor a lo normal.`);
    }
    else { score-=1; notes.push('Rango comprimido (baja volatilidad reciente): posible antesala de una ruptura, dirección todavía sin definir.'); }
  }

  // NOTA SOBRE EL IMÁN DE LIQUIDEZ (probado y descartado, agosto 2026):
  // Se probó conectar la dominancia del perfil de volumen al score, con la lógica de que el precio
  // va a buscar la liquidez acumulada. Suena razonable y es lo que dice la teoría de Smart Money,
  // pero MEDIDO en 1.829 casos reales de BTC no se sostiene:
  //   - Liquidez concentrada ARRIBA -> el precio subió el 51,6% de las veces
  //   - Liquidez concentrada ABAJO  -> el precio bajó el 50,2% de las veces
  //   - Global: 50,8%, o sea azar puro.
  // Conectarlo al score bajó la ganancia de +196% a +88% en el backtest completo, empeorando en
  // los 4 períodos. Por eso la dominancia se sigue REPORTANDO en el mensaje (es información útil
  // para leer el contexto) pero NO decide la dirección de la tesis.

  // ═══ ÍNDICE DE FUERZA CON PESO REAL EN EL SCORE ═══
  // Es la misma medida que la línea naranja de la sección Liquidez: qué porcentaje del volumen
  // reciente viene de velas alcistas vs bajistas. Pedido explícito de David para que pese de verdad.
  const fuerzaVolumen = candles.length>=30 ? computeVolumeProbability(candles, 20) : null;
  if(fuerzaVolumen){
    const p = fuerzaVolumen.probUp;
    // Escalón por intensidad: cuanto más desbalanceado el volumen, más pesa.
    if(p >= 70){ score += 3; notes.push(`⚡ Fuerza compradora dominante: el ${p.toFixed(0)}% del volumen reciente viene de velas alcistas.`); }
    else if(p >= 60){ score += 2; notes.push(`⚡ Fuerza compradora clara (${p.toFixed(0)}% del volumen).`); }
    else if(p >= 55){ score += 1; notes.push(`⚡ Leve ventaja compradora (${p.toFixed(0)}% del volumen).`); }
    else if(p <= 30){ score -= 3; notes.push(`⚡ Fuerza vendedora dominante: el ${(100-p).toFixed(0)}% del volumen reciente viene de velas bajistas.`); }
    else if(p <= 40){ score -= 2; notes.push(`⚡ Fuerza vendedora clara (${(100-p).toFixed(0)}% del volumen).`); }
    else if(p <= 45){ score -= 1; notes.push(`⚡ Leve ventaja vendedora (${(100-p).toFixed(0)}% del volumen).`); }
  }

  // ═══ LIQUIDEZ CERCANA vs LEJANA CON PESO REAL ═══
  // El precio busca primero la liquidez cercana. Si está muy cerca de un lado y lejos del otro,
  // ese desbalance inclina hacia dónde es más probable que vaya a buscarla primero.
  const liqHorizonte = candles.length>=50 ? detectLiquidezPorHorizonte(candles) : null;
  if(liqHorizonte){
    const cArr = liqHorizonte.cercanaArriba, cAba = liqHorizonte.cercanaAbajo;
    // Solo cuenta la liquidez que TODAVÍA NO fue consumida — apuntar a liquidez ya barrida no sirve.
    const arribaViva = cArr && !cArr.consumida ? cArr : null;
    const abajoViva  = cAba && !cAba.consumida ? cAba : null;

    if(arribaViva && abajoViva){
      // Las dos vivas: gana la que esté claramente más cerca
      const ratio = abajoViva.distPct / (arribaViva.distPct || 0.01);
      if(ratio > 2){ score += 2; notes.push(`💧 Liquidez cercana ARRIBA a ${arribaViva.distPct.toFixed(1)}% (${arribaViva.toques} toques), mucho más cerca que la de abajo (${abajoViva.distPct.toFixed(1)}%) — el precio suele ir a buscar la más próxima primero.`); }
      else if(ratio < 0.5){ score -= 2; notes.push(`💧 Liquidez cercana ABAJO a ${abajoViva.distPct.toFixed(1)}% (${abajoViva.toques} toques), mucho más cerca que la de arriba (${arribaViva.distPct.toFixed(1)}%) — el precio suele ir a buscar la más próxima primero.`); }
      else notes.push(`💧 Liquidez cercana pareja: arriba a ${arribaViva.distPct.toFixed(1)}%, abajo a ${abajoViva.distPct.toFixed(1)}%.`);
    } else if(arribaViva){
      score += 2;
      notes.push(`💧 Solo hay liquidez cercana sin barrer ARRIBA, a ${arribaViva.distPct.toFixed(1)}% (${arribaViva.toques} toques). La de abajo ya fue consumida.`);
    } else if(abajoViva){
      score -= 2;
      notes.push(`💧 Solo hay liquidez cercana sin barrer ABAJO, a ${abajoViva.distPct.toFixed(1)}% (${abajoViva.toques} toques). La de arriba ya fue consumida.`);
    }

    // La liquidez de temporalidad mayor se informa: es hacia donde va el precio DESPUÉS de barrer
    // la cercana. Pesa menos porque está más lejos en el tiempo.
    const lArr = liqHorizonte.lejanaArriba, lAba = liqHorizonte.lejanaAbajo;
    if(lArr || lAba){
      const partes = [];
      if(lArr) partes.push(`arriba a ${lArr.distPct.toFixed(1)}% ($${fmt(lArr.precio)})`);
      if(lAba) partes.push(`abajo a ${lAba.distPct.toFixed(1)}% ($${fmt(lAba.precio)})`);
      notes.push(`🌊 Liquidez de mayor plazo: ${partes.join(' y ')} — es hacia donde tiende a ir el precio una vez que barre la cercana.`);
    }
  }

  // LIQUIDEZ + ESTOCÁSTICO EN EXTREMO (pedido de David, agosto 2026).
  // Aclaración honesta: la liquidez SOLA se midió y no predice (50,8% en 1.829 casos). Pero acá
  // no va sola — va combinada con que el Estocástico esté en un extremo Y dando la vuelta, que es
  // como la usa David: "si hay más liquidez abajo y el Estocástico está sobrecomprado dando vuelta,
  // eso es un short con fundamento". La combinación es distinta de cada señal por separado.
  const liqDireccional = candles.length>=50 ? computeLiquidityProfile(candles, candles.at(-1).c, 150) : null;
  if(liqDireccional){
    const stochArr = stochasticOscillator(candles);
    const kNow = stochArr.k.at(-1), kPrev = stochArr.k.at(-2);
    const dNow = stochArr.d.at(-1), dPrev = stochArr.d.at(-2);
    const diff = liqDireccional.domUpPct - liqDireccional.domDownPct;

    if(kNow!=null && kPrev!=null && dNow!=null && dPrev!=null){
      // SHORT con fundamento: liquidez abajo + Estocástico sobrecomprado girando a la baja
      const liquidezAbajo = diff <= -15;
      const estocGirandoAbajo = kPrev >= 70 && kPrev >= dPrev && kNow < dNow;
      if(liquidezAbajo && estocGirandoAbajo){
        score -= 3;
        notes.push(`🎯 SHORT con fundamento: el ${liqDireccional.domDownPct.toFixed(0)}% de la liquidez está ABAJO (objetivo del movimiento) y el Estocástico viene de sobrecompra (${kPrev.toFixed(0)}) cruzando a la baja — el precio tiene hacia dónde caer y el momentum acaba de darse vuelta.`);
      }
      // LONG con fundamento: liquidez arriba + Estocástico sobrevendido girando al alza
      const liquidezArriba = diff >= 15;
      const estocGirandoArriba = kPrev <= 30 && kPrev <= dPrev && kNow > dNow;
      if(liquidezArriba && estocGirandoArriba){
        score += 3;
        notes.push(`🎯 LONG con fundamento: el ${liqDireccional.domUpPct.toFixed(0)}% de la liquidez está ARRIBA (objetivo del movimiento) y el Estocástico viene de sobreventa (${kPrev.toFixed(0)}) cruzando al alza — el precio tiene hacia dónde subir y el momentum acaba de darse vuelta.`);
      }
    }

    // ÍNDICE DE FUERZA / línea del medio del perfil: el POC es el nivel donde más se negoció, o sea
    // donde el precio históricamente rebota o se frena más seguido. Se reporta siempre para que se
    // vea en el mensaje, y se penaliza levemente abrir justo contra él (comprar debajo de un POC
    // que actúa como techo, o vender encima de uno que actúa como piso).
    if(liqDireccional.poc){
      const distPocPct = (liqDireccional.poc - candles.at(-1).c)/candles.at(-1).c*100;
      if(Math.abs(distPocPct) < 1.5){
        notes.push(`⚖️ El precio está pegado al POC ($${fmt(liqDireccional.poc)}), el nivel de mayor volumen negociado — es donde el precio más suele frenarse o rebotar. Conviene esperar a ver de qué lado sale.`);
      } else {
        notes.push(`⚖️ POC (mayor volumen) en $${fmt(liqDireccional.poc)}, a un ${Math.abs(distPocPct).toFixed(1)}% ${distPocPct>0?'por encima':'por debajo'}. Área de valor: $${fmt(liqDireccional.val)} – $${fmt(liqDireccional.vah)} (${liqDireccional.posicionRelativa}).`);
      }
    }
  }

  // Predicción de ruptura de compresión — conectada al puntaje porque es la señal mejor medida que
  // tenemos: 52-57% de acierto consistente en las 4 temporalidades (15m, 1h, 4h, 1D), probada contra
  // datos históricos reales. Pesa poco (±2) porque 55% es una ventaja real pero modesta: sirve para
  // inclinar la balanza, no para decidir sola. Cuando el análisis dice "parejo", no suma nada —
  // justamente porque reconocer que no sabe es parte de por qué funciona.
  const trianguloDetectado = detectTrianguloCompresion(candles);
  if(trianguloDetectado){
    const rupturaPredicha = analizarRupturaCompresion(candles, trianguloDetectado);
    if(rupturaPredicha && (rupturaPredicha.sesgo==='arriba' || rupturaPredicha.sesgo==='abajo')){
      const puntos = rupturaPredicha.confianza >= 75 ? 2 : 1;
      if(rupturaPredicha.sesgo==='arriba'){
        score += puntos;
        notes.push(`📐 ${trianguloDetectado.tipo.charAt(0).toUpperCase()+trianguloDetectado.tipo.slice(1)} comprimiéndose, y las señales (liquidez/fuerza/volumen) se inclinan a una ruptura hacia ARRIBA (${rupturaPredicha.confianza}%). Nivel a vigilar: $${fmt(trianguloDetectado.techo)}.`);
      } else {
        score -= puntos;
        notes.push(`📐 ${trianguloDetectado.tipo.charAt(0).toUpperCase()+trianguloDetectado.tipo.slice(1)} comprimiéndose, y las señales (liquidez/fuerza/volumen) se inclinan a una ruptura hacia ABAJO (${rupturaPredicha.confianza}%). Nivel a vigilar: $${fmt(trianguloDetectado.piso)}.`);
      }
    } else if(rupturaPredicha){
      notes.push(`📐 ${trianguloDetectado.tipo.charAt(0).toUpperCase()+trianguloDetectado.tipo.slice(1)} comprimiéndose, pero las señales están parejas — no hay inclinación clara hacia ningún lado todavía.`);
    }
  }

  // Patrón compuesto (más fuerte que un sweep suelto): Acumulación + Test Pumps fallidos + Bear Trap = compra.
  const accBearTrap = detectAccumulationBearTrap(candles);
  if(accBearTrap.patternDetected){
    score += 6;
    notes.push(`🎯 PATRÓN: Acumulación + Bear Trap confirmado — rango de ${(accBearTrap.rangeWidthPct*100).toFixed(0)}% con ${accBearTrap.testPumpCount} test(s) fallido(s) contra la resistencia ($${fmt(accBearTrap.rangeHigh)}), y ahora una barrida por debajo del soporte ($${fmt(accBearTrap.rangeLow)}) que rechazó. Señal de compra de alta calidad, más confiable que un sweep aislado.`);
  }
  const distBullTrap = detectDistributionBullTrap(candles);
  if(distBullTrap.patternDetected){
    score -= 6;
    notes.push(`🎯 PATRÓN: Distribución + Bull Trap confirmado — rango de ${(distBullTrap.rangeWidthPct*100).toFixed(0)}% con ${distBullTrap.testDumpCount} test(s) fallido(s) contra el soporte ($${fmt(distBullTrap.rangeLow)}), y ahora una barrida por encima de la resistencia ($${fmt(distBullTrap.rangeHigh)}) que rechazó. Señal de venta de alta calidad, más confiable que un sweep aislado.`);
  }
  if(candlePattern){
    // Antes esto era solo informativo (no sumaba ni restaba nada al score). La investigación es clara:
    // una vela de reversión "en el medio de la nada" no vale lo mismo que la misma vela justo en una
    // zona real (Order Block, FVG) — "un grito" vs "un susurro". Ahora exigimos esa cercanía para que
    // el patrón realmente sume o reste puntos.
    const cerca = (lvl, tol=0.015) => lvl!=null && Math.abs(price-lvl)/price <= tol;
    const enZonaAlcista = cerca(bullishOB?.top) || cerca(bullishOB?.bottom) || cerca(bullFVG?.top) || cerca(bullFVG?.bottom);
    const enZonaBajista = cerca(bearishOB?.top) || cerca(bearishOB?.bottom) || cerca(bearFVG?.top) || cerca(bearFVG?.bottom);
    const esAlcista = /alcista|Bullish|Hammer \(|Estrella de la Mañana|Tres Soldados Blancos|Pinza de piso/.test(candlePattern);
    const esBajista = /bajista|Bearish|Shooting Star|Estrella de la Tarde|Tres Cuervos Negros|Pinza de techo/.test(candlePattern);
    if(esAlcista && enZonaAlcista){ score+=2; notes.push(`Última vela: ${candlePattern} — justo en una zona real (Order Block/FVG alcista), no en el aire: la señal vale más acá.`); }
    else if(esBajista && enZonaBajista){ score-=2; notes.push(`Última vela: ${candlePattern} — justo en una zona real (Order Block/FVG bajista), no en el aire: la señal vale más acá.`); }
    else notes.push(`Última vela: ${candlePattern} (sin una zona estructural real cerca — patrón de vela solo, se lo trata como referencia débil).`);
  }

  // Fuerza en tests sucesivos: ¿el soporte/resistencia se está debilitando o fortaleciendo con cada toque?
  const {support: srSupport, resistance: srResistance} = findSupportResistance(candles);
  const resistanceTests = analyzeLevelTests(candles, srResistance, true);
  const supportTests = analyzeLevelTests(candles, srSupport, false);
  if(resistanceTests.testCount>=2){
    if(resistanceTests.weakening){ score+=3; notes.push(`📉➡️📈 Resistencia ($${fmt(srResistance)}) se está DEBILITANDO: ${resistanceTests.testCount} tests, cada rechazo más chico que el anterior — posible ruptura alcista próxima.`); }
    else if(resistanceTests.strengthening){ score-=2; notes.push(`🧱 Resistencia ($${fmt(srResistance)}) se está FORTALECIENDO: ${resistanceTests.testCount} tests, cada rechazo más fuerte — nivel sólido, romperlo va a costar.`); }
  }
  if(supportTests.testCount>=2){
    if(supportTests.weakening){ score-=3; notes.push(`📈➡️📉 Soporte ($${fmt(srSupport)}) se está DEBILITANDO: ${supportTests.testCount} tests, cada rechazo más chico que el anterior — posible ruptura bajista próxima.`); }
    else if(supportTests.strengthening){ score+=2; notes.push(`🧱 Soporte ($${fmt(srSupport)}) se está FORTALECIENDO: ${supportTests.testCount} tests, cada rechazo más fuerte — nivel sólido, buen piso.`); }
  }

  score = Math.max(0, Math.min(20, score));
  // ═══ SEPARAR LO ACCIONABLE DEL CONTEXTO ═══
  // Antes todas las observaciones iban al mismo array `notes` y se mostraban como 9 viñetas
  // idénticas. Entre ellas hay cosas muy distintas: "cluster FUERTE, objetivo muy probable"
  // es accionable; "estructura LH-LL intacta" es contexto de fondo. Verlas iguales obliga a
  // leerlas todas para encontrar la que importa.
  const esAccionable = (n) => /cluster FUERTE|BOS|CHoCH|Bear Trap|Bull Trap|barrido|sweep confirmado|Order Block .* cerca/i.test(n);
  const esAdvertencia = (n) => /⚠️|en duda|falso|atrapados/i.test(n);
  const notasClave = notes.filter(esAccionable);
  const notasAviso = notes.filter(n => !esAccionable(n) && esAdvertencia(n));
  const notasContexto = notes.filter(n => !esAccionable(n) && !esAdvertencia(n));

  return {score, notes,
    // Las mismas notas, agrupadas por importancia para que quien las muestre pueda jerarquizar
    notasClave, notasAviso, notasContexto,
    events, bullishOB, bearishOB, fvgs, ifvgs, eqHighs, eqHighsCount, eqLows, eqLowsCount, fib, pivots, candlePattern, liquiditySweep, doubleTopBottom, resistanceTests, supportTests, accBearTrap, distBullTrap};
}

// ---------- Scoring ----------
function computeScore(data, macro, newsItems, sharedMemory, marketContext, btcReference){
  const closes = data.candles.map(c=>c.c);
  const vols = data.candles.map(c=>c.v);
  const price = closes.at(-1);
  const e20=ema(closes,20), e50=ema(closes,50), e200=ema(closes,200);
  const lastE20=e20.at(-1), lastE50=e50.at(-1), lastE200=e200.at(-1);
  // Con menos de 200 velas de historia, la EMA200 matemáticamente no tiene tiempo de converger —
  // devuelve un número, pero ese número no representa una tendencia de largo plazo real (encontrado
  // investigando por qué "Dios de Tendencia" y "Dios Macro" tenían solo 13% de acierto real en
  // monedas chicas: son justo las que menos historia suelen tener). Con menos datos, se usa una
  // referencia más corta (EMA100, o lo que haya) en vez de fingir una EMA200 que no es confiable.
  const datosSuficientesPara200 = closes.length >= 200;
  const lastE200Confiable = datosSuficientesPara200 ? lastE200 : ema(closes, Math.min(100, Math.max(20,closes.length-1))).at(-1);
  const rsiArr = rsi(closes,14);
  const lastRSI = rsiArr.filter(v=>v!=null).at(-1);
  const m = macd(closes);
  const lastHist=m.hist.at(-1), prevHist=m.hist.at(-2);
  const bb = bollinger(closes,20,2);
  const lastBB = bb.at(-1);
  const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0)/20;
  const lastVol = vols.at(-1);
  const atrArr = atr(data.candles,14);
  const lastATR = atrArr.at(-1);
  let {support, resistance} = findSupportResistance(data.candles);
  const stochOsc = stochasticOscillator(data.candles);
  const lastStochK = stochOsc.k.filter(v=>v!=null).at(-1);

  let trend=15, trendBias='neutral';
  if(datosSuficientesPara200){
    if(price>lastE50 && lastE50>lastE200Confiable){ trend=30; trendBias='bull'; }
    else if(price>lastE50 && lastE50<=lastE200Confiable){ trend=21; trendBias='bull'; }
    else if(price<lastE50 && lastE50<lastE200Confiable){ trend=3; trendBias='bear'; }
    else if(price<lastE50 && lastE50>=lastE200Confiable){ trend=10; trendBias='bear'; }
  } else {
    // Sin historia suficiente para una EMA200 real: mismo criterio direccional, pero con el voto
    // más cerca del centro (menos extremo) — refleja honestamente que hay menos confianza en la
    // lectura de "tendencia de largo plazo" cuando la moneda es demasiado nueva para tenerla.
    if(price>lastE50 && lastE50>lastE200Confiable){ trend=24; trendBias='bull'; }
    else if(price>lastE50 && lastE50<=lastE200Confiable){ trend=19; trendBias='bull'; }
    else if(price<lastE50 && lastE50<lastE200Confiable){ trend=9; trendBias='bear'; }
    else if(price<lastE50 && lastE50>=lastE200Confiable){ trend=13; trendBias='bear'; }
  }

  // Momentum ahora basado en el Estocástico clásico (%K), no en RSI — el Estocástico reacciona más
  // rápido a cambios recientes de precio, que es lo que se pidió acá.
  let momentum=12;
  if(lastStochK==null) momentum=12;
  else if(lastStochK>=40 && lastStochK<=80) momentum=20;
  else if(lastStochK>20 && lastStochK<40) momentum=11;
  else if(lastStochK>=80) momentum=8;
  else if(lastStochK<=20) momentum=15;
  if(lastHist>0 && lastHist>prevHist) momentum=Math.min(25,momentum+5);
  if(lastHist<0 && lastHist<prevHist) momentum=Math.max(0,momentum-3);

  let volume = lastVol>avgVol*1.2 ? 15 : lastVol>avgVol ? 10 : 5;

  let volat=6;
  if(lastBB.upper){
    const pos=(price-lastBB.lower)/(lastBB.upper-lastBB.lower||1);
    volat = pos>0.85 ? 4 : pos<0.2 ? 8 : 10;
  }

  let deriv=10, derivNote='Sin datos de futuros (par sin mercado de derivados en Binance).';
  if(data.funding!=null){
    const f = data.funding*100;
    if(f>0.05){ deriv=6; derivNote=`Funding sobrecalentado (${f.toFixed(3)}%): mercado de longs muy crowded, riesgo de squeeze.`; }
    else if(f<-0.02){ deriv=16; derivNote=`Funding negativo (${f.toFixed(3)}%): shorts pagan a longs, sesgo sano para long.`; }
    else { deriv=18; derivNote=`Funding neutro (${f.toFixed(3)}%): apalancamiento del mercado saludable.`; }
  }

  // rebalance base factors to leave room for structure (20 pts)
  const trendR = trend*(25/30), momentumR = momentum*(20/25), volumeR = volume*(12/15), volatR = volat*(8/10), derivR = deriv*(15/20);

  const structure = computeStructure(data.candles, atrArr);

  // Si hay una zona de oferta/demanda reciente MÁS CERCA del precio que el máximo/mínimo de toda
  // la ventana, la preferimos — el techo/piso "histórico" de 40 velas puede estar tan lejos que en
  // la práctica no es la zona que realmente frena al precio ahora mismo (esto lo confirmamos
  // comparando contra un gráfico real: la resistencia relevante estaba mucho más cerca).
  const nearbyRes = findNearbyLevel(structure.pivots, price, 'high');
  const nearbySup = findNearbyLevel(structure.pivots, price, 'low');
  if(nearbyRes && nearbyRes.price < resistance && nearbyRes.price > price){
    resistance = nearbyRes.price;
  }
  if(nearbySup && nearbySup.price > support && nearbySup.price < price){
    support = nearbySup.price;
  }

  const total = trendR+momentumR+volumeR+volatR+derivR+structure.score;
  const score10 = Math.max(1, Math.min(10, total/10));
  let bias='NEUTRAL';
  const structBias = structure.events.trendStructure;
  if(score10>=6.5 && trendBias!=='bear' && structBias!=='bear') bias='LONG';
  else if(score10<=4 && trendBias!=='bull' && structBias!=='bull') bias='SHORT';
  else if(score10>=6.5) bias='LONG';
  else if(score10<=4) bias='SHORT';

  // ---- Dual Long/Short score (signed bullishness index, transparent formula) ----
  let trendSignal = trend===30?1: trend===21?0.6: trend===15?0: trend===10?-0.6: trend===3?-1:0;

  // ═══ MODO REVERSIÓN: comprar abajo y vender arriba ═══
  // PROBLEMA QUE RESUELVE: la señal de Tendencia es puramente "¿el precio está arriba o abajo de
  // las medias?". Con 21-27% del peso, eso hace que el bot SOLO pueda abrir LONG cuando el precio
  // ya subió, y SOLO SHORT cuando ya cayó — persigue el movimiento y entra tarde. No sabe comprar
  // una caída ni vender un rebote, que es donde está el mejor precio.
  // SOLUCIÓN: si el precio está en contra de la tendencia PERO llegó a una zona real de reacción
  // (demanda/soporte con sobreventa, u oferta/resistencia con sobrecompra) y encima barrió la
  // liquidez de ese lado, la penalización de tendencia se neutraliza o se da vuelta.
  // No es ignorar la tendencia: es reconocer que dentro de una tendencia hay retrocesos, y que el
  // borde del retroceso es mejor entrada que el medio del impulso.
  const stochRev = stochasticOscillator(data.candles);
  const kRev = stochRev.k.at(-1), kRevPrev = stochRev.k.at(-2);
  const zonasRev = detectZonasOfertaDemanda(data.candles);
  const liqRev = detectLiquidezPorHorizonte(data.candles);
  let reversionNota = null;

  if(kRev!=null && kRevPrev!=null){
    // COMPRAR LA CAÍDA: precio abajo de las medias (trendSignal negativo) pero en zona de demanda
    // con el Estocástico en sobreventa y frenando.
    if(trendSignal < 0){
      const enDemandaRev = zonasRev.demanda.some(z => price <= z.techo*1.01 && price >= z.piso*0.99);
      const cercaSoporte = support && Math.abs(price-support)/price < 0.015;
      const liqBarridaAbajo = liqRev?.cercanaAbajo?.consumida;
      const sobreventaFrenando = kRev <= 30 && kRev >= kRevPrev;
      if((enDemandaRev || cercaSoporte) && sobreventaFrenando){
        // Se neutraliza la penalización; si además barrió liquidez abajo, se da vuelta a favor.
        trendSignal = liqBarridaAbajo ? 0.4 : 0;
        reversionNota = `🔄 Reversión: el precio viene cayendo pero llegó a ${enDemandaRev?'una zona de demanda':'un soporte'} con el Estocástico en ${kRev.toFixed(0)} dejando de bajar${liqBarridaAbajo?' y ya barrió la liquidez de abajo':''}. Es mejor precio comprar acá que esperar a que suba.`;
      }
    }
    // VENDER EL REBOTE: precio arriba de las medias pero en zona de oferta con sobrecompra.
    if(trendSignal > 0){
      const enOfertaRev = zonasRev.oferta.some(z => price >= z.piso*0.99 && price <= z.techo*1.01);
      const cercaResistencia = resistance && Math.abs(price-resistance)/price < 0.015;
      const liqBarridaArriba = liqRev?.cercanaArriba?.consumida;
      const sobrecompraFrenando = kRev >= 70 && kRev <= kRevPrev;
      if((enOfertaRev || cercaResistencia) && sobrecompraFrenando){
        trendSignal = liqBarridaArriba ? -0.4 : 0;
        reversionNota = `🔄 Reversión: el precio viene subiendo pero llegó a ${enOfertaRev?'una zona de oferta':'una resistencia'} con el Estocástico en ${kRev.toFixed(0)} dejando de subir${liqBarridaArriba?' y ya barrió la liquidez de arriba':''}. Es mejor precio vender acá que esperar a que caiga.`;
      }
    }
  }

  // ═══ MERCADO LATERAL: operar los bordes del rango ═══
  // En lateral el bot no hacía NADA: el score se quedaba cerca de 5 y nunca llegaba al umbral.
  // Pero un rango tiene bordes operables — comprar el piso y vender el techo es justamente lo que
  // se hace en lateral.
  // OJO: la condición anterior era trend===15, que es INALCANZABLE (solo se da si el precio es
  // exactamente igual a la EMA50). Ahora se detecta con ADX bajo, que es la medida real de
  // "sin tendencia definida".
  const adxLateral = adx(data.candles);
  const esLateral = adxLateral!=null && adxLateral < 20;
  if(esLateral && support && resistance && resistance>support){
    const anchoRango = (resistance-support)/support;
    if(anchoRango > 0.02){ // rango con recorrido suficiente para que valga la pena
      const posEnRango = (price-support)/(resistance-support); // 0 = piso, 1 = techo
      if(posEnRango <= 0.25 && kRev!=null && kRev <= 45){
        trendSignal = 0.5;
        reversionNota = `📊 Mercado lateral: el precio está en la parte baja del rango ($${fmt(support)}–$${fmt(resistance)}) con el Estocástico en ${kRev.toFixed(0)}. En un rango, el piso es zona de compra.`;
      } else if(posEnRango >= 0.75 && kRev!=null && kRev >= 55){
        trendSignal = -0.5;
        reversionNota = `📊 Mercado lateral: el precio está en la parte alta del rango ($${fmt(support)}–$${fmt(resistance)}) con el Estocástico en ${kRev.toFixed(0)}. En un rango, el techo es zona de venta.`;
      }
    }
  }

  const momentumSignalBase = Math.max(-1,Math.min(1,(momentum-12.5)/12.5));
  // Divergencia RSI+MACD como señal de APOYO (no disparador principal): el backtest en 4 períodos
  // de BTC dio Profit Factor 1.07-1.43 sin perder en ninguno, pero con pocas señales — sirve para
  // reforzar o matizar el momentum, no para decidir por sí sola. Por eso pesa poco (±0.25).
  const divergencia = detectDivergencia(data.candles);
  let momentumSignal = momentumSignalBase;
  if(divergencia){
    momentumSignal = Math.max(-1, Math.min(1, momentumSignalBase + (divergencia.tipo==='alcista' ? 0.25 : -0.25)));
  }
  // Dios Derivados: deriv solo toma 4 valores discretos (no es una escala continua):
  //   6  = funding sobrecalentado (longs crowded, riesgo de squeeze) -> señal bajista
  //   10 = sin datos de futuros -> neutro
  //   16 = funding negativo (shorts pagan a longs, sano para long) -> señal alcista fuerte
  //   18 = funding neutro (apalancamiento saludable) -> señal levemente alcista
  // La fórmula anterior usaba comparaciones (deriv>=18?0.6: deriv>=16?0.8: deriv<=6?-0.5:0) que
  // daban resultados incoherentes: funding NEGATIVO (16) pesaba MÁS que funding neutro (18), y
  // cualquier valor entre 7 y 15 daba 0. Se reemplaza por un mapeo explícito de los 4 casos reales.
  const derivSignal = deriv===6 ? -0.6 : deriv===16 ? 0.8 : deriv===18 ? 0.3 : 0;
  let structureSignal = structBias==='bull'?0.8 : structBias==='bear'?-0.8 : 0;
  if(structure.events.bos) structureSignal += (structure.events.bos==='bullish'?0.2:-0.2);
  if(structure.events.choch) structureSignal += (structure.events.choch==='bullish'?0.3:-0.3);
  structureSignal = Math.max(-1,Math.min(1,structureSignal));

  // ---- Macro trend filter (4h EMA200): opera solo a favor de la tendencia mayor ----
  const macroSignal = macro? (macro.bias==='bull'?1:-1) * (macro.confiable===false ? 0.7 : 1) : 0;
  // Doble Techo/Suelo (Mind Math Money) — probado con backtest real: solo suma cuando va A FAVOR de
  // la tendencia macro (EMA200). En contra de la tendencia, se ignora del todo (no resta, no suma) —
  // el backtest mostró que en contra directamente no funciona, mejor no usarlo ahí que usarlo mal.
  let dobleTechoSueloSignal = 0;
  if(structure.doubleTopBottom && macro){
    if(structure.doubleTopBottom.dobleTecho && macro.bias==='bear') dobleTechoSueloSignal = -0.4;
    if(structure.doubleTopBottom.dobleSuelo && macro.bias==='bull') dobleTechoSueloSignal = 0.4;
  }
  structureSignal = Math.max(-1,Math.min(1, structureSignal + dobleTechoSueloSignal));
  const macroNote = macro ? `Tendencia macro (4h, EMA200): ${macro.bias==='bull'?'ALCISTA 🟢':'BAJISTA 🔴'} (precio ${macro.bias==='bull'?'por encima':'por debajo'} de EMA200 en 4h).` : 'Sin datos de tendencia macro (4h).';

  // ---- Contexto de Mercado (TOTAL2/TOTAL3, dominancia BTC, USD Strength proxy) ----
  const mc = (typeof window!=='undefined' && window.marketContext) ? window.marketContext : null;
  const isBTC = data.displayName === 'BTC';
  let marketSignal = 0, marketNote = 'Sin datos de contexto de mercado global todavía.';
  if(mc && mc.btcDominance!=null){
    const altFriendly = isBTC ? 0 : (mc.btcDominance<48 ? 1 : mc.btcDominance>55 ? -1 : 0);
    const riskAppetite = mc.marketCapChange24h!=null ? Math.max(-1,Math.min(1, mc.marketCapChange24h/5)) : 0;
    const usdHeadwind = mc.usdStrength!=null ? Math.max(-1,Math.min(1, -mc.usdStrength/1.5)) : 0;
    marketSignal = Math.max(-1, Math.min(1, altFriendly*0.4 + riskAppetite*0.4 + usdHeadwind*0.2));
    const rotation = isBTC ? '' : (mc.btcDominance<48 ? ' + rotación de capital hacia altcoins (dominancia BTC baja)' : mc.btcDominance>55 ? ' + capital todavía concentrado en BTC (poco favorable para altcoins)' : '');
    marketNote = `Mercado global: cap. total ${mc.marketCapChange24h>=0?'+':''}${mc.marketCapChange24h?.toFixed(1)}% (24h), dominancia BTC ${mc.btcDominance?.toFixed(1)}%${rotation}${mc.usdStrength!=null?`, USD ${mc.usdStrength>=0?'fortaleciéndose':'debilitándose'} (proxy ${mc.usdStrength.toFixed(2)}% en 7d)`:''}.`;
  }

  // ---- Horario de sesión: Londres ~07-16 UTC, Nueva York ~13-22 UTC. El solapamiento (13-16 UTC) es la ventana de mayor liquidez. ----
  const utcHour = new Date().getUTCHours();
  let sessionNote;
  if(utcHour>=13 && utcHour<16) sessionNote = 'Solapamiento Londres/Nueva York (mayor liquidez del día): las señales ahora tienden a ser más confiables.';
  else if(utcHour>=7 && utcHour<16) sessionNote = 'Sesión de Londres activa: liquidez razonable.';
  else if(utcHour>=13 && utcHour<22) sessionNote = 'Sesión de Nueva York activa: liquidez razonable.';
  else sessionNote = 'Fuera de las sesiones de Londres/Nueva York (Asia/madrugada): liquidez más fina, movimientos pueden ser menos confiables.';
  marketNote = marketNote + ' ' + sessionNote;
  const fomc = getFOMCWindow(3);
  if(fomc.isNear){
    marketNote += fomc.hoursUntil>0
      ? ` ⚠️ Anuncio de la Fed (FOMC) en ${fomc.hoursUntil.toFixed(1)}hs: el mercado puede moverse fuerte y errático por esto, no por el análisis técnico.`
      : ` ⚠️ El anuncio de la Fed (FOMC) fue hace ${Math.abs(fomc.hoursUntil).toFixed(1)}hs: la volatilidad reciente puede deberse a esto.`;
  }

  const weights = macro
    ? {trend:0.21,momentum:0.16,deriv:0.13,structure:0.18,macro:0.22,market:0.10}
    : {trend:0.27,momentum:0.21,deriv:0.17,structure:0.23,macro:0,market:0.12};
  // Nota: se probaron pesos adaptados por régimen (ADX) acá, con backtest real — empeoró el
  // resultado en 2 de 3 períodos (2023-2025 y 2019 lateral), casi sin cambio en el otro (2022).
  // Se revirtió a los pesos fijos, que ya están validados. Si en el futuro se quiere retomar la
  // idea, hay que ajustar los multiplicadores/umbrales de ADX y volver a correr el backtest antes
  // de subirlo — no alcanza con que la idea tenga buen respaldo teórico, tiene que dar mejor en la
  // práctica también.
  let bullishness = trendSignal*weights.trend + momentumSignal*weights.momentum + derivSignal*weights.deriv + structureSignal*weights.structure + macroSignal*weights.macro + marketSignal*weights.market;

  // ═══ EXPLAIN ENGINE ═══
  // Guarda de dónde sale el score, componente por componente. Antes esto no existía: el "breakdown"
  // que se mostraba eran sub-puntajes (Volumen, Volatilidad) que NO entran en la fórmula final —
  // o sea que la explicación visible no coincidía con lo que realmente decidía.
  // El score final es 5 + 5*bullishness, así que el aporte de cada componente en puntos de score
  // es 5 * señal * peso. Con signo: positivo empuja a LONG, negativo a SHORT.
  const _aporte = (senal, peso) => +(5 * senal * peso).toFixed(2);
  const explainEngine = {
    formula: 'score = 5 + 5 × (suma de señales × sus pesos)',
    componentes: [
      { nombre:'Tendencia',   senal:+trendSignal.toFixed(3),     peso:weights.trend,     aporte:_aporte(trendSignal, weights.trend),         detalle: trendBias==='bull'?'precio sobre las medias':trendBias==='bear'?'precio bajo las medias':'sin dirección clara' },
      { nombre:'Momentum',    senal:+momentumSignal.toFixed(3),  peso:weights.momentum,  aporte:_aporte(momentumSignal, weights.momentum),   detalle: `Estocástico ${lastStochK!=null?lastStochK.toFixed(0):'—'}${divergencia?' + divergencia '+divergencia.tipo:''}` },
      { nombre:'Estructura',  senal:+structureSignal.toFixed(3), peso:weights.structure, aporte:_aporte(structureSignal, weights.structure), detalle: structure.events?.bos ? `BOS ${structure.events.bos}` : structure.events?.choch ? `CHoCH ${structure.events.choch}` : 'sin ruptura de estructura' },
      { nombre:'Derivados',   senal:+derivSignal.toFixed(3),     peso:weights.deriv,     aporte:_aporte(derivSignal, weights.deriv),         detalle: derivNote },
      { nombre:'Macro (4h)',  senal:+macroSignal.toFixed(3),     peso:weights.macro,     aporte:_aporte(macroSignal, weights.macro),         detalle: macro ? `precio ${macro.bias==='bull'?'sobre':'bajo'} la EMA200 de 4h${macro.confiable===false?' (poca historia)':''}` : 'sin datos de 4h' },
      { nombre:'Dominancias', senal:+marketSignal.toFixed(3),    peso:weights.market,    aporte:_aporte(marketSignal, weights.market),       detalle: marketNote },
    ],
    base: 5,
    informativos: [], // se completa más abajo, cuando el comité ya está armado
  };
  explainEngine.sumaAportes = +explainEngine.componentes.reduce((s,c)=>s+c.aporte, 0).toFixed(2);
  explainEngine.componentes.sort((a,b)=>Math.abs(b.aporte)-Math.abs(a.aporte));

  const volumeQuality = volume/15;
  const volatQuality = volat>=10?1 : volat<=4?0.8 : 0.9;
  const _bullAntes = bullishness;
  bullishness = Math.max(-1,Math.min(1, bullishness*(0.75+0.25*volumeQuality)*volatQuality));
  // Volumen y volatilidad NO suman: MULTIPLICAN el resultado de los 6 componentes. Un volumen
  // flojo o una volatilidad extrema achican la señal entera. Por eso la suma de los aportes no
  // coincidía con el score final — faltaba explicar este paso.
  explainEngine.ajusteCalidad = {
    factorVolumen: +(0.75+0.25*volumeQuality).toFixed(3),
    factorVolatilidad: +volatQuality.toFixed(3),
    antes: +_bullAntes.toFixed(3),
    despues: +bullishness.toFixed(3),
    efectoEnScore: +(5*(bullishness-_bullAntes)).toFixed(2),
    nota: 'El volumen y la volatilidad multiplican la señal, no la suman: si el volumen no acompaña o la volatilidad es extrema, toda la señal se achica.',
  };

  // ---- Confluencia avanzada: cruce Estocástico + estructura SMC + funding (short/long squeeze setup) ----
  let confluenceNote = null;
  if(lastStochK!=null && lastStochK<=20 && structBias==='bull' && data.funding!=null && data.funding<0){
    bullishness = Math.max(bullishness, 0.9);
    confluenceNote = '🔥 Confluencia fuerte ALCISTA: Estocástico en sobreventa + estructura SMC alcista + funding negativo (shorts sobreapalancados) → posible short squeeze.';
  } else if(lastStochK!=null && lastStochK>=80 && structBias==='bear' && data.funding!=null && data.funding>0.0005){
    bullishness = Math.min(bullishness, -0.9);
    confluenceNote = '🔥 Confluencia fuerte BAJISTA: Estocástico en sobrecompra + estructura SMC bajista + funding muy positivo (longs sobreapalancados) → riesgo de long squeeze.';
  }

  const longScore = Math.max(0, Math.min(10, +(5+5*bullishness).toFixed(1)));
  const shortScore = Math.max(0, Math.min(10, +(10-longScore).toFixed(1)));
  const confidence = Math.round(Math.abs(bullishness)*100);
  const bestScore = Math.max(longScore, shortScore);
  let stars = bestScore>=9.5?5 : bestScore>=8?4 : bestScore>=6.5?3 : bestScore>=5?2 : 1;
  // Perfil de trader: conservador exige más confianza para operar, agresivo se conforma con menos
  const profileThresholds = {conservative:7.5, balanced:6.5, aggressive:5.5};
  const scoreThreshold = profileThresholds[typeof riskProfile!=='undefined'?riskProfile:'balanced'] || 6.5;
  const macroTolerance = {conservative:95, balanced:85, aggressive:70}[typeof riskProfile!=='undefined'?riskProfile:'balanced'] || 85;
  let recommendation = 'NO OPERAR';
  if(longScore>=scoreThreshold) recommendation='LONG'; else if(shortScore>=scoreThreshold) recommendation='SHORT';
  // Filtro de tendencia mayor: si va totalmente contra la macro de 4h, degradar a NO OPERAR salvo confluencia extrema
  if(macro && !confluenceNote){
    if(recommendation==='LONG' && macro.bias==='bear' && confidence<macroTolerance) recommendation='NO OPERAR';
    if(recommendation==='SHORT' && macro.bias==='bull' && confidence<macroTolerance) recommendation='NO OPERAR';
  }

  const supportStrength = levelStrength(data.candles, support);
  const resistanceStrength = levelStrength(data.candles, resistance);
  const distToSupportPct = ((price-support)/price)*100;
  const distToResistancePct = ((resistance-price)/price)*100;

  // ---- Indicadores adicionales (panel "Estado de indicadores") ----
  const stochRsiArr = stochRsi(rsiArr,14);
  const lastStochRsi = stochRsiArr.filter(v=>v!=null).at(-1);
  const lastMFI = mfi(data.candles,14);
  const obvArr = obvSeries(data.candles);
  const obvUp = obvArr.at(-1) > obvArr[Math.max(0,obvArr.length-11)];
  const lastADX = adx(data.candles,14);
  const lastCCI = cci(data.candles,20);
  const lastROC = roc(closes,12);

  const st = (cond, yes, no) => cond ? yes : no;
  const indicatorStatus = [
    {name:'Estocástico (%K)', value: lastStochK!=null?lastStochK.toFixed(1):'—', status: lastStochK==null?'neutral':lastStochK>=80?'bajista':lastStochK<=20?'alcista':'neutral', note: lastStochK==null?'Sin datos suficientes.':lastStochK>=80?'Sobrecompra: el motor no confirma entradas nuevas en esta zona.':lastStochK<=20?'Sobreventa: el motor no confirma entradas nuevas en esta zona.':'Zona intermedia, es el que usa el motor para el momentum.'},
    {name:'Stochastic RSI', value: lastStochRsi!=null?lastStochRsi.toFixed(1):'—', status: lastStochRsi==null?'neutral':lastStochRsi>=80?'bajista':lastStochRsi<=20?'alcista':'neutral', note: lastStochRsi==null?'Sin datos suficientes.':lastStochRsi>=80?'Sobrecompra: posible agotamiento del impulso.':lastStochRsi<=20?'Sobreventa: posible rebote.':'Zona intermedia, sin extremos.'},
    {name:'MFI (dinero)', value: lastMFI.toFixed(1), status: lastMFI>=80?'bajista':lastMFI<=20?'alcista':'neutral', note: lastMFI>=80?'Flujo de dinero sobrecomprado.':lastMFI<=20?'Flujo de dinero sobrevendido, posible entrada de compradores.':'Flujo de dinero equilibrado.'},
    {name:'OBV (volumen acumulado)', value: obvUp?'Subiendo':'Bajando', status: obvUp?'alcista':'bajista', note: obvUp?'El volumen acompaña las subidas recientes (confirma tendencia).':'El volumen acompaña las bajadas recientes.'},
    {name:'ADX (fuerza de tendencia)', value: lastADX!=null?lastADX.toFixed(1):'—', status: lastADX==null?'neutral':lastADX>=25?(trendBias==='bull'?'alcista':trendBias==='bear'?'bajista':'neutral'):'neutral', note: lastADX==null?'Sin datos suficientes.':lastADX>=25?'Tendencia con fuerza real (ADX≥25).':'Tendencia débil o mercado lateral (ADX<25).'},
    {name:'CCI', value: lastCCI!=null?lastCCI.toFixed(0):'—', status: lastCCI==null?'neutral':lastCCI>=100?'bajista':lastCCI<=-100?'alcista':'neutral', note: lastCCI==null?'Sin datos suficientes.':lastCCI>=100?'Sobrecompra según CCI.':lastCCI<=-100?'Sobreventa según CCI.':'Dentro de rango normal.'},
    {name:'ROC (momentum %)', value: lastROC!=null?lastROC.toFixed(1)+'%':'—', status: lastROC==null?'neutral':lastROC>0?'alcista':'bajista', note: lastROC==null?'Sin datos suficientes.':lastROC>0?'Precio por encima de hace 12 velas: momentum positivo.':'Precio por debajo de hace 12 velas: momentum negativo.'},
  ];

  // ---- Probabilidades (alcista / bajista / lateral), derivadas del score dual, no de un solo indicador ----
  const spreadLS = Math.abs(longScore-shortScore);
  const probSideways = Math.max(8, Math.round(38 - spreadLS*3));
  const remainingProb = 100-probSideways;
  const totalRaw = (longScore+shortScore)||1;
  const probBull = Math.round(remainingProb*(longScore/totalRaw));
  const probBear = 100-probSideways-probBull;
  const probabilities = {bull:probBull, bear:probBear, sideways:probSideways};


  const vote = s => s>=0.3?'LONG':s<=-0.3?'SHORT':'NEUTRAL';
  const committee = [
    {name:'📈 Dios de Tendencia', signal:trendSignal, vote:vote(trendSignal)},
    {name:'⚡ Dios Momentum', signal:momentumSignal, vote:vote(momentumSignal)},
    {name:'🧠 Dios Smart Money', signal:structureSignal, vote:vote(structureSignal)},
    {name:'💰 Dios Derivados', signal:derivSignal, vote:vote(derivSignal)},
  ];
  if(macro) committee.push({name:'🌐 Dios Macro (4h)', signal:macroSignal, vote:vote(macroSignal)});
  if(mc && mc.btcDominance!=null) committee.push({name:'🌍 Dios de Dominancias', signal:marketSignal, vote:vote(marketSignal)});

  // ---- Los 4 dioses nuevos: solo votan y explican (no alteran la fórmula del score ya calibrada, para no romper nada existente) ----
  // Capital Flow: usa datos REALES de DeFiLlama (stablecoins + TVL) cuando están disponibles; si no, cae al proxy de volumen.
  let capitalFlowSignal = volumeQuality>=0.8 ? 0.4 : volumeQuality<=0.3 ? -0.3 : 0;
  let capitalFlowNote = 'Proxy por volumen relativo (sin datos de DeFiLlama disponibles en este análisis).';
  if(marketContext?.capitalFlow){
    const {stablecoinTrend, tvlTrend} = marketContext.capitalFlow;
    if(stablecoinTrend && tvlTrend){
      if(stablecoinTrend==='RISING' && tvlTrend==='RISING'){ capitalFlowSignal = 0.5; capitalFlowNote = 'Stablecoins y TVL global en alza: capital entrando a cripto (pólvora seca disponible).'; }
      else if(stablecoinTrend==='FALLING' && tvlTrend==='FALLING'){ capitalFlowSignal = -0.4; capitalFlowNote = 'Stablecoins y TVL global cayendo: capital saliendo del ecosistema cripto.'; }
      else { capitalFlowNote = `Stablecoins ${stablecoinTrend}, TVL global ${tvlTrend}: señal mixta de flujo de capital.`; }
    }
  }
  committee.push({name:'💧 Dios Capital Flow', signal:capitalFlowSignal, vote:vote(capitalFlowSignal), note:capitalFlowNote});

  const riskSignalDir = trendSignal!==0 ? Math.sign(trendSignal) : 1;
  let riskSignal = volat>=10 ? 0.25*riskSignalDir : volat<=4 ? -0.25 : 0; // castiga la convicción si el precio está muy extendido
  const squeeze = detectSqueeze(data.candles, lastBB);
  let riskNote = squeeze?.squeezeOn ? 'Compresión de volatilidad detectada (Bollinger dentro de Keltner): posible ruptura fuerte próxima, en cualquier dirección.' : 'Sin compresión de volatilidad relevante ahora mismo.';
  if(squeeze?.squeezeOn) riskSignal *= 0.6; // en squeeze la dirección es incierta hasta que rompe: se atenúa la convicción
  // Barrida de liquidez reciente en contra de la dirección que este dios venía sugiriendo: penaliza fuerte (trampa detectada)
  const sweep = structure.liquiditySweep;
  if(sweep?.sweptUp && riskSignalDir>0){ const penalty = Math.min(0.7, 0.3+sweep.strengthUp/10); riskSignal = Math.min(riskSignal, -penalty); riskNote += ` 🚨 Además, se detectó una barrida de liquidez alcista reciente (mecha ${sweep.strengthUp.toFixed(1)}%): entrar en LONG justo ahora tiene riesgo de trampa.`; }
  if(sweep?.sweptDown && riskSignalDir<0){ const penalty = Math.min(0.7, 0.3+sweep.strengthDown/10); riskSignal = Math.max(riskSignal, penalty); riskNote += ` 🚨 Además, se detectó una barrida de liquidez bajista reciente (mecha ${sweep.strengthDown.toFixed(1)}%): entrar en SHORT justo ahora tiene riesgo de trampa.`; }
  committee.push({name:'⚠️ Dios Gestión de Riesgo', signal:riskSignal, vote:vote(riskSignal), note:riskNote, squeezeOn: squeeze?.squeezeOn||false});

  const liquidityOk = (data.vol24h||0) > 1000000;
  const radarSignal = liquidityOk ? 0.3*riskSignalDir : -0.2; // menos convicción si la liquidez de la fuente es baja
  committee.push({name:'📡 Dios Radar del Mercado', signal:radarSignal, vote:vote(radarSignal), note: `Fuente: ${data.source}, volumen 24h: $${((data.vol24h||0)/1e6).toFixed(1)}M`});

  let memorySignal = 0, memoryNote = 'Sin memoria compartida previa de esta moneda (TheHaton todavía no la analizó).';
  const prevMem = sharedMemory && sharedMemory[data.displayName];
  if(prevMem){
    const consistent = (prevMem.lastRecommendation==='LONG' && trendSignal>0) || (prevMem.lastRecommendation==='SHORT' && trendSignal<0);
    memorySignal = consistent ? 0.3 : -0.2;
    const when = prevMem.ts ? new Date(prevMem.ts).toLocaleString() : '';
    memoryNote = `Memoria compartida de TheHaton (${when}): última lectura ${prevMem.lastRecommendation} (${consistent?'coincide':'contradice'} la tendencia actual). Esta memoria es única para toda la plataforma (web + bot).`;
  }
  committee.push({name:'🧠 Dios Memoria', signal:memorySignal, vote:vote(memorySignal), note: memoryNote});

  // ---- Dios de Fuerza Relativa vs BTC (11°): resuelve el "problema de la dominancia" ----
  // Si BTC domina pero esta moneda le está ganando en rendimiento reciente, eso compensa
  // el castigo ciego que el Dios de Dominancias le mete cuando la dominancia de BTC sube.
  const coinCloses = data.candles.map(c=>c.c);
  const lookback = Math.min(8, coinCloses.length-1);
  const coinPctChange = lookback>0 ? ((coinCloses.at(-1)-coinCloses[coinCloses.length-1-lookback])/coinCloses[coinCloses.length-1-lookback])*100 : 0;
  let relStrengthSignal = 0;
  let relStrengthNote = 'Sin datos de BTC para comparar en este análisis.';
  if(btcReference!=null && data.displayName!=='BTC'){
    const diff = coinPctChange - btcReference.pctChange;
    relStrengthSignal = Math.max(-1, Math.min(1, diff/10)); // cada 10 puntos porcentuales de diferencia = señal completa
    relStrengthNote = diff>=0
      ? `${data.displayName} rindió ${diff.toFixed(1)}pp mejor que BTC en el mismo período (${coinPctChange.toFixed(1)}% vs ${btcReference.pctChange.toFixed(1)}%): fuerza relativa positiva, compensa una dominancia de BTC alta.`
      : `${data.displayName} rindió ${Math.abs(diff).toFixed(1)}pp peor que BTC en el mismo período (${coinPctChange.toFixed(1)}% vs ${btcReference.pctChange.toFixed(1)}%): fuerza relativa débil frente al líder del mercado.`;
  } else if(data.displayName==='BTC'){
    relStrengthNote = 'No aplica: esta es la propia referencia (BTC).';
  }
  committee.push({name:'💪 Dios de Fuerza Relativa (vs BTC)', signal:relStrengthSignal, vote:vote(relStrengthSignal), note:relStrengthNote});

  // ---- Dios VWAP (13°): el nivel que usan de verdad los institucionales para ejecutar sus órdenes.
  // Precio arriba del VWAP = sesgo alcista real (compradores pagando por encima del promedio ponderado
  // por volumen), abajo = sesgo bajista. Las bandas de desviación marcan qué tan "estirado" está.
  const vwapData = computeVWAP(data.candles);
  let vwapSignal = 0, vwapNote = 'Sin datos suficientes para VWAP.';
  if(vwapData.vwap){
    const stdevBand = vwapData.upper1 - vwapData.vwap;
    vwapSignal = stdevBand>0 ? Math.max(-1, Math.min(1, (price-vwapData.vwap)/(stdevBand*1.5))) : 0;
    const zona = price>vwapData.upper2 ? 'muy por encima de +2 desviaciones (extendido)' : price>vwapData.upper1 ? 'por encima de +1 desviación' : price>vwapData.vwap ? 'por encima del VWAP' : price>vwapData.lower1 ? 'por debajo del VWAP' : price>vwapData.lower2 ? 'por debajo de -1 desviación' : 'muy por debajo de -2 desviaciones (extendido)';
    vwapNote = `Precio $${fmtPrecio(price)} está ${zona} ($${fmtPrecio(vwapData.vwap)}) — nivel real donde ejecutan los grandes jugadores.`;
  }
  committee.push({name:'📊 Dios VWAP', signal:vwapSignal, vote:vote(vwapSignal), note:vwapNote});

  // ---- Dios CVD (14°): flujo de compra/venta aproximado (ver nota en computeCVD) — detecta rupturas
  // débiles (el precio hace un máximo/mínimo nuevo, pero el volumen que empuja no acompaña).
  const cvdData = computeCVD(data.candles);
  let cvdSignal = 0, cvdNote = 'Sin datos suficientes para CVD.';
  if(cvdData){
    if(cvdData.bearishDivergence){ cvdSignal = -0.6; cvdNote = 'Divergencia bajista de CVD: el precio sube pero el volumen comprador se debilita — posible ruptura falsa.'; }
    else if(cvdData.bullishDivergence){ cvdSignal = 0.6; cvdNote = 'Divergencia alcista de CVD: el precio baja pero el volumen vendedor se debilita — posible ruptura falsa a la baja.'; }
    else cvdNote = `CVD acompañando el movimiento actual sin divergencia (aproximado por vela, no tick-a-tick real).`;
  }
  committee.push({name:'📉 Dios CVD', signal:cvdSignal, vote:vote(cvdSignal), note:cvdNote});

  // ---- Dios Market Context Matrix (12°): OI + Precio + Funding combinados, no aislados ----
  const priceTrend = classifyTrend(data.candles.map(c=>c.c).slice(-8), 2);
  const ctx = marketContext ? marketContextMatrix(marketContext.oiTrend, priceTrend, marketContext.fundingTrend) : null;
  let contextNote = 'Sin datos de Open Interest para esta fuente (solo disponible en pares de futuros de Binance).';
  let contextSignal = 0;
  if(ctx){
    contextSignal = ctx.signal;
    contextNote = `OI ${ctx.oiTrend} + Precio ${ctx.priceTrend} + Funding ${ctx.fundingTrend} → ${ctx.outlook}${ctx.flag?' ⚠️':''}: ${ctx.note}`;
  }
  committee.push({name:'📊 Dios Market Context Matrix', signal:contextSignal, vote:vote(contextSignal), note:contextNote, flag: ctx?.flag||false});

  committee.forEach(c=>c.confidence = Math.round(Math.abs(c.signal)*100));
  const votesLong = committee.filter(c=>c.vote==='LONG').length;
  const votesShort = committee.filter(c=>c.vote==='SHORT').length;

  // ---- Sello de calidad de datos: qué le faltó a este análisis, para no confundir "score bajo" con "datos incompletos" ----
  const missingData = [];
  // Binance y MEXC Futuros dan funding e interés abierto; el resto de las fuentes no.
  if(data.source!=='Binance' && data.source!=='MEXC Futuros') missingData.push('Open Interest y Funding (esta fuente no los provee)');
  else{
    if(!marketContext?.oiTrend) missingData.push('Open Interest');
    if(!marketContext?.fundingTrend) missingData.push('Funding (tendencia)');
  }
  if(!macro) missingData.push('Tendencia macro (4h)');
  if(!marketContext?.capitalFlow) missingData.push('Flujo de capital (DeFiLlama)');
  if(btcReference==null && data.displayName!=='BTC') missingData.push('Fuerza relativa vs BTC');
  // ═══ DATA QUALITY SCORE (0-100) ═══
  // Antes solo decía "completo: sí/no". Eso mezclaba dos cosas muy distintas: que falte el flujo de
  // capital global (menor) no es lo mismo que tener pocas velas para calcular indicadores (grave).
  // Ahora cada dato pesa según cuánto afecta la decisión, y el resultado es un número comparable.
  // NO modifica el score: solo avisa cuánta confianza merecen los datos detrás de ese score.
  const _chequeos = [
    { nombre:'Velas (OHLCV)',      ok: (data.candles?.length||0) >= 200, peso: 30, parcial: (data.candles?.length||0) >= 60 },
    { nombre:'Precio actual',      ok: Number.isFinite(data.price),      peso: 15 },
    { nombre:'Volumen',            ok: (data.candles||[]).slice(-20).every(c=>c.v>0), peso: 10 },
    { nombre:'Open Interest',      ok: !!marketContext?.oiTrend,         peso: 12 },
    { nombre:'Funding',            ok: !!marketContext?.fundingTrend,    peso: 12 },
    { nombre:'Tendencia macro 4h', ok: !!macro,                          peso: 11 },
    { nombre:'Flujo de capital',   ok: !!marketContext?.capitalFlow,     peso: 5 },
    { nombre:'Referencia BTC',     ok: !!btcReference,                   peso: 5 },
  ];
  let _puntos = 0;
  const _faltantes = [];
  for(const ch of _chequeos){
    if(ch.ok) _puntos += ch.peso;
    else if(ch.parcial){ _puntos += ch.peso*0.5; _faltantes.push(`${ch.nombre} (parcial)`); }
    else _faltantes.push(ch.nombre);
  }
  const _score = Math.round(_puntos);
  const dataQuality = {
    complete: missingData.length===0,
    missing: missingData,
    score: _score,
    nivel: _score>=85 ? 'alta' : _score>=65 ? 'aceptable' : _score>=45 ? 'baja' : 'insuficiente',
    detalle: _chequeos.map(ch=>({ nombre:ch.nombre, ok:ch.ok, peso:ch.peso })),
    faltantes: _faltantes,
    // Con calidad insuficiente conviene no confirmar entradas: el score sale de datos incompletos.
    confiable: _score >= 45,
  };

  // Se completa acá porque el comité recién está armado a esta altura. Lista los que se muestran
  // pero NO entran en la fórmula — evita creer que votaron 14 cuando votaron 6.
  const _DECIDEN = ['📈 Dios de Tendencia','⚡ Dios Momentum','🧠 Dios Smart Money','💰 Dios Derivados','🌐 Dios Macro (4h)','🌍 Dios de Dominancias'];
  explainEngine.informativos = (committee||[]).filter(g=>!_DECIDEN.includes(g.name)).map(g=>g.name);

  return {
    score10, bias,
    longScore, shortScore, confidence, stars, recommendation,
    breakdown:[{label:'Tendencia',val:Math.round(trendR),max:25},{label:'Momentum',val:Math.round(momentumR),max:20},{label:'Volumen',val:Math.round(volumeR),max:12},{label:'Volatilidad',val:Math.round(volatR),max:8},{label:'Derivados',val:Math.round(derivR),max:15},{label:'Estructura SMC',val:Math.round(structure.score),max:20}],
    metrics:{price,lastE20,lastE50,lastE200,lastRSI,lastStochK,lastHist,lastATR,support,resistance,avgVol,lastVol,funding:data.funding,bb:lastBB,supportStrength,resistanceStrength,distToSupportPct,distToResistancePct,vwap:vwapData,divergencia,triangulo:detectTrianguloCompresion(data.candles)},
    derivNote, structure, macroNote, marketNote, confluenceNote, committee, votesLong, votesShort, probabilities, indicatorStatus, dataQuality, cvd:cvdData, reversionNota, explainEngine,
    series:{closes,e20,e50,e200,rsiArr,macd:m,bb}
  };
}

// ---------- Modo Analista: explicación en simple, checklist de confluencias, invalidación ----------
function buildAnalystMode(data, result, setup, currentTF){
  const m = result.metrics;
  const rec = result.recommendation;
  const totalVotes = result.committee.length;
  const st = result.structure;

  const checklist = result.committee.map(c=>({
    label: c.name,
    pass: rec==='NO OPERAR' ? c.vote==='NEUTRAL' : c.vote===rec
  }));
  const passCount = checklist.filter(c=>c.pass).length;
  const against = result.committee.filter(c=> rec!=='NO OPERAR' && c.vote!=='NEUTRAL' && c.vote!==rec).map(c=>c.name);
  const supportive = result.committee.filter(c=> rec!=='NO OPERAR' && c.vote===rec).map(c=>c.name);

  // Resumen (lo que ya había)
  let resumen;
  if(rec==='NO OPERAR'){
    resumen = `El mercado no muestra una ventaja clara ahora mismo: los especialistas internos están divididos (${result.votesLong} a favor de long, ${result.votesShort} de short). Cuando no hay confluencia, lo más profesional es esperar en vez de forzar una entrada.`;
  } else {
    const dirWord = rec==='LONG' ? 'alcista' : 'bajista';
    resumen = `La estructura es ${dirWord} en ${currentTF}. ${passCount} de ${totalVotes} especialistas internos coinciden en ${rec}, con Estocástico en ${m.lastStochK?.toFixed(0)??'—'} (${m.lastStochK>=80?'zona de sobrecompra, cuidado':m.lastStochK<=20?'zona de sobreventa':'zona sana'}) y volumen ${m.lastVol>m.avgVol?'por encima':'por debajo'} del promedio.${result.confluenceNote?' Además hay una confluencia fuerte que refuerza la señal.':''} Por eso el motor recomienda ${rec}, con ${result.confidence}% de confianza.`;
  }

  // Qué apoya / qué no acompaña
  const soporta = supportive.length ? supportive.join(', ') : 'ningún especialista con señal fuerte';
  const noAcompana = against.length ? against.join(', ') : 'ninguno — todos los que tienen opinión coinciden';

  // Dinero institucional (proxy vía funding + volumen, no es dato directo de whales)
  let institucional;
  if(m.funding==null) institucional = 'Sin datos de derivados para este par, no se puede estimar el posicionamiento institucional vía funding.';
  else if(m.funding<-0.0002) institucional = 'El funding negativo sugiere que el retail está posicionado en corto (paga a los longs) — muchas veces esto ocurre cuando el dinero grande ya viene acumulando en silencio.';
  else if(m.funding>0.0005) institucional = 'El funding muy positivo sugiere que el retail está sobre-posicionado en largo — eso históricamente precede correcciones o barridas de liquidez hacia abajo.';
  else institucional = 'El funding está neutro, no hay una señal clara de posicionamiento extremo del retail frente al smart money.';

  // Riesgos activos
  const riesgos = [];
  if(m.lastStochK>=80) riesgos.push('Estocástico en sobrecompra: el movimiento podría estar agotado en el corto plazo.');
  if(m.lastStochK<=20) riesgos.push('Estocástico en sobreventa: cuidado con un rebote técnico que no sea reversión real.');
  if(st.events.choch) riesgos.push('Hay un CHoCH reciente: la estructura previa está en duda, mayor probabilidad de falso quiebre.');
  if(result.macroNote && ((rec==='LONG' && result.macroNote.includes('BAJISTA')) || (rec==='SHORT' && result.macroNote.includes('ALCISTA')))) riesgos.push('La tendencia macro de 4h todavía no confirma esta dirección — es ir parcialmente contra la corriente mayor.');
  if(setup.volPct>5) riesgos.push('Volatilidad (ATR) alta: el stop se agranda y el tamaño de posición debería ser más chico.');
  if(!riesgos.length) riesgos.push('No se detectan banderas rojas adicionales más allá del riesgo normal de mercado.');

  // Qué confirmaría más la entrada
  const confirmacion = rec==='LONG'
    ? `Un cierre de vela en ${currentTF} por encima de $${fmt(m.resistance)} con volumen creciente, o un retest exitoso de la zona de entrada sin perder $${fmt(setup.stop)}.`
    : rec==='SHORT'
    ? `Un cierre de vela en ${currentTF} por debajo de $${fmt(m.support)} con volumen creciente, o un retest fallido de la zona de entrada sin recuperar $${fmt(setup.stop)}.`
    : 'Que aparezca un BOS claro a favor de un lado y que al menos 2-3 especialistas más se alineen.';

  // Escenario alternativo (qué pasa si el análisis se equivoca)
  const alternativo = rec==='LONG'
    ? `Si en cambio el precio pierde $${fmt(m.support)} con volumen, el escenario pasa a ser bajista, con el próximo objetivo bajista cerca de $${fmt(setup.stop - (m.lastATR*1.5))}.`
    : rec==='SHORT'
    ? `Si en cambio el precio recupera $${fmt(m.resistance)} con volumen, el escenario pasa a ser alcista, con el próximo objetivo cerca de $${fmt(setup.stop + (m.lastATR*1.5))}.`
    : `Si aparece una confluencia clara hacia un lado (ver checklist), el motor podría pasar de NO OPERAR a una señal activa en la próxima vela.`;

  // Error común / mejor nivel de espera (usa Order Block si existe y está razonablemente cerca del precio actual)
  let mejorEntrada;
  const ob = rec==='LONG' ? st.bullishOB : rec==='SHORT' ? st.bearishOB : null;
  const obMid = ob ? (ob.top+ob.bottom)/2 : null;
  const obDistancePct = obMid ? Math.abs(m.price - obMid)/m.price*100 : null;
  if(ob && obDistancePct!=null && obDistancePct <= 15){
    mejorEntrada = `En vez de entrar al precio actual, un trader más paciente esperaría un retroceso hacia la zona de Order Block ($${fmt(ob.bottom)}-$${fmt(ob.top)}), que ofrece mejor relación riesgo/beneficio.`;
  } else if(ob && obDistancePct!=null){
    // El OB existe pero está demasiado lejos del precio actual: esperarlo invalidaría el setup, no tiene sentido recomendarlo.
    mejorEntrada = `Hay un Order Block ${rec==='LONG'?'alcista':'bajista'} en $${fmt(ob.bottom)}-$${fmt(ob.top)}, pero está a ${obDistancePct.toFixed(0)}% del precio actual — esperar ese retroceso significaría que la tendencia ya se invalidó. A este precio, lo más prudente es reducir el tamaño de la posición o esperar una consolidación más cercana en vez de ese retroceso tan profundo.`;
  } else {
    mejorEntrada = rec==='LONG'
      ? `Esperar un retroceso más cerca del soporte ($${fmt(m.support)}) mejoraría la relación riesgo/beneficio frente a entrar al precio actual.`
      : rec==='SHORT'
      ? `Esperar un retroceso más cerca de la resistencia ($${fmt(m.resistance)}) mejoraría la relación riesgo/beneficio frente a entrar al precio actual.`
      : 'No aplica mientras no haya una dirección clara.';
  }
  const errorComun = rec==='NO OPERAR'
    ? 'El error más común acá sería forzar una entrada solo por impaciencia, sin que el mercado muestre una ventaja real.'
    : 'El error más común sería entrar de golpe al precio actual con tamaño completo antes de la confirmación, en vez de esperar el retroceso ideal o escalonar la entrada.';

  // ═══ SOLO SE ESCRIBE LO QUE APORTA ═══
  // Antes salían siempre 'lo que acompaña / lo que no acompaña' aunque dijeran 'ninguno':
  // dos renglones para decir que no hay nada que decir. Y marketNote aparecía DOS VECES en
  // el mismo texto, palabra por palabra. Ahora cada bloque se omite si está vacío.
  const vacio = (t) => !t || /^ningun|^nada|^—$|^-$/i.test(String(t).trim());
  const bloques = [resumen];
  const apoyos = [];
  if(!vacio(soporta)) apoyos.push(`✅ A favor: ${soporta}.`);
  if(!vacio(noAcompana)) apoyos.push(`⚠️ En contra: ${noAcompana}.`);
  if(apoyos.length) bloques.push(apoyos.join('\n'));
  if(institucional && !/no hay una señal clara/i.test(institucional)) bloques.push(`🏦 Dinero institucional: ${institucional}`);
  if(riesgos.length) bloques.push(`⚠️ Riesgos activos:\n${riesgos.map(r=>'• '+r).join('\n')}`);
  bloques.push(`📈 Qué confirmaría más la entrada:\n${confirmacion}`);
  bloques.push(`🔄 Si el análisis falla:\n${alternativo}`);
  bloques.push(`🎯 Mejor nivel para esperar:\n${mejorEntrada}\n${errorComun}`);
  const explanation = bloques.join('\n\n');

  const invalidation = [];
  if(rec==='LONG'){
    invalidation.push(`El precio cierra una vela por debajo de $${fmt(setup.stop)} (stop, 2x ATR).`);
    invalidation.push(`Se pierde el soporte de $${fmt(m.support)} con volumen (fuerza actual del soporte: ${m.supportStrength.score}/100, ${m.supportStrength.touches} toques históricos).`);
    invalidation.push('El volumen comprador desaparece o el funding se vuelve extremadamente positivo (longs sobreapalancados).');
  } else if(rec==='SHORT'){
    invalidation.push(`El precio cierra una vela por encima de $${fmt(setup.stop)} (stop, 2x ATR).`);
    invalidation.push(`Se recupera la resistencia de $${fmt(m.resistance)} con volumen (fuerza actual: ${m.resistanceStrength.score}/100, ${m.resistanceStrength.touches} toques históricos).`);
    invalidation.push('El volumen vendedor desaparece o el funding se vuelve extremadamente negativo (shorts sobreapalancados).');
  } else {
    invalidation.push('No aplica: el motor recomienda esperar hasta que haya más confluencia.');
  }

  return {explanation, checklist, passCount, totalVotes, invalidation, riesgos, confirmacion, alternativo, mejorEntrada, errorComun};
}

function buildSetup(data, result, riskProfile, dataHTF, esCapChico){
  const {price, support, resistance, lastATR} = result.metrics;
  const structure = result.structure || {};
  // El STOP se calcula con el marco MAYOR (4h) cuando está disponible, no con el de entrada (15m).
  // Motivo: la tesis se detecta en 4h, así que la operación "vive" en ese marco. Un stop basado en
  // los niveles chicos de 15m lo saca el ruido normal de una vela de 4h que todavía va bien —
  // salta el stop en una operación que en su propio marco seguía siendo válida.
  // El ATR de 4h es naturalmente más ancho, que es exactamente lo que corresponde acá.
  const atrParaStop = (dataHTF?.candles?.length >= 20)
    ? (() => { const a = atr(dataHTF.candles, 14).filter(v=>v!=null).at(-1); return a!=null ? a : lastATR; })()
    : lastATR;
  const structureHTF = dataHTF?.candles?.length >= 30 ? computeStructure(dataHTF.candles, atr(dataHTF.candles,14)) : null;
  // Stop loss: antes era SOLO 2x ATR (un número matemático, sin mirar si hay algo real ahí abajo).
  // Ahora se prefiere un nivel estructural real (Order Block o soporte/resistencia) cuando existe a
  // una distancia razonable — así el stop queda "detrás de algo" (como pondría un trader de verdad),
  // no en el aire. El ATR sigue de piso mínimo y de resguardo si no hay ningún nivel cercano sensato.
  const risk = lastATR*2; // ATR de 15m: probado con ATR de 4h y empeoró (ver nota en el piso mínimo)
  let entryLow, entryHigh, stop, t1,t2,t3, dir;
  const dirSource = result.recommendation || result.bias; // usa el score dual (Long/Short) como fuente de verdad
  const liqProfileForStop = data?.candles?.length>=30 ? computeLiquidityProfile(data.candles, price) : null;
  if(dirSource==='LONG'){
    dir='LONG'; entryLow=price*0.995; entryHigh=price*1.005;
    const atrStop = price - risk;
    // Se prefieren los niveles del marco MAYOR (4h): son los que de verdad sostienen la operación.
    const structuralLevels = [structureHTF?.bullishOB?.bottom, structure.bullishOB?.bottom, support].filter(v=>v!=null && v<price);
    const nearestStructural = structuralLevels.length ? Math.max(...structuralLevels) : null;
    const distToStructural = nearestStructural!=null ? price-nearestStructural : null;
    // "Razonable" = ni pegado al precio (ruido lo saca fácil) ni tan lejos que el R:R deje de tener sentido.
    const topeATR = esCapChico ? 7 : 4;
    const esRazonable = distToStructural!=null && distToStructural >= lastATR*0.6 && distToStructural <= lastATR*topeATR;
    stop = esRazonable ? nearestStructural*0.997 : atrStop; // pequeño colchón debajo del nivel real
    // No dejar el stop justo pegado a una concentración grande de liquidez: ahí también tienen el
    // stop otros traders, así que es un imán para que lo barran primero — si el stop calculado cae
    // cerca de un POC, lo empujamos un poco más allá para no ser la primera víctima de esa barrida.
    if(liqProfileForStop?.pocBelow && Math.abs(liqProfileForStop.pocBelow.price-stop)/price < 0.01){
      stop = Math.min(stop, liqProfileForStop.pocBelow.price*0.995);
    }
    // Piso mínimo de seguridad: si todo lo anterior (estructura, ATR, colchón de liquidez) igual dejó
    // el stop a menos de 0.8% del precio de entrada, se empuja a esa distancia mínima — un stop más
    // cerca que eso muere por ruido normal del mercado, no porque la idea haya fallado de verdad.
    // Piso mínimo de seguridad: si todo lo anterior (estructura, ATR, colchón de liquidez) igual dejó
    // el stop demasiado cerca, se empuja a una distancia mínima — pero esa distancia mínima ahora se
    // ADAPTA a qué tan volátil es la moneda (1.5x el ATR% reciente), con un piso de 1% y techo de 2% —
    // una moneda chica y movida necesita más aire que una más calma, no el mismo número fijo para todas.
    // El piso usa el ATR del marco MAYOR (4h), no el de 15m: la operación vive en 4h, así que el
    // stop tiene que aguantar el movimiento normal de una vela de 4h. Con el ATR de 15m el stop
    // quedaba a ~1-1,6% del precio y en monedas de cap chico eso es ruido normal — saltaba al toque
    // (casos reales: OPEN 1,60%, LISTA 1,00%, CROSS 2,14%, las tres cerradas por stop enseguida).
    // El techo sube a 4% para que una moneda muy volátil pueda tener el aire que necesita.
    // PROBADO Y REVERTIDO (agosto 2026): se intentó ensanchar el stop usando el ATR de 4h con
    // techo 4%, porque los stops de 15m saltaban rápido en monedas de cap chico. El backtest lo
    // desmintió: la ganancia bajó de +196% a +78% y el drawdown SUBIÓ de 26% a 37%.
    // El motivo: el bot arriesga un % fijo del capital, así que un stop más lejos obliga a una
    // posición más chica — y las operaciones ganadoras rinden la mitad. El win rate casi no
    // cambió, pero cada acierto vale menos. Por eso se mantiene el ATR de 15m con techo 2%.
    const atrPct = lastATR/price;
    // MODO CAP CHICO (memecoins y monedas de baja capitalización): estas monedas se mueven 5-10%
    // como movimiento normal, así que un stop de 1-2% lo toca el ruido antes de que la idea tenga
    // chance de funcionar (casos reales: OPEN, LISTA y CROSS cerradas por stop enseguida).
    // Acá el stop va entre 10% y 15%, y el apalancamiento baja a 5x para compensar — el riesgo en
    // dólares se mantiene parecido, pero la operación tiene aire para respirar.
    // ═══ EL STOP LO DEFINE LA ESTRUCTURA, NO UN PORCENTAJE FIJO ═══
    // Antes cap chico forzaba un piso del 10%, y eso generaba R:R malísimos de forma sistemática:
    // arriesgar 10% para buscar 6% en TP1 es un R:R de 0,6 (caso real: LISTA).
    // Ahora el piso solo evita stops absurdamente pegados; si la estructura da 6%, el stop es 6%.
    // El techo del 15% sigue como límite de seguridad — más que eso, la operación se descarta.
    const MIN_STOP_PCT = esCapChico
      ? Math.max(0.03, Math.min(0.15, atrPct*2))
      : Math.max(0.01, Math.min(0.02, atrPct*1.5));
    if((price-stop)/price < MIN_STOP_PCT) stop = price*(1-MIN_STOP_PCT);
    // TECHO MÁXIMO del stop. MIN_STOP_PCT es un PISO — sin un techo, si el soporte estructural
    // está lejísimos el stop se va con él. Caso real: BICO con el stop a 68% del precio, lo que
    // obligaba a un TP1 en +102% (la moneda tenía que duplicar para ganar). Sin sentido operativo.
    const MAX_STOP_PCT = esCapChico ? 0.15 : 0.06;
    if((price-stop)/price > MAX_STOP_PCT) stop = price*(1-MAX_STOP_PCT);

    // ═══ STOP MÁS ALLÁ DE LA LIQUIDEZ ═══
    // Si el stop queda JUSTO ANTES de un nivel con liquidez acumulada, el precio va a barrer esa
    // zona (ahí están los stops de todos) y recién después girar — te saca justo antes del
    // movimiento que esperabas. Por eso el stop se corre POR DEBAJO del nivel de liquidez más
    // importante que haya en el camino, con un margen extra.
    const liqStop = detectLiquidezPorHorizonte(data.candles);
    if(liqStop){
      // Se toma el nivel con más toques (más liquidez acumulada) que esté entre el stop y el precio
      const candidatos = [liqStop.cercanaAbajo, liqStop.lejanaAbajo]
        .filter(l => l && l.precio < price && l.precio > stop*0.97);
      if(candidatos.length){
        const masImportante = candidatos.reduce((a,b) => (b.toques||0) > (a.toques||0) ? b : a);
        const margen = esCapChico ? 0.985 : 0.995; // más margen en monedas volátiles
        const stopNuevo = masImportante.precio * margen;
        // Solo se mueve si no dispara el stop más allá de lo razonable (tope: el doble del mínimo)
        const distNueva = (price - stopNuevo)/price;
        if(stopNuevo < stop && distNueva <= MIN_STOP_PCT*2.5){
          stop = stopNuevo;
        }
      }
    }
    const R = price-stop;
    // En cap chico el stop es ancho (10-15%), así que un TP1 a 1,5R quedaría a +15/22% del precio,
    // demasiado lejos para tomar ganancia parcial. Se usan múltiplos más chicos: el R:R baja pero
    // el objetivo se vuelve alcanzable, que es lo que importa para asegurar parte de la ganancia.
    // Múltiplos de R reales: TP1 a 1R como mínimo. Antes era 0,6R, o sea que se arriesgaba más
    // de lo que se buscaba en el primer objetivo.
    // Con dos objetivos, TP2 es el final: se acerca de 1.6R a 1.8R para que sea alcanzable.
    // Los datos reales mostraron que casi ninguna operación pasaba de 1R, así que un objetivo
    // final muy lejos equivale a cerrar siempre en breakeven.
    // TP1 a 1.15R, no a 1.0R. Motivo: el filtro exige un R:R mínimo de 1:1, así que con TP1
    // exactamente en 1.0R los setups quedaban clavados en el borde — 11 de 13 en una prueba.
    // Cualquier ajuste hacia abajo por un nivel real los tiraba abajo. Con 1.15R hay margen.
    if(esCapChico){ t1=price+R*1.15; t2=price+R*1.8; t3=Math.max(resistance, price+R*2.5); }
    else { t1=price+R*1.5; t2=price+R*3; t3=Math.max(resistance, price+R*5); }
    // Los TP también buscan liquidez real, no solo un múltiplo matemático — si hay una zona de
    // liquidez real (POC) en el camino hacia arriba, a una distancia sensata, el objetivo más cercano
    // a esa zona se ajusta para apuntar ahí — porque el mercado se mueve buscando esa liquidez, no
    // un número redondo de "3R" porque sí.
    if(liqProfileForStop?.pocAbove){
      const targets = [{k:'t1',v:t1},{k:'t2',v:t2},{k:'t3',v:t3}];
      const closest = targets.reduce((a,b)=>Math.abs(liqProfileForStop.pocAbove.price-a.v)<Math.abs(liqProfileForStop.pocAbove.price-b.v)?a:b);
      const distToLiq = liqProfileForStop.pocAbove.price - price;
      const esRazonableLiq = distToLiq > R*0.8 && distToLiq < R*6; // ni muy cerca (ruido) ni tan lejos que no tenga sentido apuntar ahí
      if(esRazonableLiq && Math.abs(liqProfileForStop.pocAbove.price-closest.v)/closest.v < 0.08){
        if(closest.k==='t1') t1 = liqProfileForStop.pocAbove.price;
        else if(closest.k==='t2') t2 = liqProfileForStop.pocAbove.price;
        else t3 = liqProfileForStop.pocAbove.price;
      }
    }
  } else if(dirSource==='SHORT'){
    dir='SHORT'; entryLow=price*0.995; entryHigh=price*1.005;
    const atrStop = price + risk;
    const structuralLevels = [structureHTF?.bearishOB?.top, structure.bearishOB?.top, resistance].filter(v=>v!=null && v>price);
    const nearestStructural = structuralLevels.length ? Math.min(...structuralLevels) : null;
    const distToStructural = nearestStructural!=null ? nearestStructural-price : null;
    const topeATRs = esCapChico ? 7 : 4;
    const esRazonable = distToStructural!=null && distToStructural >= lastATR*0.6 && distToStructural <= lastATR*topeATRs;
    stop = esRazonable ? nearestStructural*1.003 : atrStop;
    if(liqProfileForStop?.pocAbove && Math.abs(liqProfileForStop.pocAbove.price-stop)/price < 0.01){
      stop = Math.max(stop, liqProfileForStop.pocAbove.price*1.005);
    }
    // Mismo piso mínimo de seguridad, mirado hacia arriba.
    // Mismo piso mínimo adaptativo, mirado hacia arriba (ATR del marco mayor, techo 4%).
    const atrPctShort = lastATR/price;
    const MIN_STOP_PCT_SHORT = esCapChico
      ? Math.max(0.03, Math.min(0.15, atrPctShort*2))
      : Math.max(0.01, Math.min(0.02, atrPctShort*1.5));
    if((stop-price)/price < MIN_STOP_PCT_SHORT) stop = price*(1+MIN_STOP_PCT_SHORT);
    const MAX_STOP_PCT_SHORT = esCapChico ? 0.15 : 0.06;
    if((stop-price)/price > MAX_STOP_PCT_SHORT) stop = price*(1+MAX_STOP_PCT_SHORT);

    // Mismo criterio que en LONG: el stop va POR ENCIMA del nivel de liquidez más importante,
    // porque ahí es donde el precio va a barrer stops antes de girar a la baja.
    const liqStopS = detectLiquidezPorHorizonte(data.candles);
    if(liqStopS){
      const candidatosS = [liqStopS.cercanaArriba, liqStopS.lejanaArriba]
        .filter(l => l && l.precio > price && l.precio < stop*1.03);
      if(candidatosS.length){
        const masImportanteS = candidatosS.reduce((a,b) => (b.toques||0) > (a.toques||0) ? b : a);
        const margenS = esCapChico ? 1.015 : 1.005;
        const stopNuevoS = masImportanteS.precio * margenS;
        const distNuevaS = (stopNuevoS - price)/price;
        if(stopNuevoS > stop && distNuevaS <= MIN_STOP_PCT_SHORT*2.5){
          stop = stopNuevoS;
        }
      }
    }
    const R = stop-price;
    if(esCapChico){ t1=price-R*1.15; t2=price-R*1.8; t3=Math.min(support, price-R*2.5); }
    else { t1=price-R*1.5; t2=price-R*3; t3=Math.min(support, price-R*5); }
    // Mismo criterio que en LONG, mirado hacia abajo: si hay una zona real de liquidez a distancia
    // sensata, el objetivo más cercano se ajusta para apuntar ahí en vez de un múltiplo matemático.
    if(liqProfileForStop?.pocBelow){
      const targets = [{k:'t1',v:t1},{k:'t2',v:t2},{k:'t3',v:t3}];
      const closest = targets.reduce((a,b)=>Math.abs(liqProfileForStop.pocBelow.price-a.v)<Math.abs(liqProfileForStop.pocBelow.price-b.v)?a:b);
      const distToLiq = price - liqProfileForStop.pocBelow.price;
      const esRazonableLiq = distToLiq > R*0.8 && distToLiq < R*6;
      if(esRazonableLiq && Math.abs(liqProfileForStop.pocBelow.price-closest.v)/closest.v < 0.08){
        if(closest.k==='t1') t1 = liqProfileForStop.pocBelow.price;
        else if(closest.k==='t2') t2 = liqProfileForStop.pocBelow.price;
        else t3 = liqProfileForStop.pocBelow.price;
      }
    }
  } else {
    dir='NEUTRAL / ESPERAR'; entryLow=support; entryHigh=resistance;
    stop=support-risk; t1=resistance; t2=resistance+risk; t3=resistance+risk*2;
    // Mismo techo que en las ramas LONG/SHORT. Sin esto, en una moneda que subió mucho el soporte
    // queda lejísimos y el stop se va con él — caso real de BICO: stop a 68% del precio, con un
    // TP1 en +102%. Esta rama es la que producía ese setup.
    const MAX_STOP_NEUTRAL = esCapChico ? 0.15 : 0.06;
    if(stop < price*(1-MAX_STOP_NEUTRAL)) stop = price*(1-MAX_STOP_NEUTRAL);
  }
  // ═══ TP CRUZADOS CON NIVELES REALES ═══
  // Un TP en "1.6R" es un número matemático. Si justo ahí no hay nada, el precio no tiene motivo
  // para frenar; y si hay una resistencia un poco antes, el TP queda detrás de una barrera.
  // Acá se buscan los niveles reales (resistencias, soportes, liquidez, POC, VAH/VAL) y se ajusta
  // cada TP al nivel más cercano, siempre que no empeore demasiado el R:R.
  if(dir==='LONG' || dir==='SHORT'){
    const esLong = dir==='LONG';
    const riesgo = Math.abs(price - stop);
    if(riesgo > 0){
      // Todos los niveles reales que hay en la dirección de la operación
      const niveles = [];
      const push = (v, etq) => { if(v!=null && isFinite(v) && (esLong ? v>price : v<price)) niveles.push({precio:v, tipo:etq}); };
      push(esLong ? resistance : support, esLong ? 'resistencia' : 'soporte');
      push(esLong ? structure.eqHighs : structure.eqLows, 'liquidez');
      try{
        const perfil = computeLiquidityProfile(data.candles, price, 200);
        if(perfil){ push(perfil.poc, 'POC'); push(esLong ? perfil.vah : perfil.val, esLong ? 'VAH' : 'VAL'); }
      }catch(e){ /* si no hay perfil, se usan los TP por R */ }
      const ob = esLong ? structure.bearishOB : structure.bullishOB;
      if(ob) push(esLong ? ob.bottom : ob.top, 'order block');

      if(niveles.length){
        niveles.sort((a,b)=> esLong ? a.precio-b.precio : b.precio-a.precio);
        // Para cada TP se busca el nivel real más cercano, y se usa si el R:R resultante es aceptable
        const ajustar = (tpOriginal, rMinimo) => {
          let mejor = tpOriginal, mejorDist = Infinity;
          for(const n of niveles){
            const rNivel = Math.abs(n.precio - price)/riesgo;
            if(rNivel < rMinimo) continue; // demasiado cerca, no sirve como objetivo
            const dist = Math.abs(n.precio - tpOriginal);
            if(dist < mejorDist && dist/riesgo < 0.6){ mejor = n.precio; mejorDist = dist; }
          }
          return mejor;
        };
        // Mínimos alineados con lo que después exige el bot para confirmar (1.0R en TP1).
        // Antes acá se usaba 0,9R y el bot rechazaba con 1,0 — el ajuste podía crear un TP que
        // después tumbaba la operación entera.
        t1 = ajustar(t1, 1.1);   // margen sobre el filtro de 1:1
        t2 = ajustar(t2, 1.5);
        t3 = ajustar(t3, 2.2);

        // Separación REAL entre objetivos. Antes solo se garantizaba que t2 > t1 por 0,1%, así que
        // podían quedar TP1 en 1,0R y TP2 en 1,05R — dos objetivos prácticamente en el mismo lugar,
        // que no aportan nada como escalonamiento. Ahora se exige al menos 0,4R de separación.
        const sepMinima = riesgo * 0.4;
        if(esLong){
          if(t2 - t1 < sepMinima) t2 = t1 + sepMinima;
          if(t3 - t2 < sepMinima) t3 = t2 + sepMinima;
        } else {
          if(t1 - t2 < sepMinima) t2 = t1 - sepMinima;
          if(t2 - t3 < sepMinima) t3 = t2 - sepMinima;
        }
      }
    }
  }

  const volPct = (lastATR/price)*100;
  let leverage='1x - 2x';
  if(volPct<1.5) leverage='4x - 5x';
  else if(volPct<3) leverage='3x - 4x';
  else if(volPct<5) leverage='2x - 3x';
  const profile = riskProfile || 'balanced';
  if(profile==='conservative'){
    // nunca sugerir más de 2x, priorizando preservar capital
    leverage = volPct<1.5 ? '1x - 2x' : '1x (spot / sin apalancamiento)';
  } else if(profile==='aggressive'){
    // permite un escalón más de leverage que el balanceado, dentro de límites razonables
    if(volPct<1.5) leverage='6x - 8x';
    else if(volPct<3) leverage='4x - 6x';
    else if(volPct<5) leverage='3x - 4x';
    else leverage='2x - 3x';
  }
  // En cap chico el apalancamiento se fija en 5x: el stop es mucho más ancho, así que un
  // apalancamiento alto multiplicaría demasiado la pérdida cuando salta.
  if(esCapChico) leverage = '5x (aislado, cap chico con stop ancho)';
  return {dir, entryLow, entryHigh, stop, t1,t2,t3, leverage, volPct, atrMultiple:2, riskProfile:profile, esCapChico:!!esCapChico};
}


async function fetchRelevantNews(coinName){
  // DESACTIVADO: el tier gratis de rss2json.com dejó de funcionar de forma confiable
  // (422/408 constantes, incluso vía proxy). En vez de fallar en cada análisis, el
  // Dios Noticias queda neutral hasta que se consiga una fuente de noticias confiable.
  // Ver committee.push('📰 Dios Noticias', ...) en computeScore.
  return [];
}


// Delega en fmtPrecio, que elige los decimales según el tamaño del número.
// Antes usaba toPrecision(4): con 4 dígitos significativos, 0.058325 se mostraba como
// "0.05832" y 0.0583251 como "0.05833" — redondeaba justo donde más importa el valor exacto,
// que es en los niveles de liquidez de monedas de precio chico.
function fmt(n){ return fmtPrecio(n); }
function fmtPct(n){ return (n>=0?'+':'')+n.toFixed(1)+'%'; }

// ---- Memoria estadística por "Dios": qué especialista acertó más históricamente ----
// Necesita que cada operación cerrada tenga guardado un `committeeSnapshot` (nombre+voto de cada
// dios al momento de confirmar la entrada). Cuenta, de las veces que cada dios votó en la MISMA
// dirección que terminó teniendo la operación, cuántas ganaron vs perdieron.
// Estadísticas desglosadas: win rate por tipo de setup, por moneda, y por horario del día —
// automatiza para los datos en vivo el mismo tipo de análisis que se hace a mano con backtests.
// ═══ HISTORIAL POR MONEDA ═══
// Responde: "¿cómo le fue al bot con esta moneda en particular?". Antes solo había estadísticas
// globales y por tipo de setup, así que no se podía saber si una moneda concreta es de las que
// funcionan o de las que siempre pierden.
// IMPORTANTE: esto NO modifica el score todavía. Primero hay que juntar datos suficientes —
// con 3 operaciones un win rate del 100% no significa nada.
function computeHistorialMoneda(closedTrades, symbol){
  const delSimbolo = (closedTrades||[]).filter(t => t.symbol === symbol);
  if(!delSimbolo.length) return { symbol, operaciones:0, suficienteMuestra:false };

  const ganadas = delSimbolo.filter(t => t.pnlPct > 0);
  const perdidas = delSimbolo.filter(t => t.pnlPct <= 0);
  const longs = delSimbolo.filter(t => t.dir === 'LONG');
  const shorts = delSimbolo.filter(t => t.dir === 'SHORT');
  const gananciaTotal = ganadas.reduce((s,t)=>s+(t.pnlUsd||0), 0);
  const perdidaTotal = Math.abs(perdidas.reduce((s,t)=>s+(t.pnlUsd||0), 0));

  const wr = arr => arr.length ? +(arr.filter(t=>t.pnlPct>0).length/arr.length*100).toFixed(1) : null;

  return {
    symbol,
    operaciones: delSimbolo.length,
    ganadas: ganadas.length,
    perdidas: perdidas.length,
    winRate: wr(delSimbolo),
    winRateLong: wr(longs),
    winRateShort: wr(shorts),
    long: longs.length,
    short: shorts.length,
    profitFactor: perdidaTotal>0 ? +(gananciaTotal/perdidaTotal).toFixed(2) : (gananciaTotal>0 ? Infinity : 0),
    pnlTotal: +(delSimbolo.reduce((s,t)=>s+(t.pnlUsd||0),0)).toFixed(2),
    // Debajo de 10 operaciones cualquier porcentaje es ruido, no una tendencia.
    suficienteMuestra: delSimbolo.length >= 10,
    caminosQueFuncionaron: (()=> {
      const porCamino = {};
      for(const t of delSimbolo){
        const k = t.tipoSetup || 'Sin dato';
        if(!porCamino[k]) porCamino[k] = {total:0, ganadas:0};
        porCamino[k].total++;
        if(t.pnlPct>0) porCamino[k].ganadas++;
      }
      return Object.entries(porCamino)
        .map(([nombre,v])=>({ nombre, operaciones:v.total, winRate:+(v.ganadas/v.total*100).toFixed(1) }))
        .sort((a,b)=>b.operaciones-a.operaciones);
    })(),
  };
}

// ═══ ANALISTA (explicador por reglas, sin IA externa) ═══
// Lee TODO lo que el motor ya calculó y arma una explicación coherente en lenguaje natural.
// No es un modelo de lenguaje: es un narrador determinista. La ventaja de hacerlo así es que
// NUNCA puede inventar nada — solo puede decir lo que está efectivamente en los datos.
// La desventaja es que no improvisa: si aparece una situación que no está contemplada acá, no la
// va a comentar. Es un intercambio a propósito: prefiero que no diga nada antes de que invente.
function explicarAnalisis(result, opciones = {}){
  if(!result) return null;
  const dir = result.recommendation;
  const score = Math.max(result.longScore, result.shortScore);
  const partes = [];
  const alertas = [];

  // 1) El veredicto y su fuerza
  const fuerza = score>=8.5 ? 'muy fuerte' : score>=8 ? 'fuerte' : score>=7.6 ? 'suficiente' : score>=7 ? 'moderada pero por debajo del umbral' : 'débil';
  partes.push(dir==='NO OPERAR'
    ? `El motor no ve una oportunidad clara acá: el score quedó en ${score.toFixed(1)}/10, que no alcanza para armar una tesis.`
    : `El motor ve una oportunidad de ${dir==='LONG'?'compra':'venta'} con una señal ${fuerza} (${score.toFixed(1)}/10, ${result.confidence}% de confianza).`);

  // 2) Qué la empujó — usando el Explain Engine
  const ee = result.explainEngine;
  if(ee?.componentes?.length){
    const aFavor = ee.componentes.filter(cp => dir==='LONG' ? cp.aporte>0.1 : cp.aporte<-0.1);
    const enContra = ee.componentes.filter(cp => dir==='LONG' ? cp.aporte<-0.1 : cp.aporte>0.1);
    if(aFavor.length){
      const principal = aFavor[0];
      partes.push(`Lo que más empuja es ${principal.nombre.toLowerCase()} (${principal.aporte>0?'+':''}${principal.aporte} puntos: ${principal.detalle})${aFavor.length>1?`, acompañado por ${aFavor.slice(1,3).map(x=>x.nombre.toLowerCase()).join(' y ')}`:''}.`);
    }
    if(enContra.length){
      alertas.push(`${enContra.map(x=>x.nombre.toLowerCase()).join(' y ')} ${enContra.length>1?'están':'está'} en contra de esta dirección.`);
    }
    const nulos = ee.componentes.filter(cp => Math.abs(cp.aporte) < 0.01);
    if(nulos.length >= 3){
      alertas.push(`${nulos.length} de los 6 componentes no aportaron nada (${nulos.map(x=>x.nombre.toLowerCase()).join(', ')}), así que el score se apoya en pocos datos.`);
    }
  }

  const hayOperacion = dir==='LONG' || dir==='SHORT';

  // 3) Fase del mercado — contexto que cambia el significado del score
  const fase = opciones.marketPhase;
  if(fase && fase.fase!=='DESCONOCIDA'){
    if(!hayOperacion){ partes.push(`Contexto: el mercado está en fase ${fase.fase}. ${fase.motivo}`); }
    else
    if(fase.riesgoLong && dir==='LONG') alertas.push(`⚠️ La fase es ${fase.fase}: ${fase.motivo} Abrir una compra acá va a contramano de la etapa del ciclo.`);
    else if(fase.riesgoShort && dir==='SHORT') alertas.push(`⚠️ La fase es ${fase.fase}: ${fase.motivo}`);
    else if(fase.favorable===dir) partes.push(`La fase del mercado (${fase.fase}) acompaña: ${fase.motivo}`);
    else if(fase.favorable && fase.favorable!=='bordes del rango' && fase.favorable!=='ninguna') alertas.push(`La fase del mercado (${fase.fase}) favorece ${fase.favorable}, no ${dir}.`);
  }

  // 4) Liquidez: hacia dónde tiende a ir el precio
  const st = result.structure;
  const precio = result.metrics?.price;
  if(st && precio && hayOperacion){
    const arriba = st.eqHighs, abajo = st.eqLows;
    if(arriba && abajo){
      const distA = Math.abs(arriba-precio)/precio*100, distB = Math.abs(abajo-precio)/precio*100;
      const masCerca = distA < distB ? 'arriba' : 'abajo';
      const enContraLiq = (dir==='LONG' && masCerca==='abajo') || (dir==='SHORT' && masCerca==='arriba');
      if(enContraLiq) alertas.push(`La liquidez más cercana está ${masCerca} (a ${Math.min(distA,distB).toFixed(1)}%), o sea en contra de la operación: el precio puede ir a buscarla antes de girar.`);
      else partes.push(`La liquidez más cercana está ${masCerca}, a ${Math.min(distA,distB).toFixed(1)}% del precio, que es hacia donde apunta la operación.`);
    }
  }

  // 5) Estructura
  if(st?.events?.bos) partes.push(`Hay una ruptura de estructura (BOS ${st.events.bos==='bullish'?'alcista':'bajista'}) confirmando el movimiento.`);
  else if(st?.events?.choch) partes.push(`Hay un cambio de carácter (CHoCH ${st.events.choch==='bullish'?'alcista':'bajista'}): la estructura puede estar dándose vuelta.`);

  // 6) Calidad de datos
  const dq = result.dataQuality;
  if(dq?.score!=null && dq.score < 65){
    alertas.push(`La calidad de datos es ${dq.nivel} (${dq.score}/100)${dq.faltantes?.length?`: falta ${dq.faltantes.slice(0,3).join(', ')}`:''}. El score sale de información incompleta.`);
  }

  // 7) Reversión, si aplica
  if(result.reversionNota) partes.push(result.reversionNota.replace(/^[🔄📊]\s*/,''));

  return {
    resumen: partes.join(' '),
    alertas,
    veredicto: dir,
    score,
    // Texto completo listo para mostrar
    texto: partes.join(' ') + (alertas.length ? '\n\n⚠️ ' + alertas.join(' ') : ''),
  };
}

// ═══ SEGUIMIENTO DE HIPÓTESIS ═══
// El Research Center genera hipótesis en cada corrida. Esta función compara reportes a lo largo
// del tiempo para ver cuáles SE SOSTIENEN y cuáles eran ruido que desapareció.
// Es la diferencia entre "encontré un patrón" y "este patrón se repite".
function seguirHipotesis(reportesHistoricos){
  const reportes = (reportesHistoricos||[]).filter(r => r?.hallazgos?.length);
  if(reportes.length < 3){
    return { hipotesis: [], listo:false, nota:`Hacen falta al menos 3 reportes para ver si un patrón se sostiene. Hay ${reportes.length}.` };
  }
  // Se agrupa cada hallazgo por su identidad (tipo + valor) a lo largo de los reportes
  const seguimiento = {};
  reportes.forEach((r, idx) => {
    for(const h of r.hallazgos){
      const clave = `${h.tipo}|${h.valor}`;
      if(!seguimiento[clave]) seguimiento[clave] = { tipo:h.tipo, valor:h.valor, apariciones:[], };
      seguimiento[clave].apariciones.push({ reporte: idx, winRate: h.winRate, diferencia: h.diferencia, operaciones: h.operaciones });
    }
  });

  const hipotesis = Object.values(seguimiento).map(s => {
    const veces = s.apariciones.length;
    const consistencia = +(veces / reportes.length * 100).toFixed(0);
    const difs = s.apariciones.map(a=>a.diferencia);
    const mismoSigno = difs.every(d=>d>0) || difs.every(d=>d<0);
    const difPromedio = +(difs.reduce((a,b)=>a+b,0)/difs.length).toFixed(1);
    return {
      ...s,
      veces, consistencia, difPromedio, mismoSigno,
      estado: (consistencia>=80 && mismoSigno) ? 'SOSTENIDA'
            : (consistencia>=50 && mismoSigno) ? 'PROBABLE'
            : 'RUIDO',
      conclusion: (consistencia>=80 && mismoSigno)
        ? `Apareció en ${veces} de ${reportes.length} reportes, siempre en la misma dirección (${difPromedio>0?'+':''}${difPromedio} puntos promedio). Este patrón se sostiene y vale la pena considerarlo.`
        : (consistencia>=50 && mismoSigno)
        ? `Apareció en ${veces} de ${reportes.length} reportes con la misma dirección. Prometedor, pero conviene esperar más datos.`
        : `Solo apareció en ${veces} de ${reportes.length} reportes${!mismoSigno?' y cambió de dirección entre uno y otro':''}. Probablemente sea ruido.`,
    };
  }).sort((a,b)=> b.consistencia - a.consistencia || Math.abs(b.difPromedio)-Math.abs(a.difPromedio));

  const sostenidas = hipotesis.filter(h=>h.estado==='SOSTENIDA');
  return {
    hipotesis,
    reportesAnalizados: reportes.length,
    listo: true,
    nota: sostenidas.length
      ? `${sostenidas.length} patrón(es) se sostienen a lo largo de ${reportes.length} reportes. Esos son los únicos que consideraría para tocar el motor.`
      : `Ningún patrón se sostuvo de forma consistente en ${reportes.length} reportes. Conviene seguir juntando datos antes de cambiar nada.`,
  };
}

// ═══ SIMULADOR DE STOPS ═══
// Responde "¿qué habría pasado con otro stop?" SIN tocar el bot ni abrir una sola operación.
// Usa el MFE y el MAE que quedaron registrados: si el MAE de una operación fue -0.7R, un stop a
// 1R la habría dejado viva, y uno a 0.5R la habría cortado.
// IMPORTANTE: es una aproximación, no una verdad. Asume que con otro stop el resto del recorrido
// habría sido igual, y eso no siempre es cierto (un stop más ancho cambia el tamaño de posición).
// Sirve para orientar, no para decidir solo.
function simularStops(closedTrades, multiplicadores = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0]){
  const conDatos = (closedTrades||[]).filter(t =>
    t.registro?.mfe != null && t.registro?.mae != null && t.registro?.gestion?.stopPct != null);

  if(conDatos.length < 10){
    return { listo:false, operaciones: conDatos.length,
      nota:`Hacen falta al menos 10 operaciones con MFE/MAE registrados para simular. Hay ${conDatos.length}.` };
  }

  const RIESGO_PCT = 0.02; // 2% del capital por operación, igual que usa el bot

  const filas = multiplicadores.map(mult => {
    // Con un stop a `mult`R el tamaño de posición se AJUSTA para arriesgar siempre lo mismo.
    // Esto es clave: un stop más ancho obliga a una posición más chica. Sin este ajuste, la
    // simulación exagera el beneficio de ensanchar el stop — es el error que casi cometimos antes.
    let capital = 100, pico = 100, drawdown = 0;
    let ganadas = 0, perdidas = 0, neutras = 0;
    let gananciaBruta = 0, perdidaBruta = 0;
    const resultadosR = [];

    for(const t of conDatos){
      const maeR = Math.abs(t.registro.mae);
      const mfeR = t.registro.mfe;
      const riesgoUsd = capital * RIESGO_PCT; // el riesgo en dólares NO cambia con el stop
      let rObtenido;

      if(maeR >= mult){
        // El precio retrocedió más de lo que aguanta este stop
        rObtenido = -1; // se pierde exactamente 1R (el riesgo definido)
        perdidas++;
      } else if(mfeR >= 1.0){
        // Llegó al objetivo parcial. Se toma 50% en 1R y el resto se asume en breakeven.
        rObtenido = 0.5;
        ganadas++;
      } else {
        rObtenido = 0; // ni stop ni objetivo
        neutras++;
      }
      resultadosR.push(rObtenido);
      const pnl = riesgoUsd * rObtenido;
      capital += pnl;
      if(pnl > 0) gananciaBruta += pnl; else perdidaBruta += Math.abs(pnl);
      pico = Math.max(pico, capital);
      drawdown = Math.max(drawdown, (pico-capital)/pico);
    }

    const total = ganadas + perdidas;
    const expectancy = resultadosR.length
      ? +(resultadosR.reduce((a,b)=>a+b,0)/resultadosR.length).toFixed(3) : 0;

    return {
      stopEnR: mult,
      operaciones: conDatos.length,
      ganadas, perdidas, neutras,
      winRate: total ? +(ganadas/total*100).toFixed(1) : null,
      // Expectancy: cuánto se gana en promedio POR OPERACIÓN, en múltiplos de R.
      // Es mejor métrica que el win rate porque incorpora cuánto se gana y cuánto se pierde.
      expectancy,
      profitFactor: perdidaBruta > 0 ? +(gananciaBruta/perdidaBruta).toFixed(2) : (gananciaBruta>0 ? Infinity : 0),
      capitalFinal: +capital.toFixed(2),
      drawdownMax: +(drawdown*100).toFixed(1),
      salvadas: conDatos.filter(t => Math.abs(t.registro.mae) < mult && Math.abs(t.registro.mae) >= 1.0).length,
    };
  });

  // El mejor se elige por expectancy, no por capital final: es más robusto al orden de las operaciones
  const mejor = filas.reduce((a,b) => b.expectancy > a.expectancy ? b : a);
  const actual = filas.find(f => f.stopEnR === 1.0) || filas[0];
  const dif = +(mejor.expectancy - actual.expectancy).toFixed(3);

  return {
    listo: true,
    operaciones: conDatos.length,
    filas, mejor, actual,
    // ANTI-SOBREAJUSTE: no se recomienda cambiar nada si la mejora es chica o la muestra es poca.
    recomendarCambio: conDatos.length >= 30 && Math.abs(dif) >= 0.10,
    conclusion: (()=>{
      if(conDatos.length < 30) return `Con ${conDatos.length} operaciones todavía no alcanza para recomendar un cambio de stop. Hacen falta al menos 30.`;
      if(Math.abs(dif) < 0.10) return `Ningún stop mejora de forma clara al actual (diferencia de ${dif}R por operación). No hay evidencia suficiente para cambiarlo.`;
      return `Un stop a ${mejor.stopEnR}R habría dado ${dif > 0 ? '+' : ''}${dif}R más por operación que el actual (${mejor.expectancy}R vs ${actual.expectancy}R), con un drawdown de ${mejor.drawdownMax}% contra ${actual.drawdownMax}%.`;
    })(),
    advertencia: 'El tamaño de posición se recalcula en cada escenario para mantener el mismo riesgo en dólares — sin eso, un stop más ancho parecería mejor de lo que es. Aun así es una aproximación: asume que el recorrido del precio habría sido igual.',
  };
}

// ═══ EXPECTANCY POR ESTRATEGIA ═══
// El win rate solo no alcanza: una estrategia con 40% de aciertos pero que gana 3R y pierde 1R es
// mejor que una con 60% que gana 0,5R y pierde 1R. La expectancy mide cuánto se gana en promedio
// POR OPERACIÓN, contando tanto la frecuencia como el tamaño.
function expectancyPorEstrategia(closedTrades, minMuestra = 10){
  const conR = (closedTrades||[])
    .filter(t => t.registro?.gestion?.stopPct > 0 && t.pnlPct != null)
    .map(t => ({ ...t, rObtenido: +(t.pnlPct/t.registro.gestion.stopPct).toFixed(3) }));

  if(conR.length < minMuestra) {
    return { listo:false, operaciones: conR.length,
      nota:`Hacen falta al menos ${minMuestra} operaciones con datos de riesgo. Hay ${conR.length}.` };
  }

  const agrupar = (etiqueta, fn) => {
    const grupos = {};
    for(const t of conR){
      const k = fn(t);
      if(k == null) continue;
      (grupos[k] = grupos[k] || []).push(t);
    }
    return Object.entries(grupos)
      .filter(([,arr]) => arr.length >= minMuestra)
      .map(([clave, arr]) => {
        const ganadoras = arr.filter(t=>t.rObtenido > 0);
        const perdedoras = arr.filter(t=>t.rObtenido <= 0);
        const rProm = +(arr.reduce((s,t)=>s+t.rObtenido,0)/arr.length).toFixed(3);
        const mfes = arr.filter(t=>t.registro.mfe!=null).map(t=>t.registro.mfe);
        const maes = arr.filter(t=>t.registro.mae!=null).map(t=>Math.abs(t.registro.mae));
        const gan = ganadoras.reduce((s,t)=>s+t.rObtenido,0);
        const per = Math.abs(perdedoras.reduce((s,t)=>s+t.rObtenido,0));
        return {
          categoria: etiqueta, estrategia: clave,
          operaciones: arr.length,
          winRate: +(ganadoras.length/arr.length*100).toFixed(1),
          expectancy: rProm,
          rPromedioGanadora: ganadoras.length ? +(gan/ganadoras.length).toFixed(2) : null,
          rPromedioPerdedora: perdedoras.length ? +(per/perdedoras.length).toFixed(2) : null,
          profitFactor: per > 0 ? +(gan/per).toFixed(2) : (gan>0?Infinity:0),
          mfePromedio: mfes.length ? +(mfes.reduce((a,b)=>a+b,0)/mfes.length).toFixed(2) : null,
          maePromedio: maes.length ? +(maes.reduce((a,b)=>a+b,0)/maes.length).toFixed(2) : null,
          // La confianza depende de la muestra: 15 operaciones no son 50
          confianza: arr.length >= 50 ? 'alta' : arr.length >= 25 ? 'media' : 'baja',
          veredicto: rProm >= 0.3 ? '🥇 muy buena' : rProm >= 0.1 ? '🥈 positiva'
                   : rProm > -0.1 ? '➖ neutra' : '⚠️ negativa',
        };
      });
  };

  const ranking = [
    ...agrupar('Camino', t => t.tipoSetup ?? null),
    ...agrupar('Dirección', t => t.dir ?? null),
    ...agrupar('Fase', t => t.marketPhase ?? null),
    ...agrupar('Horario', t => t.horaConfirmacion==null ? null : t.horaConfirmacion<6?'00-06h':t.horaConfirmacion<12?'06-12h':t.horaConfirmacion<18?'12-18h':'18-24h'),
    ...agrupar('Liquidez', t => t.registro?.liquidezAFavor ?? null),
    ...agrupar('IFVG', t => t.registro?.ifvg ?? null),
    ...agrupar('Ruptura', t => t.registro?.rupturaTriangulo ?? null),
    ...agrupar('On-chain', t => t.registro?.onChain?.acompana ?? null),
    ...agrupar('Actividad anómala', t => t.registro?.actividadAnomala?.nivel ?? null),
    ...agrupar('Estado de la cuenta', t => t.abiertaEnDrawdownAlto == null ? null : (t.abiertaEnDrawdownAlto ? 'drawdown alto' : 'cuenta sana')),
    ...agrupar('Wallets', t => t.registro?.wallets?.acompana ?? null),
    ...agrupar('Libro de órdenes', t => t.registro?.libro?.sesgo ?? null),
    ...agrupar('Cinta de medias', t => t.registro?.cinta == null ? null : (t.registro.cinta.limpia ? 'limpia' : 'plana')),
    ...agrupar('RSI', t => t.registro?.rsi == null ? null : (t.registro.rsi >= 55 ? 'alto' : t.registro.rsi >= 45 ? 'neutro' : 'bajo')),
    ...agrupar('ADX', t => t.registro?.adx == null ? null : (t.registro.adx >= 25 ? 'con tendencia' : 'sin tendencia')),
    ...agrupar('Volatilidad', t => t.registro?.atrPct == null ? null : (t.registro.atrPct >= 4 ? 'alta' : 'normal')),
    ...agrupar('Flujo de órdenes', t => t.registro?.flujoOrdenes?.sesgo ?? null),
  ].sort((a,b)=> b.expectancy - a.expectancy);

  const positivas = ranking.filter(x=>x.expectancy >= 0.1 && x.confianza !== 'baja');
  return {
    listo: true,
    operaciones: conR.length,
    ranking,
    nota: positivas.length
      ? `${positivas.length} estrategia(s) muestran expectancy positiva con muestra razonable. Esas son las únicas que consideraría para tocar el motor.`
      : 'Ninguna estrategia muestra todavía expectancy positiva con muestra suficiente. Conviene seguir juntando datos antes de cambiar nada.',
  };
}

// ═══ CALIDAD DE LA DECISIÓN vs RESULTADO ═══
// Una operación puede ser mala y ganar, o buena y perder. Si el sistema aprende del resultado
// aislado, va a sacar conclusiones equivocadas: reforzaría un setup malo que tuvo suerte y
// descartaría uno bueno que tuvo mala racha.
// Esta función separa las dos cosas: evalúa si la DECISIÓN tenía sentido según lo que se sabía
// al momento de entrar, independientemente de cómo salió.
function calidadDecision(trade, historial = []){
  if(!trade?.registro) return null;
  const r = trade.registro;
  const puntos = [];
  let score = 0;

  // 1) ¿Cuántos componentes empujaban a favor? Más confluencia = mejor decisión.
  const aFavor = (r.componentes||[]).filter(cp => {
    if(Math.abs(cp.aporte) < 0.2) return false;
    return trade.dir==='LONG' ? cp.aporte > 0 : cp.aporte < 0;
  }).length;
  if(aFavor >= 4){ score += 2; puntos.push(`${aFavor} componentes a favor`); }
  else if(aFavor >= 2){ score += 1; puntos.push(`${aFavor} componentes a favor`); }
  else puntos.push(`solo ${aFavor} componente(s) a favor`);

  // 2) ¿La liquidez acompañaba?
  if(r.liquidezAFavor === 'a favor'){ score += 1; puntos.push('liquidez a favor'); }
  else if(r.liquidezAFavor === 'en contra'){ score -= 1; puntos.push('liquidez en contra'); }

  // 3) ¿La fase del mercado acompañaba?
  if(trade.marketPhase){
    const contra = (trade.dir==='LONG' && ['CLÍMAX','DISTRIBUCIÓN','MARKDOWN'].includes(trade.marketPhase))
                || (trade.dir==='SHORT' && ['CAPITULACIÓN','ACUMULACIÓN','EXPANSIÓN ALCISTA'].includes(trade.marketPhase));
    if(contra){ score -= 2; puntos.push(`fase ${trade.marketPhase} en contra`); }
    else { score += 1; puntos.push(`fase ${trade.marketPhase} compatible`); }
  }

  // 4) ¿El Estocástico estaba en un extremo desfavorable?
  if(r.estocastico != null){
    const extremoMalo = (trade.dir==='LONG' && r.estocastico >= 80) || (trade.dir==='SHORT' && r.estocastico <= 20);
    if(extremoMalo){ score -= 2; puntos.push(`Estocástico en ${r.estocastico.toFixed(0)}, agotado`); }
  }

  // 5) ¿Entró por válvula de escape? Son entradas de menor calidad por definición.
  if(r.porValvulaEscape){ score -= 1; puntos.push('entró por válvula de escape'); }

  // 6) ¿La calidad de los datos era buena?
  if(trade.dataQuality != null){
    if(trade.dataQuality >= 85) score += 1;
    else if(trade.dataQuality < 65){ score -= 1; puntos.push(`datos incompletos (${trade.dataQuality}/100)`); }
  }

  // 7) ¿El R:R justificaba el riesgo?
  if(r.gestion?.rTp1 != null){
    if(r.gestion.rTp1 >= 1.5){ score += 1; puntos.push(`R:R ${r.gestion.rTp1} en TP1`); }
    else if(r.gestion.rTp1 < 1){ score -= 1; puntos.push(`R:R apenas ${r.gestion.rTp1}`); }
  }

  // 8) ¿Cómo venían las operaciones parecidas ANTES de entrar?
  if(r.parecidasAlEntrar?.cantidad >= 10){
    if(r.parecidasAlEntrar.winRate >= 55){ score += 1; puntos.push(`operaciones parecidas ganaban ${r.parecidasAlEntrar.winRate}%`); }
    else if(r.parecidasAlEntrar.winRate <= 40){ score -= 1; puntos.push(`operaciones parecidas ganaban solo ${r.parecidasAlEntrar.winRate}%`); }
  }

  const calidad = score >= 4 ? 'BUENA' : score >= 1 ? 'ACEPTABLE' : score >= -1 ? 'DÉBIL' : 'MALA';
  const gano = trade.pnlPct > 0;
  const coincide = (calidad==='BUENA'||calidad==='ACEPTABLE') === gano;

  // ═══ ¿LA DECISIÓN QUE TOMÓ EL MOTOR ERA LA CORRECTA? ═══
  // Esto es distinto de si la operación ganó. Evalúa si, CON LA INFORMACIÓN QUE TENÍA EN ESE
  // MOMENTO, entrar era razonable. Una operación puede perder y haber sido buena decisión,
  // o ganar y haber sido mala.
  //
  // Lo que se revisa es si el motor entró ignorando sus propias señales de alerta.
  const dec = r.decision;
  if(dec){
    // Entrar cuando el propio sistema decía esperar es lo que más caro sale
    if(dec.accion === 'ESPERAR' && trade.entry){
      score -= 2;
      puntos.push('❌ Se entró aunque la decisión era ESPERAR: no se cumplieron las condiciones que el propio motor pedía.');
    }
    if(dec.accion === 'DESCARTAR' && trade.entry){
      score -= 3;
      puntos.push('❌ Se entró aunque la decisión era DESCARTAR: había un bloqueo activo.');
    }
    // Entrar sin fuerza es la causa más común de que la operación muera a mitad de camino
    if(dec.fuerza === false){
      score -= 1;
      puntos.push('⚠️ Se entró sin que el movimiento tuviera fuerza confirmada.');
    }
    if(dec.contexto === 'ADVERSO'){
      score -= 1;
      puntos.push('⚠️ Se entró con el contexto general adverso.');
    }
    if(dec.accion === 'ENTRAR' && dec.fuerza === true){
      score += 2;
      puntos.push('✅ Se entró con la decisión a favor y el movimiento con fuerza: la entrada estaba justificada.');
    }
    if(dec.tamanoSugerido && dec.tamanoSugerido < 100 && r.gestion?.tamanoUsado === 100){
      score -= 1;
      puntos.push(`⚠️ El motor sugería entrar con el ${dec.tamanoSugerido}% del tamaño y se entró completo.`);
    }
  }

  return {
    score, calidad, puntos,
    // Qué había decidido el motor cuando entró: sirve para medir si respetar la decisión rinde
    decisionOriginal: dec?.accion || null,
    teniaFuerza: dec?.fuerza ?? null,
    resultado: gano ? 'GANÓ' : 'PERDIÓ',
    // El caso interesante: cuando decisión y resultado NO coinciden
    lección: coincide
      ? null
      : gano
      ? `⚠️ Ganó, pero la decisión era ${calidad.toLowerCase()}. No hay que reforzar este tipo de entrada solo porque salió bien esta vez.`
      : `ℹ️ Perdió, pero la decisión era ${calidad.toLowerCase()}. Una operación bien tomada puede perder — no hay que descartar este setup por este resultado.`,
    resumen: `Decisión ${calidad} (${score} puntos) · ${gano?'ganó':'perdió'}${coincide?'':' — no coinciden'}`,
  };
}

// Resumen sobre todas las operaciones: ¿el sistema toma buenas decisiones, más allá de la suerte?
function resumenCalidadDecisiones(closedTrades){
  const conCalidad = (closedTrades||[])
    .map(t => ({ trade: t, cal: calidadDecision(t) }))
    .filter(x => x.cal);

  if(conCalidad.length < 10) return { listo:false, operaciones: conCalidad.length,
    nota:`Hacen falta al menos 10 operaciones con registro completo. Hay ${conCalidad.length}.` };

  const grupos = { BUENA:[], ACEPTABLE:[], DÉBIL:[], MALA:[] };
  for(const x of conCalidad) grupos[x.cal.calidad].push(x.trade);

  const filas = Object.entries(grupos)
    .filter(([,arr]) => arr.length > 0)
    .map(([calidad, arr]) => ({
      calidad,
      operaciones: arr.length,
      winRate: +(arr.filter(t=>t.pnlPct>0).length/arr.length*100).toFixed(1),
      suficienteMuestra: arr.length >= 10,
    }));

  const buenas = grupos.BUENA.concat(grupos.ACEPTABLE);
  const malas = grupos.DÉBIL.concat(grupos.MALA);
  const wrBuenas = buenas.length ? +(buenas.filter(t=>t.pnlPct>0).length/buenas.length*100).toFixed(1) : null;
  const wrMalas = malas.length ? +(malas.filter(t=>t.pnlPct>0).length/malas.length*100).toFixed(1) : null;

  // Discrepancias: ganó con decisión mala, o perdió con decisión buena
  const ganóConMala = conCalidad.filter(x => x.trade.pnlPct > 0 && ['DÉBIL','MALA'].includes(x.cal.calidad)).length;
  const perdióConBuena = conCalidad.filter(x => x.trade.pnlPct <= 0 && ['BUENA','ACEPTABLE'].includes(x.cal.calidad)).length;

  return {
    listo: true,
    operaciones: conCalidad.length,
    filas,
    winRateDecisionesBuenas: wrBuenas,
    winRateDecisionesMalas: wrMalas,
    ganóConDecisionMala: ganóConMala,
    perdióConDecisionBuena: perdióConBuena,
    conclusion: (()=>{
      if(wrBuenas == null || wrMalas == null || buenas.length < 8 || malas.length < 8)
        return 'Todavía no hay suficientes operaciones de cada tipo para comparar decisiones buenas contra malas.';
      const dif = +(wrBuenas - wrMalas).toFixed(1);
      if(dif >= 15) return `✅ Las decisiones bien tomadas ganan ${dif} puntos más que las mal tomadas (${wrBuenas}% vs ${wrMalas}%). El criterio de entrada está funcionando.`;
      if(dif <= -10) return `⚠️ Las decisiones que el sistema considera BUENAS están ganando MENOS que las débiles (${wrBuenas}% vs ${wrMalas}%). Eso sugiere que el criterio de calidad está mal calibrado.`;
      return `➖ No hay diferencia clara entre decisiones buenas y débiles (${wrBuenas}% vs ${wrMalas}%). El criterio de calidad todavía no demuestra valor.`;
    })(),
    nota: `${ganóConMala} operación(es) ganaron con una decisión débil y ${perdióConBuena} perdieron con una decisión buena. Esos casos son ruido, no evidencia — no conviene sacar conclusiones de ellos.`,
  };
}

// ═══ ¿HABRÍAN SIDO MEJORES LOS NIVELES POR VOLATILIDAD? ═══
// El bot calcula stop y objetivos por ESTRUCTURA (soportes, resistencias, order blocks).
// La estrategia de la cinta los calcula por VOLATILIDAD (múltiplos de ATR). Ninguno es
// obviamente mejor: esto lo compara con las operaciones reales usando el MFE y el MAE.
export function compararNivelesEstructuraVsATR(closedTrades){
  const trades = (closedTrades||[]).filter(t =>
    t.registro?.cinta?.nivelesATR && t.registro?.mfe != null && t.registro?.mae != null &&
    t.registro?.gestion?.stopPct > 0);
  if(trades.length < 10) return { listo:false,
    nota:`Hacen falta al menos 10 operaciones con los dos sistemas de niveles registrados. Hay ${trades.length}.` };

  let ganaEstructura = 0, ganaATR = 0, empate = 0;
  const detalle = [];
  for(const t of trades){
    const alt = t.registro.cinta.nivelesATR;
    const stopReal = t.registro.gestion.stopPct;
    const stopAlt = alt.stopPct;
    // ¿El stop por ATR habría aguantado el retroceso que hubo? (el MAE está en R del stop real)
    const maeEnPct = Math.abs(t.registro.mae) * stopReal;
    const aguantaATR = maeEnPct < stopAlt;
    const aguantaReal = Math.abs(t.registro.mae) < 1;
    // ¿El objetivo por ATR se habría alcanzado? (el MFE también está en R del stop real)
    const mfeEnPct = t.registro.mfe * stopReal;
    const llegaTp1ATR = mfeEnPct >= (alt.rrTp1 * stopAlt);
    const llegaTp1Real = t.alcanzoTp1;

    if(aguantaATR && !aguantaReal) ganaATR++;            // el stop por ATR habría salvado la operación
    else if(!aguantaATR && aguantaReal) ganaEstructura++;  // el de estructura fue mejor
    else if(llegaTp1ATR && !llegaTp1Real) ganaATR++;
    else if(!llegaTp1ATR && llegaTp1Real) ganaEstructura++;
    else empate++;
    detalle.push({ symbol:t.symbol, stopReal, stopAlt, aguantaATR, aguantaReal, llegaTp1ATR, llegaTp1Real });
  }

  const total = trades.length;
  const dif = ganaATR - ganaEstructura;
  return {
    listo: true, operaciones: total,
    ganaEstructura, ganaATR, empate,
    veredicto: Math.abs(dif) < Math.max(3, total*0.15)
      ? `Los dos sistemas rinden parecido (${ganaEstructura} a favor de estructura, ${ganaATR} a favor de ATR, ${empate} iguales). No hay motivo para cambiar.`
      : dif > 0
      ? `⚠️ Los niveles por volatilidad habrían sido mejores en ${ganaATR} de ${total} casos contra ${ganaEstructura}. Vale la pena probarlos.`
      : `Los niveles por estructura fueron mejores (${ganaEstructura} contra ${ganaATR}). Conviene dejarlos como están.`,
    nota: 'La comparación usa el MFE y el MAE: cuánto avanzó y cuánto retrocedió cada operación. No es un backtest completo, pero indica si vale la pena investigar el cambio.',
  };
}

// ═══ FOTO ANTES / DESPUÉS DE LOS ARREGLOS ═══
// Compara las operaciones anteriores a una fecha contra las posteriores, en las dimensiones que
// importan para saber si los arreglos sirvieron. A diferencia de compararVersiones, que mira
// métricas generales, esta se enfoca en lo que se corrigió: stops falsos, ganancias parciales
// mal contabilizadas, y las señales nuevas (on-chain, actividad anómala).
function fotoAntesDespues(closedTrades, fechaCorte){
  const trades = (closedTrades||[]).filter(t => t.closedAt && t.pnlPct != null);
  const antes = trades.filter(t => t.closedAt < fechaCorte);
  const despues = trades.filter(t => t.closedAt >= fechaCorte);

  const foto = (arr) => {
    if(!arr.length) return null;
    const gan = arr.filter(t => (t.pnlUsd ?? t.pnlPct) > 0);
    const per = arr.filter(t => (t.pnlUsd ?? t.pnlPct) <= 0);
    const sumG = gan.reduce((s,t)=>s+Math.abs(t.pnlUsd ?? t.pnlPct),0);
    const sumP = per.reduce((s,t)=>s+Math.abs(t.pnlUsd ?? t.pnlPct),0);
    const conR = arr.filter(t => t.registro?.gestion?.stopPct > 0);
    const mfes = arr.filter(t=>t.registro?.mfe!=null).map(t=>t.registro.mfe);
    const maes = arr.filter(t=>t.registro?.mae!=null).map(t=>Math.abs(t.registro.mae));
    const prom = a => a.length ? +(a.reduce((x,y)=>x+y,0)/a.length).toFixed(2) : null;
    // Cuántas alcanzaron cada objetivo
    const alcanzo = (r) => mfes.length ? +(mfes.filter(x=>x>=r).length/mfes.length*100).toFixed(0) : null;
    return {
      operaciones: arr.length,
      winRate: +(gan.length/arr.length*100).toFixed(1),
      gananciaMedia: gan.length ? +(sumG/gan.length).toFixed(2) : 0,
      perdidaMedia: per.length ? +(sumP/per.length).toFixed(2) : 0,
      ratio: (per.length && gan.length) ? +((sumG/gan.length)/(sumP/per.length)).toFixed(2) : null,
      profitFactor: sumP > 0 ? +(sumG/sumP).toFixed(2) : (sumG>0?Infinity:0),
      pnlTotal: +arr.reduce((s,t)=>s+(t.pnlUsd ?? 0),0).toFixed(2),
      mfePromedio: prom(mfes), maePromedio: prom(maes),
      llegoATp1: alcanzo(1.0), llegoATp2: alcanzo(1.6), llegoATp3: alcanzo(2.5),
      // Lo específico de los arreglos
      cerradasPorStop: arr.filter(t => (t.motivoCierre||'').includes('stop')).length,
      conGananciaParcial: arr.filter(t => t.alcanzoTp1).length,
      mechasQueNoCerraron: arr.reduce((s,t)=>s+(t.auditoria?.mechasQueTocaronStop||0),0),
      // Las señales nuevas
      onChainAcompana: arr.filter(t => t.registro?.onChain?.acompana === 'acompaña').length,
      onChainContradice: arr.filter(t => t.registro?.onChain?.acompana === 'contradice').length,
      conDatosCompletos: conR.length,
    };
  };

  const a = foto(antes), d = foto(despues);
  if(!a || !d) return { listo:false,
    nota:`Hacen falta operaciones de los dos lados de la fecha. Hay ${antes.length} antes y ${despues.length} después.` };

  const dif = (x,y) => (x==null||y==null) ? null : +(y-x).toFixed(2);
  return {
    listo: true,
    antes: a, despues: d,
    cambios: {
      winRate: dif(a.winRate, d.winRate),
      ratio: dif(a.ratio, d.ratio),
      profitFactor: dif(a.profitFactor, d.profitFactor),
      mfePromedio: dif(a.mfePromedio, d.mfePromedio),
      llegoATp2: dif(a.llegoATp2, d.llegoATp2),
    },
    conclusion: (()=>{
      if(d.operaciones < 20) return `Con ${d.operaciones} operaciones nuevas todavía es pronto. Hacen falta 30-40 para comparar en serio.`;
      const partes = [];
      const dRatio = dif(a.ratio, d.ratio);
      if(dRatio != null){
        partes.push(dRatio > 0.15
          ? `El ratio ganancia/pérdida mejoró de ${a.ratio} a ${d.ratio}.`
          : dRatio < -0.15 ? `⚠️ El ratio empeoró de ${a.ratio} a ${d.ratio}.`
          : `El ratio se mantiene parecido (${a.ratio} → ${d.ratio}).`);
      }
      if(d.llegoATp2 != null && a.llegoATp2 != null){
        partes.push(d.llegoATp2 > a.llegoATp2 + 10
          ? `Más operaciones llegan a TP2 (${a.llegoATp2}% → ${d.llegoATp2}%).`
          : d.llegoATp2 < 15 ? `⚠️ Solo el ${d.llegoATp2}% llega a TP2: los objetivos siguen quedando lejos.` : '');
      }
      if(d.mechasQueNoCerraron > 0) partes.push(`${d.mechasQueNoCerraron} mecha(s) tocaron el stop sin que la vela cerrara del otro lado — señal de que los stops pueden estar ajustados.`);
      return partes.filter(Boolean).join(' ');
    })(),
    nota: 'La fecha de corte debería ser cuando se subieron los arreglos. Las operaciones anteriores incluyen cierres mal contabilizados.',
  };
}

// ═══ COMPARADOR DE VERSIONES DEL MOTOR ═══
// Cuando se cambia algo del motor, hace falta poder responder: ¿mejoró o empeoró?
// Compara las operaciones de antes y después de una fecha de corte, usando las métricas netas.
// NO cambia nada por su cuenta: produce la comparación, la decisión es humana.
function compararVersiones(closedTrades, fechaCorte, nombreAntes = 'Versión anterior', nombreDespues = 'Versión actual'){
  const trades = (closedTrades||[]).filter(t => t.pnlPct != null && t.closedAt);
  const antes = trades.filter(t => t.closedAt < fechaCorte);
  const despues = trades.filter(t => t.closedAt >= fechaCorte);

  if(antes.length < 10 || despues.length < 10){
    return { listo:false,
      nota:`Hacen falta al menos 10 operaciones de cada lado para comparar. Hay ${antes.length} antes y ${despues.length} después.` };
  }

  const mA = metricasCompletas(antes);
  const mD = metricasCompletas(despues);
  if(!mA.listo || !mD.listo) return { listo:false, nota:'No se pudieron calcular las métricas de alguno de los dos períodos.' };

  const dif = (a,b) => a==null||b==null ? null : +(b-a).toFixed(3);
  const comparacion = [
    { metrica:'Expectancy',    antes:mA.expectancy,    despues:mD.expectancy,    diferencia:dif(mA.expectancy,mD.expectancy),       mejorEsMayor:true },
    { metrica:'Win rate',      antes:mA.winRate,       despues:mD.winRate,       diferencia:dif(mA.winRate,mD.winRate),             mejorEsMayor:true },
    { metrica:'Profit Factor', antes:mA.profitFactor,  despues:mD.profitFactor,  diferencia:dif(mA.profitFactor,mD.profitFactor),   mejorEsMayor:true },
    { metrica:'Resultado neto',antes:mA.resultadoNetoPct, despues:mD.resultadoNetoPct, diferencia:dif(mA.resultadoNetoPct,mD.resultadoNetoPct), mejorEsMayor:true },
    { metrica:'Drawdown máx',  antes:mA.drawdownMax,   despues:mD.drawdownMax,   diferencia:dif(mA.drawdownMax,mD.drawdownMax),     mejorEsMayor:false },
    { metrica:'Peor racha',    antes:mA.peorRachaPerdedora, despues:mD.peorRachaPerdedora, diferencia:dif(mA.peorRachaPerdedora,mD.peorRachaPerdedora), mejorEsMayor:false },
  ].map(x => ({
    ...x,
    mejoro: x.diferencia == null ? null : (x.mejorEsMayor ? x.diferencia > 0 : x.diferencia < 0),
  }));

  const mejoras = comparacion.filter(x=>x.mejoro===true).length;
  const empeoras = comparacion.filter(x=>x.mejoro===false).length;
  const difExpectancy = dif(mA.expectancy, mD.expectancy);

  return {
    listo: true,
    antes: { nombre:nombreAntes, operaciones:antes.length, ...mA },
    despues: { nombre:nombreDespues, operaciones:despues.length, ...mD },
    comparacion,
    mejoras, empeoras,
    veredicto: (()=>{
      if(antes.length < 30 || despues.length < 30)
        return `Con ${antes.length} y ${despues.length} operaciones la comparación es orientativa. Hacen falta 30+ de cada lado para concluir algo.`;
      if(mejoras >= 4 && difExpectancy > 0.1)
        return `✅ La versión nueva mejora en ${mejoras} de 6 métricas, con +${difExpectancy} de expectancy. Hay evidencia de que el cambio ayudó.`;
      if(empeoras >= 4 && difExpectancy < -0.1)
        return `⚠️ La versión nueva empeora en ${empeoras} de 6 métricas (${difExpectancy} de expectancy). Convendría revertir el cambio.`;
      return `➖ Los resultados están parejos (${mejoras} métricas mejor, ${empeoras} peor). No hay evidencia clara de que el cambio haya servido.`;
    })(),
    nota: 'La comparación asume que la única diferencia entre los dos períodos fue el cambio del motor. Si el mercado cambió mucho, parte de la diferencia puede venir de ahí y no del cambio.',
  };
}

// ═══ MÉTRICAS COMPLETAS DEL SISTEMA ═══
// Todo lo que hace falta para saber si el sistema tiene ventaja real, en un solo lugar y
// contando los costes de ejecución. El win rate solo no dice nada.
function metricasCompletas(closedTrades, opciones = {}){
  const trades = (closedTrades||[]).filter(t => t.pnlPct != null);
  if(trades.length < 10) return { listo:false, operaciones: trades.length,
    nota:`Hacen falta al menos 10 operaciones cerradas. Hay ${trades.length}.` };

  // Se trabaja con el resultado NETO, no el bruto
  const conNeto = trades.map(t => ({ ...t, neto: calcularCosteReal(t, opciones).netoPct }));
  const ganadoras = conNeto.filter(t => t.neto > 0);
  const perdedoras = conNeto.filter(t => t.neto <= 0);

  const sumGan = ganadoras.reduce((s,t)=>s+t.neto,0);
  const sumPer = Math.abs(perdedoras.reduce((s,t)=>s+t.neto,0));
  const avgWin = ganadoras.length ? +(sumGan/ganadoras.length).toFixed(2) : 0;
  const avgLoss = perdedoras.length ? +(sumPer/perdedoras.length).toFixed(2) : 0;
  const winRate = +(ganadoras.length/conNeto.length*100).toFixed(1);

  // Expectancy: cuánto se espera ganar por operación
  const expectancy = +((winRate/100)*avgWin - (1-winRate/100)*avgLoss).toFixed(3);

  // Rachas y drawdown, en el orden real en que ocurrieron
  const ordenadas = [...conNeto].sort((a,b)=>(a.closedAt||0)-(b.closedAt||0));
  let capital = 100, pico = 100, dd = 0, rachaP = 0, peorRachaP = 0, rachaG = 0, mejorRachaG = 0;
  for(const t of ordenadas){
    capital *= (1 + (t.neto/100) * 0.02 / (t.registro?.gestion?.stopPct ? t.registro.gestion.stopPct/100 : 0.07));
    pico = Math.max(pico, capital);
    dd = Math.max(dd, (pico-capital)/pico);
    if(t.neto <= 0){ rachaP++; peorRachaP = Math.max(peorRachaP, rachaP); rachaG = 0; }
    else { rachaG++; mejorRachaG = Math.max(mejorRachaG, rachaG); rachaP = 0; }
  }

  // R promedio, si hay datos de riesgo
  const conR = conNeto.filter(t => t.registro?.gestion?.stopPct > 0);
  const rProm = conR.length
    ? +(conR.reduce((s,t)=>s + t.neto/t.registro.gestion.stopPct, 0)/conR.length).toFixed(3) : null;

  const costes = resumenCostes(trades, opciones);

  // ═══ RESULTADO EN DÓLARES ═══
  // Los porcentajes están bien para comparar, pero lo que importa en la práctica es cuánto
  // se ganó o perdió de verdad. Se descuentan los costes proporcionalmente.
  const conUsd = trades.filter(t => t.pnlUsd != null);
  let brutoUsd = 0, costesUsd = 0;
  for(const t of conUsd){
    brutoUsd += t.pnlUsd;
    // El coste en dólares se estima sobre el tamaño de la posición, no sobre el resultado
    const det = calcularCosteReal(t, opciones);
    const tamañoPos = t.registro?.gestion?.stopPct > 0 && t.pnlPct
      ? Math.abs(t.pnlUsd / (t.pnlPct/100)) : null;
    if(tamañoPos) costesUsd += tamañoPos * (det.costeTotalPct/100);
  }
  const netoUsd = +(brutoUsd - costesUsd).toFixed(2);

  return {
    listo: true,
    operaciones: conNeto.length,
    // Resultado en dólares, que es lo que se ve en la cuenta
    brutoUsd: +brutoUsd.toFixed(2),
    costesUsd: +costesUsd.toFixed(2),
    netoUsd,
    operacionesConUsd: conUsd.length,
    winRate,
    ganadoras: ganadoras.length,
    perdedoras: perdedoras.length,
    avgWin, avgLoss,
    ratioGananciaPerdida: avgLoss > 0 ? +(avgWin/avgLoss).toFixed(2) : null,
    profitFactor: sumPer > 0 ? +(sumGan/sumPer).toFixed(2) : (sumGan>0?Infinity:0),
    expectancy,
    rPromedio: rProm,
    resultadoNetoPct: +conNeto.reduce((s,t)=>s+t.neto,0).toFixed(2),
    resultadoBrutoPct: +trades.reduce((s,t)=>s+t.pnlPct,0).toFixed(2),
    capitalSimulado: +capital.toFixed(2),
    drawdownMax: +(dd*100).toFixed(1),
    peorRachaPerdedora: peorRachaP,
    mejorRachaGanadora: mejorRachaG,
    costes: costes.listo ? costes : null,
    veredicto: (()=>{
      if(conNeto.length < 30) return `Con ${conNeto.length} operaciones cualquier conclusión es provisoria. Hacen falta 30+ para empezar a confiar en estos números.`;
      if(expectancy > 0.3) return `✅ El sistema muestra ventaja: se espera +${expectancy}% neto por operación.`;
      if(expectancy > 0) return `🟡 Ventaja chica pero positiva (+${expectancy}% por operación). Con los costes contados, el margen es ajustado.`;
      return `⚠️ Expectancy negativa (${expectancy}% por operación). Después de costes, el sistema no muestra ventaja todavía.`;
    })(),
  };
}

// ═══ RÉGIMEN DE MERCADO ═══
// No todas las estrategias funcionan igual en tendencia fuerte, rango o alta volatilidad.
// Cruza cada operación con el régimen que había cuando entró, para descubrir CUÁNDO funciona
// cada cosa — no solo qué funciona.
function rendimientoPorRegimen(closedTrades, minMuestra = 8){
  const conDatos = (closedTrades||[])
    .filter(t => t.pnlPct != null && t.registro?.gestion?.stopPct > 0)
    .map(t => ({ ...t, rObtenido: +(t.pnlPct/t.registro.gestion.stopPct).toFixed(3) }));

  if(conDatos.length < minMuestra*2) return { listo:false, operaciones: conDatos.length,
    nota:`Hacen falta al menos ${minMuestra*2} operaciones. Hay ${conDatos.length}.` };

  // El régimen sale de combinar la fase del mercado con el ADX registrado
  const regimenDe = t => {
    const fase = t.marketPhase;
    const adx = t.registro?.adx;
    if(!fase) return null;
    if(fase==='CLÍMAX' || fase==='CAPITULACIÓN') return '🚨 Clímax / capitulación';
    if(fase==='RANGO') return adx!=null && adx<15 ? '💤 Rango tranquilo' : '⚪ Rango';
    if(fase==='EXPANSIÓN ALCISTA') return adx!=null && adx>=35 ? '🟢 Tendencia alcista fuerte' : '🟢 Tendencia alcista';
    if(fase==='MARKDOWN') return adx!=null && adx>=35 ? '🔴 Tendencia bajista fuerte' : '🔴 Tendencia bajista';
    if(fase==='ACUMULACIÓN') return '🟡 Acumulación';
    if(fase==='DISTRIBUCIÓN') return '🟠 Distribución';
    return fase;
  };

  const grupos = {};
  for(const t of conDatos){
    const reg = regimenDe(t);
    if(!reg) continue;
    (grupos[reg] = grupos[reg] || []).push(t);
  }

  const filas = Object.entries(grupos)
    .filter(([,arr]) => arr.length >= minMuestra)
    .map(([regimen, arr]) => {
      const gan = arr.filter(t=>t.rObtenido>0);
      const expectancy = +(arr.reduce((s,t)=>s+t.rObtenido,0)/arr.length).toFixed(3);
      // Y dentro de cada régimen, qué setup anduvo mejor
      const porSetup = {};
      for(const t of arr){ const k=t.tipoSetup||'sin dato'; (porSetup[k]=porSetup[k]||[]).push(t.rObtenido); }
      const mejorSetup = Object.entries(porSetup)
        .filter(([,v])=>v.length>=3)
        .map(([k,v])=>({ setup:k, ops:v.length, expectancy:+(v.reduce((a,b)=>a+b,0)/v.length).toFixed(2) }))
        .sort((a,b)=>b.expectancy-a.expectancy)[0] || null;
      return {
        regimen, operaciones: arr.length,
        winRate: +(gan.length/arr.length*100).toFixed(1),
        expectancy,
        mejorSetup,
        confianza: arr.length>=30?'alta':arr.length>=15?'media':'baja',
        veredicto: expectancy>=0.3?'🥇 muy favorable':expectancy>=0.1?'🥈 favorable':expectancy>-0.1?'➖ neutro':'⚠️ desfavorable',
      };
    })
    .sort((a,b)=>b.expectancy-a.expectancy);

  const malos = filas.filter(f=>f.expectancy<=-0.1 && f.confianza!=='baja');
  return {
    listo: true,
    operaciones: conDatos.length,
    filas,
    nota: malos.length
      ? `⚠️ ${malos.length} régimen(es) muestran expectancy negativa. Saber CUÁNDO no operar suele valer más que agregar otro indicador.`
      : 'Ningún régimen muestra pérdida clara todavía. Con más operaciones se va a poder distinguir mejor.',
  };
}

// ═══ MFE/MAE SEPARADO POR RESULTADO ═══
// Responde dos preguntas concretas que sirven para calibrar stop y breakeven:
//   ¿Cuánto retrocede normalmente una operación GANADORA antes de despegar?
//     -> si el stop está más cerca que ese retroceso, se están cortando operaciones buenas.
//   ¿Cuánto llega a avanzar una PERDEDORA antes de darse vuelta?
//     -> si avanzan bastante, conviene un objetivo parcial más cerca o mover el stop antes.
function analisisMfeMaePorResultado(closedTrades){
  const conDatos = (closedTrades||[]).filter(t =>
    t.registro?.mfe != null && t.registro?.mae != null && t.pnlPct != null);
  if(conDatos.length < 10) return { listo:false, operaciones: conDatos.length,
    nota:`Hacen falta al menos 10 operaciones con MFE/MAE. Hay ${conDatos.length}.` };

  const ganadoras = conDatos.filter(t => t.pnlPct > 0);
  const perdedoras = conDatos.filter(t => t.pnlPct <= 0);
  const stat = arr => {
    if(!arr.length) return null;
    const ord = [...arr].sort((a,b)=>a-b);
    return {
      promedio: +(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2),
      mediana: +ord[Math.floor(ord.length/2)].toFixed(2),
      percentil75: +ord[Math.floor(ord.length*0.75)].toFixed(2),
      maximo: +Math.max(...arr).toFixed(2),
    };
  };

  const maeGanadoras = stat(ganadoras.map(t=>Math.abs(t.registro.mae)));
  const mfeGanadoras = stat(ganadoras.map(t=>t.registro.mfe));
  const mfePerdedoras = stat(perdedoras.map(t=>t.registro.mfe));
  const maePerdedoras = stat(perdedoras.map(t=>Math.abs(t.registro.mae)));

  const recomendaciones = [];
  if(maeGanadoras && ganadoras.length >= 8){
    recomendaciones.push(`Las operaciones que terminaron GANANDO retrocedieron ${maeGanadoras.promedio}R en promedio antes de despegar (el 75% no pasó de ${maeGanadoras.percentil75}R).`);
    if(maeGanadoras.percentil75 >= 0.85) recomendaciones.push(`⚠️ Ese retroceso está muy cerca del stop de 1R: es probable que se estén cortando operaciones que iban a funcionar.`);
  }
  if(mfePerdedoras && perdedoras.length >= 8){
    recomendaciones.push(`Las que terminaron PERDIENDO llegaron a avanzar ${mfePerdedoras.promedio}R antes de darse vuelta (el 75% llegó hasta ${mfePerdedoras.percentil75}R).`);
    if(mfePerdedoras.promedio >= 0.8) recomendaciones.push(`⚠️ Avanzan bastante antes de girar: un objetivo parcial más cerca o mover el stop antes convertiría varias de estas en ganadoras o en empate.`);
  }

  return {
    listo: true,
    operaciones: conDatos.length,
    ganadoras: { cantidad: ganadoras.length, retrocesoAntes: maeGanadoras, recorridoTotal: mfeGanadoras },
    perdedoras: { cantidad: perdedoras.length, avanceAntesDeGirar: mfePerdedoras, retroceso: maePerdedoras },
    recomendaciones,
    nota: 'Estas son las dos preguntas que más sirven para calibrar el stop y el breakeven — pero con menos de 30 operaciones son orientativas.',
  };
}

// ═══ CORRELACIÓN ENTRE OPERACIONES ABIERTAS ═══
// Cinco LONG en cinco altcoins distintas NO son cinco apuestas independientes: si BTC cae, caen
// todas juntas. El riesgo real es mucho mayor que la suma de los riesgos individuales.
function analizarCorrelacion(tesisAbiertas, contexto = {}){
  const activas = (tesisAbiertas||[]).filter(t => t.entry);
  if(activas.length < 3) return { hayRiesgo:false, nivel:'bajo', operaciones: activas.length, alertas:[], resumen:'Pocas operaciones abiertas, sin riesgo de correlación.' };

  const longs = activas.filter(t => t.dir === 'LONG').length;
  const shorts = activas.filter(t => t.dir === 'SHORT').length;
  const alertas = [];
  let nivel = 'bajo';

  // CORREGIDO: antes esto bloqueaba el 100% de las tesis nuevas. Dos errores de diseño:
  //   1) Alertaba porque "casi todas son cap chico" — pero el UNIVERSO del bot ES cap chico.
  //      Es como avisar "cuidado, todas tus operaciones de cripto son de cripto". Se sacó.
  //   2) El riesgo total se comparaba contra 10%, y con 24 operaciones abiertas siempre daba alto.
  //      Ahora el umbral es proporcional y mucho más alto.
  // Lo que SÍ es correlación real: que todas apunten al mismo lado, o que vayan contra BTC.

  // 1) Todas del mismo lado — esto sí es riesgo real
  const mismoLado = Math.max(longs, shorts);
  const pctMismoLado = mismoLado/activas.length*100;
  if(activas.length >= 5 && pctMismoLado >= 90){
    alertas.push(`${mismoLado} de ${activas.length} operaciones son ${longs>shorts?'LONG':'SHORT'}. Si el mercado se da vuelta, se ven afectadas todas juntas.`);
    nivel = 'medio';
  }

  // 2) BTC yendo en contra de la mayoría — el riesgo más concreto para altcoins
  if(contexto.btcCambio24h != null && activas.length >= 4){
    const btcBaja = contexto.btcCambio24h < -3;
    const btcSube = contexto.btcCambio24h > 3;
    if((btcBaja && longs >= activas.length*0.8) || (btcSube && shorts >= activas.length*0.8)){
      alertas.push(`BTC ${btcBaja?'cayendo':'subiendo'} ${Math.abs(contexto.btcCambio24h).toFixed(1)}% y ${btcBaja?longs:shorts} de ${activas.length} operaciones van al lado contrario. Las altcoins suelen seguir a BTC.`);
      nivel = 'alto';
    }
  }

  // 3) Demasiadas operaciones abiertas a la vez. El umbral ahora es la cantidad, no el % teórico:
  // más de 30 posiciones simultáneas es difícil de gestionar aunque cada una arriesgue poco.
  const maxSimultaneas = contexto.maxSimultaneas ?? 30;
  if(activas.length > maxSimultaneas){
    alertas.push(`Hay ${activas.length} operaciones abiertas al mismo tiempo (el límite razonable es ${maxSimultaneas}).`);
    nivel = 'alto';
  }

  const riesgoTotal = activas.length * (contexto.riesgoPorOperacion ?? 2);
  return {
    hayRiesgo: alertas.length > 0,
    nivel,
    operaciones: activas.length,
    longs, shorts,
    riesgoTotalPct: +riesgoTotal.toFixed(1),
    alertas,
    resumen: alertas.length
      ? `${nivel==='alto'?'🚨':'⚠️'} Riesgo de correlación ${nivel}: ${alertas.join(' ')}`
      : `Operaciones razonablemente repartidas (${longs} LONG / ${shorts} SHORT).`,
  };
}

// ═══ PROTECCIÓN DEL MOTOR (kill switch de datos) ═══
// Antes de mandar cualquier señal, comprueba que los datos tengan sentido. Un precio absurdo o
// desactualizado puede producir una señal perfectamente formada pero completamente equivocada.
// Es el tipo de fallo más peligroso: no crashea, simplemente produce basura convincente.
function verificarDatosSanos(data, opciones = {}){
  const problemas = [];
  const velas = data?.candles || [];
  const precio = data?.price;

  // 1) Precio válido
  if(!Number.isFinite(precio) || precio <= 0) problemas.push('El precio no es un número válido.');

  // 2) Velas suficientes
  if(velas.length < 30) problemas.push(`Solo hay ${velas.length} velas: no alcanza para calcular los indicadores.`);

  if(velas.length >= 10 && Number.isFinite(precio)){
    const ultima = velas.at(-1);

    // 3) El precio actual no puede estar lejísimos de la última vela
    if(Number.isFinite(ultima?.c) && ultima.c > 0){
      const desvio = Math.abs(precio - ultima.c)/ultima.c*100;
      if(desvio > 20) problemas.push(`El precio actual ($${precio}) está ${desvio.toFixed(0)}% lejos del cierre de la última vela ($${ultima.c}). Alguna de las dos fuentes está mal.`);
    }

    // 4) Datos desactualizados: la última vela no puede ser de hace horas
    if(ultima?.t){
      const horasViejo = (Date.now() - ultima.t)/3600000;
      const maxHoras = opciones.maxHorasDesactualizado ?? 6;
      if(horasViejo > maxHoras) problemas.push(`La última vela es de hace ${horasViejo.toFixed(1)} horas. Los datos están desactualizados.`);
    }

    // 5) Velas incoherentes: el máximo tiene que ser mayor al mínimo, y el cierre estar adentro
    const incoherentes = velas.slice(-30).filter(v =>
      !Number.isFinite(v.h) || !Number.isFinite(v.l) || v.h < v.l ||
      v.c > v.h*1.001 || v.c < v.l*0.999 || v.o > v.h*1.001 || v.o < v.l*0.999
    ).length;
    if(incoherentes > 0) problemas.push(`${incoherentes} vela(s) con valores incoherentes (máximo menor al mínimo, o cierre fuera del rango).`);

    // 6) Spread anormal: si el rango de la última vela es enorme, el libro está roto o hubo un pico
    if(Number.isFinite(ultima?.h) && Number.isFinite(ultima?.l) && ultima.l > 0){
      const rangoPct = (ultima.h - ultima.l)/ultima.l*100;
      const maxRango = opciones.maxRangoVelaPct ?? 40;
      if(rangoPct > maxRango) problemas.push(`La última vela tiene un rango de ${rangoPct.toFixed(0)}%. Puede ser un pico de datos malos o un movimiento imposible de operar.`);
    }

    // 7) Volumen cero sostenido: la moneda no se está operando
    const sinVolumen = velas.slice(-10).filter(v => !v.v || v.v <= 0).length;
    if(sinVolumen >= 7) problemas.push(`${sinVolumen} de las últimas 10 velas sin volumen. La moneda prácticamente no se opera.`);

    // 8) Precios repetidos: señal de datos congelados
    const cierres = velas.slice(-10).map(v=>v.c);
    if(new Set(cierres).size === 1) problemas.push('Las últimas 10 velas tienen exactamente el mismo cierre: los datos parecen congelados.');
  }

  return {
    sano: problemas.length === 0,
    problemas,
    mensaje: problemas.length
      ? `🛑 NO OPERAR — protección del motor: ${problemas.join(' ')}`
      : null,
  };
}

// ═══ RATIOS DE APALANCAMIENTO Y POSICIONAMIENTO ═══
// Cuatro números que dicen bastante sobre cuán inflada está una moneda con derivados:
//  · OI/market cap: cuánto apalancamiento hay respecto al tamaño real de la moneda.
//    Arriba del 30% es mucho: cualquier movimiento provoca liquidaciones en cadena.
//  · Futuros/spot: si se opera mucho más en futuros que al contado, el precio lo mueven
//    los apalancados, no compradores reales. Típico de las monedas que se desploman de golpe.
//  · L/S global vs L/S de cuentas grandes: cuando difieren, los grandes están del lado
//    contrario a la mayoría — y suelen tener razón.
async function _fetchRatiosApalancamiento(symbolRaw, marketCapUsd, volSpotUsd){
  const sym = normalizarSimbolo(symbolRaw);
  const pair = sym.endsWith('USDT') ? sym : sym + 'USDT';
  const out = { oiUsd:null, oiSobreMcap:null, futSobreSpot:null,
                lsGlobal:null, lsCuentasTop:null, lsPosicionesTop:null, divergencia:null, alertas:[] };
  try{
    const [oiRes, gRes, aRes, pRes, tkRes] = await Promise.all([
      fetchJSON(`${FUTURES}/fapi/v1/openInterest?symbol=${pair}`).catch(()=>null),
      fetchJSON(`${FUTURES}/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=1h&limit=1`).catch(()=>null),
      fetchJSON(`${FUTURES}/futures/data/topLongShortAccountRatio?symbol=${pair}&period=1h&limit=1`).catch(()=>null),
      fetchJSON(`${FUTURES}/futures/data/topLongShortPositionRatio?symbol=${pair}&period=1h&limit=1`).catch(()=>null),
      fetchJSON(`${FUTURES}/fapi/v1/ticker/24hr?symbol=${pair}`).catch(()=>null),
    ]);

    const precio = parseFloat(tkRes?.lastPrice) || null;
    if(oiRes?.openInterest && precio){
      out.oiUsd = parseFloat(oiRes.openInterest) * precio;
      if(marketCapUsd > 0){
        out.oiSobreMcap = +(out.oiUsd/marketCapUsd*100).toFixed(1);
        if(out.oiSobreMcap >= 30) out.alertas.push(`El interés abierto es el ${out.oiSobreMcap}% del market cap: hay muchísimo apalancamiento para el tamaño de esta moneda. Un movimiento fuerte puede desatar liquidaciones en cadena.`);
      }
    }
    const volFut = parseFloat(tkRes?.quoteVolume) || null;
    if(volFut && volSpotUsd > 0){
      out.futSobreSpot = +(volFut/volSpotUsd).toFixed(1);
      if(out.futSobreSpot >= 5) out.alertas.push(`Se opera ${out.futSobreSpot}x más en futuros que al contado: el precio lo están moviendo los apalancados, no compradores reales.`);
    }

    const leer = r => Array.isArray(r) && r[0] ? parseFloat(r[0].longShortRatio) : null;
    out.lsGlobal = leer(gRes);
    out.lsCuentasTop = leer(aRes);
    out.lsPosicionesTop = leer(pRes);

    // Lo más interesante: cuando los grandes están del lado contrario a la mayoría
    if(out.lsGlobal && out.lsPosicionesTop){
      const gGlobal = out.lsGlobal > 1 ? 'LONG' : 'SHORT';
      const gTop = out.lsPosicionesTop > 1 ? 'LONG' : 'SHORT';
      if(gGlobal !== gTop){
        out.divergencia = {
          multitud: gGlobal, grandes: gTop,
          texto: `La mayoría está ${gGlobal} (${out.lsGlobal.toFixed(2)}) pero las posiciones grandes están ${gTop} (${out.lsPosicionesTop.toFixed(2)}). Cuando se separan así, suele tener razón el lado grande.`,
        };
      }
    }
    return (out.oiUsd || out.lsGlobal) ? out : null;
  }catch(e){ return null; }
}

// ═══ CALIDAD DE LA TENDENCIA — CINTA DE MEDIAS ═══
// Adaptado de la estrategia Madrid Ribbon Pullback. Lo valioso no es la cinta en sí, sino el
// FILTRO DE CALIDAD que trae: no alcanza con que las medias estén ordenadas, tienen que estar
// INCLINADAS y SEPARADAS. Una cinta plana o comprimida significa que no hay tendencia real,
// aunque técnicamente la media rápida esté arriba de la lenta.
//
// Por qué importa para este bot: hoy la tendencia se evalúa por posición (precio sobre las
// medias) y por ADX. Esto agrega una tercera medida —la inclinación y la apertura de la cinta—
// que descarta los rangos disfrazados de tendencia, que es donde más falsas señales se generan.
//
// Los umbrales se miden en ATR, no en porcentaje fijo: así funciona igual en una moneda que
// se mueve 1% por día y en una que se mueve 30%.
export function calidadTendenciaCinta(candles, opciones = {}){
  if(!Array.isArray(candles) || candles.length < 100) return null;
  const cierres = candles.map(c => c.c);
  const usarEMA = opciones.exponencial !== false;
  // ema() y sma() devuelven la SERIE completa, no el último valor
  const media = (len) => usarEMA ? ema(cierres, len) : sma(cierres, len);

  const m75 = media(75), m90 = media(90);
  if(!m75?.length || !m90?.length) return null;
  const a75 = m75.at(-1), a90 = m90.at(-1);
  if(!Number.isFinite(a75) || !Number.isFinite(a90)) return null;

  // ATR para escalar los umbrales al tamaño real de los movimientos de esta moneda
  // atr() también devuelve serie: se toma el último valor
  const atrSerie = atr(candles, opciones.atrLen || 14);
  const atrActual = Array.isArray(atrSerie) ? atrSerie.at(-1) : atrSerie;
  if(!Number.isFinite(atrActual) || atrActual <= 0) return null;

  const lookback = opciones.lookback || 5;
  const previo75 = m75.at(-1 - lookback);
  if(!Number.isFinite(previo75)) return null;

  const ordenAlcista = a75 > a90;
  const pendiente = a75 - previo75;                 // cuánto subió o bajó la media rápida
  const separacion = Math.abs(a75 - a90);           // qué tan abierta está la cinta

  const umbralPendiente = atrActual * (opciones.sensPendiente ?? 0.05);
  const umbralSeparacion = atrActual * (opciones.sensSeparacion ?? 0.15);

  const pendienteOk = ordenAlcista ? pendiente > umbralPendiente : (-pendiente) > umbralPendiente;
  const separacionOk = separacion > umbralSeparacion;
  const limpia = pendienteOk && separacionOk;

  // La zona de la cinta: es donde tiene sentido esperar el retroceso
  const techo = Math.max(a75, a90), piso = Math.min(a75, a90);
  const precio = cierres.at(-1);
  const dentroDeLaCinta = candles.at(-1).l <= techo && candles.at(-1).h >= piso;

  // ¿Hubo un retroceso hasta la cinta? Segunda condición: no alcanza con operar cerca,
  // el precio tiene que haber ENTRADO en la zona.
  // El índice de la última vela que tocó importa para verificar el ORDEN de los eventos:
  // en el original el toque tiene que haber pasado ANTES de la ruptura de estructura
  // (ribbonTouched[1]), no después. Si rompe primero y vuelve después, es un patrón distinto
  // y más débil — el precio rompió y no sostuvo.
  const ventana = candles.slice(-10);
  let idxUltimoToque = -1;
  ventana.forEach((v, k) => { if(v.l <= techo && v.h >= piso) idxUltimoToque = k; });
  const tocoLaCinta = idxUltimoToque >= 0;
  // Cuántas velas atrás fue el toque (0 = la vela actual)
  const velasDesdeElToque = tocoLaCinta ? (ventana.length - 1 - idxUltimoToque) : null;

  const estado = limpia ? (ordenAlcista ? 'ALCISTA LIMPIA' : 'BAJISTA LIMPIA')
               : ordenAlcista ? 'alcista débil' : 'bajista débil';

  return {
    limpia, direccion: ordenAlcista ? 'LONG' : 'SHORT',
    estado,
    pendiente: +(pendiente/atrActual).toFixed(2),      // en múltiplos de ATR, comparable entre monedas
    separacion: +(separacion/atrActual).toFixed(2),
    pendienteOk, separacionOk,
    techo, piso, dentroDeLaCinta, tocoLaCinta, velasDesdeElToque,
    distanciaALaCinta: +((precio - (ordenAlcista ? techo : piso)) / precio * 100).toFixed(2),
    motivo: limpia
      ? `La cinta de medias está ${ordenAlcista?'subiendo':'bajando'} con inclinación (${(pendiente/atrActual).toFixed(2)} ATR) y bien abierta (${(separacion/atrActual).toFixed(2)} ATR): hay tendencia real.`
      : !pendienteOk && !separacionOk
      ? `La cinta está plana y comprimida: las medias están ordenadas pero no hay tendencia real, solo un rango. Es donde más falsas señales aparecen.`
      : !pendienteOk
      ? `La cinta está ordenada pero casi sin inclinación (${(pendiente/atrActual).toFixed(2)} ATR): la tendencia perdió fuerza.`
      : `Las medias están muy juntas (${(separacion/atrActual).toFixed(2)} ATR): la tendencia todavía no se definió.`,
  };
}

// ═══ ENTRADA POR RETROCESO A LA CINTA ═══
// Las tres condiciones de la estrategia, juntas. Cada una sola genera muchas falsas señales;
// las tres a la vez son bastante más selectivas.
export function entradaRetrocesoCinta(candles, structure, dirTesis, candlesHTF){
  const cinta = calidadTendenciaCinta(candles);
  if(!cinta) return null;

  const faltan = [];
  // 1) La cinta tiene que estar limpia y en la dirección de la tesis
  if(!cinta.limpia) faltan.push(cinta.motivo);
  else if(dirTesis && cinta.direccion !== dirTesis) faltan.push(`La cinta apunta a ${cinta.direccion}, no a ${dirTesis}.`);

  // 2) Tiene que haber habido un retroceso hasta la zona de la cinta
  if(!cinta.tocoLaCinta) faltan.push(`El precio no retrocedió hasta la cinta (está a ${cinta.distanciaALaCinta}%): entrar acá es perseguir el movimiento.`);

  // 3) Y una ruptura de estructura que confirme que vuelven a entrar
  const hayBOS = /bull|bear/i.test(String(structure?.events?.bos || ''));
  const hayCHoCH = !!structure?.events?.choch;
  if(!hayBOS && !hayCHoCH) faltan.push('Falta una ruptura de estructura (BOS o CHoCH) que confirme la reanudación.');

  // 3b) EL ORDEN IMPORTA: el toque tiene que haber sido ANTES de la ruptura.
  // Si el precio está DENTRO de la cinta justo ahora y recién rompe, todavía no se alejó:
  // el patrón correcto es retroceder, y desde ahí romper para reanudar.
  if(cinta.tocoLaCinta && cinta.velasDesdeElToque === 0 && (hayBOS || hayCHoCH)){
    faltan.push('El precio todavía está dentro de la cinta: el retroceso y la ruptura tienen que pasar en ese orden, no a la vez.');
  }

  // 4) No vender contra una cinta que sigue alcista y limpia (y viceversa).
  // Es la protección del original: evita el peor SHORT posible, el que va contra
  // una tendencia que todavía está sana.
  if(dirTesis === 'SHORT' && cinta.limpia && cinta.direccion === 'LONG'){
    faltan.push('La cinta sigue alcista y limpia: vender acá es operar contra una tendencia que todavía está sana.');
  }
  if(dirTesis === 'LONG' && cinta.limpia && cinta.direccion === 'SHORT'){
    faltan.push('La cinta sigue bajista y limpia: comprar acá es operar contra una tendencia que todavía está sana.');
  }

  // El marco mayor tiene que acompañar
  let htfOk = true;
  if(candlesHTF?.length >= 100){
    const cintaHTF = calidadTendenciaCinta(candlesHTF);
    if(cintaHTF && dirTesis && cintaHTF.direccion !== dirTesis){
      htfOk = false;
      faltan.push(`El marco mayor apunta a ${cintaHTF.direccion}: operar contra él baja mucho la probabilidad.`);
    }
  }

  const confirma = faltan.length === 0;
  return {
    confirma, cinta, htfOk,
    faltan,
    texto: confirma
      ? `🎀 Retroceso a la cinta confirmado: tendencia limpia ${cinta.direccion}, el precio volvió a la zona de las medias (${cinta.piso.toPrecision(6)}–${cinta.techo.toPrecision(6)}) y apareció ${hayCHoCH?'un CHoCH':'un BOS'} confirmando la reanudación.`
      : `Retroceso a la cinta: no se cumple. ${faltan.join(' ')}`,
  };
}

// ═══ FORMATO DE PRECIOS ═══
// El problema que resuelve: toFixed(6) fijo daba "63310.340000" en Bitcoin (seis decimales
// que no aportan nada) y "0.000008" en PEPE, donde el valor real es 0.00000842 — o sea que
// PERDÍA precisión justo en las monedas donde más importa saber el nivel exacto.
//
// Ahora los decimales se eligen según el tamaño del número: los precios grandes van con
// separador de miles y pocos decimales, y los muy chicos con todos los que hagan falta para
// no perder información.
export function fmtPrecio(v, opciones = {}){
  const n = Number(v);
  if(!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if(abs === 0) return '0';

  // ═══ NO REDONDEAR: MOSTRAR EL VALOR EXACTO ═══
  // La idea es la de TradingView: el número que se ve es el número que es. En un nivel de
  // liquidez el valor exacto ES el dato — es dónde va la orden. Redondear 0.058325 a 0.05833
  // cambia el nivel.
  // Se toman los decimales que el número REALMENTE tiene, con un techo por si viene con
  // basura de coma flotante (0.1+0.2 = 0.30000000000000004).
  // Se toman los decimales reales, pero acotados: un número que viene de un cálculo puede
  // arrastrar basura de coma flotante (0.1254021271 cuando lo útil es 0.12540). Doce dígitos
  // significativos alcanzan para cualquier precio real de cripto.
  const texto = Number(n.toPrecision(12)).toString();
  const decimalesReales = texto.includes('e')
    ? 12                                        // notación científica: se expande abajo
    : (texto.split('.')[1] || '').length;

  let decimales;
  if(abs >= 1000) decimales = Math.min(2, decimalesReales);
  else if(abs >= 1) decimales = Math.min(6, decimalesReales);
  else if(abs >= 0.01) decimales = Math.min(8, decimalesReales);
  else if(abs >= 0.0001) decimales = Math.min(10, decimalesReales);
  else {
    // Muy chico: se cuentan los ceros y se dejan los dígitos que haya de verdad
    const ceros = Math.floor(-Math.log10(abs));
    decimales = Math.min(18, Math.max(ceros + 4, decimalesReales));
  }

  const fijo = n.toFixed(decimales);
  // Se quitan los ceros de la derecha que no aportan (63310.34 en vez de 63310.340000)
  const limpio = fijo.includes('.') ? fijo.replace(/0+$/, '').replace(/\.$/, '') : fijo;

  if(opciones.sinMiles || abs < 1000) return limpio;
  // Separador de miles para que 63310.34 se lea como 63.310,34 de un vistazo
  const [ent, dec] = limpio.split('.');
  const conMiles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec ? `${conMiles}.${dec}` : conMiles;
}

// ═══ NIVELES POR ATR DE LA ESTRATEGIA DE LA CINTA ═══
// Los multiplicadores del original: SL a 1.5 ATR, TP1 a 2.0 ATR, TP2 a 4.0 ATR.
// Eso da un R:R de 1.33 en TP1 y 2.67 en TP2 — bastante más ambicioso que los niveles
// que calcula el bot por estructura.
//
// NO reemplaza al setup normal: se devuelve aparte para poder COMPARAR. Si dentro de unas
// semanas los niveles por ATR resultan mejores que los de estructura, ahí se cambia con datos.
export function nivelesCintaATR(candles, dir, opciones = {}){
  if(!Array.isArray(candles) || candles.length < 20) return null;
  const atrSerie = atr(candles, opciones.atrLen || 14);
  const a = Array.isArray(atrSerie) ? atrSerie.at(-1) : atrSerie;
  if(!Number.isFinite(a) || a <= 0) return null;

  const precio = candles.at(-1).c;
  const esLong = dir === 'LONG';
  const signo = esLong ? 1 : -1;
  const mSL = opciones.slMult ?? 1.5, mTP1 = opciones.tp1Mult ?? 2.0, mTP2 = opciones.tp2Mult ?? 4.0;

  const stop = precio - signo * a * mSL;
  const tp1 = precio + signo * a * mTP1;
  const tp2 = precio + signo * a * mTP2;
  const riesgo = Math.abs(precio - stop);

  return {
    entrada: precio, stop, tp1, tp2,
    atr: a,
    atrPct: +(a/precio*100).toFixed(2),
    rrTp1: +(Math.abs(tp1-precio)/riesgo).toFixed(2),
    rrTp2: +(Math.abs(tp2-precio)/riesgo).toFixed(2),
    stopPct: +(riesgo/precio*100).toFixed(2),
    nota: `Niveles por volatilidad: stop a ${mSL} ATR, TP1 a ${mTP1} ATR y TP2 a ${mTP2} ATR. Se adaptan solos a cuánto se mueve la moneda, en vez de fijarse en niveles del gráfico.`,
  };
}

// ═══ PRECIO vs POSICIONAMIENTO DE LOS GRANDES ═══
// La idea es simple y potente: comparar hacia dónde va el PRECIO con hacia dónde se mueve el
// ratio Long/Short de los traders grandes. Cuando van juntos, hay confirmación. Cuando se
// separan, alguien está atrapado — y normalmente es la mayoría, no los grandes.
//
//   PRECIO ↑ + L/S ↑  → los grandes acompañan la suba: confirmación para LONG
//   PRECIO ↑ + L/S ↓  → suben mientras los grandes venden: los shorts pueden ser exprimidos
//   PRECIO ↓ + L/S ↑  → baja mientras los grandes compran: pueden quedar atrapados
//   PRECIO ↓ + L/S ↓  → los grandes acompañan la baja: confirmación para SHORT
export function precioVsPosicionamiento(candles, lsActual, lsPrevio, dirTesis){
  if(!Array.isArray(candles) || candles.length < 8) return null;
  if(lsActual == null || lsPrevio == null) return null;

  // Variación del precio en las últimas velas (no solo la última, para no leer ruido)
  const ult = candles.slice(-6);
  const precioIni = ult[0].c, precioFin = ult.at(-1).c;
  if(!precioIni) return null;
  const varPrecio = (precioFin - precioIni)/precioIni*100;
  const varLS = ((lsActual - lsPrevio)/Math.max(0.01, lsPrevio))*100;

  // Umbrales: por debajo de esto es ruido, no movimiento
  const precioSube = varPrecio > 0.4, precioBaja = varPrecio < -0.4;
  const lsSube = varLS > 3, lsBaja = varLS < -3;
  if((!precioSube && !precioBaja) || (!lsSube && !lsBaja)){
    return { cuadrante:'SIN DEFINIR', alineado:null, varPrecio:+varPrecio.toFixed(2), varLS:+varLS.toFixed(1),
      texto:`Ni el precio ni el posicionamiento de los grandes se están moviendo lo suficiente como para sacar una lectura (precio ${varPrecio>=0?'+':''}${varPrecio.toFixed(2)}%, L/S ${varLS>=0?'+':''}${varLS.toFixed(1)}%).` };
  }

  let cuadrante, favorece, texto, aviso = null;
  if(precioSube && lsSube){
    cuadrante = 'PRECIO ↑ · GRANDES ↑'; favorece = 'LONG';
    texto = `El precio sube ${varPrecio.toFixed(2)}% y los traders grandes están abriendo MÁS largos (L/S ${varLS>=0?'+':''}${varLS.toFixed(1)}%). Van en la misma dirección: es confirmación para el lado comprador.`;
  } else if(precioSube && lsBaja){
    cuadrante = 'PRECIO ↑ · GRANDES ↓'; favorece = 'LONG';
    texto = `El precio sube ${varPrecio.toFixed(2)}% pero los grandes se están pasando al lado corto (L/S ${varLS.toFixed(1)}%).`;
    aviso = `Si estás pensando en SHORT, ojo: esos cortos pueden ser exprimidos y empujar el precio todavía más arriba. La suba puede acelerarse justamente porque hay muchos vendidos.`;
  } else if(precioBaja && lsSube){
    cuadrante = 'PRECIO ↓ · GRANDES ↑'; favorece = 'SHORT';
    texto = `El precio baja ${varPrecio.toFixed(2)}% pero los grandes están abriendo largos (L/S +${varLS.toFixed(1)}%).`;
    aviso = `Si estás pensando en LONG, ojo: todavía no hay confirmación. Si el precio sigue cayendo, esos largos quedan atrapados y su liquidación puede acelerar la baja.`;
  } else {
    cuadrante = 'PRECIO ↓ · GRANDES ↓'; favorece = 'SHORT';
    texto = `El precio baja ${varPrecio.toFixed(2)}% y los grandes están abriendo más cortos (L/S ${varLS.toFixed(1)}%). Van en la misma dirección: es confirmación para el lado vendedor.`;
  }

  const alineado = dirTesis ? (favorece === dirTesis) : null;
  return {
    cuadrante, favorece, alineado,
    varPrecio:+varPrecio.toFixed(2), varLS:+varLS.toFixed(1),
    lsActual:+lsActual.toFixed(3), lsPrevio:+lsPrevio.toFixed(3),
    texto, aviso,
    resumen: dirTesis
      ? (alineado ? `✅ El posicionamiento de los grandes acompaña esta operación ${dirTesis}.`
                  : `⚠️ El posicionamiento de los grandes NO acompaña esta operación ${dirTesis}. ${aviso || ''}`)
      : texto,
  };
}

// ═══ TAMAÑO DE UNA TRANSFERENCIA EN CONTEXTO ═══
// Un movimiento de $4M no significa nada por sí solo: en una moneda de $10.000M es ruido,
// en una de $200M es enorme. Lo que importa es el tamaño CONTRA el market cap y contra el
// volumen diario — si una sola transferencia equivale al 17% de todo lo que se opera en un
// día, ese dinero no puede salir sin mover el precio.
export function contextoTransferencia(usd, marketCapUsd, volumenDiarioUsd){
  if(!usd || usd <= 0) return null;
  const pctMcap = marketCapUsd > 0 ? usd/marketCapUsd*100 : null;
  const pctVol = volumenDiarioUsd > 0 ? usd/volumenDiarioUsd*100 : null;
  if(pctMcap == null && pctVol == null) return null;

  // El nivel sale del mayor de los dos: cualquiera de los dos puede ser determinante
  const peor = Math.max(pctMcap ?? 0, (pctVol ?? 0)/5);   // el volumen se pondera distinto
  const nivel = peor >= 3 ? 'MUY ALTO' : peor >= 1 ? 'ALTO' : peor >= 0.3 ? 'MEDIO' : 'BAJO';

  const lecturas = [];
  if(pctVol != null && pctVol >= 15) lecturas.push(`Equivale al ${pctVol.toFixed(1)}% de todo lo que se opera en un día: un movimiento de este tamaño no puede ejecutarse sin mover el precio.`);
  else if(pctVol != null && pctVol >= 5) lecturas.push(`Es el ${pctVol.toFixed(1)}% del volumen diario: significativo, aunque el mercado puede absorberlo.`);
  if(pctMcap != null && pctMcap >= 1) lecturas.push(`Representa el ${pctMcap.toFixed(2)}% de toda la capitalización de la moneda.`);

  return {
    usd, nivel,
    pctMarketCap: pctMcap != null ? +pctMcap.toFixed(2) : null,
    pctVolumenDiario: pctVol != null ? +pctVol.toFixed(1) : null,
    relevante: nivel === 'ALTO' || nivel === 'MUY ALTO',
    lectura: lecturas.length ? lecturas.join(' ') : `Movimiento chico para el tamaño de esta moneda: probablemente no mueva el precio.`,
  };
}

// ═══ MAPA DE CALOR DE LIQUIDEZ ═══
// Devuelve una franja de precios con la densidad de liquidez en cada una, para DIBUJARLA.
// La idea: mirar el mapa y ver de un vistazo dónde están los imanes, arriba o abajo, cerca
// o lejos — sin leer un párrafo.
//
// La densidad de cada franja combina cinco cosas, todas de datos que ya tenemos:
//   · Volumen negociado ahí (perfil de volumen clásico)
//   · Tiempo que el precio pasó ahí (donde estuvo horas hay más órdenes)
//   · Toques de swing con su calidad (rechazo, frescura, volumen)
//   · Órdenes reales del libro, si están disponibles
//   · Liquidaciones estimadas por apalancamiento
export function mapaCalorLiquidez(candles, precio, opciones = {}){
  if(!Array.isArray(candles) || candles.length < 30 || !precio) return null;

  const rangoPct = opciones.rangoPct ?? 12;        // ±12% alrededor del precio
  const filas = opciones.filas ?? 60;              // resolución del mapa
  const min = precio * (1 - rangoPct/100);
  const max = precio * (1 + rangoPct/100);
  const alto = (max - min) / filas;

  // Cada franja arranca en cero y se va cargando
  const franjas = Array.from({length: filas}, (_, i) => ({
    desde: min + i*alto, hasta: min + (i+1)*alto,
    centro: min + (i+0.5)*alto,
    volumen: 0, tiempo: 0, toques: 0, rechazo: 0, libro: 0, liquidaciones: 0,
  }));
  const indiceDe = (p) => {
    if(p < min || p >= max) return -1;
    return Math.min(filas-1, Math.floor((p - min) / alto));
  };

  // ── 1 y 2: VOLUMEN Y TIEMPO ──
  // El volumen se reparte por el rango de cada vela; el tiempo cuenta cuántas velas
  // tocaron cada franja. Donde el precio estuvo horas hay muchas más órdenes puestas.
  for(const v of candles){
    const iLo = indiceDe(v.l), iHi = indiceDe(v.h);
    if(iLo < 0 && iHi < 0) continue;
    const desde = Math.max(0, iLo < 0 ? 0 : iLo);
    const hasta = Math.min(filas-1, iHi < 0 ? filas-1 : iHi);
    const n = Math.max(1, hasta - desde + 1);
    for(let i = desde; i <= hasta; i++){
      franjas[i].volumen += (v.v || 0) / n;
      franjas[i].tiempo += 1 / n;
    }
  }

  // ── 3: TOQUES DE SWING CON SU CALIDAD ──
  // Un swing con mecha larga rechazando pesa mucho más que uno que el precio cruzó de largo.
  for(let i = 2; i < candles.length - 2; i++){
    const v = candles[i];
    const esMax = v.h > candles[i-1].h && v.h > candles[i-2].h && v.h > candles[i+1].h && v.h > candles[i+2].h;
    const esMin = v.l < candles[i-1].l && v.l < candles[i-2].l && v.l < candles[i+1].l && v.l < candles[i+2].l;
    if(!esMax && !esMin) continue;
    const idx = indiceDe(esMax ? v.h : v.l);
    if(idx < 0) continue;
    const rango = v.h - v.l;
    const mecha = rango > 0 ? (esMax ? (v.h - Math.max(v.o,v.c)) : (Math.min(v.o,v.c) - v.l)) / rango : 0;
    // Los swings recientes pesan más: la liquidez vieja ya se consumió
    const frescura = 0.4 + 0.6 * (i / candles.length);
    franjas[idx].toques += frescura;
    franjas[idx].rechazo += mecha * frescura;
  }

  // ── 4: ÓRDENES REALES DEL LIBRO ──
  if(opciones.libro?.niveles?.length){
    for(const n of opciones.libro.niveles){
      const idx = indiceDe(n.precio);
      if(idx >= 0) franjas[idx].libro += n.usd || 0;
    }
  }

  // ── 5: LIQUIDACIONES ESTIMADAS ──
  // Donde están los stops de la multitud. Se calcula desde los precios de entrada probables
  // (los máximos y mínimos recientes) con los apalancamientos más usados.
  if(opciones.estimarLiquidaciones !== false){
    const recientes = candles.slice(-100);
    for(const v of recientes){
      for(const lev of [10, 20, 25, 50]){
        // Un long entrado en el máximo se liquida un 1/lev por debajo
        const liqLong = v.h * (1 - 1/lev);
        const liqShort = v.l * (1 + 1/lev);
        const peso = (v.v || 1) / lev;   // los apalancamientos altos son menos usados por volumen
        const iL = indiceDe(liqLong), iS = indiceDe(liqShort);
        if(iL >= 0) franjas[iL].liquidaciones += peso;
        if(iS >= 0) franjas[iS].liquidaciones += peso;
      }
    }
  }

  // ── NORMALIZAR Y COMBINAR ──
  const maxDe = (k) => Math.max(...franjas.map(f => f[k]), 0) || 1;
  const mV = maxDe('volumen'), mT = maxDe('tiempo'), mTo = maxDe('toques'),
        mR = maxDe('rechazo'), mL = maxDe('libro'), mLiq = maxDe('liquidaciones');

  for(const f of franjas){
    // Los pesos: el volumen y los toques son la base; el libro y las liquidaciones,
    // cuando están, son evidencia más directa y pesan más.
    f.densidad = +(
      (f.volumen/mV) * 0.25 +
      (f.tiempo/mT) * 0.15 +
      (f.toques/mTo) * 0.25 +
      (f.rechazo/mR) * 0.15 +
      (f.libro/mL) * (mL > 1 ? 0.10 : 0) +
      (f.liquidaciones/mLiq) * 0.10
    ).toFixed(3);
    f.distPct = +((f.centro - precio) / precio * 100).toFixed(2);
  }

  // Los picos: las franjas que sobresalen sobre sus vecinas son los imanes de verdad
  const promedio = franjas.reduce((s,f)=>s+f.densidad, 0) / filas;
  const picos = franjas
    .filter((f,i) => f.densidad > promedio * 1.6 &&
      (i === 0 || f.densidad >= franjas[i-1].densidad) &&
      (i === filas-1 || f.densidad >= franjas[i+1].densidad))
    .sort((a,b) => b.densidad - a.densidad);

  const arriba = franjas.filter(f => f.distPct > 0.3);
  const abajo = franjas.filter(f => f.distPct < -0.3);
  const densArriba = arriba.reduce((s,f)=>s+f.densidad, 0);
  const densAbajo = abajo.reduce((s,f)=>s+f.densidad, 0);
  const totalDens = densArriba + densAbajo;

  const picoArriba = picos.find(f => f.distPct > 0.3) || null;
  const picoAbajo = picos.find(f => f.distPct < -0.3) || null;

  return {
    franjas, picos: picos.slice(0, 8), precio, min, max,
    picoArriba, picoAbajo,
    // Hacia dónde tira: el dato que se quiere ver de un vistazo
    sesgo: totalDens > 0 ? (densArriba > densAbajo * 1.15 ? 'arriba'
                          : densAbajo > densArriba * 1.15 ? 'abajo' : 'pareja') : 'pareja',
    dominancia: totalDens > 0 ? Math.round(Math.max(densArriba, densAbajo) / totalDens * 100) : 50,
    // La distancia al imán más cercano de cada lado, para saber si vale la pena operar
    distArriba: picoArriba?.distPct ?? null,
    distAbajo: picoAbajo?.distPct ?? null,
  };
}

// ═══ CALIDAD DE UN NIVEL DE LIQUIDEZ ═══
// Contar toques no alcanza. Un nivel tocado 4 veces puede ser un muro que se está cargando
// de órdenes, o uno que se está agotando y va a ceder. La diferencia está en el detalle de
// CADA toque, y todo eso sale de las velas que ya tenemos.
//
// Lo que se mide:
//   · VOLUMEN por toque — ¿creciente (se carga) o decreciente (se agota)?
//   · ANTIGÜEDAD — la liquidez de hace 6 horas sigue ahí; la de hace 2 semanas ya se consumió
//   · RECHAZO — una mecha larga en el nivel ES el rechazo; un cierre justo encima no lo es
//   · PERFORACIONES — un nivel que ya se rompió y se recuperó está debilitado
export function calidadNivel(candles, nivelPrecio, opciones = {}){
  if(!Array.isArray(candles) || candles.length < 20 || !nivelPrecio) return null;
  const tol = opciones.tolerancia ?? 0.003;   // 0.3%: qué tan cerca cuenta como toque
  const ahora = candles.at(-1).t || Date.now();

  const toques = [];
  let perforaciones = 0;
  let ultimoToqueIdx = -99;
  for(let i = 0; i < candles.length; i++){
    const v = candles[i];
    const dentroEnRango = v.l <= nivelPrecio * (1+tol) && v.h >= nivelPrecio * (1-tol);
    if(!dentroEnRango) continue;

    // ═══ UN TOQUE, NO UNA VELA ═══
    // Si el precio se queda dando vueltas cerca del nivel, cada vela contaría como un toque
    // distinto y el conteo se dispara (82 toques donde hay 5). Un toque es una VISITA: el
    // precio llega, reacciona y se va. Hasta que no se aleje, sigue siendo el mismo toque.
    if(i - ultimoToqueIdx < 3) continue;
    ultimoToqueIdx = i;

    // ¿El precio SE QUEDÓ del otro lado? Solo eso es una perforación real.
    // Que una vela cierre apenas del otro lado y vuelva enseguida no rompe el nivel:
    // hace falta que se sostenga unas velas para que cuente.
    // Una perforación es un CRUCE: el precio venía de un lado y quedó del otro.
    // Sin comparar el antes con el después, un nivel que actúa como resistencia (con el
    // precio siempre debajo) contaba una perforación en cada toque, porque "quedó abajo"
    // era trivialmente cierto.
    const previas = candles.slice(Math.max(0, i-3), i);
    const siguientes = candles.slice(i+1, i+4);
    const veniaDeAbajo = previas.length >= 2 && previas.every(x => x.c < nivelPrecio * (1-tol));
    const veniaDeArriba = previas.length >= 2 && previas.every(x => x.c > nivelPrecio * (1+tol));
    const quedoArriba = siguientes.length >= 2 && siguientes.every(x => x.c > nivelPrecio * (1+tol));
    const quedoAbajo = siguientes.length >= 2 && siguientes.every(x => x.c < nivelPrecio * (1-tol));
    const cerroArriba = veniaDeAbajo && quedoArriba;   // cruzó hacia arriba
    const cerroAbajo = veniaDeArriba && quedoAbajo;    // cruzó hacia abajo
    const rango = v.h - v.l;

    // El rechazo: cuánto de la vela fue mecha contra el nivel
    let rechazo = 0;
    if(rango > 0){
      const mechaArriba = v.h - Math.max(v.o, v.c);
      const mechaAbajo = Math.min(v.o, v.c) - v.l;
      // Si el nivel está arriba del cierre, el rechazo relevante es la mecha superior
      rechazo = nivelPrecio > v.c ? mechaArriba / rango : mechaAbajo / rango;
    }

    toques.push({
      idx: i, ts: v.t, vol: v.v || 0, rechazo: +rechazo.toFixed(2),
      perforo: cerroArriba || cerroAbajo,
      horasAtras: v.t ? (ahora - v.t) / 3600e3 : null,
    });
    if(cerroArriba || cerroAbajo) perforaciones++;
  }
  if(!toques.length) return null;

  // ── VOLUMEN: ¿se carga o se agota? ──
  const volProm = candles.reduce((s,v)=>s+(v.v||0), 0) / candles.length;
  const volEnToques = toques.reduce((s,t)=>s+t.vol, 0) / toques.length;
  let tendenciaVol = null;
  if(toques.length >= 3){
    const mitad = Math.floor(toques.length/2);
    const primeros = toques.slice(0, mitad).reduce((s,t)=>s+t.vol,0) / mitad;
    const ultimos = toques.slice(mitad).reduce((s,t)=>s+t.vol,0) / (toques.length-mitad);
    if(primeros > 0){
      const cambio = (ultimos - primeros) / primeros;
      tendenciaVol = cambio > 0.25 ? 'creciente' : cambio < -0.25 ? 'decreciente' : 'estable';
    }
  }

  // ── ANTIGÜEDAD: la liquidez vieja ya fue consumida ──
  const recientes = toques.filter(t => t.horasAtras != null && t.horasAtras <= 24).length;
  const ultimoToque = toques.at(-1);
  const frescura = ultimoToque?.horasAtras == null ? null
    : ultimoToque.horasAtras <= 6 ? 'muy fresco'
    : ultimoToque.horasAtras <= 24 ? 'reciente'
    : ultimoToque.horasAtras <= 72 ? 'algo viejo' : 'viejo';

  // ── RECHAZO: la mecha ES el rechazo ──
  const rechazoProm = toques.reduce((s,t)=>s+t.rechazo, 0) / toques.length;

  // ── LA PUNTUACIÓN ──
  let puntos = Math.min(4, toques.length);                                  // base: cuántos toques
  if(tendenciaVol === 'creciente') puntos += 2;                             // se está cargando
  else if(tendenciaVol === 'decreciente') puntos -= 1;                      // se está agotando
  if(volEnToques > volProm * 1.4) puntos += 1;                              // toques con volumen real
  if(rechazoProm >= 0.5) puntos += 2;                                       // rechazos claros
  else if(rechazoProm < 0.2) puntos -= 1;                                   // el precio pasa sin frenar
  if(frescura === 'muy fresco') puntos += 2;
  else if(frescura === 'reciente') puntos += 1;
  else if(frescura === 'viejo') puntos -= 2;
  puntos -= perforaciones * 1.5;                                            // cada perforación lo debilita

  const calidad = puntos >= 7 ? 'MURO' : puntos >= 4 ? 'sólido' : puntos >= 2 ? 'débil' : 'irrelevante';

  return {
    precio: nivelPrecio, toques: toques.length, perforaciones,
    volumenRelativo: +(volEnToques / (volProm || 1)).toFixed(2),
    tendenciaVolumen: tendenciaVol,
    rechazoPromedio: +rechazoProm.toFixed(2),
    frescura, toquesRecientes: recientes,
    puntos: +puntos.toFixed(1), calidad,
    // La explicación de por qué es fuerte o débil, que es lo que hace falta para operar
    porque: (() => {
      const p = [];
      if(tendenciaVol === 'creciente') p.push('el volumen en cada toque viene creciendo: se está acumulando interés en ese nivel');
      if(tendenciaVol === 'decreciente') p.push('el volumen en cada toque viene bajando: el nivel se está agotando y puede ceder');
      if(rechazoProm >= 0.5) p.push(`las velas rechazan con mechas largas (${(rechazoProm*100).toFixed(0)}% del rango): hay defensa real`);
      if(rechazoProm < 0.2 && toques.length >= 2) p.push('el precio pasa por ahí sin frenar: no hay defensa');
      if(perforaciones > 0) p.push(`ya fue perforado ${perforaciones} ${perforaciones===1?'vez':'veces'}, lo que lo debilita`);
      if(frescura === 'viejo') p.push('el último toque fue hace más de 3 días: esa liquidez probablemente ya se consumió');
      if(frescura === 'muy fresco') p.push('fue tocado en las últimas 6 horas: la liquidez sigue ahí');
      return p.length ? p.join('; ') + '.' : `${toques.length} toques sin nada destacable.`;
    })(),
  };
}

// ═══ LIQUIDEZ EN TODOS LOS HORIZONTES ═══
// Hasta ahora la liquidez se calculaba sobre UNA sola serie de velas. El problema: un nivel
// que aparece solo en 15m es ruido, y uno que aparece en 15m, 1h y 4h a la vez es un muro.
// Sin comparar entre timeframes no hay forma de distinguirlos.
//
// Y el horizonte útil NO es el mismo para todas las monedas:
//   · BTC y monedas grandes tienen memoria larga: un nivel de hace un mes todavía importa
//     porque hay mucho capital posicionado ahí y el precio lo respeta.
//   · Las monedas chicas y memecoins rotan tan rápido que un nivel de hace un mes ya no
//     existe: los que estaban ahí ya salieron. Mirar tan atrás mete ruido, no señal.
//
// Por eso el rango se elige según el tamaño, no de forma fija.
export function horizontesSegunTamano(marketCapUsd, vol24hUsd){
  const mc = marketCapUsd || 0;
  // La rotación también cuenta: una moneda chica con volumen enorme rota aún más rápido
  const rotacion = (mc > 0 && vol24hUsd > 0) ? vol24hUsd / mc : 0;

  if(mc >= 10e9 || rotacion < 0.02){
    return { categoria:'grande', tfs:['15m','1h','4h','1d','1mo'],
      nota:'Moneda grande: los niveles viejos siguen valiendo porque hay mucho capital posicionado. Se mira hasta un mes atrás.' };
  }
  if(mc >= 500e6){
    return { categoria:'mediana', tfs:['15m','1h','4h','1d'],
      nota:'Moneda mediana: se mira hasta un día. Un mes atrás ya es demasiado lejos para que el nivel siga defendido.' };
  }
  if(rotacion >= 1){
    return { categoria:'rotación alta', tfs:['15m','1h','4h'],
      nota:`Esta moneda rota ${rotacion.toFixed(1)} veces su market cap por día: los niveles de hace más de unas horas ya no tienen a nadie defendiéndolos. Mirar más atrás es ruido.` };
  }
  return { categoria:'chica', tfs:['15m','1h','4h','1d'],
    nota:'Moneda chica: se mira hasta un día. Los niveles de un mes atrás ya no aplican porque quienes estaban posicionados ahí ya salieron.' };
}

// Combina la liquidez de varios timeframes y detecta CONFLUENCIA: los niveles que aparecen
// en más de uno son los que de verdad importan.
export function liquidezMultiHorizonte(seriesPorTf, precio, opciones = {}){
  const tfs = Object.keys(seriesPorTf || {}).filter(k => Array.isArray(seriesPorTf[k]) && seriesPorTf[k].length >= 30);
  if(!tfs.length || !precio) return null;

  // Cada timeframe pesa distinto: lo que aparece en 4h vale más que lo que aparece en 15m,
  // porque hace falta más tiempo y volumen para formar un nivel en un marco mayor.
  const peso = { '15m':1, '1h':1.6, '4h':2.4, '1d':3.2, '1mo':4 };
  const tolerancia = opciones.tolerancia ?? 0.004;   // 0.4%: dos niveles más cerca que esto son el mismo

  const todos = [];
  for(const tf of tfs){
    let liq;
    try{ liq = detectLiquidezPorHorizonte(seriesPorTf[tf]); }catch(e){ continue; }
    if(!liq) continue;
    for(const [clave, lado] of [['cercanaArriba','arriba'],['lejanaArriba','arriba'],
                                 ['cercanaAbajo','abajo'],['lejanaAbajo','abajo']]){
      const n = liq[clave];
      if(!n?.precio) continue;
      todos.push({ tf, lado, precio:n.precio, toques:n.toques||1, peso: peso[tf] || 1 });
    }
  }
  if(!todos.length) return null;

  // Agrupar niveles cercanos entre sí: son el mismo nivel visto en distintos marcos
  const grupos = [];
  for(const n of todos.sort((a,b)=>a.precio-b.precio)){
    const g = grupos.find(x => Math.abs(x.precio - n.precio) / n.precio < tolerancia && x.lado === n.lado);
    if(g){
      g.tfs.push(n.tf);
      g.toques += n.toques;
      g.pesoTotal += n.peso;
      g.precio = (g.precio * (g.tfs.length-1) + n.precio) / g.tfs.length;   // promedio
    } else {
      grupos.push({ precio:n.precio, lado:n.lado, tfs:[n.tf], toques:n.toques, pesoTotal:n.peso });
    }
  }

  // La calidad de cada nivel se evalúa contra las velas del marco más fino disponible:
  // volumen por toque, rechazo, frescura y perforaciones. Sin esto, un nivel tocado 4 veces
  // hace dos semanas pesaba igual que uno tocado 4 veces hoy con volumen creciente.
  const serieFina = seriesPorTf['15m'] || seriesPorTf['1h'] || seriesPorTf[tfs[0]];
  const conDist = grupos.map(g => {
    const q = (()=>{ try{ return calidadNivel(serieFina, g.precio); }catch(e){ return null; } })();
    // La calidad multiplica la fuerza: un muro vale el doble, uno irrelevante casi nada
    const mult = !q ? 1 : q.calidad === 'MURO' ? 2 : q.calidad === 'sólido' ? 1.4
               : q.calidad === 'débil' ? 0.7 : 0.3;
    return {
      ...g,
      tfs: [...new Set(g.tfs)],
      distPct: +((g.precio - precio) / precio * 100).toFixed(2),
      calidad: q?.calidad || null,
      porque: q?.porque || null,
      tendenciaVolumen: q?.tendenciaVolumen || null,
      frescura: q?.frescura || null,
      perforaciones: q?.perforaciones ?? null,
      fuerza: +(g.pesoTotal * Math.min(3, Math.sqrt(g.toques)) * mult).toFixed(1),
    };
  }).sort((a,b) => b.fuerza - a.fuerza);

  const arriba = conDist.filter(x => x.distPct > 0);
  const abajo = conDist.filter(x => x.distPct < 0);
  const fuerzaArriba = arriba.reduce((s,x)=>s+x.fuerza, 0);
  const fuerzaAbajo = abajo.reduce((s,x)=>s+x.fuerza, 0);
  const total = fuerzaArriba + fuerzaAbajo;

  // Confluencia: los que aparecen en 3 o más marcos son los niveles serios
  const confluentes = conDist.filter(x => x.tfs.length >= 3);
  const enDos = conDist.filter(x => x.tfs.length === 2);

  return {
    niveles: conDist.slice(0, 12),
    confluentes, enDos,
    masFuerteArriba: arriba[0] || null,
    masFuerteAbajo: abajo[0] || null,
    ladoFuerte: total > 0 ? (fuerzaArriba > fuerzaAbajo * 1.2 ? 'arriba'
                            : fuerzaAbajo > fuerzaArriba * 1.2 ? 'abajo' : 'pareja') : 'pareja',
    dominanciaPct: total > 0 ? Math.round(Math.max(fuerzaArriba, fuerzaAbajo) / total * 100) : 50,
    timeframes: tfs,
    resumen: (() => {
      const partes = [];
      if(confluentes.length){
        const c0 = confluentes[0];
        partes.push(`El nivel más importante está en $${fmtPrecio(c0.precio)} (${c0.distPct > 0 ? '+' : ''}${c0.distPct}%): aparece en ${c0.tfs.join(', ')}${c0.calidad ? ` y es un nivel ${c0.calidad}` : ''}.` +
          (c0.porque ? ` ${c0.porque.charAt(0).toUpperCase()}${c0.porque.slice(1)}` : ''));
      } else if(enDos.length){
        const c0 = enDos[0];
        partes.push(`El nivel más marcado está en $${fmtPrecio(c0.precio)} (${c0.distPct > 0 ? '+' : ''}${c0.distPct}%), visible en ${c0.tfs.join(' y ')}.`);
      } else {
        partes.push('Ningún nivel coincide entre timeframes: los que hay son de un solo marco y suelen ser menos confiables.');
      }
      const lado = fuerzaArriba > fuerzaAbajo * 1.2 ? 'arriba' : fuerzaAbajo > fuerzaArriba * 1.2 ? 'abajo' : null;
      if(lado) partes.push(`En conjunto la liquidez pesa más ${lado}: es hacia donde tiende a moverse el precio.`);
      return partes.join(' ');
    })(),
  };
}

// ═══ DETALLES QUE PASAN DESAPERCIBIDOS ═══
// Cosas chicas que cambian la lectura y que normalmente nadie mira, porque no son un indicador
// con nombre propio — son relaciones entre números que ya tenemos.
export function detallesQueImportan({ candles, price, marketCap, vol24hUsd, atrPct, dirTesis }){
  const hallazgos = [];
  if(!Array.isArray(candles) || candles.length < 30) return hallazgos;

  // ── 1. VOLUMEN CONTRA EL TAMAÑO DE LA MONEDA ──
  // Este es el que pedías: market cap $36M con volumen $76M significa que la moneda entera
  // cambió de manos DOS VECES en un día. Eso no pasa por casualidad.
  if(marketCap > 0 && vol24hUsd > 0){
    const rotacion = vol24hUsd / marketCap;
    if(rotacion >= 2){
      hallazgos.push({
        tipo: 'rotacion', peso: 'alto',
        texto: `El volumen de 24h ($${(vol24hUsd/1e6).toFixed(1)}M) es ${rotacion.toFixed(1)} veces el market cap ($${(marketCap/1e6).toFixed(1)}M): la moneda entera cambió de manos ${rotacion.toFixed(1)} veces en un día. Eso es rotación extrema — hay algo pasando, y los movimientos van a ser violentos en las dos direcciones.`,
      });
    } else if(rotacion >= 0.8){
      hallazgos.push({
        tipo: 'rotacion', peso: 'medio',
        texto: `El volumen de 24h ($${(vol24hUsd/1e6).toFixed(1)}M) casi iguala al market cap ($${(marketCap/1e6).toFixed(1)}M). Hay mucho interés para el tamaño de esta moneda: los movimientos pueden ser más rápidos de lo habitual.`,
      });
    } else if(rotacion < 0.02 && marketCap > 1e6){
      hallazgos.push({
        tipo: 'rotacion', peso: 'medio',
        texto: `El volumen es apenas el ${(rotacion*100).toFixed(1)}% del market cap: la moneda está prácticamente dormida. Con tan poca actividad, entrar y salir puede costar más que el movimiento que se busca.`,
      });
    }
  }

  // ── 2. EL VOLUMEN NO ACOMPAÑA AL PRECIO ──
  // Si el precio sube pero cada vez con menos volumen, el movimiento se está quedando sin nafta.
  const ult = candles.slice(-10);
  if(ult.length === 10){
    const precioSubio = ult.at(-1).c > ult[0].c;
    const volPrimera = ult.slice(0,5).reduce((s,v)=>s+v.v,0);
    const volSegunda = ult.slice(5).reduce((s,v)=>s+v.v,0);
    if(volPrimera > 0){
      const cambioVol = (volSegunda - volPrimera) / volPrimera;
      const cambioPrecio = (ult.at(-1).c - ult[0].c) / ult[0].c;
      if(Math.abs(cambioPrecio) > 0.015 && cambioVol < -0.3){
        hallazgos.push({
          tipo: 'divergencia-volumen', peso: 'alto',
          texto: `El precio ${precioSubio?'subió':'bajó'} un ${Math.abs(cambioPrecio*100).toFixed(1)}% pero el volumen cayó un ${Math.abs(cambioVol*100).toFixed(0)}% en las últimas velas: el movimiento se está quedando sin combustible. Suele preceder un freno o una vuelta.`,
        });
      }
    }
  }

  // ── 3. NÚMEROS REDONDOS ──
  // La gente pone órdenes en precios redondos. Estar justo debajo de uno cambia las chances.
  if(price > 0){
    const magnitud = Math.pow(10, Math.floor(Math.log10(price)));
    const redondoArriba = Math.ceil(price / (magnitud/2)) * (magnitud/2);
    const redondoAbajo = Math.floor(price / (magnitud/2)) * (magnitud/2);
    const distArriba = (redondoArriba - price) / price * 100;
    const distAbajo = (price - redondoAbajo) / price * 100;
    if(distArriba < 1.5 && distArriba > 0){
      hallazgos.push({
        tipo: 'psicologico', peso: 'medio',
        texto: `El precio está a ${distArriba.toFixed(2)}% de $${fmtPrecio(redondoArriba)}, que es un número redondo. Ahí suele haber órdenes de venta acumuladas: es normal que frene antes de pasarlo.`,
      });
    } else if(distAbajo < 1.5 && distAbajo > 0){
      hallazgos.push({
        tipo: 'psicologico', peso: 'medio',
        texto: `El precio está a ${distAbajo.toFixed(2)}% de $${fmtPrecio(redondoAbajo)}, un número redondo. Suele funcionar como soporte porque ahí se acumulan órdenes de compra.`,
      });
    }
  }

  // ── 4. ¿YA SE MOVIÓ TODO LO QUE SUELE MOVERSE HOY? ──
  // Si el rango del día ya superó el ATR, queda poco recorrido esperable.
  if(atrPct > 0 && candles.length >= 24){
    const dia = candles.slice(-24);
    const max = Math.max(...dia.map(v=>v.h)), min = Math.min(...dia.map(v=>v.l));
    const rangoHoy = (max - min) / min * 100;
    const proporcion = rangoHoy / atrPct;
    if(proporcion >= 1.8){
      hallazgos.push({
        tipo: 'rango-agotado', peso: 'alto',
        texto: `El rango de las últimas horas (${rangoHoy.toFixed(1)}%) ya es ${proporcion.toFixed(1)} veces la volatilidad típica de esta moneda. Estadísticamente queda poco recorrido: entrar acá es apostar a que el movimiento siga siendo excepcional.`,
      });
    }
  }

  // ── 5. LA ÚLTIMA VELA CONTRA EL PROMEDIO ──
  // Una vela con volumen enorme y cuerpo chico es absorción: alguien está aguantando.
  const ultima = candles.at(-1);
  const volProm = candles.slice(-21, -1).reduce((s,v)=>s+v.v, 0) / 20;
  if(volProm > 0 && ultima.v > volProm * 2.5){
    const cuerpo = Math.abs(ultima.c - ultima.o);
    const rango = ultima.h - ultima.l;
    if(rango > 0 && cuerpo / rango < 0.3){
      hallazgos.push({
        tipo: 'absorcion', peso: 'alto',
        texto: `La última vela tuvo ${(ultima.v/volProm).toFixed(1)}x el volumen normal pero casi no movió el precio (cuerpo del ${(cuerpo/rango*100).toFixed(0)}% del rango). Eso es absorción: alguien está tomando todo lo que se ofrece sin dejar que el precio se mueva. Suele preceder un movimiento fuerte hacia el lado del que absorbe.`,
      });
    }
  }

  return hallazgos;
}

// ═══ SÍNTESIS: LA TESIS COMPLETA, CRUZADA ═══
// EL PROBLEMA QUE RESUELVE: hasta ahora cada capa hablaba por su cuenta. La estructura decía
// una cosa, el libro otra, las wallets otra — y quien leía tenía que hacer la síntesis en la
// cabeza. Peor: `explicarAnalisis` ni siquiera VE el libro, el flujo, las wallets o el
// apalancamiento, así que la explicación se armaba ignorando la mitad de la evidencia.
//
// Esto lo cruza: no lista capas, las relaciona. En vez de
//     "estructura alcista" + "hay una pared vendedora a 0.5%"
// dice
//     "la estructura favorece LONG, pero hay una pared vendedora a +0.5% que puede frenar
//      el avance antes de TP1"
//
// La diferencia es que la segunda te dice QUÉ HACER con las dos cosas juntas.
export function sintetizarTesis({
  result, setup, liquidez, libro, flujo, wallets, onchain,
  apalancamiento, compresion, cinta, matrizGrandes, fase, calendario, dirTesis,
  // Detalles chicos que cambian la lectura: rotación del volumen, números redondos,
  // absorción, rango agotado. No son indicadores con nombre propio, son relaciones
  // entre números que ya tenemos — y justamente por eso pasan desapercibidos.
  detalles,
}){
  const dir = dirTesis || (result?.recommendation !== 'NO OPERAR' ? result?.recommendation : null);
  const esLong = dir === 'LONG';
  const fmtP = v => v == null ? '—' : fmtPrecio(v);

  // ── LO QUE SOSTIENE LA TESIS ──
  const aFavor = [], enContra = [], avisos = [];

  const empuja = (nombre, condicion, texto, lado) => {
    if(!condicion) return;
    (lado === 'contra' ? enContra : lado === 'aviso' ? avisos : aFavor).push({ nombre, texto });
  };

  // Componentes del score
  for(const comp of (result?.componentes || [])){
    if(Math.abs(comp.aporte) < 0.2) continue;
    const aFavorDeLaTesis = dir ? ((comp.aporte > 0) === esLong) : comp.aporte > 0;
    empuja(comp.n, true, `${comp.n} ${aFavorDeLaTesis ? 'empuja' : 'va en contra'} (${comp.aporte >= 0 ? '+' : ''}${comp.aporte.toFixed(2)})`,
      aFavorDeLaTesis ? 'favor' : 'contra');
  }

  // Cinta de medias
  if(cinta?.limpia){
    empuja('Tendencia', true,
      `la cinta de medias está ${cinta.direccion === 'LONG' ? 'subiendo' : 'bajando'} con fuerza`,
      (dir && cinta.direccion === dir) ? 'favor' : 'contra');
  } else if(cinta){
    empuja('Tendencia', true, 'la cinta está plana: no hay tendencia definida', 'aviso');
  }

  // ── EL CRUCE QUE IMPORTA: ESTRUCTURA vs OBSTÁCULOS ──
  // Acá es donde las capas dejan de hablar solas
  const cruces = [];

  // Pared del libro contra el primer objetivo
  if(libro?.niveles?.length && setup?.t1 && result?.metrics?.price){
    const precio = result.metrics.price;
    const enElCamino = libro.niveles.filter(n => {
      if(n.lado === (esLong ? 'venta' : 'compra')) {
        const entre = esLong ? (n.precio > precio && n.precio < setup.t1)
                             : (n.precio < precio && n.precio > setup.t1);
        return entre && n.usd >= 50000;
      }
      return false;
    }).sort((a,b) => b.usd - a.usd);
    if(enElCamino.length){
      const p = enElCamino[0];
      cruces.push({
        tipo: 'obstaculo', modulo: 'libro',
        texto: `Hay una pared ${p.lado === 'venta' ? 'vendedora' : 'compradora'} de $${(p.usd/1000).toFixed(0)}K en $${fmtP(p.precio)}, justo entre el precio actual y TP1. El movimiento tiene que consumirla antes de llegar al objetivo.`,
        nivel: p.precio,
      });
    }
  }

  // Liquidez del lado contrario a la tesis
  if(liquidez?.ladoFuerte && liquidez.ladoFuerte !== 'pareja' && dir){
    const liqEnContra = (esLong && liquidez.ladoFuerte === 'abajo') || (!esLong && liquidez.ladoFuerte === 'arriba');
    if(liqEnContra){
      cruces.push({
        tipo: 'barrido', modulo: 'liquidez',
        texto: `El imán de liquidez más fuerte está ${liquidez.ladoFuerte}, o sea del lado contrario a esta operación. Lo habitual es que el precio vaya primero a buscarlo y recién después gire a favor: ese retroceso puede ser normal y no significa que la tesis falló.`,
      });
    }
  }

  // Apalancamiento excesivo cambia el riesgo de todo lo demás
  if(apalancamiento?.oiSobreMcap >= 30){
    cruces.push({
      tipo: 'riesgo', modulo: 'apalancamiento',
      texto: `El interés abierto es el ${apalancamiento.oiSobreMcap}% del market cap. Con tanto apalancamiento, cualquier movimiento fuerte puede desatar liquidaciones en cadena y llevarse los stops por delante — conviene entrar con menos tamaño del habitual.`,
    });
  }

  // Los grandes contra la multitud
  if(apalancamiento?.divergencia && dir){
    const grandesConmigo = apalancamiento.divergencia === dir;
    cruces.push({
      tipo: grandesConmigo ? 'apoyo' : 'contradiccion', modulo: 'apalancamiento',
      texto: grandesConmigo
        ? `Las posiciones grandes están del mismo lado que esta operación mientras la mayoría está al revés. Cuando se separan así, suele tener razón el lado grande.`
        : `Las posiciones grandes están en ${apalancamiento.divergencia}, o sea del lado contrario a esta operación. Vale la pena revisar la tesis antes de entrar.`,
    });
  }

  // Compresión: cambia el significado de todo lo demás
  if(compresion?.compresionPct >= 40){
    cruces.push({
      tipo: 'compresion', modulo: 'grafico',
      texto: `El rango se comprimió un ${compresion.compresionPct.toFixed(0)}%. Mientras el precio siga adentro, las señales de dirección valen poco: lo que importa es por qué lado rompe. Operar adentro de la compresión es lo que más falsas señales genera.`,
    });
  }

  // Wallets confirmando o contradiciendo
  if(wallets?.direccion && wallets.direccion !== 'NEUTRO' && dir){
    const acompanan = wallets.direccion === dir;
    cruces.push({
      tipo: acompanan ? 'apoyo' : 'contradiccion', modulo: 'wallets',
      texto: acompanan
        ? `Los flujos on-chain acompañan: ${wallets.direccion === 'LONG' ? 'salen más tokens de exchanges de los que entran' : 'entran más tokens a exchanges de los que salen'}.`
        : `Los flujos on-chain van en contra: ${wallets.direccion === 'LONG' ? 'están retirando tokens de exchanges' : 'están depositando tokens en exchanges'}, lo opuesto a lo que esperaría esta operación.`,
    });
  }

  // Los detalles chicos: se suman a los cruces según su peso, no como lista aparte
  for(const d of (detalles || [])){
    if(d.peso === 'alto'){
      cruces.push({
        tipo: d.tipo === 'absorcion' ? 'apoyo' : 'riesgo',
        modulo: d.tipo === 'rotacion' ? 'detalle' : 'grafico',
        texto: d.texto,
      });
    } else {
      avisos.push({ nombre: d.tipo, texto: d.texto });
    }
  }

  // Evento macro inminente
  if(calendario?.inminente && calendario.inminente.horas < 24){
    cruces.push({
      tipo: 'evento', modulo: 'calendario',
      texto: `${calendario.inminente.nombre} sale en ${calendario.inminente.horas < 1 ? 'menos de una hora' : `${calendario.inminente.horas.toFixed(0)} horas`}. Los datos macro mueven el precio más que cualquier señal técnica: conviene esperar o reducir el tamaño.`,
    });
  }

  // ── QUÉ CONFIRMARÍA Y QUÉ INVALIDARÍA ──
  const confirmarian = [];
  if(compresion?.techo && compresion?.piso){
    confirmarian.push(`que rompa $${fmtP(esLong ? compresion.techo : compresion.piso)} con volumen`);
  }
  if(libro?.niveles?.length){
    const pared = cruces.find(x => x.tipo === 'obstaculo');
    if(pared) confirmarian.push(`que consuma la pared de $${fmtP(pared.nivel)}`);
  }
  if(flujo && flujo.sesgo !== (esLong ? 'COMPRADOR' : 'VENDEDOR')){
    confirmarian.push(`que el flujo agresivo se dé vuelta hacia ${esLong ? 'compras' : 'ventas'}`);
  }
  if(!confirmarian.length && setup?.t1) confirmarian.push(`que sostenga por ${esLong ? 'encima' : 'debajo'} de $${fmtP(result?.metrics?.price)} y avance hacia $${fmtP(setup.t1)}`);

  const invalidan = [];
  if(setup?.stop) invalidan.push(`que toque $${fmtP(setup.stop)}`);
  if(cinta?.limpia && dir && cinta.direccion !== dir) invalidan.push(`la cinta ya apunta al lado contrario`);
  if(liquidez?.confluencia) invalidan.push(`que pierda el nivel de $${fmtP(liquidez.confluencia.precio)}, que coincide en 15m y 4h`);

  // ── LA NARRATIVA ──
  const parrafos = [];

  // 1) Qué está pasando
  if(!dir){
    parrafos.push(`No hay una ventaja clara: ${aFavor.length} señales apuntan a un lado y ${enContra.length} al otro. Cuando las señales están divididas, lo que más suele costar plata es forzar una entrada.`);
  } else {
    const cuantas = aFavor.length;
    parrafos.push(`La lectura es ${dir}${result?.confidence ? ` con ${result.confidence}% de confianza` : ''}: ${cuantas} señal${cuantas===1?'':'es'} lo respalda${cuantas===1?'':'n'}${fase ? `, en una fase de mercado de ${fase}` : ''}.`);
  }

  // 2) Por qué — las que más pesan
  if(aFavor.length){
    parrafos.push(`Lo que más empuja: ${aFavor.slice(0,3).map(x=>x.texto).join('; ')}.`);
  }

  // 3) Lo que lo pone en riesgo — LOS CRUCES, que es lo nuevo
  const obstaculos = cruces.filter(x => ['obstaculo','barrido','riesgo','contradiccion','compresion','evento'].includes(x.tipo));
  if(obstaculos.length){
    parrafos.push(`⚠️ ${obstaculos.map(x=>x.texto).join(' ')}`);
  }
  const apoyos = cruces.filter(x => x.tipo === 'apoyo');
  if(apoyos.length) parrafos.push(`✅ ${apoyos.map(x=>x.texto).join(' ')}`);

  // Los detalles de peso medio: se mencionan al final, sin ocupar el lugar de lo importante
  if(avisos.length){
    parrafos.push(`ℹ️ ${avisos.slice(0,2).map(x=>x.texto).join(' ')}`);
  }

  // 4) Qué confirmaría y qué invalidaría
  if(confirmarian.length) parrafos.push(`📈 Confirmaría la tesis: ${confirmarian.join(', o ')}.`);
  if(invalidan.length) parrafos.push(`❌ La invalidaría: ${invalidan.join('; ')}.`);

  return {
    direccion: dir,
    aFavor, enContra, avisos, cruces,
    confirmarian, invalidan,
    // El número de obstáculos importa: con 3 o más, la tesis está muy condicionada
    obstaculos: obstaculos.length,
    veredicto: !dir ? 'ESPERAR'
      : obstaculos.length >= 3 ? 'TESIS CONDICIONADA'
      : obstaculos.length >= 1 ? 'CON RESERVAS'
      : 'CAMINO DESPEJADO',
    texto: parrafos.join('\n\n'),
  };
}

// ═══ LOS CUATRO PASOS DE UN ANALISTA ═══
// El orden importa: no se mira el RSI antes de saber en qué contexto está el mercado. Cada
// paso condiciona al siguiente, y si uno falla los de abajo pierden valor.
//   PASO 1 — ¿En qué contexto estamos?      → favorable / adverso / mixto
//   PASO 2 — ¿Qué está haciendo la moneda?  → sesgo estructural (más peso que el RSI)
//   PASO 3 — ¿Hay fuerza real?              → ¿el movimiento tiene combustible?
//   PASO 4 — ¿El precio está en buen lugar?  → se puede tener SHORT 8/10 y estar sobre soporte
//
// La distinción clave: SESGO no es lo mismo que ENTRADA, y DIRECCIÓN no es lo mismo que FUERZA.
// Un short con sesgo correcto pero sin fuerza y en mal lugar es una entrada perdedora.
export function analizarPorPasos({ result, candles, macro, btcRef, marketContext,
                                    liquidez, libro, flujo, derivados, estructura, atrPct }){
  const pasos = {};

  // ── PASO 1: CONTEXTO ──
  const señalesContexto = [];
  if(macro?.trend) señalesContexto.push({ n:'Macro 4h', v: macro.trend === 'BULLISH' ? 1 : macro.trend === 'BEARISH' ? -1 : 0 });
  if(btcRef?.pctChange != null) señalesContexto.push({ n:'BTC', v: btcRef.pctChange > 2 ? 1 : btcRef.pctChange < -2 ? -1 : 0 });
  if(marketContext?.fearGreed != null) señalesContexto.push({ n:'Fear & Greed', v: marketContext.fearGreed > 60 ? 1 : marketContext.fearGreed < 30 ? -1 : 0 });
  if(marketContext?.capitalFlow?.tvlTrend) señalesContexto.push({ n:'Capital', v: marketContext.capitalFlow.tvlTrend === 'RISING' ? 1 : marketContext.capitalFlow.tvlTrend === 'FALLING' ? -1 : 0 });
  const sumaCtx = señalesContexto.reduce((s,x)=>s+x.v, 0);
  pasos.contexto = {
    estado: sumaCtx >= 2 ? 'FAVORABLE AL RIESGO' : sumaCtx <= -2 ? 'ADVERSO' : 'MIXTO',
    señales: señalesContexto,
    texto: sumaCtx >= 2 ? 'El contexto general acompaña a los activos de riesgo.'
         : sumaCtx <= -2 ? 'El contexto general es adverso: conviene ser más selectivo y usar menos tamaño.'
         : 'El contexto está mixto: no ayuda ni estorba, la decisión se juega en la moneda.',
  };

  // ── PASO 2: SESGO ESTRUCTURAL ──
  // Pesa más que cualquier oscilador: es lo que hace el precio, no lo que dice un indicador.
  const ts = String(estructura?.events?.trendStructure || '').toLowerCase();
  const sesgo = (ts === 'bull' || /hh|hl/.test(ts)) ? 'LONG'
              : (ts === 'bear' || /lh|ll/.test(ts)) ? 'SHORT' : null;
  pasos.sesgo = {
    direccion: sesgo,
    texto: sesgo === 'LONG' ? 'La estructura hace máximos y mínimos crecientes: el sesgo es alcista.'
         : sesgo === 'SHORT' ? 'La estructura hace máximos y mínimos decrecientes: el sesgo es bajista.'
         : 'La estructura está en rango: no hay un sesgo direccional claro, conviene operar los bordes.',
    hayBOS: !!estructura?.events?.bos,
    hayCHoCH: !!estructura?.events?.choch,
  };

  // ── PASO 3: ¿HAY FUERZA? ──
  // Dirección y fuerza son cosas distintas. Un short con sesgo correcto pero sin fuerza
  // se queda a mitad de camino y termina en breakeven.
  const combustible = [];
  const m = result?.metrics || {};
  if(m.adx != null) combustible.push({ n:'ADX', ok: m.adx >= 25, detalle: `ADX ${m.adx.toFixed(0)}${m.adx>=25?' (tendencia real)':' (sin tendencia)'}` });
  if(flujo?.pctComprador != null && sesgo){
    const aFavor = (flujo.sesgo === 'COMPRADOR') === (sesgo === 'LONG');
    combustible.push({ n:'Flujo agresivo', ok: aFavor, detalle: `${flujo.pctComprador}% comprador${aFavor?', acompaña':', va en contra'}` });
  }
  if(derivados?.oiTrend && sesgo){
    const oiSube = /RISING|SUBIENDO/i.test(derivados.oiTrend);
    combustible.push({ n:'Open Interest', ok: oiSube, detalle: oiSube ? 'entra dinero nuevo al movimiento' : 'no entra dinero nuevo' });
  }
  if(candles?.length >= 20){
    const volProm = candles.slice(-21,-1).reduce((s,v)=>s+v.v,0)/20;
    const volAhora = candles.at(-1).v;
    combustible.push({ n:'Volumen', ok: volAhora > volProm, detalle: volAhora > volProm ? `${(volAhora/volProm).toFixed(1)}x el volumen normal` : 'volumen por debajo del promedio' });
  }
  const conFuerza = combustible.filter(x=>x.ok).length;
  const total = combustible.length || 1;
  pasos.fuerza = {
    tiene: conFuerza / total >= 0.6,
    proporcion: `${conFuerza}/${total}`,
    componentes: combustible,
    texto: conFuerza / total >= 0.6
      ? `El movimiento tiene combustible: ${combustible.filter(x=>x.ok).map(x=>x.detalle).join(', ')}.`
      : `El movimiento no tiene fuerza suficiente (${conFuerza} de ${total}): ${combustible.filter(x=>!x.ok).map(x=>x.detalle).join(', ')}. Un movimiento sin combustible se queda a mitad de camino.`,
  };

  // ── PASO 4: ¿EL PRECIO ESTÁ EN BUEN LUGAR? ──
  // Se puede tener SHORT 8/10 y estar entrando justo encima de un soporte enorme.
  const precio = m.price;
  const problemas = [];
  if(precio && liquidez && sesgo){
    const contra = sesgo === 'SHORT' ? (liquidez.cercanaAbajo || liquidez.lejanaAbajo)
                                     : (liquidez.cercanaArriba || liquidez.lejanaArriba);
    if(contra?.precio){
      const dist = Math.abs(contra.precio - precio) / precio * 100;
      if(dist < 2) problemas.push(`hay un nivel fuerte a ${dist.toFixed(1)}% en el camino (${contra.toques||0} toques)`);
    }
  }
  if(libro?.niveles?.length && precio && sesgo){
    const barrera = libro.niveles.find(n => {
      const enCamino = sesgo === 'SHORT' ? n.precio < precio : n.precio > precio;
      const cerca = Math.abs(n.precio - precio) / precio * 100 < 2;
      return enCamino && cerca && n.usd > 100000 && n.lado === (sesgo === 'SHORT' ? 'compra' : 'venta');
    });
    if(barrera) problemas.push(`hay $${(barrera.usd/1000).toFixed(0)}K de órdenes en contra a menos de 2%`);
  }
  if(atrPct > 0 && candles?.length >= 24){
    const dia = candles.slice(-24);
    const rango = (Math.max(...dia.map(v=>v.h)) - Math.min(...dia.map(v=>v.l))) / Math.min(...dia.map(v=>v.l)) * 100;
    if(rango / atrPct >= 1.8) problemas.push(`el rango del día ya es ${(rango/atrPct).toFixed(1)}x lo habitual: queda poco recorrido`);
  }
  pasos.ubicacion = {
    buena: problemas.length === 0,
    problemas,
    texto: problemas.length === 0
      ? 'El precio está en una zona sin obstáculos cercanos: hay espacio para que el movimiento se desarrolle.'
      : `El precio NO está en buen lugar para entrar: ${problemas.join('; ')}. Se puede tener razón en la dirección y perder igual por entrar en el lugar equivocado.`,
  };

  return pasos;
}

// ═══ LA MEMORIA APLICADA A LA DECISIÓN ═══
// EL HUECO QUE CIERRA: el Research Center descubre cosas como "cuando el ADX está por debajo
// de 20, el win rate cae 23 puntos". Ese hallazgo se muestra en un panel... y ahí queda.
// La decisión nunca lo consulta. El sistema aprende y no usa lo aprendido.
//
// Esto lo conecta: antes de decidir, se revisa si la situación actual coincide con algún
// patrón que YA demostró rendir peor. Con la muestra suficiente, eso baja el tamaño o
// directamente frena la entrada.
//
// El requisito es estricto a propósito: solo se aplica un hallazgo con al menos 15
// operaciones y una diferencia de 12 puntos o más. Con menos que eso es ruido, y actuar
// sobre ruido es peor que no actuar.
export function consultarMemoria(reporte, situacionActual){
  if(!reporte?.hallazgos?.length || !situacionActual) return null;

  const coincidencias = [];
  for(const h of reporte.hallazgos){
    if(h.operaciones < 15) continue;              // muestra insuficiente
    if(Math.abs(h.diferencia) < 12) continue;     // diferencia dentro del ruido
    if(h.confianza !== 'alta') continue;

    // ¿La situación de ahora coincide con la del hallazgo?
    const valorAhora = situacionActual[h.tipo];
    if(valorAhora == null) continue;
    if(String(valorAhora) !== String(h.valor)) continue;

    coincidencias.push({
      patron: h.tipo, valor: h.valor,
      winRate: h.winRate, diferencia: h.diferencia,
      operaciones: h.operaciones,
      esMalo: h.diferencia < 0,
      texto: h.diferencia < 0
        ? `Con ${h.tipo.toLowerCase()} en "${h.valor}" el win rate histórico es ${h.winRate}% (${h.diferencia} puntos bajo el promedio, sobre ${h.operaciones} operaciones).`
        : `Con ${h.tipo.toLowerCase()} en "${h.valor}" el win rate histórico es ${h.winRate}% (+${h.diferencia} puntos, sobre ${h.operaciones} operaciones).`,
    });
  }
  if(!coincidencias.length) return null;

  const malos = coincidencias.filter(x => x.esMalo);
  const buenos = coincidencias.filter(x => !x.esMalo);
  // El ajuste de tamaño sale de la suma de diferencias, acotado para que un solo
  // hallazgo no pueda anular la operación entera
  const impacto = coincidencias.reduce((s,x) => s + x.diferencia, 0);
  const factor = Math.max(0.4, Math.min(1.3, 1 + impacto / 100));

  return {
    coincidencias, malos, buenos, impacto: +impacto.toFixed(1),
    factorTamano: +factor.toFixed(2),
    // Si hay dos o más patrones malos con muestra grande, la entrada es cuestionable
    frena: malos.length >= 2 || malos.some(x => x.diferencia <= -20 && x.operaciones >= 25),
    resumen: malos.length
      ? `⚠️ Esta situación coincide con ${malos.length === 1 ? 'un patrón que históricamente rinde' : `${malos.length} patrones que históricamente rinden`} peor: ${malos.map(x=>x.texto).join(' ')}`
      : `✅ Esta situación coincide con ${buenos.length === 1 ? 'un patrón que históricamente rinde' : `${buenos.length} patrones que históricamente rinden`} mejor: ${buenos.map(x=>x.texto).join(' ')}`,
  };
}

// ═══ LA DECISIÓN — QUÉ HACER CON TODA ESA INFORMACIÓN ═══
// El paso que faltaba. Hasta acá el sistema describía: "tesis condicionada, 6 obstáculos".
// Eso no le sirve a nadie para operar. Un analista de verdad, con la misma información, diría:
//     "Hay short pero todavía no. Esperá a que rompa X con volumen, o que el precio suba a Y
//      para entrar con mejor precio. Si pasa Z, descartá la idea."
//
// Esto aplica un orden de prioridad, porque no todas las señales pesan igual:
//   1. Lo que bloquea del todo (no se opera, punto)
//   2. Lo que obliga a esperar (la idea sirve, el momento no)
//   3. Lo que reduce el tamaño (se opera, pero con menos)
//   4. Lo que confirma (se opera normal)
export function decidirQueHacer({ sintesis, result, setup, liquidez, libro, compresion,
                                   cinta, apalancamiento, calendario, flujo, retrocesoCinta,
                                   // Los cuatro pasos: contexto, sesgo, fuerza y ubicación.
                                   // Sin esto la decisión se toma sin saber si el movimiento
                                   // tiene combustible ni si el precio está en buen lugar.
                                   pasos,
                                   // La memoria: qué patrones ya demostraron rendir peor
                                   memoria,
                                   // Cuántas posiciones abiertas hay: la 25ª no es como la 1ª
                                   posicionesAbiertas, maxPosiciones,
                                   // Calidad de los datos con los que se está decidiendo
                                   calidadDatos }){
  const dir = sintesis?.direccion;
  const precio = result?.metrics?.price;
  const fmtP = v => v == null ? '—' : fmtPrecio(v);
  const esLong = dir === 'LONG';

  // ── NIVEL 1: LO QUE BLOQUEA ──
  // Son cosas donde operar es directamente mala idea, sin importar lo demás.
  const bloqueos = [];
  if(!dir) bloqueos.push({
    motivo: 'No hay dirección clara',
    detalle: 'Las señales están divididas. Sin una ventaja definida, cualquier entrada es una moneda al aire.',
  });
  if(calendario?.enCurso) bloqueos.push({
    motivo: `${calendario.enCurso.nombre} está saliendo ahora`,
    detalle: 'El precio puede moverse de forma violenta e impredecible en los próximos minutos. Ni el mejor análisis técnico sirve contra un dato macro saliendo.',
  });
  if(cinta?.limpia && dir && cinta.direccion !== dir) bloqueos.push({
    motivo: `La tendencia de fondo apunta a ${cinta.direccion}`,
    detalle: `Operar ${dir} contra una tendencia limpia y sana es de las cosas que más caro salen. Si querés operar esta moneda, es del otro lado.`,
  });
  if(setup?.stop && precio){
    const riesgo = Math.abs(precio - setup.stop) / precio * 100;
    if(riesgo > 15) bloqueos.push({
      motivo: `El stop queda a ${riesgo.toFixed(1)}%`,
      detalle: 'Con un stop tan ancho, el tamaño de posición se vuelve tan chico que la operación no vale la pena, o el riesgo por operación se dispara.',
    });
  }

  // ── NIVEL 2: LO QUE OBLIGA A ESPERAR ──
  // La idea sirve, pero este no es el momento. Y acá está lo importante: A QUÉ ESPERAR.
  const esperas = [];
  if(compresion?.techo && compresion?.piso && precio){
    const dentro = precio <= compresion.techo && precio >= compresion.piso;
    if(dentro) esperas.push({
      motivo: 'El precio está adentro de una compresión',
      queEsperar: `que rompa $${fmtP(esLong ? compresion.techo : compresion.piso)} con volumen`,
      nivel: esLong ? compresion.techo : compresion.piso,
      porque: 'Adentro de la compresión las señales de dirección valen poco: es donde más falsas rupturas hay. La salida suele ser rápida y del tamaño del rango comprimido.',
    });
  }
  // Liquidez del lado contrario: conviene esperar el barrido y entrar más barato
  const imanContra = liquidez && dir &&
    ((esLong && liquidez.ladoFuerte === 'abajo') || (!esLong && liquidez.ladoFuerte === 'arriba'));
  if(imanContra){
    const nivel = esLong ? (liquidez.cercanaAbajo?.precio ?? null) : (liquidez.cercanaArriba?.precio ?? null);
    esperas.push({
      motivo: `El imán de liquidez está ${liquidez.ladoFuerte}, del lado contrario`,
      queEsperar: nivel
        ? `que el precio vaya a buscar $${fmtP(nivel)} y rebote desde ahí`
        : `que barra la liquidez contraria antes de entrar`,
      nivel,
      porque: 'Entrar antes del barrido es comerse el movimiento en contra. Esperarlo da mejor precio y un stop más ajustado.',
    });
  }
  // Pared del libro entre el precio y el objetivo
  const pared = sintesis?.cruces?.find(x => x.tipo === 'obstaculo' && x.nivel);
  if(pared) esperas.push({
    motivo: 'Hay una pared de órdenes antes del objetivo',
    queEsperar: `que consuma la pared de $${fmtP(pared.nivel)}`,
    nivel: pared.nivel,
    porque: 'Si el objetivo está detrás de una pared, es probable que el precio frene ahí y no llegue. Entrar después de que la consuma cambia mucho las chances.',
  });
  // El flujo agresivo va en contra
  if(flujo?.sesgo && dir && flujo.sesgo !== 'EQUILIBRADO'){
    const flujoAFavor = (flujo.sesgo === 'COMPRADOR') === esLong;
    if(!flujoAFavor) esperas.push({
      motivo: `El flujo agresivo es ${flujo.sesgo.toLowerCase()}`,
      queEsperar: `que el volumen se dé vuelta hacia ${esLong ? 'compras' : 'ventas'}`,
      nivel: null,
      porque: `Ahora mismo quien tiene urgencia está del otro lado: ${flujo.pctComprador}% del volumen es comprador. Entrar contra eso es remar.`,
    });
  }

  // Sin fuerza: la dirección puede ser correcta pero el movimiento no llega
  if(pasos?.fuerza && !pasos.fuerza.tiene && dir){
    esperas.push({
      motivo: `El movimiento no tiene fuerza (${pasos.fuerza.proporcion})`,
      queEsperar: 'que aparezca volumen y el ADX confirme tendencia real',
      nivel: null,
      porque: pasos.fuerza.texto,
    });
  }
  // Mal lugar: se puede tener razón en la dirección y perder igual
  if(pasos?.ubicacion && !pasos.ubicacion.buena && dir){
    esperas.push({
      motivo: 'El precio no está en buen lugar',
      queEsperar: 'que el precio se aleje del obstáculo o lo supere',
      nivel: null,
      porque: pasos.ubicacion.texto,
    });
  }
  // El sesgo estructural contradice la tesis: eso es más grave que un indicador en contra
  if(pasos?.sesgo?.direccion && dir && pasos.sesgo.direccion !== dir){
    bloqueos.push({
      motivo: `La estructura tiene sesgo ${pasos.sesgo.direccion}`,
      detalle: `${pasos.sesgo.texto} Operar contra la estructura es de lo que peor sale: el sesgo estructural pesa más que cualquier oscilador.`,
    });
  }

  // La memoria frena cuando hay evidencia acumulada de que esta situación rinde peor
  if(memoria?.frena){
    esperas.push({
      motivo: 'La memoria del sistema desaconseja esta entrada',
      queEsperar: 'que cambie alguna de las condiciones que históricamente rinden peor',
      nivel: null,
      porque: memoria.resumen,
    });
  }

  // Calidad de datos baja: se decide con información incompleta
  if(calidadDatos != null && calidadDatos < 45){
    bloqueos.push({
      motivo: `Calidad de datos ${calidadDatos}/100`,
      detalle: 'Falta demasiada información para tomar esta decisión con fundamento. Operar con datos incompletos es adivinar con más pasos.',
    });
  }

  // ── NIVEL 3: LO QUE REDUCE EL TAMAÑO ──
  const reducen = [];
  if(apalancamiento?.oiSobreMcap >= 30) reducen.push({
    motivo: `Apalancamiento muy alto (OI ${apalancamiento.oiSobreMcap}% del market cap)`,
    cuanto: 0.5,
    porque: 'Con tanto apalancamiento, una liquidación en cadena puede llevarse el stop por delante y el cierre real ser peor que el previsto.',
  });
  if(apalancamiento?.divergencia && dir && apalancamiento.divergencia !== dir) reducen.push({
    motivo: 'Las posiciones grandes están del lado contrario',
    cuanto: 0.6,
    porque: 'Cuando los grandes y la multitud se separan, suele tener razón el lado grande.',
  });
  if(libro?.alertaSpread) reducen.push({
    motivo: 'El libro está fino',
    cuanto: 0.7,
    porque: 'La orden se puede ejecutar bastante peor que el precio que ves, y eso se come parte del objetivo.',
  });
  if(calendario?.inminente && calendario.inminente.horas < 12) reducen.push({
    motivo: `${calendario.inminente.nombre} en ${calendario.inminente.horas.toFixed(0)}h`,
    cuanto: 0.6,
    porque: 'Los datos macro mueven el precio más que cualquier señal técnica.',
  });

  // La memoria ajusta el tamaño aunque no frene del todo
  if(memoria && !memoria.frena && memoria.factorTamano < 0.9){
    reducen.push({
      motivo: `Patrones históricos desfavorables (${memoria.impacto} puntos)`,
      cuanto: memoria.factorTamano,
      porque: memoria.resumen,
    });
  }
  // Muchas posiciones abiertas: cada una nueva agrega correlación al conjunto
  if(posicionesAbiertas != null && maxPosiciones > 0){
    const ocupacion = posicionesAbiertas / maxPosiciones;
    if(ocupacion >= 0.8) reducen.push({
      motivo: `${posicionesAbiertas} de ${maxPosiciones} posiciones ya abiertas`,
      cuanto: 0.6,
      porque: 'Con la cartera casi llena, una operación más agrega correlación: si el mercado se da vuelta, se pierden todas juntas.',
    });
    else if(ocupacion >= 0.6) reducen.push({
      motivo: `Cartera al ${Math.round(ocupacion*100)}%`,
      cuanto: 0.8,
      porque: 'Cuantas más posiciones abiertas, más se parece el resultado a una sola apuesta grande al mercado.',
    });
  }
  // Calidad de datos mediocre: no bloquea pero justifica menos tamaño
  if(calidadDatos != null && calidadDatos >= 45 && calidadDatos < 65){
    reducen.push({
      motivo: `Calidad de datos ${calidadDatos}/100`,
      cuanto: 0.75,
      porque: 'Parte de la información no está disponible: la decisión se apoya en menos evidencia de la habitual.',
    });
  }

  // ── LA DECISIÓN ──
  let accion, titulo, detalle;
  const tamano = reducen.reduce((t, r) => t * r.cuanto, 1);

  if(bloqueos.length){
    accion = 'DESCARTAR';
    titulo = 'No operar esta moneda ahora';
    detalle = bloqueos.map(b => `${b.motivo}: ${b.detalle}`).join(' ');
  } else if(esperas.length){
    accion = 'ESPERAR';
    const principal = esperas[0];
    titulo = `Hay ${dir}, pero todavía no`;
    detalle = `${principal.porque} Lo que hay que esperar: ${esperas.map(e => e.queEsperar).join(', o ')}.`;
  } else if(retrocesoCinta?.confirma){
    accion = 'ENTRAR';
    titulo = `Entrada ${dir} con las tres condiciones cumplidas`;
    detalle = 'Tendencia limpia, el precio retrocedió a la zona de las medias, y hay ruptura de estructura confirmando. Es el escenario más selectivo del sistema.';
  } else if(tamano < 0.8){
    accion = 'ENTRAR REDUCIDO';
    titulo = `${dir} viable, pero con menos tamaño`;
    detalle = `No hay nada que bloquee ni que obligue a esperar, pero ${reducen.length === 1 ? 'hay un factor' : `hay ${reducen.length} factores`} que aumentan el riesgo: ${reducen.map(r=>r.motivo.toLowerCase()).join(', ')}.`;
  } else {
    accion = 'ENTRAR';
    titulo = `Entrada ${dir} sin obstáculos`;
    detalle = 'Las señales se alinean y no hay nada relevante en contra.';
  }

  // El nivel concreto a vigilar: es lo primero que hay que mirar mañana
  const nivelClave = esperas.find(e => e.nivel)?.nivel
    ?? (accion === 'ENTRAR' || accion === 'ENTRAR REDUCIDO' ? setup?.stop : null);

  // ═══ ENTRADA CONDICIONADA: LOS PASOS CONCRETOS ═══
  // No alcanza con "esperar": hay que decir QUÉ esperar, en orden, para poder seguirlo.
  const checklist = [];
  if(accion === 'ESPERAR'){
    let paso = 1;
    for(const e of esperas){
      checklist.push({ n: paso++, texto: e.queEsperar.charAt(0).toUpperCase() + e.queEsperar.slice(1), nivel: e.nivel });
    }
    // La confirmación en 15m siempre va al final: es el último filtro
    checklist.push({ n: paso++, texto: `Confirmación en 15m: vela ${esLong ? 'alcista' : 'bajista'} con volumen por encima del promedio`, nivel: null });
    if(pasos?.fuerza && !pasos.fuerza.tiene){
      checklist.push({ n: paso++, texto: `Que el flujo agresivo acompañe hacia ${esLong ? 'compras' : 'ventas'}`, nivel: null });
    }
  }

  // ═══ INVALIDACIÓN: QUÉ ROMPE LA IDEA ═══
  const invalidacion = [];
  if(setup?.stop) invalidacion.push(`El precio toca $${fmtP(setup.stop)}`);
  if(pasos?.sesgo?.direccion && dir && pasos.sesgo.direccion === dir){
    invalidacion.push(`La estructura deja de hacer ${esLong ? 'mínimos crecientes' : 'máximos decrecientes'} (aparece un CHoCH en contra)`);
  }
  if(compresion?.techo && compresion?.piso){
    invalidacion.push(`Rompe $${fmtP(esLong ? compresion.piso : compresion.techo)}, el lado contrario de la compresión`);
  }
  if(cinta?.limpia && dir && cinta.direccion === dir){
    invalidacion.push(`El precio pierde la cinta de medias ($${fmtP(esLong ? cinta.piso : cinta.techo)}) con cierre confirmado`);
  }

  return {
    accion, titulo, detalle,
    bloqueos, esperas, reducen,
    checklist, invalidacion,
    // El sesgo y la entrada son cosas distintas: se puede tener sesgo SHORT y no entrar
    sesgo: pasos?.sesgo?.direccion || dir,
    fuerza: pasos?.fuerza?.tiene ?? null,
    contexto: pasos?.contexto?.estado || null,
    memoriaAplicada: memoria ? { impacto: memoria.impacto, frena: memoria.frena,
                                  patrones: memoria.coincidencias.length } : null,
    // Cuánto del tamaño normal, redondeado a algo usable
    tamanoSugerido: accion.startsWith('ENTRAR') ? Math.round(tamano * 100) : 0,
    nivelClave,
    // El texto de una línea, que es lo que se lee primero
    resumen: (() => {
      const emoji = accion === 'DESCARTAR' ? '🚫' : accion === 'ESPERAR' ? '⏸️'
                  : accion === 'ENTRAR REDUCIDO' ? '🟡' : '🟢';
      let base = `${emoji} <b>${titulo}</b>`;
      if(accion === 'ESPERAR' && nivelClave) base += ` — vigilar $${fmtP(nivelClave)}`;
      if(accion === 'ENTRAR REDUCIDO') base += ` — ${Math.round(tamano*100)}% del tamaño habitual`;
      return base;
    })(),
  };
}

// ═══ QUÉ PUEDE PASAR — ESCENARIOS ═══
// Lo que le faltaba al análisis: después de mostrar todos los datos, decir qué puede pasar.
// No es una predicción: son los dos o tres caminos más probables según dónde está la liquidez,
// la estructura y la compresión, con el nivel que define cuál se cumple.
// Es la idea del gráfico anotado a mano: "área crítica", "todavía no hay entrada clara".
export function escenariosProbables({ price, structure, liquidez, compresion, fase, dirTesis, setup }){
  if(!price || !structure) return null;
  const fmt = v => v == null ? '—' : (v >= 1 ? v.toFixed(2) : v.toPrecision(6));
  const pct = (a,b) => Math.abs(a-b)/b*100;

  const escenarios = [];
  const arriba = liquidez?.cercanaArriba || liquidez?.lejanaArriba;
  const abajo = liquidez?.cercanaAbajo || liquidez?.lejanaAbajo;
  // La dirección estructural sale de events.trendStructure ('HH-HL' alcista, 'LH-LL' bajista,
  // 'range' sin definir), no de un campo `bias` que no existe.
  // trendStructure devuelve 'bull' | 'bear' | 'range' directamente. Se aceptan también las
  // formas HH-HL / LH-LL por si cambia el formato.
  const ts = String(structure.events?.trendStructure || '').toLowerCase();
  const bias = (ts === 'bull' || /hh|hl/.test(ts)) ? 'bull'
             : (ts === 'bear' || /lh|ll/.test(ts)) ? 'bear' : null;

  // ═══ ÁREA CRÍTICA ═══
  // El nivel que, si se pierde o se supera, cambia la lectura entera. Es lo primero que hay
  // que mirar: mientras el precio esté de un lado, vale una historia; del otro, otra.
  let areaCritica = null;
  if(compresion?.techo && compresion?.piso){
    areaCritica = { desde: compresion.piso, hasta: compresion.techo,
      motivo: `El precio está comprimido entre estos dos niveles. Mientras siga adentro no hay dirección; el lado por el que rompa define el movimiento.` };
  } else if(structure.bullishOB && bias === 'bull'){
    areaCritica = { desde: structure.bullishOB.bottom, hasta: structure.bullishOB.top,
      motivo: `Zona de demanda. Si el precio la pierde con un cierre debajo, la tesis alcista deja de tener sustento.` };
  } else if(structure.bearishOB && bias === 'bear'){
    areaCritica = { desde: structure.bearishOB.bottom, hasta: structure.bearishOB.top,
      motivo: `Zona de oferta. Si el precio la supera con un cierre encima, la tesis bajista deja de tener sustento.` };
  } else if(abajo && arriba){
    areaCritica = { desde: abajo.precio, hasta: arriba.precio,
      motivo: `Entre estos dos niveles el precio no tiene un imán claro. Los movimientos adentro suelen ser ruido.` };
  }

  // ═══ ESCENARIO 1: BARRIDO DE LIQUIDEZ ═══
  // El más frecuente y el que más sorprende: el precio va PRIMERO a buscar la liquidez
  // contraria antes de arrancar para el lado bueno.
  const imanCercano = (arriba && abajo)
    ? (pct(arriba.precio, price) < pct(abajo.precio, price) ? arriba : abajo)
    : (arriba || abajo);
  if(imanCercano){
    const esArriba = imanCercano === arriba;
    const dist = pct(imanCercano.precio, price);
    const contraTesis = dirTesis && ((dirTesis === 'LONG' && !esArriba) || (dirTesis === 'SHORT' && esArriba));
    escenarios.push({
      titulo: contraTesis ? '⚠️ Barrido antes de arrancar' : '🎯 Va a buscar el imán',
      probabilidad: dist < 3 ? 'alta' : dist < 8 ? 'media' : 'baja',
      texto: contraTesis
        ? `Lo más probable es que el precio baje primero a $${fmt(imanCercano.precio)} (${dist.toFixed(1)}% ${esArriba?'arriba':'abajo'}, ${imanCercano.toques} toques) a barrer los stops que se acumularon ahí, y recién después gire a favor. Si tenés la operación abierta, ese movimiento en contra puede ser normal y no significa que la tesis falló.`
        : `El precio tiene un imán a $${fmt(imanCercano.precio)}, a ${dist.toFixed(1)}% ${esArriba?'por encima':'por debajo'}, con ${imanCercano.toques} toques acumulados. Es hacia donde tiende a moverse antes de definir.`,
      nivel: imanCercano.precio,
    });
  }

  // ═══ ESCENARIO 2: SALIDA DE LA COMPRESIÓN ═══
  if(compresion?.techo && compresion?.piso){
    escenarios.push({
      titulo: '💥 Expansión desde la compresión',
      probabilidad: compresion.compresionPct >= 50 ? 'alta' : 'media',
      texto: `El rango se comprimió un ${compresion.compresionPct.toFixed(0)}%: se está acumulando energía. Cuando rompa $${fmt(compresion.techo)} o $${fmt(compresion.piso)}, el movimiento suele ser rápido y del tamaño del rango que venía comprimiendo. Operar adentro de la compresión es lo que más falsas señales genera.`,
      nivel: null,
    });
  }

  // ═══ ESCENARIO 3: CONTINUACIÓN ═══
  // El setup puede traer los objetivos como t1/t2 o como tp1/tp2 según de dónde venga
  const obj1 = setup?.t1 ?? setup?.tp1 ?? null;
  const obj2 = setup?.t2 ?? setup?.tp2 ?? null;
  if(bias && obj1){
    const alcista = bias === 'bull';
    escenarios.push({
      titulo: alcista ? '📈 Continuación alcista' : '📉 Continuación bajista',
      probabilidad: fase && /EXPANSIÓN/i.test(fase) ? 'alta' : 'media',
      texto: `La estructura sigue ${alcista?'alcista (máximos y mínimos más altos)':'bajista (máximos y mínimos más bajos)'}. Si se mantiene, el primer objetivo razonable es $${fmt(obj1)}${obj2?` y después $${fmt(obj2)}`:''}.${fase?` La fase actual (${fase}) ${/EXPANSIÓN/i.test(fase)?'acompaña':'no acompaña del todo'} este escenario.`:''}`,
      nivel: obj1,
    });
  }

  // ═══ ESCENARIO 4: INVALIDACIÓN ═══
  // structure.events es un OBJETO con {trendStructure, bos, choch, ...}, no un array.
  // Antes se llamaba .some() sobre él y toda la función se caía.
  if(structure.events?.choch){
    escenarios.push({
      titulo: '🔄 Cambio de carácter en curso',
      probabilidad: 'media',
      texto: `Apareció un CHoCH: la estructura previa está en duda. Es el aviso temprano de que la tendencia puede darse vuelta, pero también el momento donde más falsos quiebres hay. Conviene esperar confirmación antes de operar en la nueva dirección.`,
      nivel: null,
    });
  }

  if(!escenarios.length) return null;

  // Una conclusión que ate todo, no una lista de escenarios sueltos
  const alta = escenarios.filter(e=>e.probabilidad==='alta');
  const conclusion = alta.length
    ? `Lo más probable ahora: ${alta.map(e=>e.titulo.replace(/^[^\s]+\s/,'').toLowerCase()).join(' y después ')}.`
    : `Ningún escenario destaca claramente: el mercado no está mostrando una intención definida. Es de los momentos donde conviene esperar.`;

  return { escenarios, areaCritica, conclusion };
}

// Envoltorios con cache: la misma consulta se pedía dos veces por moneda (una para el mensaje,
// otra para el registro). Con el cache, la segunda reutiliza el resultado de la primera.
export function fetchRatiosApalancamiento(symbolRaw, marketCapUsd, volSpotUsd){
  return conCache(`ratios:${normalizarSimbolo(symbolRaw)}`, 120000,
    () => _fetchRatiosApalancamiento(symbolRaw, marketCapUsd, volSpotUsd));
}
export function fetchLibroOrdenes(symbolRaw, fuente = 'Binance'){
  return conCache(`libro:${normalizarSimbolo(symbolRaw)}:${fuente}`, 60000,
    () => _fetchLibroOrdenes(symbolRaw, fuente));
}
export function fetchTransferenciasTokenCached(contrato, red, horas = 24){
  if(!contrato || !red) return Promise.resolve(null);
  return conCache(`transfers:${red}:${contrato}`, 180000,
    () => fetchTransferenciasToken(contrato, red, horas));
}
export function fetchOnChainPressureCached(contrato, red, dirTesis){
  if(!contrato || !red) return Promise.resolve(null);
  // La dirección de la tesis NO va en la clave: el análisis es el mismo, solo cambia
  // la interpretación de si acompaña o contradice, que se calcula al final.
  return conCache(`onchain:${red}:${contrato}`, 180000,
    () => fetchOnChainPressure(contrato, red, dirTesis));
}

// ═══ LECTURA UNIFICADA DE LIQUIDEZ Y FLUJO ═══
// El problema que resuelve: el mensaje mostraba cinco bloques sueltos (liquidez, libro de órdenes,
// flujo, wallets, actividad anómala). Si tres decían lo mismo no se notaba, y si se contradecían
// tampoco. Leerlos por separado obliga a hacer la síntesis mentalmente.
//
// Esto los junta en UNA lectura: cuenta cuántas capas apuntan a cada lado, marca cuándo coinciden
// —que es cuando la señal vale— y sobre todo marca cuándo se contradicen, que es la información
// más útil y la que más fácil se pierde mirando bloques separados.
export function lecturaUnificada({ liquidez, libro, flujo, wallets, onchain, anomalia, dirTesis }){
  const capas = [];

  // Cada capa se reduce a lo mismo: nombre, hacia dónde apunta, y por qué
  if(liquidez?.ladoFuerte && liquidez.ladoFuerte !== 'pareja'){
    capas.push({
      nombre:'Liquidez', peso: liquidez.confluencia ? 2 : 1,   // si coincide 15m+4h pesa doble
      sesgo: liquidez.ladoFuerte === 'arriba' ? 'LONG' : 'SHORT',
      texto: liquidez.confluencia
        ? `el imán más fuerte está ${liquidez.ladoFuerte} y coincide en 15m y 4h`
        : `la liquidez más fuerte está ${liquidez.ladoFuerte}`,
    });
  }
  if(libro?.sesgo && libro.sesgo !== 'EQUILIBRADO'){
    capas.push({ nombre:'Libro de órdenes', peso:1,
      sesgo: libro.sesgo === 'COMPRADOR' ? 'LONG' : 'SHORT',
      texto: `las órdenes puestas pesan del lado ${libro.sesgo.toLowerCase()}` });
  }
  if(flujo?.sesgo && flujo.sesgo !== 'EQUILIBRADO'){
    capas.push({ nombre:'Flujo de órdenes', peso: Math.abs(flujo.cambio) > 6 ? 2 : 1,
      sesgo: flujo.sesgo === 'COMPRADOR' ? 'LONG' : 'SHORT',
      texto: `${flujo.pctComprador}% del volumen es comprador agresivo${Math.abs(flujo.cambio)>6 ? ` y viene ${flujo.cambio>0?'subiendo':'bajando'}` : ''}` });
  }
  if(wallets?.direccion && wallets.direccion !== 'NEUTRO'){
    capas.push({ nombre:'Wallets', peso: wallets.confianza >= 60 ? 2 : 1,
      sesgo: wallets.direccion,
      texto: wallets.direccion === 'LONG' ? 'salen más tokens de exchanges de los que entran' : 'entran más tokens a exchanges de los que salen' });
  }
  if(onchain?.direccion && onchain.direccion !== 'NEUTRO'){
    capas.push({ nombre:'Actividad DEX', peso:1, sesgo: onchain.direccion,
      texto: onchain.direccion === 'LONG' ? 'dominan las compras en los pools' : 'dominan las ventas en los pools' });
  }
  if(anomalia?.hayAlgo){
    const absorcion = anomalia.señales?.find(s => s.tipo === 'absorción');
    const barrido = anomalia.señales?.find(s => s.tipo === 'barrido');
    if(absorcion || barrido){
      capas.push({ nombre:'Actividad inusual', peso:1, sesgo:'AVISO',
        texto: absorcion ? 'alguien está absorbiendo órdenes sin mover el precio' : 'hubo un barrido de liquidez reciente' });
    }
  }

  if(!capas.length) return null;

  const aFavorLong = capas.filter(c=>c.sesgo==='LONG').reduce((s,c)=>s+c.peso, 0);
  const aFavorShort = capas.filter(c=>c.sesgo==='SHORT').reduce((s,c)=>s+c.peso, 0);
  const total = aFavorLong + aFavorShort;
  const dominante = aFavorLong > aFavorShort ? 'LONG' : aFavorShort > aFavorLong ? 'SHORT' : 'EMPATE';
  const fuerza = total > 0 ? Math.round(Math.abs(aFavorLong-aFavorShort)/total*100) : 0;

  const alineadas = capas.filter(c=>c.sesgo===dominante);
  const enContra = capas.filter(c=>c.sesgo!==dominante && c.sesgo!=='AVISO');
  const avisos = capas.filter(c=>c.sesgo==='AVISO');

  // Lo importante: si la mayoría apunta contra la operación, hay que decirlo con claridad
  const relacionConTesis = !dirTesis || dominante === 'EMPATE' ? null
    : dominante === dirTesis ? 'acompaña' : 'contradice';

  const frases = [];
  if(dominante === 'EMPATE'){
    frases.push(`Las señales de flujo están divididas: ${capas.filter(c=>c.sesgo==='LONG').length} apuntan arriba y ${capas.filter(c=>c.sesgo==='SHORT').length} abajo. No hay una lectura clara.`);
  } else {
    frases.push(`${alineadas.length} de ${capas.length} señales de flujo apuntan a ${dominante} (${alineadas.map(c=>c.nombre).join(', ')}): ${alineadas.map(c=>c.texto).join('; ')}.`);
    if(enContra.length){
      frases.push(`⚠️ Pero ${enContra.length} apunta${enContra.length>1?'n':''} al lado contrario — ${enContra.map(c=>`${c.nombre}: ${c.texto}`).join('; ')}.`);
    }
  }
  if(avisos.length) frases.push(`ℹ️ ${avisos.map(c=>c.texto).join('; ')}.`);
  if(relacionConTesis === 'contradice'){
    frases.push(`🔴 En conjunto, el flujo va EN CONTRA de esta operación ${dirTesis}. Puede que el precio busque el otro lado antes de girar a favor.`);
  } else if(relacionConTesis === 'acompaña' && fuerza >= 50){
    frases.push(`🟢 El flujo acompaña la operación ${dirTesis} de forma bastante consistente.`);
  }

  return {
    dominante, fuerza, capas: capas.length,
    aFavor: alineadas.length, enContra: enContra.length,
    relacionConTesis,
    detalle: capas,
    texto: frases.join(' '),
  };
}

// ═══ CACHE DE UNA CORRIDA ═══
// Varias de estas consultas se hacían DOS VECES por moneda: una para armar el mensaje y otra
// para guardar el registro. Como dentro de la misma corrida el dato no cambia, se cachea por
// 2 minutos. Eso corta a la mitad las llamadas de libro, apalancamiento, wallets y DEX.
const _cacheCorrida = new Map();
function conCache(clave, ttlMs, fn){
  const hit = _cacheCorrida.get(clave);
  if(hit && (Date.now() - hit.ts) < ttlMs) return hit.valor;
  const valor = fn();   // se guarda la PROMESA, así dos llamadas simultáneas comparten el pedido
  _cacheCorrida.set(clave, { ts: Date.now(), valor });
  // Limpieza para que el mapa no crezca sin control en corridas largas
  if(_cacheCorrida.size > 400){
    const viejo = Date.now() - ttlMs;
    for(const [k,v] of _cacheCorrida) if(v.ts < viejo) _cacheCorrida.delete(k);
  }
  return valor;
}

// ═══ LIBRO DE ÓRDENES ═══
// La diferencia con lo que veníamos haciendo: hasta ahora la liquidez se RECONSTRUÍA a partir de
// las velas (dónde hubo toques, dónde se acumuló volumen). Eso es inferir dónde PUDO haber
// liquidez. El libro muestra las órdenes que están puestas AHORA MISMO.
//
// Es gratis y sin clave, tanto en Binance como en Bitunix.
// LIMITACIÓN HONESTA: el libro es una foto del momento y se puede retirar en un segundo. Un muro
// grande puede ser real o puede ser alguien tratando de asustar. Por eso se muestra como
// contexto, no como una verdad fija.
async function _fetchLibroOrdenes(symbolRaw, fuente = 'Binance'){
  const sym = normalizarSimbolo(symbolRaw);
  try{
    let bids = [], asks = [];
    if(fuente === 'Bitunix'){
      const r = await fetchJSON(`https://fapi.bitunix.com/api/v1/futures/market/depth?symbol=${sym}USDT&limit=100`);
      bids = (r?.data?.bids||[]).map(x=>[+x[0], +x[1]]);
      asks = (r?.data?.asks||[]).map(x=>[+x[0], +x[1]]);
    } else {
      const r = await fetchJSON(`${BINANCE}/api/v3/depth?symbol=${sym}USDT&limit=500`);
      bids = (r?.bids||[]).map(x=>[+x[0], +x[1]]);
      asks = (r?.asks||[]).map(x=>[+x[0], +x[1]]);
    }
    if(bids.length < 5 || asks.length < 5) return null;

    const mejorCompra = bids[0][0], mejorVenta = asks[0][0];
    const medio = (mejorCompra + mejorVenta)/2;
    const spreadPct = (mejorVenta - mejorCompra)/medio*100;

    // Solo se mira lo que está a ±2% del precio: más lejos casi nunca se ejecuta
    const cerca = 0.02;
    const bidsCerca = bids.filter(([p]) => p >= medio*(1-cerca));
    const asksCerca = asks.filter(([p]) => p <= medio*(1+cerca));
    const usdCompra = bidsCerca.reduce((s,[p,q]) => s + p*q, 0);
    const usdVenta  = asksCerca.reduce((s,[p,q]) => s + p*q, 0);
    const total = usdCompra + usdVenta;
    if(total <= 0) return null;

    // Desbalance: +1 = todo el peso del lado comprador, -1 = todo vendedor
    const desbalance = (usdCompra - usdVenta)/total;

    // MUROS: órdenes muy por encima del tamaño típico. Son los niveles donde el precio
    // realmente puede frenar, porque hay que consumirlas para pasar.
    const detectarMuros = (ordenes, lado) => {
      const usds = ordenes.map(([p,q]) => p*q).filter(x=>x>0);
      if(usds.length < 10) return [];
      const media = usds.reduce((a,b)=>a+b,0)/usds.length;
      const desv = Math.sqrt(usds.reduce((s,x)=>s+Math.pow(x-media,2),0)/usds.length);
      if(desv <= 0) return [];
      return ordenes
        .map(([p,q]) => ({ precio:p, usd:p*q, z:((p*q)-media)/desv, lado,
                           distPct: Math.abs(p-medio)/medio*100 }))
        .filter(m => m.z >= 3 && m.usd >= 20000)   // 3 desviaciones y mínimo relevante
        .sort((a,b) => b.usd - a.usd).slice(0, 3);
    };
    const muros = [...detectarMuros(bidsCerca, 'compra'), ...detectarMuros(asksCerca, 'venta')]
      .sort((a,b) => a.distPct - b.distPct);

    // ═══ MAPA DE NIVELES ═══
    // Saber que "el libro pesa del lado comprador" no alcanza: hace falta ver DÓNDE están
    // esas órdenes. Se agrupa el libro en escalones de 0.25% alrededor del precio, para
    // poder mostrar en qué niveles concretos está concentrado el dinero.
    const escalon = 0.0025;
    const agrupar = (ordenes, lado) => {
      const cubos = new Map();
      for(const [p, q] of ordenes){
        const dist = (p - medio) / medio;
        const cubo = Math.round(dist / escalon);
        const usd = p * q;
        const prev = cubos.get(cubo) || { usd:0, precioMin:p, precioMax:p, ordenes:0 };
        cubos.set(cubo, {
          usd: prev.usd + usd,
          precioMin: Math.min(prev.precioMin, p),
          precioMax: Math.max(prev.precioMax, p),
          ordenes: prev.ordenes + 1,
        });
      }
      return [...cubos.entries()].map(([cubo, v]) => ({
        lado,
        distPct: +(cubo * escalon * 100).toFixed(2),
        precio: (v.precioMin + v.precioMax) / 2,
        precioDesde: v.precioMin, precioHasta: v.precioMax,
        usd: Math.round(v.usd), ordenes: v.ordenes,
      })).filter(x => x.usd > 0);
    };

    const nivelesCompra = agrupar(bidsCerca, 'compra').sort((a,b) => b.usd - a.usd);
    const nivelesVenta = agrupar(asksCerca, 'venta').sort((a,b) => b.usd - a.usd);

    // Los cinco escalones con más dinero de cada lado: son los que de verdad importan
    const concentracion = [...nivelesCompra.slice(0,5), ...nivelesVenta.slice(0,5)]
      .sort((a,b) => Math.abs(a.distPct) - Math.abs(b.distPct));

    return {
      fuente, precioMedio: medio,
      spreadPct: +spreadPct.toFixed(4),
      usdCompra: Math.round(usdCompra), usdVenta: Math.round(usdVenta),
      desbalance: +desbalance.toFixed(3),
      sesgo: desbalance > 0.2 ? 'COMPRADOR' : desbalance < -0.2 ? 'VENDEDOR' : 'EQUILIBRADO',
      muros: muros.map(m => ({ ...m, precio:+m.precio.toFixed(8), usd:Math.round(m.usd), distPct:+m.distPct.toFixed(2) })),
      // El mapa completo: dónde está concentrado el dinero, no solo cuánto hay
      niveles: concentracion.map(n => ({
        lado: n.lado, precio: n.precio, distPct: n.distPct, usd: n.usd, ordenes: n.ordenes,
      })),
      // Los dos niveles más gruesos de cada lado, que son los que frenan el precio
      soporteMasFuerte: nivelesCompra[0] || null,
      resistenciaMasFuerte: nivelesVenta[0] || null,
      // Un spread ancho avisa de un problema práctico: la orden se ejecuta peor de lo esperado
      alertaSpread: spreadPct > 0.5 ? `Spread de ${spreadPct.toFixed(2)}%: el libro está fino, la orden se puede ejecutar bastante peor que el precio que ves.` : null,
      resumen: (() => {
        const p = [];
        p.push(desbalance > 0.2
          ? `Hay $${(usdCompra/1000).toFixed(0)}K de órdenes de compra contra $${(usdVenta/1000).toFixed(0)}K de venta cerca del precio: el libro pesa del lado comprador.`
          : desbalance < -0.2
          ? `Hay $${(usdVenta/1000).toFixed(0)}K de órdenes de venta contra $${(usdCompra/1000).toFixed(0)}K de compra cerca del precio: el libro pesa del lado vendedor.`
          : `Las órdenes de compra y venta cerca del precio están parejas.`);
        // DÓNDE está el dinero, no solo cuánto: es lo que hace falta para operar
        const sop = nivelesCompra[0], res = nivelesVenta[0];
        if(sop) p.push(`La mayor concentración de compras está en $${fmtPrecio(sop.precio)} (${Math.abs(sop.distPct)}% por debajo) con $${(sop.usd/1000).toFixed(0)}K en ${sop.ordenes} órdenes: ahí hay soporte real.`);
        if(res) p.push(`La mayor concentración de ventas está en $${fmtPrecio(res.precio)} (${res.distPct}% por encima) con $${(res.usd/1000).toFixed(0)}K: ahí el precio puede frenar.`);
        const primero = muros[0];
        if(primero) p.push(`El muro individual más cercano es de ${primero.lado} en $${fmtPrecio(primero.precio)}, a ${primero.distPct.toFixed(2)}%, con $${(primero.usd/1000).toFixed(0)}K.`);
        return p.join(' ');
      })(),
      aclaracion: 'El libro es una foto del momento: las órdenes se pueden retirar en cualquier instante. Sirve para ver dónde hay peso ahora, no para dar por hecho que va a seguir ahí.',
    };
  }catch(e){ return null; }
}

// ═══ PRESIÓN DE FLUJO DE ÓRDENES ═══
// Usa el volumen comprador/vendedor agresivo que viene en cada vela y hasta ahora se descartaba.
// Es la versión medible de "quién está siendo más agresivo": el que compra al precio de venta
// tiene más urgencia que el que espera en el libro.
function calcularPresionFlujo(candles, velas = 24){
  const v = (candles||[]).slice(-velas).filter(c => c.vc != null && c.v > 0);
  if(v.length < 6) return null;

  const totalComprador = v.reduce((s,c)=>s+c.vc, 0);
  const totalVendedor = v.reduce((s,c)=>s+c.vv, 0);
  const total = totalComprador + totalVendedor;
  if(total <= 0) return null;
  const pctComprador = totalComprador/total*100;

  // La tendencia importa tanto como el nivel: comparar la última parte contra la primera
  const mitad = Math.floor(v.length/2);
  const pctDe = arr => { const a=arr.reduce((s,c)=>s+c.vc,0), b=arr.reduce((s,c)=>s+c.vv,0); return (a+b)>0 ? a/(a+b)*100 : 50; };
  const primera = pctDe(v.slice(0, mitad)), ultima = pctDe(v.slice(mitad));
  const cambio = ultima - primera;

  const sesgo = pctComprador >= 57 ? 'COMPRADOR' : pctComprador <= 43 ? 'VENDEDOR' : 'EQUILIBRADO';
  return {
    pctComprador: +pctComprador.toFixed(1),
    sesgo,
    cambio: +cambio.toFixed(1),
    tendencia: cambio > 6 ? 'los compradores vienen ganando terreno'
             : cambio < -6 ? 'los vendedores vienen ganando terreno'
             : 'sin cambio claro en las últimas velas',
    velas: v.length,
    // Se avisa cuando el dato es estimado: OKX, Bybit y Bitunix no publican el volumen
    // comprador real, se aproxima por dónde cerró la vela en su rango.
    estimado: v.some(x => x.estimado),
    resumen: `${pctComprador.toFixed(0)}% del volumen de las últimas ${v.length} velas fue de compradores${v.some(x=>x.estimado) ? ' (estimado: esta fuente no publica el dato exacto)' : ' agrediendo el libro'}${Math.abs(cambio)>6 ? ` — y ${cambio>0?'subiendo':'bajando'}` : ''}.`,
    aclaracion: 'Mide quién ejecuta contra el libro (quien tiene urgencia), no las órdenes que esperan.',
  };
}

// ═══ BUSCAR EL CONTRATO DE UN TOKEN ═══
// EL BUG QUE ARREGLA: de las 12 fuentes de velas, SOLO GeckoTerminal devuelve la dirección del
// contrato. Y como Gecko es la última que se prueba, casi nunca se usa — si la moneda está en
// Binance, los datos vienen de ahí y el contrato queda en null.
// Resultado: el panel de Wallets y la actividad DEX no aparecían NUNCA, porque las dos necesitan
// contrato y red. Ahora el contrato se busca aparte, sin importar de dónde salieron las velas.
const _cacheContrato = new Map();
export async function buscarContratoToken(symbolRaw){
  const sym = normalizarSimbolo(symbolRaw);
  if(!sym) return null;
  if(_cacheContrato.has(sym)) return _cacheContrato.get(sym);

  const guardar = (v) => { _cacheContrato.set(sym, v); return v; };
  try{
    // GeckoTerminal busca por símbolo y devuelve los pools con su red y su contrato
    const res = await fetchJSON(`${GECKO}/search/pools?query=${encodeURIComponent(sym)}&page=1`);
    const pools = res?.data;
    if(!Array.isArray(pools) || !pools.length) return guardar(null);

    // Se elige el pool con más liquidez cuyo token base coincida con el símbolo buscado:
    // sin ese filtro se podía terminar tomando el contrato de otra moneda parecida.
    const candidatos = pools
      .map(p => {
        const nombre = String(p.attributes?.name || '');
        const base = nombre.split('/')[0]?.trim().toUpperCase();
        return {
          base,
          liquidez: parseFloat(p.attributes?.reserve_in_usd) || 0,
          red: p.relationships?.network?.data?.id || null,
          contrato: p.relationships?.base_token?.data?.id?.split('_').pop() || null,
        };
      })
      .filter(x => x.contrato && x.red && x.base === sym && x.liquidez > 1000)
      .sort((a,b) => b.liquidez - a.liquidez);

    if(!candidatos.length) return guardar(null);
    const mejor = candidatos[0];
    return guardar({ contrato: mejor.contrato, red: mejor.red, liquidez: mejor.liquidez });
  }catch(e){ return guardar(null); }
}

// ═══ WALLET INTELLIGENCE: TRAER LAS TRANSFERENCIAS ═══
// Este es el único punto que habla con una API externa. Toda la inteligencia —clasificar
// wallets, detectar depósitos, descartar movimientos internos— está en wallet-intelligence.js,
// que no depende de ninguna fuente en particular.
//
// NECESITA UNA CLAVE DE ALCHEMY (gratis, 30M unidades al mes). Se guarda como secreto de
// GitHub Actions igual que TELEGRAM_BOT_TOKEN. Sin clave, esta función devuelve null y el bot
// sigue funcionando exactamente como antes, sin esta capa.
// La clave sale de dos lugares distintos según dónde corra:
//  · En el bot (Node): de process.env, que viene del secreto de GitHub Actions.
//  · En la web (navegador): NO hay process. Se lee de window.ALCHEMY_KEY, que se puede
//    definir en el HTML. Antes esto era solo process.env, así que en la web SIEMPRE daba
//    null y el panel de Wallets no aparecía nunca.
const ALCHEMY_KEY =
  (typeof process !== 'undefined' && process.env?.ALCHEMY_API_KEY) ||
  (typeof window !== 'undefined' && window.ALCHEMY_KEY) || null;

// Los identificadores de red de GeckoTerminal NO son los mismos que los de Alchemy.
// Gecko devuelve 'eth' y 'polygon_pos'; Alchemy espera 'eth-mainnet' y 'polygon-mainnet'.
// Sin este mapeo, buscar LINK (red 'eth') devolvía undefined y la función cortaba antes de
// llamar a la API — o sea que tampoco funcionaba en el bot.
const ALCHEMY_REDES = {
  eth:'eth-mainnet', ethereum:'eth-mainnet',
  bsc:'bnb-mainnet', 'binance-smart-chain':'bnb-mainnet',
  base:'base-mainnet',
  arbitrum:'arb-mainnet', arbitrum_one:'arb-mainnet', 'arbitrum-one':'arb-mainnet',
  polygon_pos:'polygon-mainnet', polygon:'polygon-mainnet', 'polygon-pos':'polygon-mainnet',
};

export function estadoWalletIntelligence(red){
  // Sirve para poder mostrar POR QUÉ no hay datos, en vez de que el panel simplemente
  // no aparezca y no se sepa si está roto o si la moneda no aplica.
  if(!ALCHEMY_KEY) return { ok:false, motivo:'Falta la clave de Alchemy. Se configura como secreto ALCHEMY_API_KEY en GitHub Actions y se pasa al paso del bot en el bloque env del workflow.' };
  if(!red) return { ok:false, motivo:'No se encontró el contrato de esta moneda en ninguna red soportada.' };
  if(!ALCHEMY_REDES[red]) return { ok:false, motivo:`La red "${red}" no está soportada. Funciona con Ethereum, BNB Chain, Base, Arbitrum y Polygon. Las monedas de Solana no tienen análisis de wallets.` };
  return { ok:true, motivo:null };
}

async function fetchTransferenciasToken(contrato, red, horas = 24){
  if(!ALCHEMY_KEY || !contrato) return null;
  const subdominio = ALCHEMY_REDES[red];
  if(!subdominio) return null;   // red no soportada: mejor null que datos a medias
  try{
    const url = `https://${subdominio}.g.alchemy.com/v2/${ALCHEMY_KEY}`;
    const cuerpo = {
      jsonrpc:'2.0', id:1, method:'alchemy_getAssetTransfers',
      params:[{ contractAddresses:[contrato], category:['erc20'], withMetadata:true,
                excludeZeroValue:true, maxCount:'0x64', order:'desc' }],
    };
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(cuerpo) });
    if(!res.ok) return null;
    const j = await res.json();
    const transfers = j?.result?.transfers;
    if(!Array.isArray(transfers)) return null;

    const desde = Date.now() - horas*3600e3;
    return transfers.map(t => {
      const ts = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : null;
      return { from:t.from, to:t.to, hash:t.hash, ts, cantidad:Number(t.value)||0 };
    }).filter(t => !t.ts || t.ts >= desde);
  }catch(e){ return null; }
}

// ═══ PRESIÓN ON-CHAIN / SMART MONEY ═══
// QUÉ ES Y QUÉ NO ES:
// Esto NO es Arkham. No identifica billeteras ni dice "esta compra es de Jump Trading".
// Lo que hace es leer la actividad REAL en los pools de DEX —compras contra ventas, cambios de
// liquidez, volumen on-chain— y decir si esa actividad acompaña o contradice la tesis.
// Los datos salen de GeckoTerminal, que ya está conectado y agrega transacciones on-chain reales.
//
// LIMITACIÓN IMPORTANTE: solo funciona para monedas con pools de DEX. Una moneda que cotiza
// únicamente en exchanges centralizados no tiene actividad on-chain que leer, y la función
// devuelve null en vez de inventar un número.
//
// NO SUMA AL SCORE. Es evidencia independiente que se registra en cada operación, para que
// dentro de unas semanas el Research Center pueda responder si realmente predice algo.
async function fetchOnChainPressure(contractAddress, network, dirTesis){
  if(!contractAddress || !network) return null;
  try{
    const res = await fetchJSON(`${GECKO}/networks/${network}/tokens/${contractAddress}/pools?page=1`);
    const pools = res?.data;
    if(!Array.isArray(pools) || !pools.length) return null;

    // Se usa el pool con más liquidez: es el que refleja la actividad real
    const pool = pools
      .filter(p => parseFloat(p.attributes?.reserve_in_usd) > 0)
      .sort((a,b)=> parseFloat(b.attributes.reserve_in_usd) - parseFloat(a.attributes.reserve_in_usd))[0];
    if(!pool) return null;
    const a = pool.attributes;

    const señales = [];
    let puntaje = 0, medidas = 0;

    // 1) COMPRAS vs VENTAS en las últimas horas.
    // Es lo más parecido a "quién está moviendo el dinero" que se puede conseguir gratis:
    // no sabemos quién, pero sí cuántas operaciones fueron de compra y cuántas de venta.
    const tx = a.transactions || {};
    const leerTramo = (t) => {
      const b = parseInt(t?.buys ?? 0, 10), s = parseInt(t?.sells ?? 0, 10);
      return (b + s) >= 20 ? { buys:b, sells:s, total:b+s, pctCompra: b/(b+s)*100 } : null;
    };
    const h24 = leerTramo(tx.h24), h6 = leerTramo(tx.h6), h1 = leerTramo(tx.h1);
    const tramo = h6 || h24 || h1;
    if(tramo){
      medidas++;
      const desvio = tramo.pctCompra - 50;
      puntaje += Math.max(-1, Math.min(1, desvio/20));  // ±20 puntos porcentuales = señal completa
      señales.push({
        tipo: 'Compras vs ventas',
        valor: `${tramo.buys} compras / ${tramo.sells} ventas (${tramo.pctCompra.toFixed(0)}% compradoras)`,
        sesgo: desvio > 8 ? 'LONG' : desvio < -8 ? 'SHORT' : 'neutro',
      });
    }

    // 2) ACELERACIÓN: si en la última hora hay mucha más actividad que el promedio del día,
    // algo está pasando ahora. Combinado con el sesgo de compra/venta dice hacia dónde.
    if(h1 && h24){
      const esperadoPorHora = h24.total/24;
      if(esperadoPorHora > 0){
        const acel = h1.total/esperadoPorHora;
        if(acel >= 2.5){
          medidas++;
          const dir = h1.pctCompra > 55 ? 'LONG' : h1.pctCompra < 45 ? 'SHORT' : 'neutro';
          puntaje += dir==='LONG' ? 0.6 : dir==='SHORT' ? -0.6 : 0;
          señales.push({ tipo:'Aceleración', valor:`${acel.toFixed(1)}x la actividad normal en la última hora`, sesgo:dir });
        }
      }
    }

    // 3) CAMBIO DE LIQUIDEZ: liquidez que entra al pool suele preceder movimiento;
    // liquidez que se va es señal de que los proveedores se están retirando.
    const liq = parseFloat(a.reserve_in_usd) || 0;
    const vol24 = parseFloat(a.volume_usd?.h24) || 0;
    if(liq > 0 && vol24 > 0){
      medidas++;
      const rotacion = vol24/liq;   // cuántas veces se dio vuelta la liquidez en un día
      señales.push({
        tipo: 'Rotación de liquidez',
        valor: `${rotacion.toFixed(1)}x por día (liquidez $${(liq/1000).toFixed(0)}K, volumen $${(vol24/1000).toFixed(0)}K)`,
        sesgo: 'neutro',
        alerta: rotacion > 8 ? 'Rotación muy alta: mucho movimiento para la liquidez que hay, los precios se mueven fácil.'
              : rotacion < 0.3 ? 'Rotación muy baja: pool dormido, poca actividad real.' : null,
      });
      if(liq < 50000) señales.push({ tipo:'Liquidez baja', valor:`Solo $${(liq/1000).toFixed(0)}K en el pool`, sesgo:'neutro',
        alerta:'Con tan poca liquidez, una sola orden grande mueve el precio. Cuidado con el slippage.' });
    }

    if(!medidas) return null;

    const presion = Math.max(-1, Math.min(1, puntaje/Math.max(1, medidas)));
    const fuerza = Math.round(Math.abs(presion)*100);
    const direccion = presion > 0.15 ? 'LONG' : presion < -0.15 ? 'SHORT' : 'NEUTRO';
    const acompana = dirTesis && direccion !== 'NEUTRO'
      ? (direccion === dirTesis ? 'acompaña' : 'contradice') : null;

    return {
      presion: +presion.toFixed(3),
      direccion, fuerza, señales,
      acompana,
      liquidezUsd: liq,
      resumen: direccion === 'NEUTRO'
        ? 'La actividad on-chain no muestra un sesgo claro.'
        : `La actividad on-chain apunta a ${direccion} con fuerza ${fuerza}/100${acompana ? ` — ${acompana} esta operación` : ''}.`,
      aclaracion: 'Lee la actividad real de los pools de DEX (compras contra ventas, liquidez, volumen). No identifica quién opera: para eso haría falta Arkham o Nansen, que son de pago.',
    };
  }catch(e){ return null; }
}

// ═══ DETECTOR DE ACTIVIDAD ANÓMALA ═══
// No identifica QUIÉN mueve el dinero — para eso haría falta Arkham o Nansen, que son de pago.
// Lo que SÍ se puede con datos gratuitos es detectar que ALGO RARO está pasando: movimientos que
// no encajan con el comportamiento normal de esa moneda.
// La idea: alguien grande operando deja huellas aunque no sepamos quién es. Volumen que aparece
// de la nada, posiciones que se abren de golpe, precio que se mueve sin volumen que lo justifique.
function detectActividadAnomala(candles, contexto = {}){
  if(!candles || candles.length < 60) return null;

  const señales = [];
  let puntaje = 0;
  const ultima = candles.at(-1);
  const v50 = candles.slice(-50);

  // 1) VOLUMEN FUERA DE LO NORMAL
  // Se compara contra la desviación típica, no contra el promedio: así detecta lo verdaderamente
  // raro y no cualquier vela un poco más grande.
  const vols = v50.map(c=>c.v).filter(v=>v>0);
  if(vols.length >= 30){
    const media = vols.reduce((a,b)=>a+b,0)/vols.length;
    const desv = Math.sqrt(vols.reduce((s,v)=>s+Math.pow(v-media,2),0)/vols.length);
    if(desv > 0){
      const z = (ultima.v - media)/desv;
      if(z >= 4){ puntaje += 3; señales.push({ tipo:'volumen', nivel:'extremo', texto:`Volumen ${z.toFixed(1)} desviaciones sobre lo normal — es un movimiento muy fuera de lo habitual para esta moneda.` }); }
      else if(z >= 2.5){ puntaje += 2; señales.push({ tipo:'volumen', nivel:'alto', texto:`Volumen ${z.toFixed(1)} desviaciones sobre lo normal.` }); }
    }
  }

  // 2) VOLUMEN SIN MOVIMIENTO DE PRECIO
  // Mucho volumen y el precio casi no se mueve: alguien está absorbiendo órdenes.
  // Es una de las huellas más claras de un participante grande acumulando o distribuyendo.
  const rango = ultima.h - ultima.l;
  const cuerpo = Math.abs(ultima.c - ultima.o);
  const volPromedio = vols.length ? vols.reduce((a,b)=>a+b,0)/vols.length : 0;
  if(volPromedio > 0 && ultima.v > volPromedio*2.5 && rango > 0 && cuerpo/rango < 0.25){
    puntaje += 3;
    señales.push({ tipo:'absorción', nivel:'alto',
      texto:`Volumen ${(ultima.v/volPromedio).toFixed(1)}x el promedio pero el precio casi no se movió. Alguien está absorbiendo las órdenes — suele preceder un movimiento.` });
  }

  // 3) MOVIMIENTO DE PRECIO SIN VOLUMEN
  // Lo contrario: el precio se mueve fuerte con poco volumen. En monedas chicas suele significar
  // que el libro está vacío y basta poca plata para mover el precio.
  const cambioPct = Math.abs((ultima.c - ultima.o)/ultima.o*100);
  if(volPromedio > 0 && cambioPct > 3 && ultima.v < volPromedio*0.6){
    puntaje += 2;
    señales.push({ tipo:'libro vacío', nivel:'medio',
      texto:`El precio se movió ${cambioPct.toFixed(1)}% con volumen por debajo del promedio. El libro de órdenes está fino: con poca plata se mueve mucho, y eso se corta en cualquier momento.` });
  }

  // 4) SALTO REPENTINO DEL INTERÉS ABIERTO
  // Si el OI sube de golpe, hay dinero nuevo entrando a posiciones. Combinado con precio plano,
  // es señal de que alguien está armando una posición grande.
  if(contexto.oiCambioPct != null){
    if(Math.abs(contexto.oiCambioPct) >= 15){
      puntaje += 2;
      señales.push({ tipo:'interés abierto', nivel:'alto',
        texto:`El interés abierto ${contexto.oiCambioPct>0?'subió':'bajó'} ${Math.abs(contexto.oiCambioPct).toFixed(0)}% de golpe. ${contexto.oiCambioPct>0?'Están abriendo posiciones nuevas en masa.':'Están cerrando posiciones en masa.'}` });
    }
  }

  // 5) FUNDING EXTREMO
  // Un funding muy alto significa que hay demasiada gente del mismo lado pagando por estar ahí.
  // Es la antesala típica de una liquidación en cadena.
  if(contexto.funding != null){
    const f = contexto.funding;
    if(Math.abs(f) >= 0.08){
      puntaje += 3;
      señales.push({ tipo:'funding', nivel:'extremo',
        texto:`Funding en ${f.toFixed(3)}%: hay muchísima gente ${f>0?'en largo':'en corto'} pagando por mantener la posición. Ese desbalance suele terminar en liquidaciones en cadena.` });
    } else if(Math.abs(f) >= 0.05){
      puntaje += 2;
      señales.push({ tipo:'funding', nivel:'alto', texto:`Funding en ${f.toFixed(3)}%, bastante desbalanceado hacia ${f>0?'los largos':'los cortos'}.` });
    }
  }

  // 6) CAMBIO BRUSCO EN EL POSICIONAMIENTO DE LOS GRANDES
  // Si el ratio long/short de los top traders se da vuelta rápido, los que más información
  // manejan están cambiando de opinión.
  if(contexto.ratioAnterior != null && contexto.ratioActual != null && contexto.ratioAnterior > 0){
    const cambio = (contexto.ratioActual - contexto.ratioAnterior)/contexto.ratioAnterior*100;
    if(Math.abs(cambio) >= 20){
      puntaje += 2;
      señales.push({ tipo:'posicionamiento', nivel:'alto',
        texto:`Los traders grandes cambiaron su posicionamiento un ${Math.abs(cambio).toFixed(0)}% ${cambio>0?'hacia largos':'hacia cortos'} en poco tiempo.` });
    }
  }

  // 7) MECHA LARGA CON VOLUMEN — barrido de liquidez
  // El precio va a buscar stops, los toma, y vuelve. La huella clásica de una cacería.
  const mechaArriba = ultima.h - Math.max(ultima.o, ultima.c);
  const mechaAbajo = Math.min(ultima.o, ultima.c) - ultima.l;
  if(rango > 0 && volPromedio > 0 && ultima.v > volPromedio*2){
    if(mechaArriba/rango > 0.6){
      puntaje += 2;
      señales.push({ tipo:'barrido', nivel:'alto',
        texto:`Mecha larga hacia arriba con volumen alto: el precio subió a buscar stops y volvió. Barrido de liquidez.` });
    } else if(mechaAbajo/rango > 0.6){
      puntaje += 2;
      señales.push({ tipo:'barrido', nivel:'alto',
        texto:`Mecha larga hacia abajo con volumen alto: el precio bajó a buscar stops y volvió. Barrido de liquidez.` });
    }
  }

  // 8) SECUENCIA DE VELAS GRANDES SEGUIDAS
  // Varias velas fuertes del mismo lado con volumen creciente: alguien está entrando en serio.
  const ultimas5 = candles.slice(-5);
  const mismaDireccion = ultimas5.every(c => c.c > c.o) || ultimas5.every(c => c.c < c.o);
  const volCreciente = ultimas5.slice(1).every((c,i) => c.v >= ultimas5[i].v * 0.9);
  if(mismaDireccion && volCreciente && volPromedio > 0 && ultimas5.at(-1).v > volPromedio*1.5){
    puntaje += 2;
    señales.push({ tipo:'acumulación', nivel:'medio',
      texto:`Cinco velas seguidas ${ultimas5[0].c>ultimas5[0].o?'alcistas':'bajistas'} con volumen creciendo. Parece entrada sostenida, no una operación suelta.` });
  }

  if(!señales.length) return { hayAlgo:false, puntaje:0, señales:[], resumen:'Actividad normal, sin nada fuera de lo habitual.' };

  const nivel = puntaje >= 7 ? 'MUY ALTA' : puntaje >= 4 ? 'ALTA' : 'MODERADA';
  return {
    hayAlgo: true,
    puntaje,
    nivel,
    señales,
    resumen: `${nivel === 'MUY ALTA' ? '🚨' : nivel === 'ALTA' ? '⚠️' : 'ℹ️'} Actividad inusual (${nivel.toLowerCase()}): ${señales.map(s=>s.tipo).join(', ')}.`,
    detalle: señales.map(s=>s.texto).join(' '),
    // Aclaración deliberada: esto NO dice quién está operando.
    aclaracion: 'Esto detecta que algo fuera de lo normal está pasando, pero no identifica quién lo hace. Para saber qué billeteras están detrás haría falta Arkham o Nansen, que son de pago.',
  };
}

// ═══ COSTE REAL DE OPERACIÓN ═══
// Un backtest puede verse hermoso y perder plata en la práctica. En cap chico especialmente:
// el spread es ancho, la liquidez es poca y el slippage se come una parte del movimiento.
// Esta función descuenta comisiones, funding y slippage estimado para mostrar el resultado NETO.
// Valores por defecto: comisión taker de Binance futuros (0,05% por lado) y slippage conservador
// para monedas chicas. Se pueden ajustar si medís los tuyos reales.
const COSTES = {
  comisionPorLado: 0.0005,   // 0,05% al abrir + 0,05% al cerrar
  slippageCapChico: 0.0015,  // 0,15% estimado por lado en monedas de baja liquidez
  slippageNormal: 0.0003,    // 0,03% en pares líquidos
  fundingPorDia: 0.0003,     // ~0,01% cada 8hs, aproximado
};

function calcularCosteReal(trade, opciones = {}){
  const cfg = { ...COSTES, ...opciones };
  const esCapChico = (trade.tag||'').includes('cap chico');
  const slip = esCapChico ? cfg.slippageCapChico : cfg.slippageNormal;

  // Cuántas veces se entra y sale: apertura + TP1 parcial + cierre final
  const operacionesParciales = trade.partialTaken ? 3 : 2;
  const comisionTotal = cfg.comisionPorLado * operacionesParciales;
  const slippageTotal = slip * operacionesParciales;

  // Funding: solo si la operación duró más de 8 horas
  let horasAbierta = null, costeFunding = 0;
  if(trade.entryTs && trade.closedAt) horasAbierta = (trade.closedAt - trade.entryTs)/3600000;
  else if(trade.registro?.horasHastaConfirmar != null && trade.closedAt && trade.detectedAt){
    horasAbierta = (trade.closedAt - trade.detectedAt)/3600000 - trade.registro.horasHastaConfirmar;
  }
  if(horasAbierta && horasAbierta > 8) costeFunding = cfg.fundingPorDia * (horasAbierta/24);

  const costeTotalPct = (comisionTotal + slippageTotal + costeFunding) * 100;
  const brutoPct = trade.pnlPct ?? 0;
  const netoPct = +(brutoPct - costeTotalPct).toFixed(3);

  return {
    brutoPct: +brutoPct.toFixed(3),
    comisionPct: +(comisionTotal*100).toFixed(3),
    slippagePct: +(slippageTotal*100).toFixed(3),
    fundingPct: +(costeFunding*100).toFixed(3),
    costeTotalPct: +costeTotalPct.toFixed(3),
    netoPct,
    // Si el resultado cambia de signo al descontar costes, es una señal de alarma
    cambiaDeSigno: (brutoPct > 0 && netoPct <= 0),
    horasAbierta: horasAbierta != null ? +horasAbierta.toFixed(1) : null,
  };
}

// Resumen de costes sobre todas las operaciones: cuánto se lleva la ejecución.
function resumenCostes(closedTrades, opciones = {}){
  const trades = (closedTrades||[]).filter(t => t.pnlPct != null);
  if(trades.length < 5) return { listo:false, nota:`Hacen falta al menos 5 operaciones. Hay ${trades.length}.` };

  const detalles = trades.map(t => calcularCosteReal(t, opciones));
  const suma = campo => +detalles.reduce((s,d)=>s+d[campo],0).toFixed(2);
  const brutoTotal = suma('brutoPct'), netoTotal = suma('netoPct'), costeTotal = suma('costeTotalPct');
  const cambianSigno = detalles.filter(d=>d.cambiaDeSigno).length;
  const ganadorasBruto = detalles.filter(d=>d.brutoPct>0).length;
  const ganadorasNeto = detalles.filter(d=>d.netoPct>0).length;

  return {
    listo: true,
    operaciones: trades.length,
    brutoTotal, netoTotal, costeTotal,
    costePromedioPorOperacion: +(costeTotal/trades.length).toFixed(3),
    winRateBruto: +(ganadorasBruto/trades.length*100).toFixed(1),
    winRateNeto: +(ganadorasNeto/trades.length*100).toFixed(1),
    operacionesQueCambianDeSigno: cambianSigno,
    conclusion: (()=>{
      const partes = [];
      partes.push(`Los costes de ejecución se llevan ${costeTotal.toFixed(1)} puntos porcentuales en total (${(costeTotal/trades.length).toFixed(2)}% por operación).`);
      if(cambianSigno > 0) partes.push(`⚠️ ${cambianSigno} operación(es) que aparecían como ganadoras terminan en pérdida al descontar costes.`);
      if(brutoTotal > 0 && netoTotal <= 0) partes.push(`⚠️ El resultado pasa de ${brutoTotal.toFixed(1)}% bruto a ${netoTotal.toFixed(1)}% neto: la ventaja desaparece con los costes reales.`);
      else if(netoTotal > 0) partes.push(`El resultado sigue siendo positivo después de costes: ${netoTotal.toFixed(1)}%.`);
      return partes.join(' ');
    })(),
    nota: 'Comisión 0,05% por lado, slippage 0,15% en cap chico y funding aproximado. Son estimaciones — si medís los tuyos reales, se pueden ajustar.',
  };
}

// ═══ WALK-FORWARD / FUERA DE MUESTRA ═══
// El problema que resuelve: si el Research Center mira TODO el historial y encuentra que "BOS en
// horario 12-18h gana 70%", puede estar describiendo casualidades de ese historial en particular.
// La única forma de saber si un patrón es real es encontrarlo en una parte de los datos y
// comprobarlo en OTRA que nunca se miró.
// Divide las operaciones por fecha: las primeras para investigar, las últimas para validar.
function validarFueraDeMuestra(closedTrades, proporcionEntrenamiento = 0.7){
  const ordenadas = (closedTrades||[])
    .filter(t => t.closedAt && t.pnlPct != null)
    .sort((a,b) => a.closedAt - b.closedAt);

  if(ordenadas.length < 30){
    return { listo:false, operaciones: ordenadas.length,
      nota:`Hacen falta al menos 30 operaciones para dividir en muestra de investigación y validación. Hay ${ordenadas.length}.` };
  }

  const corte = Math.floor(ordenadas.length * proporcionEntrenamiento);
  const entrenamiento = ordenadas.slice(0, corte);
  const validacion = ordenadas.slice(corte);

  const wr = arr => arr.length ? +(arr.filter(t=>t.pnlPct>0).length/arr.length*100).toFixed(1) : null;
  const wrGlobalEnt = wr(entrenamiento);

  // Se buscan patrones SOLO en la parte de entrenamiento
  const buscarPatrones = (arr, base) => {
    const encontrados = [];
    const agrupar = (etiqueta, fn) => {
      const g = {};
      for(const t of arr){ const k = fn(t); if(k==null) continue; (g[k]=g[k]||[]).push(t); }
      for(const [clave, sub] of Object.entries(g)){
        if(sub.length < 8) continue;
        const w = wr(sub);
        // El umbral se adapta al tamaño del grupo: con pocas operaciones hace falta una diferencia
        // más grande para que signifique algo. Un umbral fijo de 15 puntos era ciego con muestras
        // chicas (dejaba pasar diferencias reales de 11 puntos sobre 24 operaciones).
        const umbral = sub.length >= 40 ? 8 : sub.length >= 20 ? 10 : 15;
        if(Math.abs(w - base) >= umbral) encontrados.push({ etiqueta, clave, winRate:w, diferencia:+(w-base).toFixed(1), operaciones:sub.length, umbralUsado:umbral });
      }
    };
    agrupar('Camino', t => t.tipoSetup ?? null);
    agrupar('Dirección', t => t.dir ?? null);
    agrupar('Fase', t => t.marketPhase ?? null);
    agrupar('Liquidez', t => t.registro?.liquidezAFavor ?? null);
    return encontrados;
  };

  const patrones = buscarPatrones(entrenamiento, wrGlobalEnt);
  const wrGlobalVal = wr(validacion);

  // Cada patrón encontrado se comprueba en la parte que nunca se miró
  const resultados = patrones.map(p => {
    const enValidacion = validacion.filter(t => {
      const v = p.etiqueta==='Camino' ? t.tipoSetup
              : p.etiqueta==='Dirección' ? t.dir
              : p.etiqueta==='Fase' ? t.marketPhase
              : t.registro?.liquidezAFavor;
      return v === p.clave;
    });
    if(enValidacion.length < 5){
      return { ...p, validado:null, wrValidacion:null, veredicto:'Sin casos suficientes en la muestra de validación.' };
    }
    const wVal = wr(enValidacion);
    const difVal = +(wVal - wrGlobalVal).toFixed(1);
    // Se considera validado si mantiene la misma dirección y al menos la mitad de la ventaja
    const mismaDireccion = Math.sign(difVal) === Math.sign(p.diferencia);
    const mantiene = mismaDireccion && Math.abs(difVal) >= Math.abs(p.diferencia)*0.5;
    return {
      ...p,
      wrValidacion: wVal,
      difValidacion: difVal,
      opsValidacion: enValidacion.length,
      validado: mantiene,
      veredicto: mantiene
        ? `✅ SE MANTIENE: en investigación daba ${p.diferencia>0?'+':''}${p.diferencia} puntos, en validación ${difVal>0?'+':''}${difVal}. El patrón parece real.`
        : mismaDireccion
        ? `🟡 SE DEBILITA: la ventaja bajó de ${p.diferencia>0?'+':''}${p.diferencia} a ${difVal>0?'+':''}${difVal} puntos. Puede ser parcialmente real.`
        : `❌ NO SE MANTIENE: en investigación daba ${p.diferencia>0?'+':''}${p.diferencia} y en validación ${difVal>0?'+':''}${difVal}. Era ruido del período analizado.`,
    };
  });

  const validados = resultados.filter(r => r.validado === true);
  return {
    listo: true,
    operaciones: ordenadas.length,
    entrenamiento: { operaciones: entrenamiento.length, winRate: wrGlobalEnt },
    validacion: { operaciones: validacion.length, winRate: wrGlobalVal },
    patronesEncontrados: patrones.length,
    resultados,
    validados: validados.length,
    conclusion: !patrones.length
      ? 'No se encontró ningún patrón en la muestra de investigación, así que no hay nada para validar.'
      : validados.length
      ? `De ${patrones.length} patrones encontrados, ${validados.length} se mantuvieron en datos que nunca se miraron. Esos son los únicos en los que confiaría para cambiar el motor.`
      : `⚠️ Ninguno de los ${patrones.length} patrones encontrados se sostuvo fuera de muestra. Eso sugiere que eran casualidades del período analizado, no ventajas reales.`,
    nota: 'La muestra de validación nunca se usa para buscar patrones, solo para comprobarlos. Un patrón que no sobrevive acá no debería cambiar nada del motor.',
  };
}

// ═══ COMBINACIONES DE COMPONENTES ═══
// Un componente puede no aportar solo, pero sí cuando coincide con otro. Esta función mide los
// PARES: qué pasa cuando Tendencia y Estructura empujan juntos, comparado con cuando va uno solo.
// Es lo que eventualmente podría justificar cambiar los pesos — pero solo con muestra suficiente.
function combinacionDioses(closedTrades, minMuestra = 10){
  const conR = (closedTrades||[])
    .filter(t => t.registro?.componentes?.length && t.registro?.gestion?.stopPct > 0 && t.pnlPct != null)
    .map(t => ({ ...t, rObtenido: +(t.pnlPct/t.registro.gestion.stopPct).toFixed(3) }));

  if(conR.length < minMuestra*2){
    return { listo:false, operaciones: conR.length,
      nota:`Hacen falta al menos ${minMuestra*2} operaciones con componentes registrados. Hay ${conR.length}.` };
  }

  // Un componente "empujó" si su aporte fue significativo Y a favor de la dirección de la operación
  const empujo = (t, nombre) => {
    const cp = t.registro.componentes.find(x=>x.n===nombre);
    if(!cp || Math.abs(cp.aporte) < 0.3) return false;
    return t.dir==='LONG' ? cp.aporte > 0 : cp.aporte < 0;
  };
  const nombres = [...new Set(conR.flatMap(t=>t.registro.componentes.map(cp=>cp.n)))];
  const expect = arr => arr.length ? +(arr.reduce((s,t)=>s+t.rObtenido,0)/arr.length).toFixed(3) : null;

  // Individuales
  const individuales = nombres.map(n => {
    const con = conR.filter(t=>empujo(t,n));
    return con.length >= minMuestra ? { componentes:[n], operaciones:con.length, expectancy:expect(con) } : null;
  }).filter(Boolean);

  // Pares
  const pares = [];
  for(let i=0;i<nombres.length;i++){
    for(let j=i+1;j<nombres.length;j++){
      const con = conR.filter(t => empujo(t,nombres[i]) && empujo(t,nombres[j]));
      if(con.length < minMuestra) continue;
      const e = expect(con);
      const soloA = individuales.find(x=>x.componentes[0]===nombres[i])?.expectancy;
      const soloB = individuales.find(x=>x.componentes[0]===nombres[j])?.expectancy;
      const mejorSolo = (soloA!=null && soloB!=null) ? Math.max(soloA, soloB) : (soloA ?? soloB);
      pares.push({
        componentes: [nombres[i], nombres[j]],
        operaciones: con.length,
        expectancy: e,
        mejorIndividual: mejorSolo,
        // Sinergia: ¿juntos rinden más que el mejor de los dos por separado?
        sinergia: mejorSolo!=null ? +(e - mejorSolo).toFixed(3) : null,
        confianza: con.length >= 40 ? 'alta' : con.length >= 20 ? 'media' : 'baja',
      });
    }
  }
  // COMBINACIONES CON EVIDENCIA EXTERNA
  // Responde la pregunta concreta: "cuando el on-chain acompañaba Y el componente empujaba,
  // ¿el resultado fue mejor que con el componente solo?". Es la única forma de saber si vale
  // la pena darle peso al on-chain, en vez de asumirlo porque suena razonable.
  for(const nombre of nombres){
    const conAmbos = conR.filter(t => empujo(t, nombre) && t.registro?.onChain?.acompana === 'acompaña');
    if(conAmbos.length < minMuestra) continue;
    const e = expect(conAmbos);
    const solo = individuales.find(x=>x.componentes[0]===nombre)?.expectancy;
    pares.push({
      componentes: [nombre, 'On-chain acompaña'],
      operaciones: conAmbos.length,
      expectancy: e,
      mejorIndividual: solo ?? null,
      sinergia: solo != null ? +(e - solo).toFixed(3) : null,
      confianza: conAmbos.length >= 40 ? 'alta' : conAmbos.length >= 20 ? 'media' : 'baja',
    });
  }
  pares.sort((a,b)=>b.expectancy-a.expectancy);

  const conSinergia = pares.filter(p => p.sinergia != null && p.sinergia >= 0.15 && p.confianza !== 'baja');
  return {
    listo: true,
    operaciones: conR.length,
    individuales: individuales.sort((a,b)=>b.expectancy-a.expectancy),
    pares,
    nota: conSinergia.length
      ? `${conSinergia.length} combinación(es) rinden más juntas que por separado. Eso sí sería un argumento para revisar pesos — pero con muestra mayor.`
      : 'Ninguna combinación muestra sinergia clara todavía. Los componentes parecen aportar de forma independiente.',
  };
}

// ═══ SIMULADOR DE OBJETIVOS (TP) ═══
// Igual que el de stops pero al revés: prueba distintos múltiplos de R como objetivo, usando el
// MFE registrado. Si el MFE de una operación fue 1.4R, un TP a 1.2R se habría alcanzado y uno a
// 2R no. Contempla el porcentaje que se cierra en cada objetivo, no solo si se toca.
function simularTPs(closedTrades, multiplicadores = [0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5]){
  const conDatos = (closedTrades||[]).filter(t =>
    t.registro?.mfe != null && t.registro?.mae != null && t.registro?.gestion?.stopPct != null);

  if(conDatos.length < 10){
    return { listo:false, operaciones: conDatos.length,
      nota:`Hacen falta al menos 10 operaciones con MFE registrado. Hay ${conDatos.length}.` };
  }

  const filas = multiplicadores.map(tp => {
    let sumaR = 0, alcanzados = 0, stopeados = 0;
    for(const t of conDatos){
      const maeR = Math.abs(t.registro.mae), mfeR = t.registro.mfe;
      // Si el retroceso superó 1R (el stop), la operación muere antes
      if(maeR >= 1.0){ sumaR -= 1; stopeados++; continue; }
      if(mfeR >= tp){
        // Se toma 50% en el objetivo y el resto se asume cerrado en breakeven
        sumaR += tp * 0.5;
        alcanzados++;
      }
      // Si no llegó al objetivo ni al stop, se asume cierre neutro
    }
    return {
      tpEnR: tp,
      alcanzados,
      pctAlcanzado: +(alcanzados/conDatos.length*100).toFixed(1),
      stopeados,
      expectancy: +(sumaR/conDatos.length).toFixed(3),
      resultadoTotalR: +sumaR.toFixed(2),
    };
  });

  const mejor = filas.reduce((a,b)=> b.expectancy > a.expectancy ? b : a);
  const actual = filas.find(f=>f.tpEnR === 1.0) || filas[0];
  const dif = +(mejor.expectancy - actual.expectancy).toFixed(3);

  return {
    listo: true,
    operaciones: conDatos.length,
    filas, mejor, actual,
    recomendarCambio: conDatos.length >= 30 && Math.abs(dif) >= 0.10,
    conclusion: conDatos.length < 30
      ? `Con ${conDatos.length} operaciones no alcanza para recomendar un cambio de objetivo. Hacen falta al menos 30.`
      : Math.abs(dif) < 0.10
      ? `Ningún objetivo mejora de forma clara al actual (diferencia de ${dif}R). Sin evidencia para cambiarlo.`
      : `Un TP1 a ${mejor.tpEnR}R habría dado ${dif>0?'+':''}${dif}R más por operación (se alcanza el ${mejor.pctAlcanzado}% de las veces, contra ${actual.pctAlcanzado}% del actual).`,
    advertencia: 'Asume que el resto de la posición cierra en breakeven y que el recorrido habría sido igual. Aproximación para orientar, no para decidir sola.',
  };
}

// ═══ MONTE CARLO ═══
// El win rate y el resultado final dependen mucho del ORDEN en que aparecieron las operaciones.
// Si las 5 perdedoras cayeron juntas al principio, el drawdown fue grande; si estuvieron repartidas,
// mucho menor. Esta simulación baraja el orden miles de veces y muestra la distribución real de
// resultados posibles — incluido el peor caso razonable, que es lo que importa para sobrevivir.
function monteCarlo(closedTrades, iteraciones = 2000){
  const rs = (closedTrades||[])
    .filter(t => t.pnlUsd != null && t.registro?.gestion?.stopPct)
    .map(t => {
      // Resultado en múltiplos de R: cuánto se ganó respecto a lo que se arriesgaba
      const riesgoPct = t.registro.gestion.stopPct;
      return riesgoPct > 0 && t.pnlPct != null ? +(t.pnlPct/riesgoPct).toFixed(3) : null;
    })
    .filter(x => x != null);

  if(rs.length < 20){
    return { listo:false, operaciones: rs.length,
      nota:`Hacen falta al menos 20 operaciones para que Monte Carlo tenga sentido. Hay ${rs.length}.` };
  }

  const capitalesFinales = [];
  const drawdowns = [];
  const peoresRachas = [];

  for(let it=0; it<iteraciones; it++){
    // Se baraja el orden (Fisher-Yates)
    const orden = [...rs];
    for(let i=orden.length-1; i>0; i--){
      const j = Math.floor(Math.random()*(i+1));
      [orden[i], orden[j]] = [orden[j], orden[i]];
    }
    let capital = 100, pico = 100, dd = 0, rachaActual = 0, peorRacha = 0;
    for(const r of orden){
      capital += capital * 0.02 * r; // 2% de riesgo por operación
      pico = Math.max(pico, capital);
      dd = Math.max(dd, (pico-capital)/pico);
      if(r < 0){ rachaActual++; peorRacha = Math.max(peorRacha, rachaActual); }
      else rachaActual = 0;
    }
    capitalesFinales.push(capital);
    drawdowns.push(dd*100);
    peoresRachas.push(peorRacha);
  }

  const percentil = (arr, p) => {
    const o = [...arr].sort((a,b)=>a-b);
    return +o[Math.floor(o.length*p)].toFixed(2);
  };
  const prom = arr => +(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2);

  const perdieron = capitalesFinales.filter(x => x < 100).length;
  const ruina = capitalesFinales.filter(x => x < 50).length; // perder la mitad del capital

  return {
    listo: true,
    operaciones: rs.length,
    iteraciones,
    capital: {
      peor: percentil(capitalesFinales, 0.01),
      malo: percentil(capitalesFinales, 0.05),
      mediana: percentil(capitalesFinales, 0.5),
      bueno: percentil(capitalesFinales, 0.95),
    },
    drawdown: {
      tipico: percentil(drawdowns, 0.5),
      malo: percentil(drawdowns, 0.95),
      peor: percentil(drawdowns, 0.99),
    },
    peorRachaTipica: Math.round(prom(peoresRachas)),
    peorRachaPosible: Math.max(...peoresRachas),
    probPerder: +(perdieron/iteraciones*100).toFixed(1),
    probRuina: +(ruina/iteraciones*100).toFixed(1),
    conclusion: (()=>{
      const med = percentil(capitalesFinales, 0.5);
      const ddMalo = percentil(drawdowns, 0.95);
      const partes = [];
      partes.push(med >= 100
        ? `En la mitad de los escenarios el capital termina en ${med} o más.`
        : `⚠️ En la mitad de los escenarios el capital termina en ${med} — o sea, perdiendo.`);
      partes.push(`El drawdown puede llegar a ${ddMalo}% en 1 de cada 20 secuencias.`);
      partes.push(`Hay que estar preparado para ${Math.round(prom(peoresRachas))} pérdidas seguidas como algo normal (hasta ${Math.max(...peoresRachas)} en el peor caso).`);
      if(ruina/iteraciones > 0.05) partes.push(`⚠️ En el ${(ruina/iteraciones*100).toFixed(1)}% de los escenarios se pierde más de la mitad del capital.`);
      return partes.join(' ');
    })(),
  };
}

// ═══ POST-MORTEM DE UNA OPERACIÓN ═══
// Después de cerrar, responde: ¿qué esperaba el bot, qué pasó, qué componente acertó y cuál falló?
// Todo sale de datos registrados — no infiere ni inventa nada. Si un dato no está, lo dice.
function postMortem(trade, historial = []){
  if(!trade) return null;
  const r = trade.registro || {};
  const g = r.gestion || {};
  // El resultado se juzga por la plata REAL, no solo por el precio de salida.
  // Una operación que tomó ganancia en TP1 y después cerró el resto en breakeven GANÓ,
  // aunque el precio final sea igual al de entrada. Antes esto se reportaba como PERDIDA.
  const pnlReal = Number.isFinite(trade.pnlUsd) ? trade.pnlUsd : null;
  const gano = pnlReal != null ? pnlReal > 0 : trade.pnlPct > 0;
  const empate = pnlReal != null ? Math.abs(pnlReal) < 0.01 : Math.abs(trade.pnlPct||0) < 0.01;
  const secciones = [];
  const aciertos = [];
  const fallos = [];

  // 1) Qué esperaba vs qué pasó — reconociendo si TP1 se alcanzó de verdad
  const logrado = r.mfe!=null ? `${r.mfe}R a favor` : 'sin dato de recorrido';
  if(trade.alcanzoTp1){
    secciones.push(`Alcanzó TP1 y se tomó la ganancia parcial. Llegó a ${logrado}${r.mae!=null?`, con un retroceso máximo de ${Math.abs(r.mae)}R`:''}. ${trade.motivoCierre==='stop tras toma parcial' ? 'El resto cerró en el stop, que ya estaba en el punto de entrada.' : ''}`);
  } else {
    const esperado = g.rTp1!=null ? `alcanzar al menos ${g.rTp1}R (TP1)` : 'alcanzar TP1';
    secciones.push(`Esperaba ${esperado}. Llegó a ${logrado}${r.mae!=null?`, con un retroceso máximo de ${Math.abs(r.mae)}R`:''}.`);
  }

  // 2) Qué componente acertó y cuál falló
  // Un componente "acertó" si empujó hacia la dirección que terminó siendo correcta.
  if(r.componentes?.length){
    const direccionCorrecta = gano ? 1 : -1; // 1 = la dirección de la tesis funcionó
    for(const cp of r.componentes){
      if(Math.abs(cp.aporte) < 0.2) continue; // no empujó lo suficiente para juzgarlo
      const empujoAFavor = trade.dir==='LONG' ? cp.aporte > 0 : cp.aporte < 0;
      if((empujoAFavor && gano) || (!empujoAFavor && !gano)) aciertos.push(cp.n);
      else fallos.push(cp.n);
    }
  }

  // 3) ¿El stop fue demasiado corto?
  let notaStop = null;
  if(!gano && !trade.alcanzoTp1 && r.mfe!=null && r.mfe >= 0.8){
    notaStop = `⚠️ Llegó a ${r.mfe}R a favor antes de girar y tocar el stop. Con un objetivo parcial más cerca, esta operación podía cerrarse en positivo.`;
  } else if(!gano && r.mae!=null && Math.abs(r.mae) <= 1.05 && g.stopPct){
    notaStop = `El stop estaba a ${g.stopPct}% y el precio lo tocó casi justo. Si la tesis era correcta pero el stop quedó ajustado, conviene revisarlo con más casos.`;
  }

  // 4) ¿La fase estaba en contra?
  let notaFase = null;
  if(trade.marketPhase){
    const faseContra = (trade.dir==='LONG' && ['CLÍMAX','DISTRIBUCIÓN','MARKDOWN'].includes(trade.marketPhase))
                    || (trade.dir==='SHORT' && ['CAPITULACIÓN','ACUMULACIÓN','EXPANSIÓN ALCISTA'].includes(trade.marketPhase));
    if(faseContra) notaFase = `⚠️ La fase del mercado era ${trade.marketPhase}, que va en contra de un ${trade.dir}.`;
  }

  // 5) ¿La liquidez estaba en contra?
  const notaLiquidez = r.liquidezAFavor === 'en contra'
    ? '⚠️ La liquidez dominante estaba en contra de la operación.' : null;

  // 6) ¿Entró por válvula de escape?
  const notaEscape = r.porValvulaEscape
    ? '⚠️ Entró por válvula de escape (la tesis llevaba más de 8hs esperando), no por una confirmación fresca.' : null;

  // 7) Comparación con operaciones parecidas
  let notaHistorial = null;
  if(historial.length >= 10){
    const par = buscarTesisParecidas(historial, trade, 60);
    if(par.encontradas >= 5) notaHistorial = `Operaciones parecidas: ${par.resumen}`;
  }

  return {
    symbol: trade.symbol,
    resultado: empate ? 'EMPATE' : gano ? 'GANADA' : 'PERDIDA',
    pnlUsd: pnlReal,
    alcanzoTp1: !!trade.alcanzoTp1,
    pnlPct: trade.pnlPct,
    esperadoVsReal: secciones[0],
    componentesAcertaron: aciertos,
    componentesFallaron: fallos,
    notas: [notaStop, notaFase, notaLiquidez, notaEscape, notaHistorial].filter(Boolean),
    // Auditoría de ejecución: demuestra con números si el stop se tocó de verdad
    auditoria: trade.auditoria ? {
      minDesdeEntrada: trade.auditoria.minDesdeEntrada,
      maxDesdeEntrada: trade.auditoria.maxDesdeEntrada,
      slTocado: trade.auditoria.slTocadoDesdeEntrada,
      tp1Tocado: trade.auditoria.tp1TocadoDesdeEntrada,
    } : null,
    // Texto listo para mostrar
    texto: [
      `${empate?'➖':gano?'✅':'❌'} ${trade.symbol} ${trade.dir} — ${empate?'CERRADA EN EMPATE':gano?'GANADA':'PERDIDA'} (${pnlReal!=null?`${pnlReal>=0?'+':''}${pnlReal.toFixed(2)} USDT`:`${trade.pnlPct>=0?'+':''}${trade.pnlPct}%`})`,
      secciones[0],
      aciertos.length ? `Acertaron: ${aciertos.join(', ')}.` : null,
      fallos.length ? `Fallaron: ${fallos.join(', ')}.` : null,
      ...[notaStop, notaFase, notaLiquidez, notaEscape, notaHistorial].filter(Boolean),
      // Auditoría con números concretos, para no tener que mirar el gráfico y adivinar
      // AUDITORÍA POR TRAMOS: cada nivel se juzga con el stop que estaba activo en ese momento.
      // Antes se comparaba el mínimo de TODA la operación contra el stop FINAL (el breakeven),
      // y un retroceso anterior a TP1 aparecía como "tocó el breakeven". Ese era el caso PROM.
      (()=>{ const a = trade.auditoria;
        if(!a || a.minDesdeEntrada == null) return null;
        const fmt = v => v==null ? '—' : (v>=1 ? v.toFixed(4) : v.toPrecision(6));
        const esLong = trade.dir === 'LONG';
        const stopOrig = trade.originalStop ?? trade.stop;

        // Tramo 1: entrada → TP1, con el stop ORIGINAL
        const tocoStopOriginal = esLong
          ? a.minDesdeEntrada <= stopOrig
          : a.maxDesdeEntrada >= stopOrig;

        const lineas = [
          `\n🔎 <b>AUDITORÍA POR TRAMOS</b>`,
          `<i>Tramo 1 — entrada hasta TP1</i>`,
          `Entrada $${fmt(trade.entry)} · stop original $${fmt(stopOrig)}`,
          `Recorrido: mínimo $${fmt(a.minDesdeEntrada)} · máximo $${fmt(a.maxDesdeEntrada)}`,
          `¿Tocó el stop original? ${tocoStopOriginal ? '✅ sí' : '❌ no'}`,
          `¿Alcanzó TP1? ${trade.alcanzoTp1 ? '✅ sí' : '❌ no'}`,
        ];

        // Tramo 2: solo existe si se activó el breakeven
        if(trade.alcanzoTp1 && trade.breakEvenActivatedAt){
          const tocoBE = a.minDesdeBE == null && a.maxDesdeBE == null ? null
            : esLong ? a.minDesdeBE <= trade.entry : a.maxDesdeBE >= trade.entry;
          lineas.push(
            `\n<i>Tramo 2 — desde TP1, con el stop ya en el punto de entrada</i>`,
            `Breakeven en $${fmt(trade.entry)}`,
            a.minDesdeBE != null
              ? `Recorrido posterior: mínimo $${fmt(a.minDesdeBE)} · máximo $${fmt(a.maxDesdeBE)}`
              : `Sin recorrido posterior registrado`,
            `¿Volvió al breakeven? ${tocoBE === null ? '— sin datos' : tocoBE ? '✅ sí' : '❌ NO'}`,
          );
          if(tocoBE === false && (trade.motivoCierre||'').includes('breakeven')){
            lineas.push(`⚠️ Se cerró por breakeven pero el precio nunca volvió al nivel después de TP1 — revisar.`);
          }
        }
        return lineas.join('\n');
      })(),
    ].filter(Boolean).join('\n'),
  };
}

// ═══ RESEARCH CENTER ═══
// Analiza todas las operaciones cerradas y busca patrones reales: qué caminos funcionan, en qué
// horarios, con qué score, en qué fase de mercado. Genera HIPÓTESIS, no cambios automáticos.
// Deliberadamente NO modifica el motor: propone, y la decisión de aplicar algo es humana.
// Motivo: probamos cambios de pesos varias veces y casi todos empeoraron. Un sistema que se
// ajusta solo encontraría "mejoras" que son ruido estadístico y las aplicaría sin que nadie mire.
const MUESTRA_MINIMA = 10; // debajo de esto, cualquier porcentaje es ruido

function _wr(arr){ return arr.length ? +(arr.filter(t=>t.pnlPct>0).length/arr.length*100).toFixed(1) : null; }

function generarReporteResearch(closedTrades, opciones = {}){
  const trades = (closedTrades||[]).filter(t => t.pnlPct!=null);
  const wrGlobal = _wr(trades);
  const hallazgos = [];
  const advertencias = [];

  if(trades.length < MUESTRA_MINIMA){
    return {
      fecha: new Date().toISOString(),
      operaciones: trades.length,
      winRateGlobal: wrGlobal,
      hallazgos: [],
      advertencias: [`Solo hay ${trades.length} operaciones cerradas. Hacen falta al menos ${MUESTRA_MINIMA} para que cualquier patrón signifique algo. Hasta entonces, este reporte no puede sacar conclusiones.`],
      listoParaConcluir: false,
    };
  }

  // Agrupa por un campo y devuelve solo los grupos con muestra suficiente
  function analizarPor(campo, etiqueta, transformar){
    const grupos = {};
    for(const t of trades){
      const clave = transformar ? transformar(t) : (t[campo] ?? 'Sin dato');
      if(clave==null) continue;
      (grupos[clave] = grupos[clave] || []).push(t);
    }
    for(const [clave, arr] of Object.entries(grupos)){
      if(arr.length < MUESTRA_MINIMA) continue;
      const wr = _wr(arr);
      const diff = +(wr - wrGlobal).toFixed(1);
      // Solo se reporta si la diferencia es grande de verdad (15 puntos o más)
      if(Math.abs(diff) >= 15){
        hallazgos.push({
          tipo: etiqueta,
          valor: clave,
          operaciones: arr.length,
          winRate: wr,
          diferencia: diff,
          direccion: diff > 0 ? 'mejor' : 'peor',
          hipotesis: diff > 0
            ? `Cuando ${etiqueta.toLowerCase()} es "${clave}", el win rate sube a ${wr}% (${diff > 0 ? '+' : ''}${diff} puntos sobre el promedio de ${wrGlobal}%). Vale la pena investigar si conviene darle más peso.`
            : `Cuando ${etiqueta.toLowerCase()} es "${clave}", el win rate cae a ${wr}% (${diff} puntos bajo el promedio). Vale la pena investigar si conviene filtrarlo o restarle peso.`,
          confianza: arr.length >= 30 ? 'alta' : arr.length >= 20 ? 'media' : 'baja',
        });
      }
    }
  }

  analizarPor('tipoSetup', 'Camino de confirmación');
  analizarPor('dir', 'Dirección');
  analizarPor('tag', 'Tipo de moneda');
  analizarPor('marketPhase', 'Fase del mercado');
  analizarPor(null, 'Rango de score', t => t.score==null ? null : t.score>=8.5 ? '8.5 o más' : t.score>=8 ? '8.0 a 8.4' : t.score>=7.6 ? '7.6 a 7.9' : 'menos de 7.6');
  analizarPor(null, 'Horario (UTC)', t => t.horaConfirmacion==null ? null : t.horaConfirmacion<6 ? 'madrugada (0-5h)' : t.horaConfirmacion<12 ? 'mañana (6-11h)' : t.horaConfirmacion<18 ? 'tarde (12-17h)' : 'noche (18-23h)');
  analizarPor(null, 'Calidad de datos', t => t.dataQuality==null ? null : t.dataQuality>=85 ? 'alta (85+)' : t.dataQuality>=65 ? 'aceptable (65-84)' : 'baja (menos de 65)');

  // Dimensiones nuevas, que vienen del registro completo que ahora guarda cada operación.
  // Son justamente las preguntas que quedaron abiertas: ¿la liquidez en contra hace perder más?
  // ¿las entradas por válvula de escape son peores? ¿el Estocástico extremo importa?
  analizarPor(null, 'Liquidez', t => t.registro?.liquidezAFavor ?? null);
  analizarPor(null, 'Entrada por válvula de escape', t => t.registro?.porValvulaEscape==null ? null : (t.registro.porValvulaEscape ? 'sí (tesis vieja)' : 'no (confirmó rápido)'));
  analizarPor(null, 'Estocástico al entrar', t => t.registro?.estocastico==null ? null : t.registro.estocastico>=80 ? 'sobrecomprado (80+)' : t.registro.estocastico<=20 ? 'sobrevendido (20-)' : 'zona media');
  analizarPor(null, 'Divergencia', t => t.registro?.divergencia ?? (t.registro ? 'sin divergencia' : null));
  analizarPor(null, 'Fuerza del volumen', t => t.registro?.fuerzaVolumen==null ? null : t.registro.fuerzaVolumen>=60 ? 'compradora (60%+)' : t.registro.fuerzaVolumen<=40 ? 'vendedora (40%-)' : 'pareja');

  // ON-CHAIN: la pregunta concreta es si acompañar o contradecir la tesis cambia el resultado.
  // Si con muestra suficiente no hay diferencia, no hay que darle peso al score por más
  // razonable que suene la idea.
  analizarPor(null, 'On-chain', t => t.registro?.onChain?.acompana ?? (t.registro?.onChain ? 'neutro' : null));
  analizarPor(null, 'Fuerza on-chain', t => {
    const f = t.registro?.onChain?.fuerza;
    return f == null ? null : f >= 50 ? 'clara (50+)' : f >= 25 ? 'moderada (25-49)' : 'débil (menos de 25)';
  });
  analizarPor(null, 'Actividad anómala', t => t.registro?.actividadAnomala?.nivel ?? (t.registro ? 'sin nada raro' : null));
  // ¿El motor rinde distinto cuando la cuenta ya viene golpeada? Puede pasar por dos motivos:
  // el riesgo se reduce automáticamente en drawdown, o las condiciones de mercado que causaron
  // el drawdown siguen presentes. Vale la pena poder separarlo.
  // Wallet Intelligence: ¿los flujos de wallets predicen algo? Es la pregunta que justifica
  // toda esta capa. Si con muestra suficiente no hay diferencia, no hay que darle peso al score.
  analizarPor(null, 'Wallets', t => t.registro?.wallets?.acompana ?? (t.registro?.wallets ? 'neutro' : null));
  // Libro de órdenes y flujo real: ¿predicen algo o son ruido llamativo?
  analizarPor(null, 'Libro de órdenes', t => t.registro?.libro?.sesgo ?? null);
  // La afirmación central de la estrategia de la cinta: operar con cinta plana rinde peor.
  // Esto lo comprueba con datos reales en vez de darlo por cierto.
  // ¿El retroceso a la cinta rinde distinto que entrar sin retroceso?
  // ═══ LOS INDICADORES CLÁSICOS ═══
  // Son los que MÁS votan en el score y hasta ahora no se medía ninguno. El dato ya se
  // guardaba en cada operación (rsi, adx, estocastico); solo faltaba analizarlo.
  // Se agrupan en rangos porque "RSI 58" no dice nada suelto: lo que importa es si entrar
  // con RSI alto rinde distinto que entrar con RSI bajo.
  analizarPor(null, 'RSI al entrar', t => {
    const v = t.registro?.rsi;
    if(v == null) return null;
    return v >= 70 ? 'sobrecomprado (70+)' : v >= 55 ? 'alto (55-70)'
         : v >= 45 ? 'neutro (45-55)' : v >= 30 ? 'bajo (30-45)' : 'sobrevendido (-30)';
  });
  analizarPor(null, 'ADX al entrar', t => {
    const v = t.registro?.adx;
    if(v == null) return null;
    // Por debajo de 20 no hay tendencia; arriba de 40 puede estar agotándose
    return v >= 40 ? 'tendencia muy fuerte (40+)' : v >= 25 ? 'tendencia real (25-40)'
         : v >= 20 ? 'tendencia débil (20-25)' : 'sin tendencia (-20)';
  });
  // La volatilidad al entrar: puede ser el factor que explica por qué los stops se tocan
  analizarPor(null, 'Volatilidad al entrar', t => {
    const v = t.registro?.atrPct;
    if(v == null) return null;
    return v >= 8 ? 'muy alta (8%+)' : v >= 4 ? 'alta (4-8%)' : v >= 2 ? 'normal (2-4%)' : 'baja (-2%)';
  });
  // ¿El stop salió de una estructura real o fue un porcentaje fijo?
  analizarPor(null, 'Tipo de stop', t => t.registro?.stopEstructural == null ? null
    : (t.registro.stopEstructural ? 'estructural' : 'por porcentaje'));
  // El ancho del stop: los muy anchos dan menos tamaño, los muy finos se tocan por ruido
  analizarPor(null, 'Ancho del stop', t => {
    const v = t.registro?.gestion?.stopPct ?? t.registro?.stopPct;
    if(v == null) return null;
    return v >= 8 ? 'muy ancho (8%+)' : v >= 5 ? 'ancho (5-8%)' : v >= 3 ? 'normal (3-5%)' : 'fino (-3%)';
  });

  // ¿Rinde mejor respetar la decisión del motor que ignorarla? Es la medición más
  // importante: valida si toda la capa de decisión sirve para algo.
  analizarPor(null, 'Decisión del motor', t => t.registro?.decision?.accion ?? null);
  // ═══ ¿CONVIENE ALEJAR EL OBJETIVO? ═══
  // Ahora se cierra todo en TP1 (1.15R). La pregunta que sigue es si el precio habría
  // seguido hasta 1.5R o 1.8R. El MFE lo responde: es cuánto avanzó como máximo cada
  // operación antes de cerrarse. Si muchas ganadoras llegaron a 1.5R, vale la pena alejar
  // el objetivo; si se quedaron justo en 1.15R, moverlo sería regalar los aciertos.
  analizarPor(null, 'Hasta dónde llegó', t => {
    const mfe = t.registro?.mfe;
    if(mfe == null) return null;
    return mfe >= 2 ? 'pasó 2R' : mfe >= 1.8 ? 'llegó a 1.8R' : mfe >= 1.5 ? 'llegó a 1.5R'
         : mfe >= 1.15 ? 'llegó a TP1 (1.15R)' : mfe >= 0.5 ? 'se quedó a mitad' : 'no avanzó';
  });
  analizarPor(null, 'Entró con fuerza', t => t.registro?.decision?.fuerza == null ? null
    : (t.registro.decision.fuerza ? 'con fuerza' : 'sin fuerza'));
  analizarPor(null, 'Retroceso a la cinta', t => t.registro?.cinta == null ? null
    : (t.registro.cinta.tocoLaCinta ? 'volvió a la cinta' : 'entró sin retroceso'));
  analizarPor(null, 'Cinta de medias', t => t.registro?.cinta == null ? null
    : (t.registro.cinta.limpia ? (t.registro.cinta.alineada ? 'limpia y alineada' : 'limpia pero contraria') : 'plana o comprimida'));
  // La afirmación central de la estrategia de la cinta: operar con cinta plana rinde peor.
  // Esto lo comprueba con datos reales en vez de darlo por cierto.
  analizarPor(null, 'Cinta de medias', t => t.registro?.cinta == null ? null
    : (t.registro.cinta.limpia ? (t.registro.cinta.alineada ? 'limpia y alineada' : 'limpia pero contraria') : 'plana o comprimida'));
  // ¿El apalancamiento excesivo predice algo? Es la sospecha clásica: OI muy alto respecto al
  // market cap suele preceder movimientos violentos, pero hay que comprobarlo.
  analizarPor(null, 'Apalancamiento', t => {
    const o = t.registro?.apalancamiento?.oiSobreMcap;
    return o == null ? null : o >= 30 ? 'muy alto (30%+)' : o >= 15 ? 'alto (15-30%)' : 'normal';
  });
  analizarPor(null, 'Grandes vs multitud', t => t.registro?.apalancamiento?.divergencia == null ? null
    : `grandes en ${t.registro.apalancamiento.divergencia}`);
  analizarPor(null, 'Flujo de órdenes', t => t.registro?.flujoOrdenes?.sesgo ?? null);
  analizarPor(null, 'Flujo de exchange', t => {
    const w = t.registro?.wallets;
    if(!w || (w.entradaUsd == null && w.salidaUsd == null)) return null;
    const neto = (w.salidaUsd||0) - (w.entradaUsd||0);
    return neto > 50000 ? 'salidas dominan (acumulación)' : neto < -50000 ? 'entradas dominan (distribución)' : 'equilibrado';
  });
  analizarPor(null, 'Estado de la cuenta', t => t.abiertaEnDrawdownAlto == null ? null
    : (t.abiertaEnDrawdownAlto ? 'abierta en drawdown alto' : 'cuenta sana'));

  // APORTE DE CADA COMPONENTE: compara el win rate cuando un componente empujó fuerte
  // contra cuando no aportó. Es la medición que faltaba para saber cuánto vale cada Dios.
  const conRegistro = trades.filter(t => t.registro?.componentes?.length);
  const aporteComponentes = [];
  if(conRegistro.length >= MUESTRA_MINIMA*2){
    const nombres = [...new Set(conRegistro.flatMap(t => t.registro.componentes.map(cp=>cp.n)))];
    for(const nombre of nombres){
      const conAporte = conRegistro.filter(t => {
        const cp = t.registro.componentes.find(x=>x.n===nombre);
        return cp && Math.abs(cp.aporte) >= 0.3;
      });
      const sinAporte = conRegistro.filter(t => {
        const cp = t.registro.componentes.find(x=>x.n===nombre);
        return cp && Math.abs(cp.aporte) < 0.1;
      });
      if(conAporte.length < MUESTRA_MINIMA || sinAporte.length < MUESTRA_MINIMA) continue;
      const wrCon = _wr(conAporte), wrSin = _wr(sinAporte);
      const edge = +(wrCon - wrSin).toFixed(1);
      aporteComponentes.push({
        componente: nombre,
        conAporte: conAporte.length, winRateConAporte: wrCon,
        sinAporte: sinAporte.length, winRateSinAporte: wrSin,
        edge,
        veredicto: edge >= 10 ? 'APORTA — cuando empuja fuerte, se gana más'
                 : edge <= -10 ? 'RESTA — cuando empuja fuerte, se gana MENOS'
                 : 'NEUTRO — no cambia el resultado',
      });
    }
    aporteComponentes.sort((a,b)=>Math.abs(b.edge)-Math.abs(a.edge));
  }

  // Pregunta central del proyecto: ¿la fase de confirmación en 15m agrega valor?
  // Compara las que confirmaron contra las que expiraron y se simularon.
  const confirmadas = trades.filter(t => t.entry!=null);
  const expiradas = (closedTrades||[]).filter(t => t.wouldHaveWon!=null);
  let valorConfirmacion = null;
  if(confirmadas.length >= MUESTRA_MINIMA && expiradas.length >= MUESTRA_MINIMA){
    const wrConf = _wr(confirmadas);
    const wrExp = +(expiradas.filter(t=>t.wouldHaveWon).length/expiradas.length*100).toFixed(1);
    const ventaja = +(wrConf - wrExp).toFixed(1);
    valorConfirmacion = {
      winRateConfirmadas: wrConf,
      winRateDescartadas: wrExp,
      ventaja,
      veredicto: ventaja > 5
        ? `La confirmación en 15m SUMA: las que pasaron el filtro ganaron ${ventaja} puntos más que las descartadas.`
        : ventaja < -5
        ? `⚠️ La confirmación en 15m RESTA: las descartadas habrían ganado ${Math.abs(ventaja)} puntos MÁS que las confirmadas. El filtro está sacando operaciones buenas.`
        : 'La confirmación en 15m no muestra una diferencia clara todavía.',
    };
  } else {
    advertencias.push(`Todavía no se puede evaluar si la confirmación en 15m aporta: hacen falta ${MUESTRA_MINIMA}+ confirmadas y ${MUESTRA_MINIMA}+ expiradas (hay ${confirmadas.length} y ${expiradas.length}).`);
  }

  // ═══ ANÁLISIS DE GESTIÓN: ¿los múltiplos de R están bien elegidos? ═══
  // Responde con datos si 1R/1.6R/2.5R son los objetivos correctos para estas monedas, o si
  // habría que moverlos. Hoy esos números son una hipótesis razonable, no una verdad medida.
  const conGestion = trades.filter(t => t.registro?.gestion?.stopPct != null);
  let analisisGestion = null;
  if(conGestion.length >= MUESTRA_MINIMA){
    const prom = arr => arr.length ? +(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2) : null;
    const conMfe = conGestion.filter(t => t.registro.mfe != null);
    const mfes = conMfe.map(t => t.registro.mfe);
    const maes = conMfe.filter(t=>t.registro.mae!=null).map(t => Math.abs(t.registro.mae));
    const stops = conGestion.map(t => t.registro.gestion.stopPct);

    // ¿Cuántas operaciones llegaron a cada múltiplo?
    const llegoA = r => conMfe.length ? +(conMfe.filter(t=>t.registro.mfe >= r).length / conMfe.length * 100).toFixed(0) : null;

    analisisGestion = {
      operaciones: conGestion.length,
      stopPromedio: prom(stops),
      stopMinimo: stops.length ? +Math.min(...stops).toFixed(2) : null,
      stopMaximo: stops.length ? +Math.max(...stops).toFixed(2) : null,
      mfePromedio: prom(mfes),
      maePromedio: prom(maes),
      alcance: { '1R': llegoA(1), '1.6R': llegoA(1.6), '2.5R': llegoA(2.5) },
      conclusion: (()=>{
        const mfeP = prom(mfes), maeP = prom(maes);
        if(mfeP == null) return 'Todavía sin datos de MFE suficientes.';
        const partes = [];
        partes.push(`El movimiento promedio a favor llega a ${mfeP}R.`);
        if(mfeP < 1.6) partes.push(`Como TP2 está en 1.6R, la mayoría de las operaciones no llega — convendría acercarlo.`);
        else if(mfeP > 2.5) partes.push(`El precio suele pasar de 2.5R, así que TP3 podría estar dejando ganancia sobre la mesa.`);
        else partes.push(`Los objetivos actuales (1R/1.6R/2.5R) están en un rango razonable.`);
        if(maeP != null) partes.push(`El retroceso promedio antes de girar es ${maeP}R${maeP > 0.7 ? ' — el stop está cerca de ese límite, conviene revisarlo' : ''}.`);
        return partes.join(' ');
      })(),
    };
  } else {
    advertencias.push(`Todavía no se puede evaluar si los múltiplos de R (1R/1.6R/2.5R) son correctos: hacen falta ${MUESTRA_MINIMA}+ operaciones con datos de gestión (hay ${conGestion.length}).`);
  }

  // ═══ MFE POR CATEGORÍA ═══
  // Responde si conviene tener TP distintos según el tipo de operación. Puede pasar que un BOS
  // recorra 2.4R en promedio y una reversión solo 1.2R — en ese caso, usar los mismos objetivos
  // para las dos es dejar ganancia en una y no llegar nunca en la otra.
  // OJO: esto MIDE, no cambia nada. Cualquier ajuste de TP tiene que salir de acá con muestra real.
  const mfePorCategoria = [];
  if(conGestion.length >= MUESTRA_MINIMA*2){
    const conMfeCat = conGestion.filter(t => t.registro?.mfe != null);
    const agrupar = (etiqueta, fn) => {
      const grupos = {};
      for(const t of conMfeCat){
        const k = fn(t);
        if(k==null) continue;
        (grupos[k] = grupos[k] || []).push(t.registro.mfe);
      }
      for(const [clave, mfes] of Object.entries(grupos)){
        if(mfes.length < MUESTRA_MINIMA) continue;
        const ordenados = [...mfes].sort((a,b)=>a-b);
        const mediana = ordenados[Math.floor(ordenados.length/2)];
        mfePorCategoria.push({
          categoria: etiqueta,
          valor: clave,
          operaciones: mfes.length,
          mfePromedio: +(mfes.reduce((a,b)=>a+b,0)/mfes.length).toFixed(2),
          mfeMediana: +mediana.toFixed(2),
          // Porcentaje que alcanzó cada objetivo actual
          llegoA1R: +(mfes.filter(x=>x>=1).length/mfes.length*100).toFixed(0),
          llegoA16R: +(mfes.filter(x=>x>=1.6).length/mfes.length*100).toFixed(0),
          llegoA25R: +(mfes.filter(x=>x>=2.5).length/mfes.length*100).toFixed(0),
        });
      }
    };
    agrupar('Camino de confirmación', t => t.tipoSetup ?? null);
    agrupar('Dirección', t => t.dir ?? null);
    agrupar('Fase del mercado', t => t.marketPhase ?? null);
    agrupar('Tipo de moneda', t => t.tag ? 'cap chico' : 'normal');
    mfePorCategoria.sort((a,b)=>b.mfePromedio-a.mfePromedio);
  }

  hallazgos.sort((a,b)=>Math.abs(b.diferencia)-Math.abs(a.diferencia));
  if(!hallazgos.length) advertencias.push('No se encontró ningún patrón con diferencia significativa. Puede ser que no lo haya, o que falte muestra.');

  return {
    fecha: new Date().toISOString(),
    operaciones: trades.length,
    winRateGlobal: wrGlobal,
    hallazgos,
    aporteComponentes,
    analisisGestion,
    mfePorCategoria,
    valorConfirmacion,
    advertencias,
    listoParaConcluir: trades.length >= 30,
    nota: 'Estas son HIPÓTESIS, no conclusiones. Antes de cambiar cualquier peso del motor hay que validarlas con más datos: un patrón sobre 10-20 operaciones puede ser casualidad.',
  };
}

// ═══ BIBLIOTECA DE TESIS ═══
// Permite buscar entre todas las operaciones cerradas con filtros, y sobre todo encontrar las
// PARECIDAS a una tesis actual. La idea: antes de abrir, poder responder "¿cómo salieron las otras
// veces que se dio esta misma configuración?".
// No decide nada por sí sola — es una herramienta de consulta.
function buscarEnBiblioteca(closedTrades, filtros = {}){
  let res = [...(closedTrades||[])];
  if(filtros.symbol)     res = res.filter(t => t.symbol === filtros.symbol);
  if(filtros.dir)        res = res.filter(t => t.dir === filtros.dir);
  if(filtros.setup)      res = res.filter(t => (t.tipoSetup||'').includes(filtros.setup));
  if(filtros.scoreMin!=null) res = res.filter(t => (t.score||0) >= filtros.scoreMin);
  if(filtros.scoreMax!=null) res = res.filter(t => (t.score||0) <= filtros.scoreMax);
  if(filtros.soloGanadas) res = res.filter(t => t.pnlPct > 0);
  if(filtros.soloPerdidas)res = res.filter(t => t.pnlPct <= 0);
  if(filtros.tag)        res = res.filter(t => (t.tag||'').includes(filtros.tag));

  const ganadas = res.filter(t=>t.pnlPct>0);
  const gan = ganadas.reduce((s,t)=>s+(t.pnlUsd||0),0);
  const per = Math.abs(res.filter(t=>t.pnlPct<=0).reduce((s,t)=>s+(t.pnlUsd||0),0));
  return {
    operaciones: res,
    total: res.length,
    winRate: res.length ? +(ganadas.length/res.length*100).toFixed(1) : null,
    profitFactor: per>0 ? +(gan/per).toFixed(2) : (gan>0?Infinity:0),
    pnlTotal: +res.reduce((s,t)=>s+(t.pnlUsd||0),0).toFixed(2),
    suficienteMuestra: res.length >= 10,
  };
}

// Busca operaciones históricas parecidas a una tesis actual, para ver cómo salieron.
// La similitud se calcula sobre lo que de verdad define un setup: dirección, camino de
// confirmación, rango de score y tipo de moneda.
function buscarTesisParecidas(closedTrades, tesisActual, minSimilitud = 50){
  const puntuadas = (closedTrades||[]).map(t => {
    let sim = 0;
    if(t.dir === tesisActual.dir) sim += 30;
    if(t.tipoSetup && tesisActual.tipoSetup && t.tipoSetup === tesisActual.tipoSetup) sim += 30;
    if(t.score!=null && tesisActual.score!=null && Math.abs(t.score - tesisActual.score) <= 0.5) sim += 20;
    if((t.tag||'') === (tesisActual.tag||'')) sim += 10;
    if(t.symbol === tesisActual.symbol) sim += 10;
    return { ...t, similitud: sim };
  }).filter(t => t.similitud >= minSimilitud)
    .sort((a,b) => b.similitud - a.similitud);

  if(!puntuadas.length) return { encontradas:0, suficienteMuestra:false, resumen:'No hay operaciones históricas parecidas todavía.' };
  const ganadas = puntuadas.filter(t=>t.pnlPct>0).length;
  const wr = +(ganadas/puntuadas.length*100).toFixed(1);
  return {
    encontradas: puntuadas.length,
    winRate: wr,
    similares: puntuadas.slice(0,5),
    suficienteMuestra: puntuadas.length >= 10,
    resumen: puntuadas.length >= 10
      ? `De ${puntuadas.length} operaciones parecidas, ganaron ${ganadas} (${wr}%).`
      : `Solo ${puntuadas.length} operaciones parecidas hasta ahora (${wr}% ganadas) — muy poca muestra para sacar conclusiones.`,
  };
}

function computeStatsDesglosadas(closedTrades){
  function agrupar(campo){
    const grupos = {};
    for(const t of closedTrades){
      const clave = t[campo] ?? 'Sin dato';
      if(!grupos[clave]) grupos[clave] = {wins:0, total:0};
      grupos[clave].total++;
      if(t.result==='win') grupos[clave].wins++;
    }
    return Object.entries(grupos).map(([clave,v])=>({
      nombre: clave, operaciones: v.total, ganadas: v.wins,
      winRate: v.total>0 ? +(v.wins/v.total*100).toFixed(1) : 0
    })).sort((a,b)=>b.operaciones-a.operaciones);
  }
  return {
    porTipoSetup: agrupar('tipoSetup'),
    porMoneda: agrupar('symbol'),
    porHorario: agrupar('horaConfirmacion'),
  };
}

function computeGodPerformance(closedTrades){
  const stats = {}; // { [godName]: {agreedWins, agreedLosses, agreedTotal} }
  for(const trade of (closedTrades||[])){
    if(!Array.isArray(trade.committeeSnapshot)) continue;
    for(const god of trade.committeeSnapshot){
      if(god.vote !== trade.dir) continue; // solo cuenta cuando el dios coincidió con la dirección tomada
      if(!stats[god.name]) stats[god.name] = {agreedWins:0, agreedLosses:0, agreedTotal:0};
      stats[god.name].agreedTotal++;
      if(trade.result==='win') stats[god.name].agreedWins++; else stats[god.name].agreedLosses++;
    }
  }
  const ranking = Object.entries(stats).map(([name, s])=>({
    name, ...s, winRate: s.agreedTotal>0 ? Math.round((s.agreedWins/s.agreedTotal)*100) : null
  })).sort((a,b)=> (b.winRate||0)-(a.winRate||0));
  return ranking;
}

// ---- Modo Aprendizaje Pasivo: ¿el filtro de confirmación en 15m realmente ayuda? ----
// Compara el win rate REAL de las operaciones confirmadas contra el win rate SIMULADO de las
// tesis que expiraron sin confirmar (si igual se hubiera entrado con el setup teórico de 4h).
// Si el simulado termina siendo mayor, es señal de que el filtro está descartando buenas
// oportunidades; si es menor, confirma que el filtro está cumpliendo su función.
function computeFilterEffectiveness(closedTrades, expiredTheses){
  const confirmed = closedTrades||[];
  const confirmedWins = confirmed.filter(t=>t.result==='win').length;
  const confirmedWinRate = confirmed.length ? Math.round((confirmedWins/confirmed.length)*100) : null;

  const decided = (expiredTheses||[]).filter(t=>t.wouldHaveWon!=null);
  const simulatedWins = decided.filter(t=>t.wouldHaveWon===true).length;
  const simulatedWinRate = decided.length ? Math.round((simulatedWins/decided.length)*100) : null;

  let veredicto = 'Todavía no hay suficientes datos (hacen falta más operaciones confirmadas y más tesis expiradas con resultado simulado definido).';
  if(confirmedWinRate!=null && simulatedWinRate!=null && confirmed.length>=5 && decided.length>=5){
    if(simulatedWinRate > confirmedWinRate+10) veredicto = '⚠️ El filtro de confirmación en 15m parece estar descartando buenas oportunidades (las que expiraron sin confirmar hubieran ganado más seguido que las confirmadas).';
    else if(confirmedWinRate > simulatedWinRate+10) veredicto = '✅ El filtro de confirmación en 15m está cumpliendo su función (las confirmadas ganan más seguido que las que se hubieran tomado sin filtrar).';
    else veredicto = 'El filtro no muestra una diferencia clara todavía — parecido con o sin confirmación.';
  }
  return { confirmedWinRate, confirmedCount: confirmed.length, simulatedWinRate, simulatedCount: decided.length, veredicto };
}

// ============================================================
// EXPORTS — misma lista para el navegador (script type=module) y para Node
// ============================================================
export {
  computeGodPerformance, computeFilterEffectiveness, computeStatsDesglosadas, computeHistorialMoneda, buscarEnBiblioteca, buscarTesisParecidas, generarReporteResearch, postMortem, simularStops, monteCarlo, expectancyPorEstrategia, combinacionDioses, simularTPs, validarFueraDeMuestra, calcularCosteReal, resumenCostes, detectActividadAnomala, fetchOnChainPressure, fetchTransferenciasToken,  calcularPresionFlujo, verificarDatosSanos, analisisMfeMaePorResultado, analizarCorrelacion, metricasCompletas, rendimientoPorRegimen, compararVersiones, fotoAntesDespues, calidadDecision, resumenCalidadDecisiones, explicarAnalisis, seguirHipotesis, getSaludAPIs, detectMarketPhase,
  BINANCE, FUTURES, GECKO, TF_MAP,
  fetchJSON, fetchTokenData, fetchMacroTrend, fetchRelevantNews, fetchBTCReference,
  fetchOpenInterestTrend, fetchFundingTrend, fetchTopTraderRatio, fetchOIToMarketCapRatio, fetchSpotFuturesFlow, classifyTrend, marketContextMatrix, MARKET_CONTEXT_TABLE,
  fetchCapitalFlowContext, fetchUnlockRisk, fetchUsdStrength, keltnerChannel, detectSqueeze, confluenceScore15m, fetchFearGreedIndex, getFOMCWindow, getHighImpactMacroWindow,
  tryBinance, tryBinanceFutures, tryGecko, tryOKX, tryOKXPerp, tryBybit, tryBybitPerp,
  tryMEXC, tryBitunix, tryBitunixSpot, tryKuCoin,
  ema, sma, rsi, macd, bollinger, atr, stochRsi, stochasticOscillator, computeLiquidityProfile, computeVolumeProbability, detectVolumeSpike, detectDivergencia, detectTrianguloCompresion, analizarRupturaCompresion, detectZonasOfertaDemanda, detectNivelesEstructurales, detectLiquidezPorHorizonte, detectIFVG, computeVWAP, computeCVD, mfi, obvSeries, adx, cci, roc,
  findSupportResistance, findNearbyLevel, levelStrength, analyzeLevelTests, findPivots, labelSwings, detectStructureEvents,
  detectOrderBlocks, detectFVG, detectDoubleTopBottom, detectEqualLevels, detectLiquiditySweep, detectAccumulationBearTrap, detectDistributionBullTrap, fibLevels, detectCandlePattern, computeStructure,
  computeScore, buildAnalystMode, buildSetup,
  fmt, fmtPct, detectSFP
};
