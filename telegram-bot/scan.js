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
import webpush from 'web-push';
import {
  fetchTokenData, fetchMacroTrend, fetchRelevantNews,
  fetchOpenInterestTrend, fetchFundingTrend, fetchCapitalFlowContext, fetchBTCReference,
  confluenceScore15m, fetchFearGreedIndex, getFOMCWindow, fetchTopTraderRatio, rsi,
  computeScore, buildSetup, buildAnalystMode
} from '../thehaton-engine.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const THRESHOLD = 7.6;
const TOP_N_BINANCE = 60;
const DEX_NETWORKS = ['solana','base','eth'];
const STATE_FILE = 'telegram-bot/state.json';
const MAX_TRADES_PER_DAY = 4;
const KILL_SWITCH_DRAWDOWN = 0.30; // si el drawdown supera esto, se pausa la apertura de operaciones nuevas hasta revisión manual
const WORK_HOUR_START = 4;
const WORK_HOUR_END = 15;
const RISK_PCT = 0.01;

// ---- Análisis de Wall Street (apertura/cierre) — solo informativo, NUNCA abre operaciones ----
function isUSDST(date){
  const year = date.getUTCFullYear();
  const marchFirst = new Date(Date.UTC(year,2,1));
  const secondSunday = 1 + ((7 - marchFirst.getUTCDay()) % 7) + 7;
  const dstStart = new Date(Date.UTC(year,2,secondSunday,7));
  const novFirst = new Date(Date.UTC(year,10,1));
  const firstSunday = 1 + ((7 - novFirst.getUTCDay()) % 7);
  const dstEnd = new Date(Date.UTC(year,10,firstSunday,6));
  return date>=dstStart && date<dstEnd;
}
function getWallStreetPulseType(now){
  const dst = isUSDST(now);
  const hourUTC = now.getUTCHours();
  const openHour = dst ? 14 : 15;  // ~9:30am ET (primer hora completa después de la apertura real)
  const closeHour = dst ? 20 : 21; // 4:00pm ET exacto
  if(hourUTC===openHour) return 'open';
  if(hourUTC===closeHour) return 'close';
  return null;
}
async function runMarketPulse(state, capitalFlow){
  const now = new Date();
  const type = getWallStreetPulseType(now);
  if(!type) return;
  const todayKey2 = todayKey();
  const already = state.lastMarketPulse && state.lastMarketPulse.date===todayKey2 && state.lastMarketPulse.type===type;
  if(already) return;

  try{
    const results = {};
    for(const tf of ['1h','4h','1d']){
      const data = await fetchTokenData('BTC', tf);
      const macro = tf==='1d' ? null : await fetchMacroTrend('BTC').catch(()=>null);
      const oiTrendData = await fetchOpenInterestTrend('BTC', tf).catch(()=>null);
      const fundingTrendData = await fetchFundingTrend('BTC').catch(()=>null);
      const mc = { oiTrend: oiTrendData?.trend||null, fundingTrend: fundingTrendData?.trend||null, capitalFlow };
      results[tf] = computeScore(data, macro, [], state.memory, mc, null);
      if(tf==='4h') results['4h'].rawData = data; // guardamos el precio actual real de esta temporalidad
    }
    const votes = Object.values(results).map(r=>r.recommendation);
    const longCount = votes.filter(v=>v==='LONG').length, shortCount = votes.filter(v=>v==='SHORT').length;
    const lean = longCount>shortCount ? '🟢 Alcista' : shortCount>longCount ? '🔴 Bajista' : '⚪ Mixto, sin sesgo claro';

    // Niveles clave: soporte/resistencia y liquidez (Equal Highs/Lows) del marco de 4h, que es el
    // más representativo para un pulso "de día" (ni tan ruidoso como 1h, ni tan lento como 1D).
    const m4h = results['4h'].metrics;
    const st4h = results['4h'].structure;
    const price = m4h.price;
    const eqHighsTxt = st4h.eqHighs ? `$${st4h.eqHighs.toFixed(0)} (${st4h.eqHighsCount}x, liquidez compradora)` : 'sin cluster relevante detectado';
    const eqLowsTxt = st4h.eqLows ? `$${st4h.eqLows.toFixed(0)} (${st4h.eqLowsCount}x, liquidez vendedora)` : 'sin cluster relevante detectado';

    const ratio = await fetchTopTraderRatio('BTC', '1h').catch(()=>null);
    const ratioTxt = ratio ? `${ratio.ratio.toFixed(2)}:1 (${ratio.longPct.toFixed(0)}% long / ${ratio.shortPct.toFixed(0)}% short)` : 'no disponible';

    const fomc = getFOMCWindow(24);
    const fomcTxt = fomc.isNear
      ? (fomc.hoursUntil>0 ? `Anuncio de la Fed en ${fomc.hoursUntil.toFixed(0)}hs` : `la Fed anunció hace ${Math.abs(fomc.hoursUntil).toFixed(0)}hs`)
      : null;

    // Contexto de Wall Street real (mismo dato que ya usa la web, vía Twelve Data)
    let stocksTxt = null;
    try{
      const stocksRes = await fetch(`https://api.twelvedata.com/quote?symbol=SPY,QQQ&apikey=afd54daf55834d41ad0b535b16b9f3b4`).then(r=>r.json());
      const spy = stocksRes?.SPY, qqq = stocksRes?.QQQ;
      if(spy?.percent_change) stocksTxt = `S&P 500 ${parseFloat(spy.percent_change)>=0?'+':''}${parseFloat(spy.percent_change).toFixed(1)}%${qqq?.percent_change?`, Nasdaq ${parseFloat(qqq.percent_change)>=0?'+':''}${parseFloat(qqq.percent_change).toFixed(1)}%`:''}`;
    }catch(e){ /* si falla, seguimos sin este dato puntual */ }

    // Narrativa del movimiento reciente: último rechazo (swing high) -> último mínimo (swing low) -> ahora
    const pivots4h = st4h.pivots || [];
    const lastHighPivot = [...pivots4h].reverse().find(p=>p.type==='high');
    const lastLowPivot = [...pivots4h].reverse().find(p=>p.type==='low');
    let narrativa = '';
    if(lastHighPivot && lastLowPivot){
      const highFirst = lastHighPivot.i < lastLowPivot.i; // ¿el rechazo pasó antes que el mínimo?
      if(highFirst){
        narrativa = `Rechazo en $${lastHighPivot.price.toFixed(0)}, cayó a $${lastLowPivot.price.toFixed(0)} y ahora ${price>lastLowPivot.price?'está recuperándose':'sigue presionado'} hacia $${price.toFixed(0)}. `;
      } else {
        narrativa = `Rebote desde $${lastLowPivot.price.toFixed(0)}, llegó a $${lastHighPivot.price.toFixed(0)} y ahora ${price<lastHighPivot.price?'está corrigiendo':'sigue empujando'} hacia $${price.toFixed(0)}. `;
      }
    }

    // Posición respecto a las medias móviles principales (dato que faltaba vs. lo que pediste)
    const emaTxt = (m4h.lastE20!=null && m4h.lastE50!=null)
      ? (price > m4h.lastE20 && price > m4h.lastE50 ? 'por encima de sus medias móviles principales (EMA20/50)'
        : price < m4h.lastE20 && price < m4h.lastE50 ? 'por debajo de sus medias móviles principales (EMA20/50)'
        : 'justo entre sus medias móviles (EMA20/50), zona de indecisión')
      : null;

    // Tesis direccional con invalidación explícita, en vez de solo "sesgo mixto"
    let tesis;
    if(longCount>shortCount){
      tesis = `Sesgo alcista mientras se sostenga por encima de $${(m4h.support||price*0.97).toFixed(0)} (soporte 4h). Objetivo si continúa: zona de resistencia $${(m4h.resistance||price*1.03).toFixed(0)}. Se invalida con un cierre de vela 4h por debajo del soporte.`;
    } else if(shortCount>longCount){
      tesis = `Sesgo bajista mientras se mantenga por debajo de $${(m4h.resistance||price*1.03).toFixed(0)} (resistencia 4h). Objetivo si continúa: soporte en $${(m4h.support||price*0.97).toFixed(0)}. Se invalida con un cierre de vela 4h por encima de la resistencia.`;
    } else {
      tesis = `Sin sesgo claro entre los 3 marcos — mejor esperar una ruptura definida de $${(m4h.support||price*0.97).toFixed(0)}–$${(m4h.resistance||price*1.03).toFixed(0)} antes de operar.`;
    }

    // Párrafo narrativo tipo "todo junto", como en tu ejemplo, antes del desglose en líneas
    let parrafo = narrativa;
    parrafo += `Entrando en zona de resistencia ($${(m4h.resistance||price*1.03).toFixed(0)})`;
    if(emaTxt) parrafo += `, ${emaTxt}`;
    parrafo += '. ';
    const contextoExtra = [];
    if(fomcTxt) contextoExtra.push(fomcTxt);
    if(stocksTxt) contextoExtra.push(stocksTxt);
    if(ratio) contextoExtra.push(`los traders grandes ya están posicionados ${ratio.ratio>=1?'largos':'cortos'} (${ratioTxt})`);
    if(st4h.eqLows) contextoExtra.push(`hay liquidez esperando justo abajo, cerca de $${st4h.eqLows.toFixed(0)}`);
    if(contextoExtra.length) parrafo += 'Contexto: ' + contextoExtra.join('; ') + '.';

    const label = type==='open' ? '🔔 Apertura de Wall Street' : '🔕 Cierre de Wall Street';
    const contexto = type==='open' ? 'perspectiva de las próximas horas' : 'de cara al día de mañana';

    sendPromises.push(sendTelegram(
      `${label} — Análisis de BTC/USDT (solo informativo, no abre operaciones)\n\n` +
      `💰 $${price.toFixed(0)} | ${contexto}\n\n` +
      `${parrafo}\n\n` +
      `📊 Marcos: 1h ${results['1h'].recommendation} · 4h ${results['4h'].recommendation} · 1D ${results['1d'].recommendation} → ${lean}\n\n` +
      `📍 Soporte 4h: $${(m4h.support||0).toFixed(0)} · Resistencia 4h: $${(m4h.resistance||0).toFixed(0)}\n` +
      `💧 Liquidez arriba: ${eqHighsTxt}\n` +
      `💧 Liquidez abajo: ${eqLowsTxt}\n` +
      `⚖️ Long/Short (top traders, 1h): ${ratioTxt}\n` +
      `\n📈 Tesis: ${tesis}\n\n` +
      `⚠️ Esto es solo un pulso informativo del mercado, no una señal de entrada.`
    ));
    state.lastMarketPulse = { date: todayKey2, type };
  }catch(e){ console.error('Error en el análisis de Wall Street:', e.message); }
}

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

// ---- Notificaciones push de verdad (llegan aunque el celular tenga la app cerrada) ----
const FIRESTORE_PROJECT = 'critophaton';
const VAPID_PUBLIC_KEY = 'BPXgVxHRjeFdsHoHmlRSMx8LlpSu2fWy-Pm6y32m8PYbjpvtg0691ctw46NCnoXyqndoitb98ljppeh26faP9Gk';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
if(VAPID_PRIVATE_KEY){
  webpush.setVapidDetails('mailto:soporte@kraxcapital.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

async function fetchPushSubscribers(){
  try{
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/push_subscriptions`);
    if(!res.ok) return [];
    const data = await res.json();
    return (data.documents||[]).map(d=>{
      try{ return JSON.parse(d.fields.sub.stringValue); }catch(e){ return null; }
    }).filter(Boolean);
  }catch(e){ console.error('Error trayendo suscripciones push:', e.message); return []; }
}

async function sendPushToAll(title, body, url){
  if(!VAPID_PRIVATE_KEY) return; // sin la clave privada (secret de GitHub) no se puede firmar el push, se omite en silencio
  const subs = await fetchPushSubscribers();
  const payload = JSON.stringify({title, body, url: url||'./index.html'});
  await Promise.all(subs.map(sub =>
    webpush.sendNotification(sub, payload).catch(e=>{
      // Un error 410/404 significa que esa suscripción ya no existe (usuario desinstaló, etc.) — normal, se ignora.
      if(e.statusCode!==410 && e.statusCode!==404) console.error('Error mandando push:', e.message);
    })
  ));
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

function computeDynamicRisk(acc, confidencePct, patternQuality){
  acc.peakCapital = Math.max(acc.peakCapital, acc.capital);
  const drawdown = acc.peakCapital>0 ? (acc.peakCapital-acc.capital)/acc.peakCapital : 0;
  const recent = acc.closedTrades.slice(-3);
  const recentLosses = recent.filter(t=>t.result==='loss').length;
  let risk = RISK_PCT, reason = 'riesgo base (1%)';
  if(drawdown>0.15 || recentLosses>=2){ risk=0.005; reason=`riesgo reducido a 0.5% (drawdown ${(drawdown*100).toFixed(0)}% o ${recentLosses} pérdidas seguidas)`; }
  else if(confidencePct>=90 && recentLosses===0 && drawdown<0.05){ risk=0.015; reason=`riesgo aumentado a 1.5% (alta confianza, sin pérdidas recientes)`; }
  // Patrones "de manual" (BOS de estructura, Bear/Bull Trap confirmado) son entradas más limpias que una
  // confluencia genérica de indicadores — se les da un poco más de tamaño dentro del mismo rango permitido.
  if(patternQuality==='high' && risk < 0.015){ risk = Math.min(0.015, risk*1.2); reason += ' · patrón de alta calidad (BOS/Bear-Trap): tamaño ligeramente mayor'; }
  return { risk: Math.max(0.005, Math.min(0.015, risk)), reason };
}

function journal(thesis, note){
  thesis.journal.push({ts: Date.now(), note});
  console.log(`  [${thesis.symbol}] ${note}`);
}

// ---------- Fase 1: escanear 4h/1D en busca de nuevas tesis (usa el motor completo) ----------
async function scanForTheses(state, candidates, capitalFlow, btcReference4h){
  const acc = state.account;
  if(acc.peakCapital==null) acc.peakCapital = acc.capital;
  const drawdownNow = acc.peakCapital>0 ? (acc.peakCapital-acc.capital)/acc.peakCapital : 0;
  if(drawdownNow >= KILL_SWITCH_DRAWDOWN){
    const todayKey2 = todayKey();
    if(state.killSwitchNotifiedDate !== todayKey2){
      sendPromises.push(sendTelegram(
        `🛑 <b>KILL SWITCH activado — TheHaton (cuenta #${acc.id})</b>\n\n` +
        `Drawdown actual: ${(drawdownNow*100).toFixed(1)}% (límite: ${(KILL_SWITCH_DRAWDOWN*100).toFixed(0)}%).\n` +
        `Se pausa la apertura de operaciones NUEVAS hasta revisión manual. Las tesis y operaciones ya abiertas se siguen gestionando normalmente (TP/SL/breakeven).\n\n` +
        `Para reactivar: revisá qué está fallando (motor, condiciones de mercado) y reiniciá manualmente el capital o ajustá KILL_SWITCH_DRAWDOWN en el código si corresponde.`
      ));
      state.killSwitchNotifiedDate = todayKey2;
    }
    console.log(`🛑 Kill switch activo (drawdown ${(drawdownNow*100).toFixed(1)}%) — no se abren tesis nuevas esta corrida.`);
    return;
  }
  for(const {symbol, tag} of candidates){
    if(acc.theses.find(t=>t.symbol===symbol)) continue; // ya hay una tesis abierta para esa moneda
    try{
      const data = await fetchTokenData(symbol, '4h');
      if(!data.candles || data.candles.length<220) continue;
      const macro = await fetchMacroTrend(symbol).catch(()=>null);
      const news = await fetchRelevantNews(symbol).catch(()=>[]);
      const oiTrendData = data.source==='Binance' ? await fetchOpenInterestTrend(symbol, '4h').catch(()=>null) : null;
      const fundingTrendData = data.source==='Binance' ? await fetchFundingTrend(symbol).catch(()=>null) : null;
      const btcReference = data.displayName!=='BTC' ? btcReference4h : null;
      const marketContext = { oiTrend: oiTrendData?.trend||null, fundingTrend: fundingTrendData?.trend||null, capitalFlow };
      const result = computeScore(data, macro, news, state.memory, marketContext, btcReference);
      const best = Math.max(result.longScore, result.shortScore);
      console.log(`${symbol}${tag}`, result.recommendation, best.toFixed(1));

      updateSharedMemory(state, symbol, result.recommendation);

      if(best < THRESHOLD || result.recommendation === 'NO OPERAR') continue;

      const hour = argentinaHourNow();
      if(hour < WORK_HOUR_START || hour >= WORK_HOUR_END) continue;
      const today = todayKey();
      if(acc.tradesToday.date !== today) acc.tradesToday = {date:today, count:0};
      if(acc.tradesToday.count >= MAX_TRADES_PER_DAY) continue;

      // Crear la TESIS (todavía no es una operación real)
      const theoSetup = buildSetup(data, result, 'balanced'); // setup teórico, para el Modo Aprendizaje Pasivo si expira sin confirmar
      const thesis = {
        id: Date.now()+'_'+symbol, symbol, dir: result.recommendation, tag,
        status: 'WATCHING', conviction: best*10,
        detectedAt: Date.now(), expiresAt: Date.now()+THESIS_EXPIRY_HOURS*3600*1000,
        breakEvenMoved: false, journal: [],
        theoEntry: result.metrics.price, theoStop: theoSetup.stop, theoTp1: theoSetup.t1,
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
      // Modo Aprendizaje Pasivo: simula qué hubiera pasado si igual hubiésemos entrado con el setup
      // teórico de la detección original. Sirve para medir si el filtro de confirmación realmente
      // ayuda (compara win rate de confirmadas vs. win rate simulado de las que el filtro descartó).
      let wouldHaveWon = null, simNote = 'No se pudo simular (sin datos históricos suficientes).';
      try{
        if(thesis.theoStop!=null && thesis.theoTp1!=null){
          const dataSince = await fetchTokenData(thesis.symbol, '4h');
          const relevant = (dataSince?.candles||[]).filter(c=>c.t >= thesis.detectedAt);
          for(const c of relevant){
            if(thesis.dir==='LONG'){
              if(c.l<=thesis.theoStop){ wouldHaveWon=false; break; }
              if(c.h>=thesis.theoTp1){ wouldHaveWon=true; break; }
            } else {
              if(c.h>=thesis.theoStop){ wouldHaveWon=false; break; }
              if(c.l<=thesis.theoTp1){ wouldHaveWon=true; break; }
            }
          }
          simNote = wouldHaveWon==null ? 'Todavía indefinido (nunca tocó ni el TP1 ni el Stop teórico en ese lapso).' : (wouldHaveWon?'✅ HUBIERA GANADO':'❌ HUBIERA PERDIDO');
        }
      }catch(e){ /* si falla la simulación, no rompe el archivado */ }
      thesis.wouldHaveWon = wouldHaveWon;
      journal(thesis, `Expiró sin confirmación después de ${THESIS_EXPIRY_HOURS}h. Simulación pasiva (si hubiéramos entrado igual): ${simNote}. Se archiva (el historial nunca se borra).`);
      state.account.expiredTheses.push(thesis);
      continue;
    }

    try{
      const data15 = await fetchTokenData(thesis.symbol, '15m');
      if(!data15.candles || data15.candles.length<220){ stillWatching.push(thesis); continue; }
      const macro = await fetchMacroTrend(thesis.symbol).catch(()=>null);
      const oiTrendData = data15.source==='Binance' ? await fetchOpenInterestTrend(thesis.symbol, '15m').catch(()=>null) : null;
      const fundingTrendData = data15.source==='Binance' ? await fetchFundingTrend(thesis.symbol).catch(()=>null) : null;
      const btcReference = data15.displayName!=='BTC' ? await fetchBTCReference('15m').catch(()=>null) : null;
      const marketContext15 = { oiTrend: oiTrendData?.trend||null, fundingTrend: fundingTrendData?.trend||null, capitalFlow };
      const result15 = computeScore(data15, macro, [], state.memory, marketContext15, btcReference);

      const alineado = result15.recommendation === thesis.dir;
      const bosAFavor = thesis.dir==='LONG' ? result15.structure?.events?.bos==='bullish' : result15.structure?.events?.bos==='bearish';
      const confianzaSubio = result15.confidence >= thesis.conviction;
      // Score de Confluencia: no depender solo del BOS (que suele confirmar tarde) — MACD acelerando +
      // Stochastic saliendo recién de un extremo (no ya agotado adentro) + velas con cuerpo fuerte.
      const confluence = confluenceScore15m(data15.candles);
      const rawConfluenceAFavor = thesis.dir==='LONG' ? confluence.bullConfluence>=3 : confluence.bearConfluence>=3;

      // Combinar confluencia con liquidez (no eran independientes antes):
      // - Si hay un sweep EN CONTRA de la dirección (trampa reciente a favor nuestro), la confluencia sola no alcanza para confirmar.
      // - Si hay un sweep A FAVOR (bear trap barrido y rechazado para un LONG, o al revés), eso en sí mismo es una confirmación fuerte.
      const sweep = result15.structure?.liquiditySweep;
      const sweepEnContra = thesis.dir==='LONG' ? sweep?.sweptUp : sweep?.sweptDown;
      const sweepAFavor = thesis.dir==='LONG' ? sweep?.sweptDown : sweep?.sweptUp; // bear trap para LONG / bull trap barrido para SHORT
      const confluenceAFavor = rawConfluenceAFavor && !sweepEnContra;
      const bearTrapConfirmacion = sweepAFavor && alineado; // "Bear Trap + Test Pump" que proponías: el sweep en contra del mercado, a favor nuestro, ya es señal

      // Patrón completo (más específico y confiable que un sweep suelto): Acumulación con varios
      // "test pumps" fallidos + Bear Trap recién ahora (o el espejo Distribución + Bull Trap para SHORT).
      const patronCompleto = thesis.dir==='LONG' ? result15.structure?.accBearTrap?.patternDetected : result15.structure?.distBullTrap?.patternDetected;
      const patronCompletoConfirmacion = patronCompleto && alineado;

      // Momentum Continuation: en una tendencia ya fuerte, un pullback a EMA20/50 o al Order Block
      // (sin romper la tendencia) es una entrada conservadora clásica de trend-following.
      const mt = result15.metrics;
      const st15 = result15.structure;
      const priceNow = mt.price;
      const nearEMA20 = Math.abs(priceNow - mt.lastE20)/priceNow < 0.01;
      const nearEMA50 = Math.abs(priceNow - mt.lastE50)/priceNow < 0.015;
      const ob15 = thesis.dir==='LONG' ? st15?.bullishOB : st15?.bearishOB;
      const nearOB = ob15 && priceNow <= ob15.top*1.02 && priceNow >= ob15.bottom*0.98;
      const trendFuerte = thesis.dir==='LONG'
        ? (priceNow>mt.lastE20 && mt.lastE20>mt.lastE50)
        : (priceNow<mt.lastE20 && mt.lastE20<mt.lastE50);
      const pullbackConfirmacion = trendFuerte && (nearEMA20 || nearEMA50 || nearOB) && alineado && !sweepEnContra;

      // "Imán de liquidez" multi-timeframe: si el marco MAYOR (1D) todavía tiene espacio (no está agotado
      // en la misma dirección) y el marco de confirmación está en un extremo local (pullback, no agotamiento
      // real), y además hay un cluster de liquidez (Equal Highs/Lows) esperando en la dirección de la tesis,
      // el precio tiene buenas chances de seguir para "barrer" esa liquidez antes de girar.
      let liquidityMagnetConfirmacion = false, htfNote = '';
      try{
        const data1d = await fetchTokenData(thesis.symbol, '1d');
        if(data1d?.candles?.length>=30){
          const rsi1d = rsi(data1d.candles.map(c=>c.c), 14).filter(v=>v!=null).at(-1);
          const rsiLTF = result15.metrics.lastRSI;
          const htfConEspacio = rsi1d!=null && rsi1d>35 && rsi1d<65; // 1D neutral, ni sobrecomprado ni sobrevendido: hay recorrido
          const ltfExtremo = thesis.dir==='LONG' ? (rsiLTF!=null && rsiLTF<=35) : (rsiLTF!=null && rsiLTF>=65); // pullback local, no tendencia agotada
          const liqTarget = thesis.dir==='LONG' ? st15?.eqHighs : st15?.eqLows;
          const liqEnDireccion = liqTarget!=null && (thesis.dir==='LONG' ? liqTarget>priceNow : liqTarget<priceNow);
          liquidityMagnetConfirmacion = htfConEspacio && ltfExtremo && liqEnDireccion && alineado && !sweepEnContra;
          htfNote = `1D RSI ${rsi1d?.toFixed(0)??'—'} (${htfConEspacio?'con espacio':'sin espacio'}), LTF RSI ${rsiLTF?.toFixed(0)??'—'} (${ltfExtremo?'pullback local':'sin extremo'}), liquidez objetivo ${liqEnDireccion?`detectada a favor (~$${liqTarget.toFixed(6)})`:'no detectada a favor'}.`;
        }
      }catch(e){ /* si falla, simplemente no aporta este camino, no rompe el resto */ }

      // Filtro macro suave (Fear & Greed): F&G<30 (no solo <25) ya se considera zona de miedo relevante para exigir más evidencia.
      const fng = await fetchFearGreedIndex().catch(()=>null);
      const macroAdverso = fng!=null && ((thesis.dir==='LONG' && fng<30) || (thesis.dir==='SHORT' && fng>75));
      if(macroAdverso && !bosAFavor && !bearTrapConfirmacion){
        journal(thesis, `Todavía esperando confirmación (Fear&Greed en ${fng}, contexto adverso para ${thesis.dir} — se exige BOS claro o un Bear/Bull Trap confirmado, no alcanza con confluencia sola en este contexto).`);
        stillWatching.push(thesis);
        continue;
      }

      // Filtro FOMC: antes del anuncio de la Fed no hay análisis técnico que valga (es un evento binario,
      // no una señal de mercado) — se pausa por completo. Después del anuncio, se exige más evidencia,
      // igual que con Fear&Greed, porque el mercado puede estar reaccionando de forma errática todavía.
      const fomc = getFOMCWindow(3);
      if(fomc.isNear && fomc.hoursUntil>0){
        journal(thesis, `Pausado: anuncio de la Fed (FOMC) en ${fomc.hoursUntil.toFixed(1)}hs. No tiene sentido confirmar una entrada técnica justo antes de un evento binario que puede mover todo el mercado de golpe.`);
        stillWatching.push(thesis);
        continue;
      }
      if(fomc.isNear && fomc.hoursUntil<=0 && !bosAFavor && !bearTrapConfirmacion){
        journal(thesis, `Todavía esperando confirmación (el anuncio de la Fed fue hace ${Math.abs(fomc.hoursUntil).toFixed(1)}hs — se exige BOS claro o un Bear/Bull Trap confirmado hasta que el mercado se asiente).`);
        stillWatching.push(thesis);
        continue;
      }

      if(alineado && (bosAFavor || confianzaSubio || confluenceAFavor || bearTrapConfirmacion || pullbackConfirmacion || liquidityMagnetConfirmacion || patronCompletoConfirmacion)){
        const setup = buildSetup(data15, result15, 'balanced');
        const entryPrice = result15.metrics.price; // mismo precio que usó buildSetup para calcular stop/TP, evita descalces
        const patternQuality = (bosAFavor || bearTrapConfirmacion || liquidityMagnetConfirmacion || patronCompletoConfirmacion) ? 'high' : 'normal';
        const {risk: riskPct, reason} = computeDynamicRisk(acc, result15.confidence, patternQuality);
        const riskAmount = acc.capital * riskPct;
        const distance = Math.abs(entryPrice - setup.stop);
        if(distance<=0){ stillWatching.push(thesis); continue; }
        const rrToTp1 = Math.abs(setup.t1-entryPrice)/distance;
        if(rrToTp1 < 1.5){
          journal(thesis, `Confirmación técnica presente pero R:R a TP1 es solo ${rrToTp1.toFixed(2)}:1 (mínimo exigido 1.5:1). Se sigue observando en vez de forzar una entrada con mala relación riesgo/beneficio.`);
          stillWatching.push(thesis);
          continue;
        }
        const units = riskAmount / distance;

        thesis.status = 'ACTIVE';
        thesis.entry = entryPrice; thesis.stop = setup.stop; thesis.tp1 = setup.t1; thesis.tp2 = setup.t2; thesis.units = units;
        thesis.riskPct = riskPct; thesis.confirmedAt = Date.now(); thesis.partialTaken = false;
        thesis.committeeSnapshot = result15.committee.map(c=>({name:c.name, vote:c.vote})); // para la memoria estadística por Dios
        const motivoConfirmacion = patronCompletoConfirmacion ? `Patrón completo ${thesis.dir==='LONG'?'Acumulación + Bear Trap':'Distribución + Bull Trap'} (rango testeado ${thesis.dir==='LONG'?result15.structure.accBearTrap.testPumpCount:result15.structure.distBullTrap.testDumpCount} veces antes de la barrida)` : bosAFavor ? 'BOS a favor detectado' : bearTrapConfirmacion ? `${thesis.dir==='LONG'?'Bear Trap':'Bull Trap'} barrido y rechazado (liquidez tomada en contra del mercado, a favor de la tesis)` : liquidityMagnetConfirmacion ? `Imán de liquidez multi-timeframe (${htfNote})` : pullbackConfirmacion ? `Momentum Continuation: pullback a ${nearOB?'Order Block':nearEMA20?'EMA20':'EMA50'} dentro de una tendencia ya fuerte` : confluenceAFavor ? `Score de Confluencia (${thesis.dir==='LONG'?confluence.bullConfluence:confluence.bearConfluence}/5: MACD, Stochastic, velas fuertes, volumen, ADX)` : `la confianza del motor subió a ${result15.confidence}%`;
        journal(thesis, `Entrada CONFIRMADA en 15m (${motivoConfirmacion}). Entrada: $${entryPrice.toFixed(6)}, Stop: $${setup.stop.toFixed(6)}, TP1: $${setup.t1.toFixed(6)}, TP2: $${setup.t2.toFixed(6)}. ${reason}.`);
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
        sendPromises.push(sendPushToAll(
          `${thesis.dir==='LONG'?'🟢':'🔴'} Señal: ${thesis.symbol} ${thesis.dir}`,
          `Entrada $${entryPrice.toFixed(6)} · Score ${Math.max(result15.longScore,result15.shortScore).toFixed(1)}/10`
        ));
        stillWatching.push(thesis); // CRÍTICO: sin esto, la tesis recién confirmada se perdía al reemplazar acc.theses al final
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
// Chequea el rango real (máximo/mínimo) de precio desde la última vez que se revisó esta tesis,
// no solo el precio del instante actual — así no se pierden mechas que tocan TP/SL entre corridas.
async function fetchPriceRange(symbol, sinceTs){
  try{
    const d = await fetchTokenData(symbol, '15m');
    if(!d.candles || !d.candles.length) return null;
    const marginMs = 20*60*1000; // margen para no perder la vela justo en el borde
    const minLookbackMs = 6*3600*1000; // colchón mínimo: GitHub Actions a veces salta o atrasa corridas programadas
    const effectiveSince = Math.min(sinceTs, Date.now()-minLookbackMs);
    const relevant = d.candles.filter(c => c.t >= (effectiveSince - marginMs));
    const scope = relevant.length ? relevant : d.candles.slice(-24); // fallback: últimas 6hs aprox (24 velas de 15m)
    return { high: Math.max(...scope.map(c=>c.h)), low: Math.min(...scope.map(c=>c.l)), last: d.price };
  }catch(e){ return null; }
}

async function manageActiveTheses(state){
  const acc = state.account;
  const stillOpen = [];
  for(const thesis of acc.theses){
    if(thesis.status !== 'ACTIVE'){ stillOpen.push(thesis); continue; }

    // Migración defensiva: tesis viejas (de antes del sistema de 50%-en-TP1) tenían un solo campo
    // `tp`, no `tp1`/`tp2`. Sin esto, `thesis.tp1` queda undefined para siempre y la tesis nunca
    // se cierra (exactamente lo que le pasó a WIF). Las tratamos como cierre completo en un solo TP.
    if(thesis.tp1==null && thesis.tp!=null){
      thesis.tp1 = thesis.tp; thesis.tp2 = thesis.tp; thesis.partialTaken = true;
      console.log(`⚠️ ${thesis.symbol}: tesis con esquema viejo (sin tp1/tp2) migrada a cierre completo en $${thesis.tp}.`);
    }

    const sinceTs = thesis.lastCheckedAt || thesis.confirmedAt || thesis.detectedAt;
    const range = await fetchPriceRange(thesis.symbol, sinceTs);
    const price = range?.last ?? null;

    if(price==null){
      thesis.priceFailCount = (thesis.priceFailCount||0) + 1;
      console.log(`⚠️ No se pudo obtener precio de ${thesis.symbol} (falla #${thesis.priceFailCount} seguida).`);
      if(thesis.priceFailCount===3){ // ~3 horas de fallas seguidas (ahora corre cada 1 hora)
        sendPromises.push(sendTelegram(`⚠️ <b>TheHaton no puede leer el precio de ${thesis.symbol}${thesis.tag||''} hace 2 horas.</b>\nLa posición sigue abierta pero no se puede chequear TP/SL. Revisá si el símbolo sigue existiendo en su fuente original (${thesis.source}).`));
      }
      stillOpen.push(thesis); continue;
    }
    thesis.priceFailCount = 0;
    const isReconciliation = !thesis.lastCheckedAt; // primera vez que se revisa con la lógica de rango nuevo
    thesis.lastCheckedAt = Date.now();


    // Narración diaria: una vez cada 24h, vuelve a correr el motor completo sobre la tesis activa
    // y cuenta cómo va evolucionando (sigue en pie / se debilita / conviene cerrar el resto ya).
    const lastNarration = thesis.lastNarrationAt || thesis.confirmedAt || thesis.detectedAt;
    if(Date.now() - lastNarration > 24*3600*1000){
      try{
        const d = await fetchTokenData(thesis.symbol, '4h');
        const macroN = await fetchMacroTrend(thesis.symbol).catch(()=>null);
        const resultN = computeScore(d, macroN, [], state.memory, {});
        const stillAligned = resultN.recommendation === thesis.dir;
        const bestN = Math.max(resultN.longScore, resultN.shortScore);
        const daysOpen = ((Date.now()-(thesis.confirmedAt||thesis.detectedAt))/(1000*60*60*24)).toFixed(1);
        const pnlFloat = thesis.units * (price-thesis.entry) * (thesis.dir==='LONG'?1:-1);

        let veredicto;
        if(stillAligned && bestN>=6.5) veredicto = `La tesis sigue en pie: el motor todavía confirma ${thesis.dir} (score ${bestN.toFixed(1)}/10). Se mantiene sin cambios.`;
        else if(stillAligned) veredicto = `La tesis se debilitó (score bajó a ${bestN.toFixed(1)}/10) pero todavía no se invalida del todo. Se sigue vigilando de cerca.`;
        else veredicto = `⚠️ El motor ya NO confirma ${thesis.dir} en esta moneda (ahora da ${resultN.recommendation}). La tesis original puede estar equivocada — revisar manualmente si conviene cerrar antes de que toque el stop.`;

        journal(thesis, `Actualización día ${daysOpen}: ${veredicto} P&L flotante: ${pnlFloat>=0?'+':''}${pnlFloat.toFixed(2)} USDT.`);
        sendPromises.push(sendTelegram(
          `📅 <b>Actualización — ${thesis.symbol}${thesis.tag||''} ${thesis.dir} (día ${daysOpen})</b>\n\n` +
          `${veredicto}\n\nP&L flotante: ${pnlFloat>=0?'+':''}${pnlFloat.toFixed(2)} USDT\nPrecio actual: $${price.toFixed(6)}`
        ));
        thesis.lastNarrationAt = Date.now();
      }catch(e){ console.error('Error en narración diaria de', thesis.symbol, e.message); }
    }

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

    // Etapa 1: todavía no tomó ganancia parcial -> vigila Stop y TP1 (con el rango real, no solo el precio actual)
    if(!thesis.partialTaken){
      let hitTP1=false, hitSL=false;
      if(thesis.dir==='LONG'){ if(range.low<=thesis.stop) hitSL=true; else if(range.high>=thesis.tp1) hitTP1=true; }
      else { if(range.high>=thesis.stop) hitSL=true; else if(range.low<=thesis.tp1) hitTP1=true; }

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
          (isReconciliation ? `🔎 <b>Auditoría/conciliación:</b> se detectó que esto ya había pasado y no estaba reflejado. Corrigiendo:\n\n` : '') +
          `💰 <b>TheHaton tomó 50% de ganancia — ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
          `TP1 alcanzado: $${thesis.tp1.toFixed(6)} (+${pnl.toFixed(2)} USDT realizados)\n` +
          `Stop movido a breakeven ($${thesis.entry.toFixed(6)}): el 50% restante ya no puede terminar en pérdida.\n` +
          `El resto sigue corriendo hacia TP2 ($${thesis.tp2.toFixed(6)}).\nCapital: ${acc.capital.toFixed(2)} USDT`
        ));
        sendPromises.push(sendPushToAll(`💰 TP1 alcanzado: ${thesis.symbol}`, `+${pnl.toFixed(2)} USDT · Stop movido a breakeven`));
        stillOpen.push(thesis);
      } else if(hitSL){
        const pnl = thesis.units * (thesis.stop-thesis.entry) * (thesis.dir==='LONG'?1:-1);
        acc.capital = +(acc.capital+pnl).toFixed(4);
        journal(thesis, `Stop tocado antes de TP1 (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT). Capital: ${acc.capital.toFixed(2)}.`);
        acc.closedTrades.push({...thesis, exit:thesis.stop, result: pnl>=0?'win':'loss', pnl:+pnl.toFixed(4), closedAt: Date.now()});
        sendPromises.push(sendTelegram(
          (isReconciliation ? `🔎 <b>Auditoría/conciliación:</b> se detectó que esto ya había pasado y no estaba reflejado. Corrigiendo:\n\n` : '') +
          `🛑 <b>TheHaton cerró ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
          `PERDIÓ (${pnl.toFixed(2)} USDT)\nCapital actual: ${acc.capital.toFixed(2)} USDT`
        ));
        sendPromises.push(sendPushToAll(`🛑 Stop tocado: ${thesis.symbol}`, `${pnl.toFixed(2)} USDT`));
      } else {
        stillOpen.push(thesis);
      }
      continue;
    }

    // Etapa 2: ya tomó el 50% -> el resto corre hasta TP2 o vuelve a breakeven (con el rango real)
    let hitTP2=false, hitBE=false;
    if(thesis.dir==='LONG'){ if(range.low<=thesis.stop) hitBE=true; else if(range.high>=thesis.tp2) hitTP2=true; }
    else { if(range.high>=thesis.stop) hitBE=true; else if(range.low<=thesis.tp2) hitTP2=true; }

    if(hitTP2 || hitBE){
      const exit = hitTP2 ? thesis.tp2 : thesis.stop;
      const pnl = thesis.units * (exit-thesis.entry) * (thesis.dir==='LONG'?1:-1);
      acc.capital = +(acc.capital+pnl).toFixed(4);
      const totalPnl = (thesis.partialPnl||0) + pnl;
      journal(thesis, `${hitTP2?'TP2 alcanzado':'Volvió a breakeven'}: se cierra el 50% restante (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT). Resultado total de la operación: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT. Capital: ${acc.capital.toFixed(2)}.`);
      acc.closedTrades.push({...thesis, exit, result: totalPnl>=0?'win':'loss', pnl:+totalPnl.toFixed(4), closedAt: Date.now()});
      sendPromises.push(sendTelegram(
        (isReconciliation ? `🔎 <b>Auditoría/conciliación:</b> se detectó que esto ya había pasado y no estaba reflejado. Corrigiendo:\n\n` : '') +
        `${hitTP2?'🚀':'⚖️'} <b>TheHaton cerró el resto de ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
        `${hitTP2?'TP2 alcanzado ✅':'Volvió al punto de entrada (breakeven en el 50% restante)'}\n` +
        `Resultado total de la operación: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT\nCapital actual: ${acc.capital.toFixed(2)} USDT`
      ));
      sendPromises.push(sendPushToAll(`${hitTP2?'🚀 TP2':'⚖️ Cierre'}: ${thesis.symbol}`, `Resultado total: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT`));
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
// Listas reales de qué se puede operar — para no analizar monedas que después no se puedan tradear.
async function fetchBinanceFuturesSymbols(){
  try{
    const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo').then(r=>r.json());
    return new Set((res.symbols||[]).filter(s=>s.status==='TRADING' && s.quoteAsset==='USDT').map(s=>s.baseAsset));
  }catch(e){ console.error('Error trayendo símbolos de Binance Futures:', e.message); return null; }
}
async function fetchBitunixFuturesSymbols(){
  try{
    const res = await fetch('https://fapi.bitunix.com/api/v1/futures/market/trading_pairs').then(r=>r.json());
    const list = res?.data || res || [];
    return new Set(list.map(p => (p.symbol||p.base||'').toUpperCase().replace('USDT','')).filter(Boolean));
  }catch(e){ console.error('Error trayendo símbolos de Bitunix Futures:', e.message); return null; }
}

const MIDCAP_CACHE_HOURS = 24; // recalcular la lista de "qué se puede operar" solo 1 vez por día, no en cada corrida

async function getMidCapCandidates(state){
  const cache = state.midCapCache;
  const cacheAgeHours = cache ? (Date.now()-cache.updatedAt)/(3600*1000) : Infinity;
  if(cache && cacheAgeHours < MIDCAP_CACHE_HOURS){
    console.log(`Usando lista de cap chico ya filtrada (calculada hace ${cacheAgeHours.toFixed(1)}hs de ${MIDCAP_CACHE_HOURS}hs) — ${cache.symbols.length} monedas, sin recalcular de nuevo.`);
    return cache.symbols;
  }
  try{
    const pages = await Promise.all([1,2,3,4].map(p=>
      fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}`).then(r=>r.json())
    ));
    const flat = pages.flatMap(p=>Array.isArray(p)?p:[]);
    const rawSymbols = flat
      .filter(c => c.market_cap >= 1_000_000 && c.market_cap <= 100_000_000)
      .map(c => c.symbol.toUpperCase())
      .filter(s => /^[A-Z0-9]{2,10}$/.test(s)); // descarta símbolos raros/wrapped con caracteres extraños

    // Cruce contra futuros reales de Binance y Bitunix: solo dejamos pasar lo que sí se puede operar.
    const [binanceSet, bitunixSet] = await Promise.all([fetchBinanceFuturesSymbols(), fetchBitunixFuturesSymbols()]);
    if(!binanceSet && !bitunixSet){
      console.error('⚠️ No se pudo traer ninguna lista de futuros (Binance ni Bitunix) — se sigue sin filtrar por esta vez, para no dejar de escanear del todo.');
      return cache ? cache.symbols : rawSymbols; // si había un cache previo, mejor eso que una lista sin filtrar
    }
    const tradeable = rawSymbols.filter(s => (binanceSet && binanceSet.has(s)) || (bitunixSet && bitunixSet.has(s)));
    console.log(`Filtro de futuros recalculado: ${rawSymbols.length} candidatas por cap → ${tradeable.length} realmente operables (Binance/Bitunix). Se guarda por ${MIDCAP_CACHE_HOURS}hs.`);
    state.midCapCache = { symbols: tradeable, updatedAt: Date.now() };
    return tradeable;
  }catch(e){
    console.error('Error trayendo monedas de cap chico:', e.message);
    return cache ? cache.symbols : []; // si falla el recálculo pero había un cache viejo, mejor usar ese que nada
  }
}

async function main(){
  if(!BOT_TOKEN || !CHAT_ID){ console.error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.'); process.exit(1); }
  const state = loadState();

  console.log('--- Fase 0: chequeando flujo de capital global (DeFiLlama) y referencia de BTC (4h, una sola vez) ---');
  const capitalFlow = await fetchCapitalFlowContext();
  const btcReference4h = await fetchBTCReference('4h').catch(()=>null);
  console.log('Capital flow:', capitalFlow, '| BTC 4h:', btcReference4h);

  console.log('--- Fase 0.5: chequeando si es apertura/cierre de Wall Street (análisis informativo de BTC) ---');
  await runMarketPulse(state, capitalFlow);

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
  await scanForTheses(state, candidates, capitalFlow, btcReference4h);

  console.log('--- Fase 4: monedas de cap chico ($1M-$100M) para la Market Context Matrix ---');
  const midCaps = await getMidCapCandidates(state);
  console.log(midCaps.length, 'monedas de cap chico encontradas.');
  const eligibleMidCaps = midCaps.filter(s => !pairs.includes(s) && !CUSTOM_COINS.includes(s));
  // Rotación: en vez de mirar siempre las primeras 60 (y nunca las demás), usamos la hora
  // actual para ir rotando qué "tanda" se revisa — así con el tiempo se cubren todas.
  const BATCH_SIZE = 60; // subido de 40 a 60: sacamos la fase de DEX, así que hay más margen por corrida
  const totalBatches = Math.max(1, Math.ceil(eligibleMidCaps.length / BATCH_SIZE));
  const batchIndex = new Date().getUTCHours() % totalBatches;
  const offset = batchIndex * BATCH_SIZE;
  console.log(`Revisando tanda ${batchIndex+1}/${totalBatches} de monedas de cap chico (rotando por hora).`);
  const midCapCandidates = eligibleMidCaps
    .slice(offset, offset+BATCH_SIZE)
    .map(symbol=>({symbol, tag:' (cap chico)'}));
  await scanForTheses(state, midCapCandidates, capitalFlow, btcReference4h);

  await Promise.all(sendPromises);
  saveState(state);
  console.log('--- Listo. Capital de TheHaton:', state.account.capital, '· Tesis abiertas:', state.account.theses.length, '---');
}

main().catch(e=>{ console.error('Error fatal:', e); process.exit(1); });
