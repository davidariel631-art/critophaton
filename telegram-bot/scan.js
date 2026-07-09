// Fortress Terminal — Bot de señales para Telegram
// Corre en GitHub Actions (gratis, programado). Usa una versión simplificada
// del motor de score del sitio web (EMA/RSI/MACD/ATR + estructura básica).
//
// v2: ya no analiza una lista fija de 12 monedas. Ahora escanea:
//   1) Las top N pares USDT de Binance por volumen 24h (dinámico, se actualiza solo).
//   2) Pools nuevas en DEXs (Solana/Base/Ethereum) con el mismo filtro de
//      seguridad que la web: liquidez >= $20,000.

import fs from 'fs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const THRESHOLD = 8.0;         // score mínimo (sobre 10) para avisar
const TOP_N_BINANCE = 60;      // cuántos pares de Binance escanear, por volumen 24h
const DEX_NETWORKS = ['solana','base','eth'];
const STATE_FILE = 'telegram-bot/state.json';

// ---------- Indicadores (mismas fórmulas que la web) ----------
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

// ---------- Fuente 1: Binance, top N por volumen 24h (dinámico) ----------
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

// ---------- Fuente 2: DEX (pools nuevas, filtro de seguridad liquidez >= $20k) ----------
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

function loadState(){
  try{ return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); }catch(e){ return {}; }
}
function saveState(state){
  fs.mkdirSync('telegram-bot', {recursive:true});
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
async function sendTelegram(text){
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({chat_id: CHAT_ID, text, parse_mode:'HTML'})
  });
  if(!res.ok){ console.error('Error enviando a Telegram:', await res.text()); }
}

async function evaluateAndNotify(name, candles, state, now, ONE_HOUR, tag){
  if(!candles || candles.length<220){ console.log(name, 'sin datos suficientes'); return; }
  const r = scoreCoin(candles);
  const best = Math.max(r.longScore, r.shortScore);
  console.log(`${name}${tag}`, r.recommendation, best.toFixed(1));
  if(best>=THRESHOLD && r.recommendation!=='NO OPERAR'){
    const key = name+'_'+r.recommendation;
    const lastNotified = state[key] || 0;
    if(now-lastNotified > ONE_HOUR){
      const msg = `🚨 <b>SIGNAL — ${name}${tag} ${r.recommendation}</b>\n\n` +
        `Score: ${best.toFixed(1)}/10\n` +
        `Precio: $${r.price.toFixed(6)}\n` +
        `Stop Loss (2x ATR): $${r.stop.toFixed(6)}\n` +
        `TP1: $${r.t1.toFixed(6)}\n\n` +
        `⚠️ Análisis automatizado (4h), no es asesoría financiera.`;
      await sendTelegram(msg);
      state[key] = now;
      console.log('  -> Alerta enviada.');
    } else {
      console.log('  -> Ya notificado hace menos de 1h, se omite.');
    }
  }
}

async function main(){
  if(!BOT_TOKEN || !CHAT_ID){
    console.error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en los secrets.');
    process.exit(1);
  }
  const state = loadState();
  const now = Date.now();
  const ONE_HOUR = 60*60*1000;

  console.log('--- Escaneando Binance (top', TOP_N_BINANCE, 'por volumen 24h) ---');
  const pairs = await getTopBinancePairs(TOP_N_BINANCE);
  for(const symbol of pairs){
    try{
      const candles = await fetchBinanceCandles(symbol);
      await evaluateAndNotify(symbol, candles, state, now, ONE_HOUR, '');
    }catch(e){ console.error('Error con', symbol, e.message); }
    await new Promise(res=>setTimeout(res, 250));
  }

  console.log('--- Escaneando pools nuevas en DEXs (liquidez >= $20k) ---');
  const dexPools = await getNewDexPools();
  console.log(dexPools.length, 'pools pasaron el filtro de seguridad.');
  for(const pool of dexPools.slice(0, 25)){ // límite razonable para no gastar de más el rate limit
    try{
      const candles = await fetchDexCandles(pool.network, pool.poolAddress);
      const name = (pool.name||'?').split('/')[0].trim();
      await evaluateAndNotify(name, candles, state, now, ONE_HOUR, ` (DEX ${pool.network})`);
    }catch(e){ console.error('Error con pool DEX', e.message); }
    await new Promise(res=>setTimeout(res, 400));
  }

  saveState(state);
  console.log('--- Escaneo completo ---');
}

main();
