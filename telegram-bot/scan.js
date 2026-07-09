// Fortress Terminal — Bot de señales + TheHaton (cuenta virtual)
// Corre en GitHub Actions cada 15 min. Usa una versión simplificada del motor
// (EMA/RSI/MACD/ATR). Escanea:
//   1) Binance top N por volumen 24h (dinámico).
//   2) CUSTOM_COINS: monedas específicas que VOS elegís abajo, buscadas en
//      Binance -> OKX -> Bybit -> MEXC -> Gate.io (radar multi-exchange),
//      para las que operás que no están entre las top 60 de Binance.
//   3) Pools nuevas en DEX (Solana/Base/Ethereum).
//
// NUEVO (TheHaton): mantiene una cuenta virtual de 100 USDT que:
//  - Abre operaciones de papel cuando aparece una señal fuerte (score>=8).
//  - Revisa en cada corrida si el precio tocó el TP o el Stop, y cierra la operación.
//  - Nunca borra el historial: si el capital llega a 0, archiva la cuenta y abre una nueva.
//  - Solo abre operaciones nuevas dentro del horario de trabajo (04:00–15:00 Argentina).
//  - Máximo 4 operaciones nuevas por día.
//  - Riesgo dinámico según drawdown y racha (0.5% - 1.5%).
// El estado completo queda en telegram-bot/state.json, y la web lee ese mismo
// archivo (público, vía GitHub raw) para mostrar el panel TheHaton.

import fs from 'fs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const THRESHOLD = 8.0;
const TOP_N_BINANCE = 60;
const DEX_NETWORKS = ['solana','base','eth'];
const STATE_FILE = 'telegram-bot/state.json';
const MAX_TRADES_PER_DAY = 4;
const WORK_HOUR_START = 4;   // 04:00 Argentina (UTC-3)
const WORK_HOUR_END = 15;    // 15:00 Argentina (UTC-3)
const RISK_PCT = 0.01;       // 1% del capital por operación (base, se ajusta dinámicamente)

// 👇 EDITÁ ESTA LISTA vos mismo: poné acá cualquier moneda que operes aunque no esté
// entre las top 60 de Binance por volumen. El bot la va a buscar automáticamente en
// Binance, OKX, Bybit, MEXC y Gate.io (el que la tenga primero, gana).
const CUSTOM_COINS = ['TIA','SEI','JUP','PYTH','WIF','ORDI','STRK','ENA','W','TNSR'];

// ---------- Indicadores ----------
function ema(values, period){
  const k = 2/(period+1); const out=[]; let prev;
  values.forEach((v,i)=>{ prev = i===0? v : v*k+prev*(1-k); out.push(prev); });
  return out;
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
function macdHist(values){
  const e12=ema(values,12), e26=ema(values,26);
  const line = values.map((_,i)=> e12[i]-e26[i]);
  const signal = ema(line,9);
  return line.map((v,i)=> v-signal[i]);
}
function atr(candles, period=14){
  const trs = candles.map((c,i)=> i===0? c.h-c.l : Math.max(c.h-c.l, Math.abs(c.h-candles[i-1].c), Math.abs(c.l-candles[i-1].c)));
  return ema(trs, period);
}
function scoreCoin(candles){
  const closes = candles.map(c=>c.c);
  const price = closes.at(-1);
  const e20=ema(closes,20).at(-1), e50=ema(closes,50).at(-1), e200=ema(closes,200).at(-1);
  const rsiArr = rsi(closes,14);
  const lastRSI = rsiArr.filter(v=>v!=null).at(-1);
  const hist = macdHist(closes);
  const lastHist = hist.at(-1), prevHist = hist.at(-2);
  const lastATR = atr(candles,14).at(-1);

  let trendSignal = 0;
  if(price>e20 && e20>e50 && e50>e200) trendSignal = 1;
  else if(price>e20 && e50<e200) trendSignal = 0.6;
  else if(price<e20 && e20<e50 && e50<e200) trendSignal = -1;
  else if(price<e20 && e50>e200) trendSignal = -0.6;

  let momentumSignal = Math.max(-1, Math.min(1, (lastRSI-50)/25));
  if(lastHist>0 && lastHist>prevHist) momentumSignal = Math.min(1, momentumSignal+0.2);
  if(lastHist<0 && lastHist<prevHist) momentumSignal = Math.max(-1, momentumSignal-0.2);

  const bullishness = Math.max(-1, Math.min(1, trendSignal*0.55 + momentumSignal*0.45));
  const longScore = Math.max(0, Math.min(10, +(5+5*bullishness).toFixed(1)));
  const shortScore = Math.max(0, Math.min(10, +(10-longScore).toFixed(1)));
  const recommendation = longScore>=6.5 ? 'LONG' : shortScore>=6.5 ? 'SHORT' : 'NO OPERAR';
  const risk = lastATR*2;
  const stop = recommendation==='LONG' ? price-risk : price+risk;
  const t1 = recommendation==='LONG' ? price+risk*1.5 : price-risk*1.5;
  return {price, longScore, shortScore, recommendation, stop, t1};
}

// ---------- Fuentes de datos ----------
async function getTopBinancePairs(n){
  const r = await fetch('https://api.binance.com/api/v3/ticker/24hr');
  const all = await r.json();
  if(!Array.isArray(all)) return [];
  return all
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('UP') && !t.symbol.includes('DOWN'))
    .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, n)
    .map(t => t.symbol.replace('USDT',''));
}
async function fetchBinanceCandles(symbol){
  const pair = symbol.toUpperCase()+'USDT';
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=4h&limit=220`);
  const klines = await r.json();
  if(!Array.isArray(klines)) return null;
  return klines.map(k=>({t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5]}));
}
async function fetchBinancePrice(symbol){
  const pair = symbol.toUpperCase()+'USDT';
  try{
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
    const d = await r.json();
    return parseFloat(d.price);
  }catch(e){ return null; }
}

// ---------- Radar multi-exchange (para CUSTOM_COINS que no están en el top 60 de Binance) ----------
async function tryOKXCandles(symbol){
  const instId = `${symbol.toUpperCase()}-USDT`;
  const res = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=4H&limit=220`);
  const data = await res.json();
  if(!data.data || !data.data.length) throw new Error('OKX sin datos');
  return data.data.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]})).sort((a,b)=>a.t-b.t);
}
async function tryBybitCandles(symbol){
  const pair = `${symbol.toUpperCase()}USDT`;
  const res = await fetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair}&interval=240&limit=220`);
  const data = await res.json();
  const list = data.result?.list;
  if(!list || !list.length) throw new Error('Bybit sin datos');
  return list.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]})).sort((a,b)=>a.t-b.t);
}
async function tryMEXCCandles(symbol){
  const pair = `${symbol.toUpperCase()}USDT`;
  const res = await fetch(`https://api.mexc.com/api/v3/klines?symbol=${pair}&interval=4h&limit=220`);
  const klines = await res.json();
  if(!Array.isArray(klines) || !klines.length) throw new Error('MEXC sin datos');
  return klines.map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})).sort((a,b)=>a.t-b.t);
}
async function tryGateCandles(symbol){
  const pair = `${symbol.toUpperCase()}_USDT`;
  const res = await fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=4h&limit=220`);
  const rows = await res.json();
  if(!Array.isArray(rows) || !rows.length) throw new Error('Gate.io sin datos');
  // Formato Gate: [timestamp, volumen, close, high, low, open]
  return rows.map(r=>({t:+r[0]*1000,o:+r[5],h:+r[3],l:+r[4],c:+r[2],v:+r[1]})).sort((a,b)=>a.t-b.t);
}
// Prueba las fuentes en orden hasta encontrar una que tenga la moneda. Devuelve {source, candles}.
async function fetchCandlesAnywhere(symbol){
  const sources = [
    {name:'Binance', fn: ()=>fetchBinanceCandles(symbol)},
    {name:'OKX',     fn: ()=>tryOKXCandles(symbol)},
    {name:'Bybit',   fn: ()=>tryBybitCandles(symbol)},
    {name:'MEXC',    fn: ()=>tryMEXCCandles(symbol)},
    {name:'Gate.io', fn: ()=>tryGateCandles(symbol)},
  ];
  for(const s of sources){
    try{
      const candles = await s.fn();
      if(candles && candles.length>=220) return {source: s.name, candles};
    }catch(e){ /* probamos la siguiente */ }
  }
  return null;
}
async function getNewDexPools(){
  let pools = [];
  for(const net of DEX_NETWORKS){
    try{
      const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/new_pools?page=1`);
      const data = await r.json();
      const items = (data.data||[]).map(p=>({...p.attributes, network:net, poolAddress:p.attributes.address}));
      pools = pools.concat(items);
    }catch(e){ console.error('Error escaneando DEX', net, e.message); }
    await new Promise(res=>setTimeout(res, 400));
  }
  return pools.filter(p=>{
    const liq = parseFloat(p.reserve_in_usd)||0;
    const tx1h = (p.transactions?.h1?.buys||0) + (p.transactions?.h1?.sells||0);
    return liq >= 20000 && tx1h >= 10;
  });
}
async function fetchDexCandles(network, poolAddress){
  const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/hour?aggregate=4&limit=220`);
  const data = await r.json();
  const list = data?.data?.attributes?.ohlcv_list;
  if(!list || list.length<220) return null;
  return list.reverse().map(row=>({t:row[0]*1000, o:row[1], h:row[2], l:row[3], c:row[4], v:row[5]}));
}
async function fetchDexPrice(network, poolAddress){
  try{
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}`);
    const data = await r.json();
    return parseFloat(data?.data?.attributes?.base_token_price_usd);
  }catch(e){ return null; }
}

// ---------- Estado (nunca se borra el historial) ----------
function loadState(){
  let raw;
  try{ raw = JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); }catch(e){ raw = {}; }
  if(!raw || typeof raw !== 'object') raw = {};
  if(!raw.account){
    // Migración automática desde el formato viejo del bot (solo tenía el mapa de "ya notificado").
    // Antes, todo el archivo ERA ese mapa; ahora vive adentro de `notified`.
    const oldNotified = (raw.notified && typeof raw.notified==='object') ? raw.notified : raw;
    console.log('Migrando state.json de formato viejo a formato con cuenta TheHaton...');
    return {
      notified: oldNotified,
      account: { id:1, capital:100, initialCapital:100, openPositions:[], closedTrades:[], tradesToday:{date:null,count:0} },
      accountHistory: Array.isArray(raw.accountHistory) ? raw.accountHistory : []
    };
  }
  if(!raw.notified) raw.notified = {};
  if(!Array.isArray(raw.accountHistory)) raw.accountHistory = [];
  return raw;
}
function saveState(state){
  fs.mkdirSync('telegram-bot', {recursive:true});
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
async function sendTelegram(text){
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({chat_id: CHAT_ID, text, parse_mode:'HTML'})
  });
  if(!res.ok){ console.error('Error enviando a Telegram:', await res.text()); }
}

function argentinaHourNow(){
  const utcHour = new Date().getUTCHours();
  return (utcHour - 3 + 24) % 24; // Argentina = UTC-3, sin horario de verano
}
function todayKey(){
  return new Date().toISOString().slice(0,10); // YYYY-MM-DD (UTC, suficiente como clave de día)
}

// ---------- TheHaton: revisar posiciones abiertas ----------
async function getLatestPrice(pos){
  if(pos.source==='DEX') return await fetchDexPrice(pos.network, pos.poolAddress);
  if(pos.source==='BINANCE') return await fetchBinancePrice(pos.symbol);
  // OKX / BYBIT / MEXC / GATE.IO: reusamos el resolver multi-exchange y tomamos el último cierre
  const found = await fetchCandlesAnywhere(pos.symbol);
  return found ? found.candles.at(-1).c : null;
}

async function checkOpenPositions(state){
  const acc = state.account;
  const stillOpen = [];
  for(const pos of acc.openPositions){
    let price = null;
    try{ price = await getLatestPrice(pos); }catch(e){}
    if(price==null){ stillOpen.push(pos); continue; }

    let hitTP=false, hitSL=false;
    if(pos.dir==='LONG'){ if(price<=pos.stop) hitSL=true; else if(price>=pos.tp) hitTP=true; }
    else { if(price>=pos.stop) hitSL=true; else if(price<=pos.tp) hitTP=true; }

    if(hitTP || hitSL){
      const exit = hitTP ? pos.tp : pos.stop;
      const pnl = pos.units * (exit-pos.entry) * (pos.dir==='LONG'?1:-1);
      acc.capital = +(acc.capital + pnl).toFixed(4);
      const trade = {...pos, exit, result: hitTP?'win':'loss', pnl:+pnl.toFixed(4), closedAt: Date.now()};
      acc.closedTrades.push(trade);
      console.log(`TheHaton cerró ${pos.symbol} ${pos.dir}: ${trade.result} (${pnl.toFixed(2)} USDT). Capital: ${acc.capital}`);
      sendPromises.push(sendTelegram(
        `${hitTP?'✅':'🛑'} <b>TheHaton cerró ${pos.symbol} ${pos.dir}</b>\n` +
        `Resultado: ${trade.result==='win'?'GANÓ':'PERDIÓ'} (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT)\n` +
        `Capital actual: ${acc.capital.toFixed(2)} USDT`
      ));
    } else {
      stillOpen.push(pos);
    }
  }
  acc.openPositions = stillOpen;

  // Cuenta agotada -> archivar y abrir una nueva, sin borrar nada
  if(acc.capital <= 0){
    console.log('TheHaton agotó el capital. Archivando cuenta #' + acc.id + ' y abriendo una nueva.');
    sendPromises.push(sendTelegram(`💀 <b>TheHaton agotó la cuenta #${acc.id}</b>\nAbriendo cuenta nueva de 100 USDT. El historial anterior queda guardado para siempre.`));
    state.accountHistory.push({id:acc.id, finalCapital:acc.capital, closedTrades:acc.closedTrades, closedAt:Date.now()});
    state.account = { id: acc.id+1, capital:100, initialCapital:100, openPositions:[], closedTrades:[], tradesToday:{date:null,count:0} };
  }
}

// ---------- TheHaton: abrir posición nueva si hay señal y estamos en horario ----------
// Riesgo dinámico: sube o baja el % arriesgado según el drawdown y la racha reciente.
// Nunca sale del rango 0.5%-1.5% (regla maestra: nunca romper el límite conservador salvo confluencia extrema del propio score).
function computeDynamicRisk(acc, confidencePct){
  if(acc.peakCapital == null) acc.peakCapital = acc.capital;
  acc.peakCapital = Math.max(acc.peakCapital, acc.capital);
  const drawdown = acc.peakCapital>0 ? (acc.peakCapital-acc.capital)/acc.peakCapital : 0;
  const recent = acc.closedTrades.slice(-3);
  const recentLosses = recent.filter(t=>t.result==='loss').length;

  let risk = RISK_PCT; // base 1%
  let reason = 'riesgo base (1%)';
  if(drawdown>0.15 || recentLosses>=2){
    risk = 0.005;
    reason = `riesgo reducido a 0.5% (drawdown ${(drawdown*100).toFixed(0)}% o ${recentLosses} pérdidas seguidas)`;
  } else if(confidencePct>=90 && recentLosses===0 && drawdown<0.05){
    risk = 0.015;
    reason = `riesgo aumentado a 1.5% (alta confianza ${confidencePct}% y sin pérdidas recientes)`;
  }
  return {risk: Math.max(0.005, Math.min(0.015, risk)), reason};
}

function tryOpenPosition(state, symbol, r, tag, source, network, poolAddress){
  const acc = state.account;
  const hour = argentinaHourNow();
  if(hour < WORK_HOUR_START || hour >= WORK_HOUR_END) return false; // fuera de horario de trabajo

  const today = todayKey();
  if(acc.tradesToday.date !== today) acc.tradesToday = {date:today, count:0};
  if(acc.tradesToday.count >= MAX_TRADES_PER_DAY) return false;

  if(acc.openPositions.find(p=>p.symbol===symbol)) return false; // ya hay una posición abierta en esa moneda

  const best = Math.max(r.longScore, r.shortScore);
  if(best < THRESHOLD || r.recommendation==='NO OPERAR') return false;

  const confidencePct = Math.round(best*10); // proxy simple 0-100 a partir del score
  const {risk: riskPct, reason: riskReason} = computeDynamicRisk(acc, confidencePct);
  const riskAmount = acc.capital * riskPct;
  const distance = Math.abs(r.price - r.stop);
  if(distance<=0) return false;
  const units = riskAmount / distance;

  acc.openPositions.push({
    symbol, dir: r.recommendation, entry: r.price, stop: r.stop, tp: r.t1, units,
    source, network, poolAddress, tag, openedAt: Date.now(), riskPct
  });
  acc.tradesToday.count++;
  console.log(`TheHaton abrió ${symbol}${tag} ${r.recommendation} @ ${r.price} (score ${best.toFixed(1)}, ${riskReason})`);
  sendPromises.push(sendTelegram(
    `🏛️ <b>TheHaton abrió ${symbol}${tag} ${r.recommendation}</b>\n` +
    `Score: ${best.toFixed(1)}/10\nEntrada: $${r.price.toFixed(6)}\nStop: $${r.stop.toFixed(6)}\nTP: $${r.t1.toFixed(6)}\n` +
    `Riesgo de esta operación: ${(riskPct*100).toFixed(1)}% (${riskReason})\n` +
    `Capital de la cuenta: ${acc.capital.toFixed(2)} USDT (cuenta #${acc.id})`
  ));
  return true;
}

let sendPromises = [];

async function evaluateAndNotify(name, candles, state, now, ONE_HOUR, tag, source, network, poolAddress){
  if(!candles || candles.length<220){ console.log(name, 'sin datos suficientes'); return; }
  const r = scoreCoin(candles);
  const best = Math.max(r.longScore, r.shortScore);
  console.log(`${name}${tag}`, r.recommendation, best.toFixed(1));

  if(best>=THRESHOLD && r.recommendation!=='NO OPERAR'){
    const key = name+'_'+r.recommendation;
    const lastNotified = state.notified[key] || 0;
    if(now-lastNotified > ONE_HOUR){
      const msg = `🚨 <b>SIGNAL — ${name}${tag} ${r.recommendation}</b>\n\n` +
        `Score: ${best.toFixed(1)}/10\nPrecio: $${r.price.toFixed(6)}\n` +
        `Stop Loss (2x ATR): $${r.stop.toFixed(6)}\nTP1: $${r.t1.toFixed(6)}\n\n` +
        `⚠️ Análisis automatizado (4h), no es asesoría financiera.`;
      sendPromises.push(sendTelegram(msg));
      state.notified[key] = now;
      console.log('  -> Alerta enviada.');
    }
  }
  tryOpenPosition(state, name, r, tag, source, network, poolAddress);
}

async function main(){
  if(!BOT_TOKEN || !CHAT_ID){
    console.error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en los secrets.');
    process.exit(1);
  }
  const state = loadState();
  const now = Date.now();
  const ONE_HOUR = 60*60*1000;

  console.log('--- TheHaton: revisando posiciones abiertas ---');
  await checkOpenPositions(state);

  // ---- Modo de prueba: fuerza una operación de test en BTC para confirmar que todo el circuito funciona ----
  if(process.env.FORCE_TEST_TRADE === 'true'){
    console.log('--- MODO DE PRUEBA: forzando una operación de test en BTC ---');
    try{
      const candles = await fetchBinanceCandles('BTC');
      const r = scoreCoin(candles);
      const acc = state.account;
      const riskAmount = acc.capital * RISK_PCT;
      const distance = Math.max(Math.abs(r.price - r.stop), r.price*0.001);
      const units = riskAmount / distance;
      const dir = r.recommendation === 'NO OPERAR' ? 'LONG' : r.recommendation; // si no hay señal, forzamos LONG igual
      const stopTest = dir==='LONG' ? r.price - distance : r.price + distance;
      const tpTest = dir==='LONG' ? r.price + distance*1.5 : r.price - distance*1.5;
      acc.openPositions.push({
        symbol:'BTC', dir, entry:r.price, stop:stopTest, tp:tpTest, units,
        source:'BINANCE', network:null, poolAddress:null, tag:' (TEST)', openedAt: Date.now()
      });
      await sendTelegram(
        `🧪 <b>TheHaton — Operación de PRUEBA abierta (BTC ${dir})</b>\n` +
        `Esto es solo para confirmar que el circuito funciona de punta a punta.\n` +
        `Entrada: $${r.price.toFixed(2)}\nStop: $${stopTest.toFixed(2)}\nTP: $${tpTest.toFixed(2)}\n` +
        `Capital: ${acc.capital.toFixed(2)} USDT (cuenta #${acc.id})`
      );
      console.log('Operación de prueba abierta y mensaje de test enviado a Telegram.');
    }catch(e){ console.error('Error en el modo de prueba:', e.message); }
  }

  console.log('--- Escaneando Binance (top', TOP_N_BINANCE, 'por volumen 24h) ---');
  const pairs = await getTopBinancePairs(TOP_N_BINANCE);
  for(const symbol of pairs){
    try{
      const candles = await fetchBinanceCandles(symbol);
      await evaluateAndNotify(symbol, candles, state, now, ONE_HOUR, '', 'BINANCE', null, null);
    }catch(e){ console.error('Error con', symbol, e.message); }
    await new Promise(res=>setTimeout(res, 250));
  }

  console.log('--- Escaneando CUSTOM_COINS (radar multi-exchange: Binance/OKX/Bybit/MEXC/Gate.io) ---');
  for(const symbol of CUSTOM_COINS){
    if(pairs.includes(symbol)){ console.log(symbol, 'ya se escaneó en el top', TOP_N_BINANCE, 'de Binance, se omite duplicado.'); continue; }
    try{
      const found = await fetchCandlesAnywhere(symbol);
      if(!found){ console.log(symbol, '-> no se encontró en ninguna de las 5 fuentes.'); continue; }
      await evaluateAndNotify(symbol, found.candles, state, now, ONE_HOUR, ` (${found.source})`, found.source.toUpperCase(), null, null);
    }catch(e){ console.error('Error con', symbol, e.message); }
    await new Promise(res=>setTimeout(res, 300));
  }

  console.log('--- Escaneando pools nuevas en DEXs (liquidez >= $20k) ---');
  const dexPools = await getNewDexPools();
  console.log(dexPools.length, 'pools pasaron el filtro de seguridad.');
  for(const pool of dexPools.slice(0, 25)){
    try{
      const candles = await fetchDexCandles(pool.network, pool.poolAddress);
      const name = (pool.name||'?').split('/')[0].trim();
      await evaluateAndNotify(name, candles, state, now, ONE_HOUR, ` (DEX ${pool.network})`, 'DEX', pool.network, pool.poolAddress);
    }catch(e){ console.error('Error con pool DEX', e.message); }
    await new Promise(res=>setTimeout(res, 400));
  }

  await Promise.all(sendPromises);
  saveState(state);
  console.log('--- Escaneo completo. Capital actual de TheHaton:', state.account.capital, '---');
}

main();
