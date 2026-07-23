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

const TF_MAP = {
  '15m': {binance:'15m', okx:'15m', bybit:'15', mexc:'15m', gate:'15m', kucoin:'15min', kucoinSec:900,  gecko:{timeframe:'minute', aggregate:15}},
  '1h':  {binance:'1h',  okx:'1H',  bybit:'60', mexc:'60m', gate:'1h',  kucoin:'1hour', kucoinSec:3600, gecko:{timeframe:'hour',   aggregate:1}},
  '4h':  {binance:'4h',  okx:'4H',  bybit:'240', mexc:'4h', gate:'4h',  kucoin:'4hour', kucoinSec:14400, gecko:{timeframe:'hour',   aggregate:4}},
  '1d':  {binance:'1d',  okx:'1D',  bybit:'D',  mexc:'1d', gate:'1d',  kucoin:'1day',  kucoinSec:86400, gecko:{timeframe:'day',    aggregate:1}},
};

async function fetchJSON(url){ const r = await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }

async function tryBinance(symbolRaw, tf){
  const sym = symbolRaw.toUpperCase().replace(/[^A-Z0-9]/g,'');
  const pair = sym.endsWith('USDT') ? sym : sym + 'USDT';
  const interval = TF_MAP[tf].binance;
  const klines = await fetchJSON(`${BINANCE}/api/v3/klines?symbol=${pair}&interval=${interval}&limit=220`);
  const ticker = await fetchJSON(`${BINANCE}/api/v3/ticker/24hr?symbol=${pair}`);
  let funding = null;
  try{
    const prem = await fetchJSON(`${FUTURES}/fapi/v1/premiumIndex?symbol=${pair}`);
    funding = parseFloat(prem.lastFundingRate);
  }catch(e){}
  const candles = klines.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
  return {
    source:'Binance', symbol: pair, displayName: sym.replace('USDT',''),
    price: parseFloat(ticker.lastPrice), change24h: parseFloat(ticker.priceChangePercent),
    vol24h: parseFloat(ticker.quoteVolume), candles, funding, oi:null, dexUrl:null, contract:null,
  };
}

// ---------- Market Context Matrix: OI + Precio + Funding, combinados (no aislados) ----------
// Solo disponible para símbolos de Binance: es la única fuente gratis con historial de Open Interest.
const OI_PERIOD_MAP = { '15m':'15m', '1h':'1h', '4h':'4h', '1d':'1d' };

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
  const sym = symbolRaw.toUpperCase().replace(/[^A-Z0-9]/g,'');
  const pair = sym.endsWith('USDT') ? sym : sym + 'USDT';
  const period = OI_PERIOD_MAP[tf] || '4h';
  try{
    const rows = await fetchJSON(`${FUTURES}/futures/data/openInterestHist?symbol=${pair}&period=${period}&limit=8`);
    if(!Array.isArray(rows) || rows.length<2) return null;
    const values = rows.map(r=>parseFloat(r.sumOpenInterest));
    return { trend: classifyTrend(values, 3), values };
  }catch(e){ return null; } // el símbolo puede no tener mercado de futuros -> sin dato, no rompe nada
}

async function fetchFundingTrend(symbolRaw){
  const sym = symbolRaw.toUpperCase().replace(/[^A-Z0-9]/g,'');
  const pair = sym.endsWith('USDT') ? sym : sym + 'USDT';
  try{
    const rows = await fetchJSON(`${FUTURES}/fapi/v1/fundingRate?symbol=${pair}&limit=6`);
    if(!Array.isArray(rows) || rows.length<2) return null;
    const values = rows.map(r=>parseFloat(r.fundingRate));
    return { trend: classifyTrend(values, 15), values }; // funding se mueve en % muy chicos, tolerancia relativa más amplia
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
  const pools = search.data;
  if(!pools || !pools.length) throw new Error('No se encontró en GeckoTerminal');
  pools.sort((a,b)=> (parseFloat(b.attributes.reserve_in_usd)||0) - (parseFloat(a.attributes.reserve_in_usd)||0));
  const pool = pools[0];
  const network = pool.relationships.network.data.id;
  const poolAddr = pool.attributes.address;
  const g = TF_MAP[tf].gecko;
  const ohlcv = await fetchJSON(`${GECKO}/networks/${network}/pools/${poolAddr}/ohlcv/${g.timeframe}?aggregate=${g.aggregate}&limit=220`);
  const list = ohlcv.data.attributes.ohlcv_list;
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
  };
}

async function tryOKX(symbolRaw, tf){
  const sym = symbolRaw.toUpperCase().replace(/[^A-Z0-9]/g,'');
  const instId = `${sym}-USDT`;
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
async function tryBybit(symbolRaw, tf){
  const sym = symbolRaw.toUpperCase().replace(/[^A-Z0-9]/g,'');
  const pair = `${sym}USDT`;
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
async function tryMEXC(symbolRaw, tf){
  const sym = symbolRaw.toUpperCase().replace(/[^A-Z0-9]/g,'');
  const pair = `${sym}USDT`;
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
async function tryGate(symbolRaw, tf){
  const sym = symbolRaw.toUpperCase().replace(/[^A-Z0-9]/g,'');
  const pair = `${sym}_USDT`;
  const interval = TF_MAP[tf].gate;
  const rows = await fetchJSON(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=${interval}&limit=220`);
  if(!Array.isArray(rows) || !rows.length) throw new Error('Gate.io sin datos');
  // Formato Gate: [timestamp, volumen, close, high, low, open]
  const candles = rows.map(r=>({t:+r[0]*1000,o:+r[5],h:+r[3],l:+r[4],c:+r[2],v:+r[1]})).sort((a,b)=>a.t-b.t);
  return {
    source:'Gate.io', symbol: pair, displayName: sym,
    price: candles.at(-1).c,
    change24h: ((candles.at(-1).c-candles.at(0).c)/candles.at(0).c)*100,
    vol24h: candles.at(-1).v, candles, funding:null, oi:null, dexUrl:null, contract:null,
  };
}
async function tryKuCoin(symbolRaw, tf){
  const sym = symbolRaw.toUpperCase().replace(/[^A-Z0-9]/g,'');
  const pair = `${sym}-USDT`;
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

async function fetchTokenData(query, tf){
  const sources = [tryBinance, tryOKX, tryBybit, tryMEXC, tryGate, tryKuCoin];
  for(const src of sources){
    try{
      const data = await src(query, tf);
      if(data.candles && data.candles.length>=30) return data;
    }catch(e){ /* probamos con la siguiente fuente */ }
  }
  // ninguna fuente de exchanges centralizados lo tiene -> probamos DEXs (GeckoTerminal)
  return await tryGecko(query, tf);
}

// Tendencia macro (4h, EMA200) usada como filtro: no se opera contra la tendencia mayor sin confluencia extrema
async function fetchMacroTrend(query){
  try{
    const d = await fetchTokenData(query, '4h');
    if(!d.candles || d.candles.length < 60) return null;
    const closesArr = d.candles.map(c=>c.c);
    const e200arr = ema(closesArr, Math.min(200, closesArr.length-1));
    const e200 = e200arr.at(-1);
    const price = closesArr.at(-1);
    return { bias: price>e200 ? 'bull':'bear', price, e200 };
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
// Cuenta cuántas veces el precio "tocó" un nivel (dentro de una tolerancia) en el historial reciente -> fuerza del nivel
function levelStrength(candles, level, lookback=80, tolPct=0.006){
  const recent = candles.slice(-lookback);
  const tol = level*tolPct;
  let touches = 0;
  recent.forEach(c=>{ if(Math.abs(c.h-level)<=tol || Math.abs(c.l-level)<=tol) touches++; });
  return {touches, score: Math.min(100, touches*18)};
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

function detectEqualLevels(labeledPivots, tolerancePct=0.0015){
  const highs = labeledPivots.filter(p=>p.type==='high').slice(-6);
  const lows = labeledPivots.filter(p=>p.type==='low').slice(-6);
  let eqHighs=null, eqLows=null;
  for(let i=0;i<highs.length;i++) for(let j=i+1;j<highs.length;j++){
    if(Math.abs(highs[i].price-highs[j].price)/highs[i].price < tolerancePct){ eqHighs = (highs[i].price+highs[j].price)/2; }
  }
  for(let i=0;i<lows.length;i++) for(let j=i+1;j<lows.length;j++){
    if(Math.abs(lows[i].price-lows[j].price)/lows[i].price < tolerancePct){ eqLows = (lows[i].price+lows[j].price)/2; }
  }
  return {eqHighs, eqLows};
}

function fibLevels(labeledPivots){
  const last = labeledPivots.slice(-2);
  if(last.length<2) return null;
  const [a,b] = last;
  const hi = Math.max(a.price,b.price), lo = Math.min(a.price,b.price);
  const range = hi-lo;
  const up = b.price>a.price;
  return {
    dir: up?'bull':'bear',
    l236: up? hi-range*0.236 : lo+range*0.236,
    l382: up? hi-range*0.382 : lo+range*0.382,
    l500: up? hi-range*0.5   : lo+range*0.5,
    l618: up? hi-range*0.618 : lo+range*0.618,
    l786: up? hi-range*0.786 : lo+range*0.786,
    ext1272: up? hi+range*0.272 : lo-range*0.272,
    ext1618: up? hi+range*0.618 : lo-range*0.618,
  };
}

function detectCandlePattern(candles){
  const c = candles.at(-1), p = candles.at(-2);
  const body = Math.abs(c.c-c.o), range = c.h-c.l || 1e-9;
  const upperWick = c.h - Math.max(c.o,c.c), lowerWick = Math.min(c.o,c.c) - c.l;
  if(body/range < 0.1) return 'Doji';
  if(lowerWick > body*2 && upperWick < body*0.5) return c.c>c.o ? 'Hammer (posible reversal alcista)' : 'Hammer';
  if(upperWick > body*2 && lowerWick < body*0.5) return 'Shooting Star (posible reversal bajista)';
  if(body/range > 0.9) return c.c>c.o ? 'Marubozu alcista' : 'Marubozu bajista';
  if(p){
    const pBody = Math.abs(p.c-p.o);
    if(c.c>c.o && p.c<p.o && c.c>p.o && c.o<p.c) return 'Bullish Engulfing';
    if(c.c<c.o && p.c>p.o && c.o>p.c && c.c<p.o) return 'Bearish Engulfing';
  }
  return null;
}

function computeStructure(candles, atrArr){
  const pivots = labelSwings(findPivots(candles,3));
  const events = detectStructureEvents(candles, pivots);
  const {bullishOB, bearishOB} = detectOrderBlocks(candles, atrArr);
  const fvgs = detectFVG(candles);
  const {eqHighs, eqLows} = detectEqualLevels(pivots);
  const fib = fibLevels(pivots);
  const candlePattern = detectCandlePattern(candles);

  let score=10, notes=[];
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
  if(eqHighs){ notes.push(`Equal Highs (EQH) detectados ~$${fmt(eqHighs)}: liquidez compradora (buy-side) reposando ahí, posible objetivo de un liquidity sweep.`); }
  if(eqLows){ notes.push(`Equal Lows (EQL) detectados ~$${fmt(eqLows)}: liquidez vendedora (sell-side) reposando ahí.`); }
  if(candlePattern){ notes.push(`Última vela: ${candlePattern}.`); }
  score = Math.max(0, Math.min(20, score));
  return {score, notes, events, bullishOB, bearishOB, fvgs, eqHighs, eqLows, fib, pivots, candlePattern};
}

// ---------- Scoring ----------
function computeScore(data, macro, newsItems, sharedMemory, marketContext){
  const closes = data.candles.map(c=>c.c);
  const vols = data.candles.map(c=>c.v);
  const price = closes.at(-1);
  const e20=ema(closes,20), e50=ema(closes,50), e200=ema(closes,200);
  const lastE20=e20.at(-1), lastE50=e50.at(-1), lastE200=e200.at(-1);
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
  const {support, resistance} = findSupportResistance(data.candles);

  let trend=15, trendBias='neutral';
  if(price>lastE20 && lastE20>lastE50 && lastE50>lastE200){ trend=30; trendBias='bull'; }
  else if(price>lastE20 && lastE50<lastE200){ trend=21; trendBias='bull'; }
  else if(price<lastE20 && lastE20<lastE50 && lastE50<lastE200){ trend=3; trendBias='bear'; }
  else if(price<lastE20 && lastE50>lastE200){ trend=10; trendBias='bear'; }

  let momentum=12;
  if(lastRSI>=50 && lastRSI<=70) momentum=20;
  else if(lastRSI>30 && lastRSI<50) momentum=11;
  else if(lastRSI>=70) momentum=8;
  else if(lastRSI<=30) momentum=15;
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

  const total = trendR+momentumR+volumeR+volatR+derivR+structure.score;
  const score10 = Math.max(1, Math.min(10, total/10));
  let bias='NEUTRAL';
  const structBias = structure.events.trendStructure;
  if(score10>=6.5 && trendBias!=='bear' && structBias!=='bear') bias='LONG';
  else if(score10<=4 && trendBias!=='bull' && structBias!=='bull') bias='SHORT';
  else if(score10>=6.5) bias='LONG';
  else if(score10<=4) bias='SHORT';

  // ---- Dual Long/Short score (signed bullishness index, transparent formula) ----
  const trendSignal = trend===30?1: trend===21?0.6: trend===15?0: trend===10?-0.6: trend===3?-1:0;
  const momentumSignal = Math.max(-1,Math.min(1,(momentum-12.5)/12.5));
  const derivSignal = deriv>=18?0.6: deriv>=16?0.8: deriv<=6?-0.5:0;
  let structureSignal = structBias==='bull'?0.8 : structBias==='bear'?-0.8 : 0;
  if(structure.events.bos) structureSignal += (structure.events.bos==='bullish'?0.2:-0.2);
  if(structure.events.choch) structureSignal += (structure.events.choch==='bullish'?0.3:-0.3);
  structureSignal = Math.max(-1,Math.min(1,structureSignal));

  // ---- Macro trend filter (4h EMA200): opera solo a favor de la tendencia mayor ----
  const macroSignal = macro? (macro.bias==='bull'?1:-1) : 0;
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

  const weights = macro
    ? {trend:0.21,momentum:0.16,deriv:0.13,structure:0.18,macro:0.22,market:0.10}
    : {trend:0.27,momentum:0.21,deriv:0.17,structure:0.23,macro:0,market:0.12};
  let bullishness = trendSignal*weights.trend + momentumSignal*weights.momentum + derivSignal*weights.deriv + structureSignal*weights.structure + macroSignal*weights.macro + marketSignal*weights.market;
  const volumeQuality = volume/15;
  const volatQuality = volat>=10?1 : volat<=4?0.8 : 0.9;
  bullishness = Math.max(-1,Math.min(1, bullishness*(0.75+0.25*volumeQuality)*volatQuality));

  // ---- Confluencia avanzada: cruce RSI + estructura SMC + funding (short/long squeeze setup) ----
  let confluenceNote = null;
  if(lastRSI<=32 && structBias==='bull' && data.funding!=null && data.funding<0){
    bullishness = Math.max(bullishness, 0.9);
    confluenceNote = '🔥 Confluencia fuerte ALCISTA: RSI en sobreventa + estructura SMC alcista + funding negativo (shorts sobreapalancados) → posible short squeeze.';
  } else if(lastRSI>=68 && structBias==='bear' && data.funding!=null && data.funding>0.0005){
    bullishness = Math.min(bullishness, -0.9);
    confluenceNote = '🔥 Confluencia fuerte BAJISTA: RSI en sobrecompra + estructura SMC bajista + funding muy positivo (longs sobreapalancados) → riesgo de long squeeze.';
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
  const capitalFlowSignal = volumeQuality>=0.8 ? 0.4 : volumeQuality<=0.3 ? -0.3 : 0; // proxy: volumen relativo como flujo de capital hacia este activo
  committee.push({name:'💧 Dios Capital Flow', signal:capitalFlowSignal, vote:vote(capitalFlowSignal)});

  const riskSignalDir = trendSignal!==0 ? Math.sign(trendSignal) : 1;
  const riskSignal = volat>=10 ? 0.25*riskSignalDir : volat<=4 ? -0.25 : 0; // castiga la convicción si el precio está muy extendido
  committee.push({name:'⚠️ Dios Gestión de Riesgo', signal:riskSignal, vote:vote(riskSignal)});

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

  // ---- Dios Noticias (11°): también solo vota, atenuado a la mitad a propósito para que nunca sea lo que decide ----
  const news = newsItems || [];
  const newsBullish = news.filter(n=>n.sentiment==='bullish').length;
  const newsBearish = news.filter(n=>n.sentiment==='bearish').length;
  const newsRaw = news.length ? (newsBullish-newsBearish)/news.length : 0;
  const newsSignal = Math.max(-1,Math.min(1,newsRaw)) * 0.5; // atenuado: nunca pesa como si fuera lo único importante
  const newsNote = news.length
    ? `${news.length} titular(es) relevante(s) (${newsBullish} con tono alcista, ${newsBearish} con tono bajista). Es 1 voto de 11, no decide solo.`
    : 'Sin titulares relevantes detectados en este momento.';
  committee.push({name:'📰 Dios Noticias', signal:newsSignal, vote:vote(newsSignal), note:newsNote});

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

  return {
    score10, bias,
    longScore, shortScore, confidence, stars, recommendation,
    breakdown:[{label:'Tendencia',val:Math.round(trendR),max:25},{label:'Momentum',val:Math.round(momentumR),max:20},{label:'Volumen',val:Math.round(volumeR),max:12},{label:'Volatilidad',val:Math.round(volatR),max:8},{label:'Derivados',val:Math.round(derivR),max:15},{label:'Estructura SMC',val:Math.round(structure.score),max:20}],
    metrics:{price,lastE20,lastE50,lastE200,lastRSI,lastHist,lastATR,support,resistance,avgVol,lastVol,funding:data.funding,bb:lastBB,supportStrength,resistanceStrength,distToSupportPct,distToResistancePct},
    derivNote, structure, macroNote, marketNote, confluenceNote, committee, votesLong, votesShort, probabilities, indicatorStatus, newsItems: news,
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
    resumen = `La estructura es ${dirWord} en ${currentTF}. ${passCount} de ${totalVotes} especialistas internos coinciden en ${rec}, con RSI en ${m.lastRSI?.toFixed(0)} (${m.lastRSI>=70?'zona de sobrecompra, cuidado':m.lastRSI<=30?'zona de sobreventa':'zona sana'}) y volumen ${m.lastVol>m.avgVol?'por encima':'por debajo'} del promedio.${result.confluenceNote?' Además hay una confluencia fuerte que refuerza la señal.':''} Por eso el motor recomienda ${rec}, con ${result.confidence}% de confianza.`;
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
  if(m.lastRSI>=70) riesgos.push('RSI en sobrecompra: el movimiento podría estar agotado en el corto plazo.');
  if(m.lastRSI<=30) riesgos.push('RSI en sobreventa: cuidado con un rebote técnico que no sea reversión real.');
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

  // Error común / mejor nivel de espera (usa Order Block si existe, si no usa zona de descuento/premium)
  let mejorEntrada;
  const ob = rec==='LONG' ? st.bullishOB : rec==='SHORT' ? st.bearishOB : null;
  if(ob){
    mejorEntrada = `En vez de entrar al precio actual, un trader más paciente esperaría un retroceso hacia la zona de Order Block ($${fmt(ob.bottom)}-$${fmt(ob.top)}), que ofrece mejor relación riesgo/beneficio.`;
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

  const explanation = `${resumen}

✅ Lo que acompaña la decisión: ${soporta}.
⚠️ Lo que no acompaña del todo: ${noAcompana}.

🏦 Dinero institucional (proxy vía funding): ${institucional}

🌍 ${result.marketNote}

⚠️ Riesgos activos:
${riesgos.map(r=>'• '+r).join('\n')}

📈 Qué confirmaría más la entrada:
${confirmacion}

🔄 Escenario alternativo (si el análisis falla):
${alternativo}

🎯 Mejor nivel para esperar / error común de entrar ya:
${mejorEntrada}
${errorComun}`;

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

function buildSetup(data, result, riskProfile){
  const {price, support, resistance, lastATR} = result.metrics;
  // Stop loss ahora basado en volatilidad real: 2x ATR (se agranda si el mercado está movido, se achica si está tranquilo)
  const risk = lastATR*2;
  let entryLow, entryHigh, stop, t1,t2,t3, dir;
  const dirSource = result.recommendation || result.bias; // usa el score dual (Long/Short) como fuente de verdad
  if(dirSource==='LONG'){
    dir='LONG'; entryLow=price*0.995; entryHigh=price*1.005;
    stop = price - risk;
    const R = price-stop;
    t1=price+R*1.5; t2=price+R*3; t3=Math.max(resistance, price+R*5);
  } else if(dirSource==='SHORT'){
    dir='SHORT'; entryLow=price*0.995; entryHigh=price*1.005;
    stop = price + risk;
    const R = stop-price;
    t1=price-R*1.5; t2=price-R*3; t3=Math.min(support, price-R*5);
  } else {
    dir='NEUTRAL / ESPERAR'; entryLow=support; entryHigh=resistance;
    stop=support-risk; t1=resistance; t2=resistance+risk; t3=resistance+risk*2;
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
  return {dir, entryLow, entryHigh, stop, t1,t2,t3, leverage, volPct, atrMultiple:2, riskProfile:profile};
}


async function fetchRelevantNews(coinName){
  const feeds = ['https://cointelegraph.com/rss','https://www.coindesk.com/arc/outboundfeeds/rss/'];
  const bullishWords = ['surge','rally','bullish','soar','approval','inflow','adoption','breakout','record high','partnership','upgrade','all-time high','buy the dip'];
  const bearishWords = ['crash','hack','exploit','lawsuit','ban','bearish','sell-off','plunge','liquidation','fraud','investigation','delist','outflow','scam','rug pull'];
  let matched = [];
  for(const feedUrl of feeds){
    try{
      const res = await fetchJSON(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}&count=25`);
      if(res.status!=='ok' || !res.items) continue;
      res.items.forEach(item=>{
        const title = item.title||'';
        const lower = title.toLowerCase();
        const mentionsCoin = coinName && lower.includes(coinName.toLowerCase());
        const mentionsMacro = /(fomc|cpi|fed |federal reserve|interest rate|sec |etf|halving)/i.test(title);
        if(mentionsCoin || mentionsMacro){
          let sentiment = 'neutral';
          if(bullishWords.some(w=>lower.includes(w))) sentiment='bullish';
          if(bearishWords.some(w=>lower.includes(w))) sentiment='bearish';
          matched.push({title, link:item.link, sentiment, mentionsCoin});
        }
      });
    }catch(e){ /* esta fuente no respondió (rate limit u otro), seguimos con la próxima */ }
  }
  return matched.slice(0,12);
}


function fmt(n){ if(n==null||isNaN(n)) return '—'; if(n>=1000) return n.toLocaleString('en-US',{maximumFractionDigits:2}); if(n>=1) return n.toFixed(4); return n.toPrecision(4); }
function fmtPct(n){ return (n>=0?'+':'')+n.toFixed(1)+'%'; }

// ============================================================
// EXPORTS — misma lista para el navegador (script type=module) y para Node
// ============================================================
export {
  BINANCE, FUTURES, GECKO, TF_MAP,
  fetchJSON, fetchTokenData, fetchMacroTrend, fetchRelevantNews,
  fetchOpenInterestTrend, fetchFundingTrend, classifyTrend, marketContextMatrix, MARKET_CONTEXT_TABLE,
  tryBinance, tryGecko, tryOKX, tryBybit, tryMEXC, tryGate, tryKuCoin,
  ema, sma, rsi, macd, bollinger, atr, stochRsi, mfi, obvSeries, adx, cci, roc,
  findSupportResistance, levelStrength, findPivots, labelSwings, detectStructureEvents,
  detectOrderBlocks, detectFVG, detectEqualLevels, fibLevels, detectCandlePattern, computeStructure,
  computeScore, buildAnalystMode, buildSetup,
  fmt, fmtPct
};
