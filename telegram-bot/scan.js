// Fortress Terminal — TheHaton Strategy Center (bot)
// Corre en GitHub Actions cada 1 hora. USA EL MISMO MOTOR que la web
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
  fetchOpenInterestTrend, fetchFundingTrend, fetchCapitalFlowContext,
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
// (el breakeven ahora se maneja al tomar el 50% en TP1, ver manageActiveTheses)
const MAX_DAYS_OPEN_LIMIT = 30; // cierre forzado si una tesis queda abierta más de este tiempo sin resolver

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
  if(!raw.account.theses){
    // Migración desde v3: esas posiciones YA estaban abiertas (no eran tesis "observando"),
    // así que hay que marcarlas como ACTIVE explícitamente. Este era el bug: al no tener
    // status, ni confirmTheses (busca WATCHING) ni manageActiveTheses (busca ACTIVE) las
    // procesaba nunca — quedaban "flotando" para siempre sin chequear TP/SL.
    raw.account.theses = (raw.account.openPositions || []).map(p => ({
      ...p,
      status: p.status || 'ACTIVE',
      journal: p.journal || [{ts: p.openedAt || Date.now(), note: 'Posición migrada desde una versión anterior del bot (sin diario previo).'}],
      breakEvenMoved: p.breakEvenMoved || false,
    }));
  }
  if(!raw.account.expiredTheses) raw.account.expiredTheses = [];
  if(raw.account.peakCapital == null) raw.account.peakCapital = raw.account.capital;

  // Red de seguridad: cualquier tesis sin status reconocido, o ACTIVE con más de 30 días,
  // se fuerza a cerrar en vez de quedar invisible para siempre.
  const MAX_DAYS_OPEN = MAX_DAYS_OPEN_LIMIT;
  raw.account.theses = raw.account.theses.filter(t=>{
    if(t.status!=='WATCHING' && t.status!=='ACTIVE'){
      console.log(`⚠️ Tesis huérfana detectada en ${t.symbol} (status="${t.status}"). Se fuerza a ACTIVE para que no quede trabada.`);
      t.status = 'ACTIVE';
      t.journal = t.journal || [];
    }
    const ageDays = (Date.now() - (t.detectedAt||t.openedAt||Date.now())) / (1000*60*60*24);
    if(t.status==='ACTIVE' && ageDays > MAX_DAYS_OPEN){
      console.log(`⚠️ ${t.symbol} lleva ${ageDays.toFixed(0)} días abierta (límite ${MAX_DAYS_OPEN}). Se marca para cierre forzado esta corrida.`);
      t.forceClose = true;
    }
    return true;
  });
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
async function scanForTheses(state, candidates, capitalFlow){
  const acc = state.account;
  for(const {symbol, tag} of candidates){
    if(acc.theses.find(t=>t.symbol===symbol)) continue; // ya hay una tesis abierta para esa moneda
    try{
      const data = await fetchTokenData(symbol, '4h');
      if(!data.candles || data.candles.length<220) continue;
      const macro = await fetchMacroTrend(symbol).catch(()=>null);
      const news = await fetchRelevantNews(symbol).catch(()=>[]);
      const oiTrendData = data.source==='Binance' ? await fetchOpenInterestTrend(symbol, '4h').catch(()=>null) : null;
      const fundingTrendData = data.source==='Binance' ? await fetchFundingTrend(symbol).catch(()=>null) : null;
      const marketContext = { oiTrend: oiTrendData?.trend||null, fundingTrend: fundingTrendData?.trend||null, capitalFlow };
      const result = computeScore(data, macro, news, state.memory, marketContext);
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
async function confirmTheses(state, capitalFlow){
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
      const oiTrendData = data15.source==='Binance' ? await fetchOpenInterestTrend(thesis.symbol, '15m').catch(()=>null) : null;
      const fundingTrendData = data15.source==='Binance' ? await fetchFundingTrend(thesis.symbol).catch(()=>null) : null;
      const marketContext15 = { oiTrend: oiTrendData?.trend||null, fundingTrend: fundingTrendData?.trend||null, capitalFlow };
      const result15 = computeScore(data15, macro, [], state.memory, marketContext15);

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
        thesis.entry = entryPrice; thesis.stop = setup.stop; thesis.tp1 = setup.t1; thesis.tp2 = setup.t2; thesis.units = units;
        thesis.riskPct = riskPct; thesis.confirmedAt = Date.now(); thesis.partialTaken = false;
        journal(thesis, `Entrada CONFIRMADA en 15m ${bosAFavor?'(BOS a favor detectado)':'(la confianza del motor subió a '+result15.confidence+'%)'}. Entrada: $${entryPrice.toFixed(6)}, Stop: $${setup.stop.toFixed(6)}, TP1: $${setup.t1.toFixed(6)}, TP2: $${setup.t2.toFixed(6)}. ${reason}.`);
        acc.tradesToday.count++;

        const analyst = buildAnalystMode(data15, result15, setup, '15m');
        const rrTp1 = (Math.abs(setup.t1-entryPrice)/distance).toFixed(1);
        const rrTp2 = (Math.abs(setup.t2-entryPrice)/distance).toFixed(1);
        const razones = result15.committee.filter(c=>c.vote===thesis.dir).slice(0,4).map(c=>`✅ ${c.name.replace(/^[^\s]+\s/,'')}: ${c.note||'a favor'}`).join('\n');
        const invalidacion = (analyst.invalidation||[])[0] || `Cierre de vela más allá del stop ($${setup.stop.toFixed(6)}).`;

        sendPromises.push(sendTelegram(
          `📈 <b>SEÑAL: $${thesis.symbol}${thesis.tag||''} ${thesis.dir==='LONG'?'COMPRA 🟢':'VENTA 🔴'}</b>\n\n` +
          `<b>¿Por qué ${thesis.dir==='LONG'?'COMPRA':'VENTA'}?</b>\n${razones || 'Confluencia general del comité de 12 dioses.'}\n\n` +
          `📊 <b>Configuración</b>\n` +
          `📌 Entrada: $${entryPrice.toFixed(6)}\n` +
          `🛑 Stop Loss: $${setup.stop.toFixed(6)}\n` +
          `🎯 TP1: $${setup.t1.toFixed(6)} (R:R ≈ ${rrTp1}:1)\n` +
          `🚀 TP2: $${setup.t2.toFixed(6)} (R:R ≈ ${rrTp2}:1)\n\n` +
          `🛠️ <b>Riesgo</b>\n` +
          `Riesgo: ${(riskPct*100).toFixed(1)}% del capital (${reason})\n` +
          `Ejecución: TheHaton toma 50% en TP1 y mueve el Stop a Break Even automáticamente. El resto corre hasta TP2 o breakeven.\n` +
          `❌ Se invalida si: ${invalidacion}\n\n` +
          `⚡ Score IA: ${Math.max(result15.longScore,result15.shortScore).toFixed(1)}/10 · Confianza ${result15.confidence}%\n` +
          `Capital de la cuenta: ${acc.capital.toFixed(2)} USDT (cuenta #${acc.id})\n\n` +
          `⚠️ Solo con fines educativos. No es asesoría financiera.`
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

    if(price==null){
      thesis.priceFailCount = (thesis.priceFailCount||0) + 1;
      console.log(`⚠️ No se pudo obtener precio de ${thesis.symbol} (falla #${thesis.priceFailCount} seguida).`);
      if(thesis.priceFailCount===3){ // ~3 horas de fallas seguidas (ahora corre cada 1 hora)
        sendPromises.push(sendTelegram(`⚠️ <b>TheHaton no puede leer el precio de ${thesis.symbol}${thesis.tag||''} hace 2 horas.</b>\nLa posición sigue abierta pero no se puede chequear TP/SL. Revisá si el símbolo sigue existiendo en su fuente original (${thesis.source}).`));
      }
      stillOpen.push(thesis); continue;
    }
    thesis.priceFailCount = 0;

    // Cierre forzado: tesis viejas (>30 días) o huérfanas migradas, para que nunca quede algo invisible para siempre
    if(thesis.forceClose){
      const pnl = thesis.units * (price-thesis.entry) * (thesis.dir==='LONG'?1:-1);
      acc.capital = +(acc.capital+pnl).toFixed(4);
      journal(thesis, `Cierre forzado por antigüedad (más de ${MAX_DAYS_OPEN_LIMIT} días abierta sin resolver). Cerrada al precio actual $${price.toFixed(6)} (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT).`);
      acc.closedTrades.push({...thesis, exit:price, result: pnl>=0?'win':'loss', pnl:+pnl.toFixed(4), closedAt: Date.now()});
      sendPromises.push(sendTelegram(
        `⏰ <b>TheHaton cerró ${thesis.symbol}${thesis.tag||''} ${thesis.dir} por antigüedad</b>\n` +
        `Llevaba abierta demasiado tiempo sin tocar TP ni Stop. Resultado: ${pnl>=0?'GANÓ':'PERDIÓ'} (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT)\nCapital actual: ${acc.capital.toFixed(2)} USDT`
      ));
      continue;
    }

    // Etapa 1: todavía no tomó ganancia parcial -> vigila Stop y TP1
    if(!thesis.partialTaken){
      let hitTP1=false, hitSL=false;
      if(thesis.dir==='LONG'){ if(price<=thesis.stop) hitSL=true; else if(price>=thesis.tp1) hitTP1=true; }
      else { if(price>=thesis.stop) hitSL=true; else if(price<=thesis.tp1) hitTP1=true; }

      if(hitTP1){
        const halfUnits = thesis.units/2;
        const pnl = halfUnits * (thesis.tp1-thesis.entry) * (thesis.dir==='LONG'?1:-1);
        acc.capital = +(acc.capital+pnl).toFixed(4);
        thesis.units = halfUnits; // queda el otro 50% corriendo
        thesis.partialTaken = true;
        thesis.stop = thesis.entry; // mueve el stop al punto de entrada (breakeven), como pediste
        journal(thesis, `TP1 alcanzado ($${thesis.tp1.toFixed(6)}). Se tomó el 50% de la ganancia (+${pnl.toFixed(2)} USDT) y se movió el Stop al punto de entrada. El 50% restante sigue corriendo hacia TP2 ($${thesis.tp2.toFixed(6)}).`);
        thesis.partialPnl = pnl;
        sendPromises.push(sendTelegram(
          `💰 <b>TheHaton tomó 50% de ganancia — ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
          `TP1 alcanzado: $${thesis.tp1.toFixed(6)} (+${pnl.toFixed(2)} USDT realizados)\n` +
          `Stop movido a breakeven ($${thesis.entry.toFixed(6)}): el 50% restante ya no puede terminar en pérdida.\n` +
          `El resto sigue corriendo hacia TP2 ($${thesis.tp2.toFixed(6)}).\nCapital: ${acc.capital.toFixed(2)} USDT`
        ));
        stillOpen.push(thesis);
      } else if(hitSL){
        const pnl = thesis.units * (thesis.stop-thesis.entry) * (thesis.dir==='LONG'?1:-1);
        acc.capital = +(acc.capital+pnl).toFixed(4);
        journal(thesis, `Stop tocado antes de TP1 (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT). Capital: ${acc.capital.toFixed(2)}.`);
        acc.closedTrades.push({...thesis, exit:thesis.stop, result: pnl>=0?'win':'loss', pnl:+pnl.toFixed(4), closedAt: Date.now()});
        sendPromises.push(sendTelegram(
          `🛑 <b>TheHaton cerró ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
          `PERDIÓ (${pnl.toFixed(2)} USDT)\nCapital actual: ${acc.capital.toFixed(2)} USDT`
        ));
      } else {
        stillOpen.push(thesis);
      }
      continue;
    }

    // Etapa 2: ya tomó el 50% -> el resto corre hasta TP2 o vuelve a breakeven (stop ya está en el punto de entrada)
    let hitTP2=false, hitBE=false;
    if(thesis.dir==='LONG'){ if(price<=thesis.stop) hitBE=true; else if(price>=thesis.tp2) hitTP2=true; }
    else { if(price>=thesis.stop) hitBE=true; else if(price<=thesis.tp2) hitTP2=true; }

    if(hitTP2 || hitBE){
      const exit = hitTP2 ? thesis.tp2 : thesis.stop;
      const pnl = thesis.units * (exit-thesis.entry) * (thesis.dir==='LONG'?1:-1);
      acc.capital = +(acc.capital+pnl).toFixed(4);
      const totalPnl = (thesis.partialPnl||0) + pnl;
      journal(thesis, `${hitTP2?'TP2 alcanzado':'Volvió a breakeven'}: se cierra el 50% restante (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT). Resultado total de la operación: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT. Capital: ${acc.capital.toFixed(2)}.`);
      acc.closedTrades.push({...thesis, exit, result: totalPnl>=0?'win':'loss', pnl:+totalPnl.toFixed(4), closedAt: Date.now()});
      sendPromises.push(sendTelegram(
        `${hitTP2?'🚀':'⚖️'} <b>TheHaton cerró el resto de ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
        `${hitTP2?'TP2 alcanzado ✅':'Volvió al punto de entrada (breakeven en el 50% restante)'}\n` +
        `Resultado total de la operación: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT\nCapital actual: ${acc.capital.toFixed(2)} USDT`
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

// Monedas de "cap chico" (~$20M-$100M): menos ojos de otros bots encima, más probabilidad de
// que una señal real de la Market Context Matrix todavía no esté arbitrada por el mercado.
async function getMidCapCandidates(){
  try{
    const pages = await Promise.all([1,2,3,4].map(p=>
      fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}`).then(r=>r.json())
    ));
    const flat = pages.flatMap(p=>Array.isArray(p)?p:[]);
    return flat
      .filter(c => c.market_cap >= 20_000_000 && c.market_cap <= 100_000_000)
      .map(c => c.symbol.toUpperCase())
      .filter(s => /^[A-Z0-9]{2,10}$/.test(s)); // descarta símbolos raros/wrapped con caracteres extraños
  }catch(e){ console.error('Error trayendo monedas de cap chico:', e.message); return []; }
}


  if(!BOT_TOKEN || !CHAT_ID){ console.error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.'); process.exit(1); }
  const state = loadState();

  console.log('--- Fase 0: chequeando flujo de capital global (DeFiLlama) ---');
  const capitalFlow = await fetchCapitalFlowContext();
  console.log('Capital flow:', capitalFlow);

  console.log('--- Fase 1: gestionando tesis ACTIVAS (TP/SL/breakeven) ---');
  await manageActiveTheses(state);

  console.log('--- Fase 2: confirmando tesis WATCHING en 15m (motor completo) ---');
  await confirmTheses(state, capitalFlow);

  console.log('--- Fase 3: escaneando Binance top', TOP_N_BINANCE, 'en busca de nuevas tesis ---');
  const pairs = await getTopBinancePairs(TOP_N_BINANCE);
  const candidates = pairs.map(symbol=>({symbol, tag:''}));
  for(const symbol of CUSTOM_COINS){
    if(!pairs.includes(symbol)) candidates.push({symbol, tag:' (custom)'});
  }
  await scanForTheses(state, candidates, capitalFlow);

  console.log('--- Fase 4: pools nuevas en DEX ---');
  const dexPools = await getNewDexPools();
  const dexCandidates = dexPools.slice(0,20).map(p=>({symbol:(p.name||'?').split('/')[0].trim(), tag:` (DEX ${p.network})`}));
  await scanForTheses(state, dexCandidates, capitalFlow);

  console.log('--- Fase 5: monedas de cap chico ($20M-$100M) para la Market Context Matrix ---');
  const midCaps = await getMidCapCandidates();
  console.log(midCaps.length, 'monedas de cap chico encontradas.');
  const midCapCandidates = midCaps
    .filter(s => !pairs.includes(s) && !CUSTOM_COINS.includes(s))
    .slice(0, 40) // límite para no disparar el tiempo de ejecución ni el rate limit de las 5 exchanges
    .map(symbol=>({symbol, tag:' (cap chico)'}));
  await scanForTheses(state, midCapCandidates, capitalFlow);

  await Promise.all(sendPromises);
  saveState(state);
  console.log('--- Listo. Capital de TheHaton:', state.account.capital, '· Tesis abiertas:', state.account.theses.length, '---');
}

main().catch(e=>{ console.error('Error fatal:', e); process.exit(1); });
