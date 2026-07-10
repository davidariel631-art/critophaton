// Fortress Terminal — TheHaton Strategy Center (bot)
// Corre en GitHub Actions cada 15 min. USA EL MISMO MOTOR que la web
// (../thehaton-engine.js, un único archivo físico en la raíz del repo,
// el mismo que carga index.html) — no hay una versión "simplificada" acá.
// Cualquier análisis (Binance top N, CUSTOM_COINS multi-exchange, DEX
// nuevas) usa exactamente computeScore/buildSetup/buildAnalystMode del
// motor compartido, con Smart Money, comité de 11 dioses, filtro macro,
// noticias y todo lo demás.
//
// TheHaton Strategy Center: en vez de abrir una operación apenas ve un
// score alto en 4h, crea una TESIS (estado WATCHING) y baja a 15m para
// buscar confirmación usando el MISMO motor completo (no una regla
// simplificada de RSI+volumen). Solo pasa a ACTIVE cuando el motor,
// corrido sobre 15m, confirma la misma dirección con estructura real
// (BOS a favor) o sube su confianza. Cada tesis lleva un diario
// cronológico en lenguaje simple.
//
// Memoria compartida: state.json (este mismo archivo) es LA ÚNICA
// memoria de toda la plataforma. La web la lee (misma URL pública de
// GitHub) para el "Dios Memoria" del comité y el panel TheHaton.

import fs from 'fs';
import {
  fetchTokenData, fetchMacroTrend, fetchRelevantNews,
  computeScore, buildSetup, buildAnalystMode
} from '../thehaton-engine.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const THRESHOLD = 8.0;
const TOP_N_BINANCE = 60;
const DEX_NETWORKS = ['solana','base','eth'];
const STATE_FILE = 'telegram-bot/state.json';
const MAX_TRADES_PER_DAY = 4;
const WORK_HOUR_START = 4;
const WORK_HOUR_END = 15;
const RISK_PCT = 0.01;
const THESIS_EXPIRY_HOURS = 18; // si no confirma entrada en este tiempo, se archiva como expirada
const BREAKEVEN_AT_R = 1;       // mueve el stop a breakeven al alcanzar 1R de ganancia flotante

// Editá esta lista con las monedas que operás aunque no estén en el top 60 de Binance
const CUSTOM_COINS = ['TIA','SEI','JUP','PYTH','WIF','ORDI','STRK','ENA','W','TNSR'];

let sendPromises = [];

async function sendTelegram(text){
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({chat_id: CHAT_ID, text, parse_mode:'HTML'})
  });
  if(!res.ok){ console.error('Error enviando a Telegram:', await res.text()); }
}

// ---------- Estado / memoria compartida (única para toda la plataforma) ----------
function loadState(){
  let raw;
  try{ raw = JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); }catch(e){ raw = {}; }
  if(!raw || typeof raw !== 'object') raw = {};
  if(!raw.account){
    const oldNotified = (raw.notified && typeof raw.notified==='object') ? raw.notified : raw;
    console.log('Migrando state.json a formato con TheHaton Strategy Center...');
    raw = {
      notified: oldNotified,
      account: { id:1, capital:100, initialCapital:100, peakCapital:100, theses:[], closedTrades:[], expiredTheses:[], tradesToday:{date:null,count:0} },
      accountHistory: [],
      memory: {}
    };
  }
  if(!raw.notified) raw.notified = {};
  if(!Array.isArray(raw.accountHistory)) raw.accountHistory = [];
  if(!raw.memory) raw.memory = {};
  if(!raw.account.theses) raw.account.theses = raw.account.openPositions || []; // migración desde v3
  if(!raw.account.expiredTheses) raw.account.expiredTheses = [];
  if(raw.account.peakCapital == null) raw.account.peakCapital = raw.account.capital;
  return raw;
}
function saveState(state){
  fs.mkdirSync('telegram-bot', {recursive:true});
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function updateSharedMemory(state, displayName, recommendation){
  state.memory[displayName] = { lastRecommendation: recommendation, ts: Date.now() };
}

function argentinaHourNow(){ return (new Date().getUTCHours() - 3 + 24) % 24; }
function todayKey(){ return new Date().toISOString().slice(0,10); }

function computeDynamicRisk(acc, confidencePct){
  acc.peakCapital = Math.max(acc.peakCapital, acc.capital);
  const drawdown = acc.peakCapital>0 ? (acc.peakCapital-acc.capital)/acc.peakCapital : 0;
  const recent = acc.closedTrades.slice(-3);
  const recentLosses = recent.filter(t=>t.result==='loss').length;
  let risk = RISK_PCT, reason = 'riesgo base (1%)';
  if(drawdown>0.15 || recentLosses>=2){ risk=0.005; reason=`riesgo reducido a 0.5% (drawdown ${(drawdown*100).toFixed(0)}% o ${recentLosses} pérdidas seguidas)`; }
  else if(confidencePct>=90 && recentLosses===0 && drawdown<0.05){ risk=0.015; reason=`riesgo aumentado a 1.5% (alta confianza, sin pérdidas recientes)`; }
  return { risk: Math.max(0.005, Math.min(0.015, risk)), reason };
}

function journal(thesis, note){
  thesis.journal.push({ts: Date.now(), note});
  console.log(`  [${thesis.symbol}] ${note}`);
}

// ---------- Fase 1: escanear 4h/1D en busca de nuevas tesis (usa el motor completo) ----------
async function scanForTheses(state, candidates){
  const acc = state.account;
  for(const {symbol, tag} of candidates){
    if(acc.theses.find(t=>t.symbol===symbol)) continue; // ya hay una tesis abierta para esa moneda
    try{
      const data = await fetchTokenData(symbol, '4h');
      if(!data.candles || data.candles.length<220) continue;
      const macro = await fetchMacroTrend(symbol).catch(()=>null);
      const news = await fetchRelevantNews(symbol).catch(()=>[]);
      const result = computeScore(data, macro, news, state.memory);
      const best = Math.max(result.longScore, result.shortScore);
      console.log(`${symbol}${tag}`, result.recommendation, best.toFixed(1));

      updateSharedMemory(state, symbol, result.recommendation);

      // Alerta instantánea existente (igual que siempre), no depende de la tesis
      if(best>=THRESHOLD && result.recommendation!=='NO OPERAR'){
        const key = symbol+'_'+result.recommendation;
        const now = Date.now();
        if(now - (state.notified[key]||0) > 60*60*1000){
          sendPromises.push(sendTelegram(
            `🚨 <b>SIGNAL — ${symbol}${tag} ${result.recommendation}</b>\n\nScore: ${best.toFixed(1)}/10\nPrecio: $${data.price.toFixed(6)}\n\n⚠️ Análisis automatizado, no es asesoría financiera.`
          ));
          state.notified[key] = now;
        }
      }

      if(best < THRESHOLD || result.recommendation === 'NO OPERAR') continue;

      const hour = argentinaHourNow();
      if(hour < WORK_HOUR_START || hour >= WORK_HOUR_END) continue;
      const today = todayKey();
      if(acc.tradesToday.date !== today) acc.tradesToday = {date:today, count:0};
      if(acc.tradesToday.count >= MAX_TRADES_PER_DAY) continue;

      // Crear la TESIS (todavía no es una operación real)
      const thesis = {
        id: Date.now()+'_'+symbol, symbol, dir: result.recommendation, tag,
        status: 'WATCHING', conviction: best*10,
        detectedAt: Date.now(), expiresAt: Date.now()+THESIS_EXPIRY_HOURS*3600*1000,
        breakEvenMoved: false, journal: []
      };
      journal(thesis, `Tesis detectada en 4h: ${result.recommendation} (score ${best.toFixed(1)}/10, confianza ${result.confidence}%). ${analystSummary(result)} Bajando a 15m a buscar confirmación de entrada.`);
      acc.theses.push(thesis);
    }catch(e){ console.error('Error escaneando', symbol, e.message); }
    await new Promise(res=>setTimeout(res, 300));
  }
}

function analystSummary(result){
  const top = result.committee.filter(c=>c.vote===result.recommendation).map(c=>c.name.replace(/^[^\s]+\s/,''));
  return top.length ? `A favor: ${top.slice(0,4).join(', ')}.` : '';
}

// ---------- Fase 2: confirmar tesis en 15m usando el MISMO motor completo ----------
async function confirmTheses(state){
  const acc = state.account;
  const stillWatching = [];
  for(const thesis of acc.theses){
    if(thesis.status !== 'WATCHING'){ stillWatching.push(thesis); continue; }

    if(Date.now() > thesis.expiresAt){
      journal(thesis, `Expiró sin confirmación después de ${THESIS_EXPIRY_HOURS}h. Se archiva (el historial nunca se borra).`);
      state.account.expiredTheses.push(thesis);
      continue;
    }

    try{
      const data15 = await fetchTokenData(thesis.symbol, '15m');
      if(!data15.candles || data15.candles.length<220){ stillWatching.push(thesis); continue; }
      const macro = await fetchMacroTrend(thesis.symbol).catch(()=>null);
      const result15 = computeScore(data15, macro, [], state.memory);

      const alineado = result15.recommendation === thesis.dir;
      const bosAFavor = thesis.dir==='LONG' ? result15.structure?.events?.bos==='bullish' : result15.structure?.events?.bos==='bearish';
      const confianzaSubio = result15.confidence >= thesis.conviction;

      if(alineado && (bosAFavor || confianzaSubio)){
        const setup = buildSetup(data15, result15, 'balanced');
        const entryPrice = result15.metrics.price; // mismo precio que usó buildSetup para calcular stop/TP, evita descalces
        const {risk: riskPct, reason} = computeDynamicRisk(acc, result15.confidence);
        const riskAmount = acc.capital * riskPct;
        const distance = Math.abs(entryPrice - setup.stop);
        if(distance<=0){ stillWatching.push(thesis); continue; }
        const units = riskAmount / distance;

        thesis.status = 'ACTIVE';
        thesis.entry = entryPrice; thesis.stop = setup.stop; thesis.tp = setup.t1; thesis.units = units;
        thesis.riskPct = riskPct; thesis.confirmedAt = Date.now();
        journal(thesis, `Entrada CONFIRMADA en 15m ${bosAFavor?'(BOS a favor detectado)':'(la confianza del motor subió a '+result15.confidence+'%)'}. Entrada: $${entryPrice.toFixed(6)}, Stop: $${setup.stop.toFixed(6)}, TP: $${setup.t1.toFixed(6)}. ${reason}.`);
        acc.tradesToday.count++;
        sendPromises.push(sendTelegram(
          `🏛️ <b>TheHaton confirmó entrada — ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n\n` +
          `Entrada: $${entryPrice.toFixed(6)}\nStop: $${setup.stop.toFixed(6)}\nTP: $${setup.t1.toFixed(6)}\n` +
          `Riesgo: ${(riskPct*100).toFixed(1)}% (${reason})\nCapital: ${acc.capital.toFixed(2)} USDT (cuenta #${acc.id})`
        ));
      } else {
        journal(thesis, `Todavía esperando confirmación en 15m (no hay BOS a favor ni suba de confianza). Sigue observando.`);
        stillWatching.push(thesis);
      }
    }catch(e){ console.error('Error confirmando', thesis.symbol, e.message); stillWatching.push(thesis); }
    await new Promise(res=>setTimeout(res, 300));
  }
  acc.theses = stillWatching;
}

// ---------- Fase 3: gestionar tesis activas (TP/SL, breakeven) ----------
async function manageActiveTheses(state){
  const acc = state.account;
  const stillOpen = [];
  for(const thesis of acc.theses){
    if(thesis.status !== 'ACTIVE'){ stillOpen.push(thesis); continue; }
    let price = null;
    try{ const d = await fetchTokenData(thesis.symbol, '15m'); price = d.price; }catch(e){}
    if(price==null){ stillOpen.push(thesis); continue; }

    const distanceR = Math.abs(thesis.entry - thesis.stop);
    const favorMove = thesis.dir==='LONG' ? (price-thesis.entry) : (thesis.entry-price);
    if(!thesis.breakEvenMoved && favorMove >= distanceR*BREAKEVEN_AT_R){
      thesis.stop = thesis.entry;
      thesis.breakEvenMoved = true;
      journal(thesis, `Alcanzó ${BREAKEVEN_AT_R}R de ganancia flotante. Se movió el Stop Loss a Break Even ($${thesis.entry.toFixed(6)}) para proteger capital.`);
    }

    let hitTP=false, hitSL=false;
    if(thesis.dir==='LONG'){ if(price<=thesis.stop) hitSL=true; else if(price>=thesis.tp) hitTP=true; }
    else { if(price>=thesis.stop) hitSL=true; else if(price<=thesis.tp) hitTP=true; }

    if(hitTP || hitSL){
      const exit = hitTP ? thesis.tp : thesis.stop;
      const pnl = thesis.units * (exit-thesis.entry) * (thesis.dir==='LONG'?1:-1);
      acc.capital = +(acc.capital+pnl).toFixed(4);
      journal(thesis, `Operación cerrada: ${hitTP?'TP alcanzado':'Stop tocado'} (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT). Capital: ${acc.capital.toFixed(2)}.`);
      acc.closedTrades.push({...thesis, exit, result: hitTP?'win':'loss', pnl:+pnl.toFixed(4), closedAt: Date.now()});
      sendPromises.push(sendTelegram(
        `${hitTP?'✅':'🛑'} <b>TheHaton cerró ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
        `${hitTP?'GANÓ':'PERDIÓ'} (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT)\nCapital actual: ${acc.capital.toFixed(2)} USDT`
      ));
    } else {
      stillOpen.push(thesis);
    }
  }
  acc.theses = stillOpen;

  if(acc.capital <= 0){
    sendPromises.push(sendTelegram(`💀 <b>TheHaton agotó la cuenta #${acc.id}</b>\nAbriendo cuenta nueva de 100 USDT. El historial anterior queda archivado para siempre.`));
    state.accountHistory.push({id:acc.id, finalCapital:acc.capital, closedTrades:acc.closedTrades, expiredTheses:acc.expiredTheses, closedAt:Date.now()});
    state.account = { id:acc.id+1, capital:100, initialCapital:100, peakCapital:100, theses:[], closedTrades:[], expiredTheses:[], tradesToday:{date:null,count:0} };
  }
}

// ---------- Candidatos a escanear ----------
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
async function getNewDexPools(){
  let pools = [];
  for(const net of DEX_NETWORKS){
    try{
      const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/new_pools?page=1`);
      const data = await r.json();
      pools = pools.concat((data.data||[]).map(p=>({...p.attributes, network:net})));
    }catch(e){}
    await new Promise(res=>setTimeout(res, 400));
  }
  return pools.filter(p=>{
    const liq = parseFloat(p.reserve_in_usd)||0;
    const tx1h = (p.transactions?.h1?.buys||0) + (p.transactions?.h1?.sells||0);
    return liq>=20000 && tx1h>=10;
  });
}

async function main(){
  if(!BOT_TOKEN || !CHAT_ID){ console.error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.'); process.exit(1); }
  const state = loadState();

  console.log('--- Fase 1: gestionando tesis ACTIVAS (TP/SL/breakeven) ---');
  await manageActiveTheses(state);

  console.log('--- Fase 2: confirmando tesis WATCHING en 15m (motor completo) ---');
  await confirmTheses(state);

  console.log('--- Fase 3: escaneando Binance top', TOP_N_BINANCE, 'en busca de nuevas tesis ---');
  const pairs = await getTopBinancePairs(TOP_N_BINANCE);
  const candidates = pairs.map(symbol=>({symbol, tag:''}));
  for(const symbol of CUSTOM_COINS){
    if(!pairs.includes(symbol)) candidates.push({symbol, tag:' (custom)'});
  }
  await scanForTheses(state, candidates);

  console.log('--- Fase 4: pools nuevas en DEX ---');
  const dexPools = await getNewDexPools();
  const dexCandidates = dexPools.slice(0,20).map(p=>({symbol:(p.name||'?').split('/')[0].trim(), tag:` (DEX ${p.network})`}));
  await scanForTheses(state, dexCandidates);

  await Promise.all(sendPromises);
  saveState(state);
  console.log('--- Listo. Capital de TheHaton:', state.account.capital, '· Tesis abiertas:', state.account.theses.length, '---');
}

main().catch(e=>{ console.error('Error fatal:', e); process.exit(1); });
