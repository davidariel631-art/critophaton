// Fortress Terminal — TheHaton Strategy Center (bot)
// Corre en GitHub Actions programado cada 30 min (minutos :07 y :37, no en punto — GitHub atrasa
// más los horarios "en punto" por la carga alta). Aun así, GitHub NO garantiza el horario exacto:
// en la práctica puede tardar entre 30 min y varias horas entre corrida y corrida — es una
// limitación conocida y documentada de GitHub Actions, no un bug de este código.
// USA EL MISMO MOTOR que la web
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
  fetchOpenInterestTrend, fetchFundingTrend, fetchCapitalFlowContext, fetchBTCReference, fetchUnlockRisk,
  confluenceScore15m, fetchFearGreedIndex, getFOMCWindow, getHighImpactMacroWindow, fetchTopTraderRatio, fetchSpotFuturesFlow, computeLiquidityProfile, rsi, stochasticOscillator, macd, adx,
  computeScore, buildSetup, buildAnalystMode, computeGodPerformance, detectSFP, ema, detectVolumeSpike, detectDivergencia, detectTrianguloCompresion, analizarRupturaCompresion
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
const RISK_PCT = 0.02; // subido de 1% a 2% — probado con backtest real: sube la ganancia proporcional, sube también el drawdown máximo (hasta 23% en los peores casos probados). David lo eligió sabiendo ese trade-off.

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
      `${label}\n` +
      `<i>Análisis de BTC/USDT — solo informativo, no abre operaciones</i>\n\n` +
      `💰 <code>$${price.toFixed(0)}</code> · ${contexto}\n\n` +
      `${parrafo}\n\n` +
      `━━━━━━━━━━━━━━\n` +
      `📊 <b>Marcos</b>: 1h ${results['1h'].recommendation} · 4h ${results['4h'].recommendation} · 1D ${results['1d'].recommendation} → ${lean}\n` +
      `📍 Soporte 4h: <code>$${(m4h.support||0).toFixed(0)}</code> · Resistencia 4h: <code>$${(m4h.resistance||0).toFixed(0)}</code>\n` +
      `💧 Liquidez arriba: ${eqHighsTxt}\n` +
      `💧 Liquidez abajo: ${eqLowsTxt}\n` +
      `⚖️ Long/Short (top traders, 1h): ${ratioTxt}\n` +
      `━━━━━━━━━━━━━━\n\n` +
      `📈 <b>Tesis:</b> ${tesis}\n\n` +
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

// Genera una imagen del gráfico (vía QuickChart.io, gratis, sin key) con las velas recientes y
// los niveles de entrada/stop/TP1/TP2 marcados como líneas horizontales. Devuelve una URL corta
// que Telegram puede usar directo como foto. Si falla, devuelve null (el mensaje de texto sigue andando igual).
async function buildChartUrl(candles, entry, stop, tp1, tp2, dir, symbol){
  try{
    const recent = candles.slice(-40);
    const labels = recent.map((c,i)=> i%5===0 ? new Date(c.t).toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'}) : '');
    const closes = recent.map(c=>c.c);
    const lineColor = dir==='LONG' ? '#10b981' : '#ef4444';
    const config = {
      type:'line',
      data:{ labels, datasets:[{ label:symbol, data:closes, fill:false, borderColor:lineColor, borderWidth:2, pointRadius:0, tension:0.15 }] },
      options:{
        title:{ display:true, text:`${symbol} — ${dir}`, fontColor:'#eef3f8' },
        legend:{ display:false },
        scales:{
          xAxes:[{ gridLines:{ color:'#242c38' }, ticks:{ fontColor:'#8b98a8' } }],
          yAxes:[{ gridLines:{ color:'#242c38' }, ticks:{ fontColor:'#8b98a8' } }]
        },
        annotation:{ annotations:[
          { type:'line', mode:'horizontal', scaleID:'y-axis-0', value:entry, borderColor:'#00d9ff', borderWidth:2, label:{ enabled:true, content:'Entrada', backgroundColor:'#00d9ff', position:'left' } },
          { type:'line', mode:'horizontal', scaleID:'y-axis-0', value:stop, borderColor:'#ef4444', borderWidth:2, label:{ enabled:true, content:'Stop', backgroundColor:'#ef4444', position:'left' } },
          { type:'line', mode:'horizontal', scaleID:'y-axis-0', value:tp1, borderColor:'#10b981', borderWidth:2, label:{ enabled:true, content:'TP1', backgroundColor:'#10b981', position:'left' } },
          { type:'line', mode:'horizontal', scaleID:'y-axis-0', value:tp2, borderColor:'#10b981', borderWidth:2, label:{ enabled:true, content:'TP2', backgroundColor:'#10b981', position:'left' } },
        ]}
      }
    };
    const res = await fetch('https://quickchart.io/chart/create', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ width:700, height:450, backgroundColor:'#0b0e14', version:'2', chart: config })
    });
    if(!res.ok) return null;
    const data = await res.json();
    return data.success ? data.url : null;
  }catch(e){ console.error('Error generando gráfico:', e.message); return null; }
}

async function sendTelegramPhoto(photoUrl, caption){
  try{
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
    const res = await fetch(url, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({chat_id: CHAT_ID, photo: photoUrl, caption, parse_mode:'HTML'})
    });
    if(!res.ok){ console.error('Error enviando foto a Telegram:', await res.text()); return false; }
    return true;
  }catch(e){ console.error('Error enviando foto:', e.message); return false; }
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

// Límite de pérdida diaria: si hoy ya hubo 3 pérdidas seguidas, se frena por el resto del día — no
// solo se reduce el tamaño (eso ya lo hace computeDynamicRisk), directamente no se confirma nada
// más hasta el día siguiente. Probado con backtest real: nunca empeoró el resultado, y en 2 de 3
// períodos lo mejoró un poco — protege en rachas malas sin costar nada en los períodos normales.
function frenadoHoyPorRacha(acc, frenarDespuesDe=3){
  const hoy = new Date().toISOString().slice(0,10);
  const deHoy = acc.closedTrades.filter(t => new Date(t.closedAt).toISOString().slice(0,10)===hoy);
  let racha = 0;
  for(let i=deHoy.length-1;i>=0;i--){
    if(deHoy[i].result==='loss') racha++; else break;
  }
  return racha >= frenarDespuesDe;
}

function computeDynamicRisk(acc, confidencePct, patternQuality){
  acc.peakCapital = Math.max(acc.peakCapital, acc.capital);
  const drawdown = acc.peakCapital>0 ? (acc.peakCapital-acc.capital)/acc.peakCapital : 0;
  const recent = acc.closedTrades.slice(-3);
  const recentLosses = recent.filter(t=>t.result==='loss').length;
  // Todo proporcional a RISK_PCT (la base), no números fijos — así, si el día de mañana se cambia
  // RISK_PCT de nuevo, este sistema entero se reajusta solo, en vez de quedar roto como pasó hoy
  // (el bono de "alta confianza" terminaba siendo MENOR que la base nueva del 2%, sin querer).
  let risk = RISK_PCT, reason = `riesgo base (${(RISK_PCT*100).toFixed(1)}%)`;
  if(drawdown>0.15 || recentLosses>=2){ risk=RISK_PCT*0.5; reason=`riesgo reducido a ${(risk*100).toFixed(1)}% (drawdown ${(drawdown*100).toFixed(0)}% o ${recentLosses} pérdidas seguidas)`; }
  else if(confidencePct>=90 && recentLosses===0 && drawdown<0.05){ risk=RISK_PCT*1.5; reason=`riesgo aumentado a ${(risk*100).toFixed(1)}% (alta confianza, sin pérdidas recientes)`; }
  // Patrones "de manual" (BOS de estructura, Bear/Bull Trap confirmado) son entradas más limpias que una
  // confluencia genérica de indicadores — se les da un poco más de tamaño dentro del mismo rango permitido.
  if(patternQuality==='high' && risk < RISK_PCT*1.5){ risk = Math.min(RISK_PCT*1.5, risk*1.2); reason += ' · patrón de alta calidad (BOS/Bear-Trap): tamaño ligeramente mayor'; }
  // Nota: se probó acá una reducción por "riesgo correlacionado" (varias posiciones abiertas en la
  // misma dirección al mismo tiempo) — David decidió no usarla, se sacó. Si en el futuro se quiere
  // retomar: reducía a 0.7x con 2 posiciones misma dirección, 0.5x con 3+.
  return { risk: Math.max(RISK_PCT*0.5, Math.min(RISK_PCT*1.5, risk)), reason };
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

      // Mensaje de "en radar" — a propósito con formato bien distinto al de la SEÑAL confirmada
      // (más corto, sin la caja de "Configuración/Riesgo"), para que de un vistazo se note que
      // esto todavía NO es una entrada real, solo algo a seguir.
      const razonesDeteccion = result.committee.filter(c=>c.vote===result.recommendation).slice(0,3).map(c=>c.name.replace(/^[^\s]+\s/,'')).join(', ');
      const nivelClave = result.recommendation==='LONG' ? result.metrics.resistance : result.metrics.support;
      const nivelLabel = result.recommendation==='LONG' ? 'resistencia' : 'soporte';
      sendPromises.push(sendTelegram(
        `🔭 <b>$${symbol}${tag||''} — ojo con esto</b>\n` +
        `<i>(todavía NO es una entrada, solo algo que estamos siguiendo)</i>\n\n` +
        `Lo que llamó la atención acá fue ${razonesDeteccion || 'la confluencia general del comité'} — apuntando a un posible ${result.recommendation==='LONG'?'movimiento hacia arriba 🟢':'movimiento hacia abajo 🔴'}. ` +
        `Ahora hay que esperar a que rompa <code>$${nivelClave?.toFixed(6)}</code> (${nivelLabel} en 4h) de forma clara, o que aparezca una confluencia técnica más fuerte, o un Bear/Bull Trap a favor — recién ahí se confirmaría de verdad.\n\n` +
        `━━━━━━━━━━━━━━\n` +
        `📐 <b>Si eso pasa</b> <i>(estimado, puede cambiar)</i>\n` +
        `📌 Entrada: <code>$${result.metrics.price.toFixed(6)}</code>\n` +
        `🛑 Stop: <code>$${theoSetup.stop.toFixed(6)}</code>\n` +
        `🎯 TP1: <code>$${theoSetup.t1.toFixed(6)}</code>\n` +
        `🎯 TP2: <code>$${theoSetup.t2.toFixed(6)}</code>\n` +
        `━━━━━━━━━━━━━━\n\n` +
        `📊 Score ${best.toFixed(1)}/10 · ${result.confidence}% de confianza\n` +
        `<i>Te aviso aparte si esto termina confirmando.</i>`
      ));
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

      // Combo EMA50 (zona, 4h) + Estocástico (gatillo, 15m) — SOLO para SHORT. Probado con backtest
      // real en 3 períodos (2022, 2023-2025, 2018): profit factor 1.0 a 2.33, consistente. El LONG
      // con esta misma combinación se probó también (varios anchos de stop) y NUNCA dio ventaja real
      // — por eso acá solo se implementa el lado SHORT, a propósito, no es un olvido.
      let ema50ShortConfirmacion = false;
      if(thesis.dir==='SHORT'){
        const closes4hArr = data4h.candles.map(c=>c.c);
        const ema50Arr = ema(closes4hArr, 50);
        const ema50Now = ema50Arr.at(-1);
        const precio4h = closes4hArr.at(-1);
        if(ema50Now!=null){
          const tendenciaBajista = precio4h < ema50Now;
          const distanciaEma = Math.abs(precio4h-ema50Now)/precio4h;
          const enZona = distanciaEma <= 0.015;
          const kArr15 = stochasticOscillator(data15.candles).k;
          const dArr15 = stochasticOscillator(data15.candles).d;
          const kNow = kArr15.at(-1), kPrev = kArr15.at(-2), dNow = dArr15.at(-1), dPrev = dArr15.at(-2);
          const cruceBajista = kNow!=null && kPrev!=null && dNow!=null && dPrev!=null && kPrev>=dPrev && kNow<dNow && kPrev>=65;
          ema50ShortConfirmacion = tendenciaBajista && enZona && cruceBajista;
        }
      }

      // Entrada temprana de MACD (histograma "aclarándose"), blindada con ADX + Estocástico alineado —
      // ya viene armada y verificada desde el motor (confluence.macdEarlyBull/macdEarlyBear). No se usa
      // sola nunca: solo confirma si además no hay un sweep en contra reciente (misma lógica que el resto).
      const macdEarlyAFavor = (thesis.dir==='LONG' ? confluence.macdEarlyBull : confluence.macdEarlyBear) && !sweepEnContra;

      // NUEVO camino de confirmación: Swing Failure Pattern (SFP) — más riguroso que el sweep básico
      // de arriba. No es solo "hubo una mecha en contra", es "barrió un nivel real de liquidez (Equal
      // High/Low), con volumen elevado de verdad, cerró adentro, Y la estructura después ya viene
      // confirmando la reversión". Es el concepto SMC con mejor evidencia práctica encontrada en la
      // investigación para usarlo como gatillo de entrada, no solo como filtro.
      const sfp = detectSFP(data15.candles, result15.structure?.eqHighs, result15.structure?.eqLows);
      const sfpConfirmacion = false; // desactivado: el backtest mostró que empeora el resultado (probado en 2023-2025 y 2022, ver bitácora) — la función detectSFP queda disponible en el motor por si en el futuro se ajustan los umbrales y se vuelve a probar

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
      // Corrección probada con backtest real: antes entraba apenas tocaba la zona, sin esperar
      // confirmación de que el rebote ya arrancó — eso estaba restando en 2023-2025. Ahora exige
      // que el Estocástico cruce a favor (el gatillo exacto que enseña GRANMAGO) O que el MACD ya
      // esté acelerando a favor (más rápido, para no llegar tarde en mercados veloces como 2022).
      const kArrPull = stochasticOscillator(data15.candles).k;
      const dArrPull = stochasticOscillator(data15.candles).d;
      const kNowPull=kArrPull.at(-1), kPrevPull=kArrPull.at(-2), dNowPull=dArrPull.at(-1), dPrevPull=dArrPull.at(-2);
      const estocCruceAFavor = kNowPull!=null && kPrevPull!=null && dNowPull!=null && dPrevPull!=null && (
        thesis.dir==='LONG' ? (kPrevPull<=dPrevPull && kNowPull>dNowPull) : (kPrevPull>=dPrevPull && kNowPull<dNowPull)
      );
      const histMacdPull = macd(data15.candles.map(c=>c.c)).hist.filter(v=>v!=null);
      const macdAFavorPull = histMacdPull.length>=3 && (
        thesis.dir==='LONG' ? (histMacdPull.at(-1)>histMacdPull.at(-2)) : (histMacdPull.at(-1)<histMacdPull.at(-2))
      );
      const pullbackConfirmacion = trendFuerte && (nearEMA20 || nearEMA50 || nearOB) && alineado && !sweepEnContra && (estocCruceAFavor || macdAFavorPull);

      // "Imán de liquidez" multi-timeframe: si el marco MAYOR (1D) todavía tiene espacio (no está agotado
      // en la misma dirección) y el marco de confirmación está en un extremo local (pullback, no agotamiento
      // real), y además hay un cluster de liquidez (Equal Highs/Lows) esperando en la dirección de la tesis,
      // el precio tiene buenas chances de seguir para "barrer" esa liquidez antes de girar.
      let liquidityMagnetConfirmacion = false, htfNote = '';
      let momentumHealthOk = true, momentumHealthNote = '';
      try{
        const data1d = await fetchTokenData(thesis.symbol, '1d');
        const data4h = await fetchTokenData(thesis.symbol, '4h');
        if(data1d?.candles?.length>=30){
          const rsi1d = rsi(data1d.candles.map(c=>c.c), 14).filter(v=>v!=null).at(-1);
          const rsiLTF = result15.metrics.lastRSI;
          const htfConEspacio = rsi1d!=null && rsi1d>35 && rsi1d<65; // 1D neutral, ni sobrecomprado ni sobrevendido: hay recorrido
          const ltfExtremo = thesis.dir==='LONG' ? (rsiLTF!=null && rsiLTF<=35) : (rsiLTF!=null && rsiLTF>=65); // pullback local, no tendencia agotada
          const liqTarget = thesis.dir==='LONG' ? st15?.eqHighs : st15?.eqLows;
          const liqEnDireccion = liqTarget!=null && (thesis.dir==='LONG' ? liqTarget>priceNow : liqTarget<priceNow);
          liquidityMagnetConfirmacion = htfConEspacio && ltfExtremo && liqEnDireccion && alineado && !sweepEnContra;
          htfNote = `1D RSI ${rsi1d?.toFixed(0)??'—'} (${htfConEspacio?'con espacio':'sin espacio'}), LTF RSI ${rsiLTF?.toFixed(0)??'—'} (${ltfExtremo?'pullback local':'sin extremo'}), liquidez objetivo ${liqEnDireccion?`detectada a favor (~$${liqTarget.toFixed(6)})`:'no detectada a favor'}.`;

          // "¿Tiene tiempo/espacio real de subir (o bajar)?" — no alcanza con que el marco de entrada
          // (15m) se vea bien: si el Estocástico del marco MAYOR (4h/1D) ya está muy extendido, o el
          // MACD/ADX muestran que la fuerza se está yendo, es más probable que no llegue ni a TP1
          // antes de girar (exactamente lo que puede pasar si el precio primero va a buscar liquidez
          // cercana, como un cluster de Equal Highs/Lows fuerte, y ahí revierte).
          const problems = [];
          if(data4h?.candles?.length>=20){
            const stoch4h = stochasticOscillator(data4h.candles).k.filter(v=>v!=null).at(-1);
            if(stoch4h!=null){
              if(thesis.dir==='LONG' && stoch4h>=85) problems.push(`Estocástico 4h ya en ${stoch4h.toFixed(0)} (muy extendido, poco espacio para seguir subiendo)`);
              if(thesis.dir==='SHORT' && stoch4h<=15) problems.push(`Estocástico 4h ya en ${stoch4h.toFixed(0)} (muy extendido, poco espacio para seguir bajando)`);
            }
            const macd4h = macd(data4h.candles.map(c=>c.c));
            const hist4h = macd4h.hist.filter(v=>v!=null);
            if(hist4h.length>=3){
              const perdiendoFuerza = thesis.dir==='LONG' ? (hist4h.at(-1)<hist4h.at(-2) && hist4h.at(-2)<hist4h.at(-3)) : (hist4h.at(-1)>hist4h.at(-2) && hist4h.at(-2)>hist4h.at(-3));
              if(perdiendoFuerza) problems.push('MACD 4h perdiendo fuerza en las últimas 3 velas (el histograma se viene achicando)');
            }
            const adxNow = adx(data4h.candles);
            const adxPrev = adx(data4h.candles.slice(0,-1));
            if(adxNow!=null && adxPrev!=null && adxNow<adxPrev && adxNow<25) problems.push(`ADX 4h débil y bajando (${adxNow.toFixed(0)}) — la tendencia se está quedando sin fuerza`);
          }
          const stoch1d = stochasticOscillator(data1d.candles).k.filter(v=>v!=null).at(-1);
          if(stoch1d!=null){
            if(thesis.dir==='LONG' && stoch1d>=85) problems.push(`Estocástico 1D ya en ${stoch1d.toFixed(0)} (sin espacio en el marco mayor)`);
            if(thesis.dir==='SHORT' && stoch1d<=15) problems.push(`Estocástico 1D ya en ${stoch1d.toFixed(0)} (sin espacio en el marco mayor)`);
          }
          if(problems.length>=2){ // exigimos al menos 2 señales de "sin espacio" antes de bloquear, para no ser demasiado estricto
            momentumHealthOk = false;
            momentumHealthNote = problems.join('; ') + '.';
          }
        }
      }catch(e){ /* si falla, simplemente no aporta este camino, no rompe el resto */ }

      if(!momentumHealthOk){
        journal(thesis, `Todavía esperando confirmación: el marco mayor (4h/1D) no muestra espacio real para que el movimiento continúe — ${momentumHealthNote} Puede que el precio no llegue ni a TP1 antes de girar (por ejemplo, si primero va a buscar liquidez cercana).`);
        stillWatching.push(thesis);
        continue;
      }

      // Filtro de Estocástico — RECODIFICADO para que dependa del régimen del mercado (investigado a
      // fondo): un Estocástico "pegado" en un extremo NO significa lo mismo siempre.
      // - En RANGO (ADX débil, <20): un extremo (≥80/≤20) sí es señal real de agotamiento/reversión —
      //   se mantiene el bloqueo de siempre, ahí es donde ese filtro tiene sentido de verdad.
      // - En TENDENCIA real (ADX≥20): quedarse pegado en el extremo es FUERZA de tendencia, no
      //   agotamiento — pelear contra eso (como hacía el filtro viejo, bloqueando SIEMPRE) es el error
      //   clásico de principiante que describe toda la bibliografía. Acá simplemente no se veta: se
      //   deja que los demás caminos (sobre todo "Momentum Continuation", que ya busca el pullback a
      //   EMA20/50 dentro de la tendencia) hagan su trabajo sin este filtro peleando en contra.
      const stochK = result15.metrics.lastStochK;
      const enRegimenDeTendencia = confluence.adxStrong; // ADX>=20, mismo umbral que ya usa el motor
      if(stochK!=null && !enRegimenDeTendencia && (stochK>=80 || stochK<=20)){
        journal(thesis, `Todavía esperando confirmación (Estocástico en ${stochK.toFixed(0)}, zona de ${stochK>=80?'sobrecompra':'sobreventa'} en un mercado LATERAL, ADX ${confluence.adxVal?.toFixed(0)} — acá sí es agotamiento real, no se abren operaciones nuevas en el extremo).`);
        stillWatching.push(thesis);
        continue;
      }

      // Filtro de desbloqueo de tokens (el catalizador que usa David en sus señales de BEAT y UB):
      // cuando se libera un lote grande de tokens (vesting de equipo/inversores), entra oferta
      // programada al mercado. No es análisis técnico — es saber que viene una avalancha de supply.
      // Bloquea LONGs antes de un desbloqueo grande; para SHORTs es viento a favor, no se bloquea.
      const unlockRisk = await fetchUnlockRisk(thesis.symbol).catch(()=>null);
      if(unlockRisk?.riesgoAlto && thesis.dir==='LONG'){
        journal(thesis, `Todavía esperando confirmación: hay un ${unlockRisk.descripcion}. Un desbloqueo grande mete oferta nueva al mercado y suele presionar el precio a la baja — no se abre un LONG justo antes de eso.`);
        stillWatching.push(thesis);
        continue;
      }

      // Filtro de coherencia con el perfil de volumen (encontrado analizando la operación real de
      // OPEN): el bot reportaba "87% del volumen está ABAJO" y abría un LONG igual. El perfil de
      // volumen es un imán — si la concentración está mayormente del lado contrario a la operación,
      // el precio tiende a ir hacia allá, no hacia donde apunta la tesis. Se exige que la dominancia
      // no contradiga fuertemente la dirección (más de 70/30 en contra es contradicción seria).
      const liqCoherencia = computeLiquidityProfile(data15.candles, result15.metrics.price, 200);
      if(liqCoherencia){
        const dominanciaEnContra = thesis.dir==='LONG'
          ? liqCoherencia.domDownPct >= 70
          : liqCoherencia.domUpPct >= 70;
        if(dominanciaEnContra && !bosAFavor && !bearTrapConfirmacion){
          journal(thesis, `Todavía esperando confirmación: el perfil de volumen contradice la dirección — ${thesis.dir==='LONG' ? liqCoherencia.domDownPct.toFixed(0)+'% del volumen está ABAJO del precio en una tesis LONG' : liqCoherencia.domUpPct.toFixed(0)+'% del volumen está ARRIBA del precio en una tesis SHORT'}. El precio tiende a ir hacia donde está la concentración de volumen. Se exige BOS o Bear/Bull Trap para confirmar contra esa lectura.`);
          stillWatching.push(thesis);
          continue;
        }
      }

      // Filtro macro suave (Fear & Greed): F&G<30 (no solo <25) ya se considera zona de miedo relevante para exigir más evidencia.
      const fng = await fetchFearGreedIndex().catch(()=>null);
      const macroAdverso = fng!=null && ((thesis.dir==='LONG' && fng<30) || (thesis.dir==='SHORT' && fng>75));
      // Válvula de escape: si el Fear&Greed se queda extremo por mucho tiempo seguido (pasó en la
      // práctica — 2 días seguidos sin que abriera ninguna operación, con decenas de tesis atascadas
      // acá mismo hasta expirar a las 18hs sin nunca confirmar), este filtro puede bloquear TODO
      // indefinidamente. Después de 8 horas atascada específicamente por este motivo, se libera y se
      // deja confirmar con la confluencia normal — 8hs ya le dieron una chance real de mostrar un
      // BOS o Bear/Bull Trap; seguir esperando después de eso es más probable que mate la tesis por
      // expiración (a las 18hs) que protegerla de algo.
      const horasEsperando = (Date.now()-thesis.detectedAt)/3600000;
      const escapeValvulaTiempo = horasEsperando >= 8;
      if(macroAdverso && !bosAFavor && !bearTrapConfirmacion && !sfpConfirmacion && !escapeValvulaTiempo){
        journal(thesis, `Todavía esperando confirmación (Fear&Greed en ${fng}, contexto adverso para ${thesis.dir} — se exige BOS claro o un Bear/Bull Trap confirmado, no alcanza con confluencia sola en este contexto).`);
        stillWatching.push(thesis);
        continue;
      }
      if(macroAdverso && escapeValvulaTiempo && !bosAFavor && !bearTrapConfirmacion && !sfpConfirmacion){
        journal(thesis, `Fear&Greed sigue en ${fng} (adverso), pero ya lleva ${horasEsperando.toFixed(1)}hs esperando un BOS o Bear/Bull Trap que no llegó — se libera el filtro y se deja confirmar con la confluencia normal, para no dejar que expire sin oportunidad.`);
      }

      // Filtro de "crowding" (funding + Open Interest juntos) — el hueco que encontramos: ya
      // traíamos este dato, pero solo se usaba para el texto del mensaje, nunca para decidir nada.
      // Basado en el paper del BIS (Banco de Pagos Internacionales, WP 1087): un funding alto Y el
      // Open Interest subiendo AL MISMO TIEMPO significa que hay longs (o shorts) muy apalancados y
      // amontonados — ahí es donde el mercado suele "purgar" con una liquidación en cadena. Si vamos
      // A FAVOR de esa masa (ej: LONG cuando ya está todo el mundo en largo), pedimos más evidencia,
      // igual que con Fear&Greed. Si vamos EN CONTRA (ej: SHORT justo ahí), no se bloquea — el
      // apretón jugaría a favor nuestro.
      // Aviso honesto (de la investigación): esta ventaja se sabe que se "gasta" con el tiempo —
      // no es una regla fija para siempre, hay que vigilar si sigue aportando con el correr de los meses.
      const lastFunding = fundingTrendData?.values?.at(-1);
      const oiSubiendo = oiTrendData?.trend === 'RISING';
      // Umbrales recalibrados (antes: >0.03% / <-0.02%) — se comprobó con datos reales de octubre
      // 2025 (93 registros, mes completo) que el funding NUNCA llegó a esos niveles ni una sola vez,
      // ni siquiera durante el evento de liquidaciones más grande del año — el filtro estaba dormido
      // todo el tiempo. Los nuevos umbrales salen de la distribución real de ese mes (percentil ~90
      // del lado positivo, percentil ~95 del lado negativo), no de un número inventado — capturan
      // el funding realmente extremo de hoy, no el de un mercado de 2021-2022 que ya no existe así.
      const longsAmontonados = lastFunding!=null && lastFunding > 0.008 && oiSubiendo;
      const shortsAmontonados = lastFunding!=null && lastFunding < -0.005 && oiSubiendo;
      const crowdingEnContra = (thesis.dir==='LONG' && longsAmontonados) || (thesis.dir==='SHORT' && shortsAmontonados);
      if(crowdingEnContra && !bosAFavor && !bearTrapConfirmacion && !sfpConfirmacion && !escapeValvulaTiempo){
        journal(thesis, `Todavía esperando confirmación: funding en ${lastFunding.toFixed(3)}% con Open Interest subiendo — ${thesis.dir==='LONG'?'longs':'shorts'} muy amontonados y apalancados, riesgo de que el mercado los purgue con una liquidación en cadena — se exige BOS claro o un Bear/Bull Trap confirmado, no alcanza con confluencia sola en este contexto.`);
        stillWatching.push(thesis);
        continue;
      }

      // Filtro macro AMPLIADO: antes no solo miraba FOMC — ahora también NFP (empleo, primer viernes
      // del mes) y peticiones de desempleo semanales (todos los jueves), que son los otros datos de
      // EE.UU. que más mueven el mercado. Antes de cualquiera de estos eventos no hay análisis técnico
      // que valga (son eventos binarios) — se pausa por completo. Después, se exige más evidencia,
      // igual que con Fear&Greed, porque el mercado puede estar reaccionando de forma errática todavía.
      const fomc = getHighImpactMacroWindow(2);
      if(fomc.isNear && fomc.hoursUntil>0){
        journal(thesis, `Pausado: ${fomc.kind} en ${fomc.hoursUntil.toFixed(1)}hs. No tiene sentido confirmar una entrada técnica justo antes de un evento binario que puede mover todo el mercado de golpe.`);
        stillWatching.push(thesis);
        continue;
      }
      if(fomc.isNear && fomc.hoursUntil<=0 && !bosAFavor && !bearTrapConfirmacion && !sfpConfirmacion && !escapeValvulaTiempo){
        journal(thesis, `Todavía esperando confirmación (${fomc.kind} fue hace ${Math.abs(fomc.hoursUntil).toFixed(1)}hs — se exige BOS claro o un Bear/Bull Trap confirmado hasta que el mercado se asiente).`);
        stillWatching.push(thesis);
        continue;
      }

      if(frenadoHoyPorRacha(acc)){
        journal(thesis, `Se frena por hoy: 3 pérdidas seguidas ya en el día. No se confirma nada más hasta mañana, para no seguir operando en un momento donde algo está afectando varias operaciones seguidas.`);
        stillWatching.push(thesis);
        continue;
      }
      if(alineado && (bosAFavor || confianzaSubio || confluenceAFavor || bearTrapConfirmacion || pullbackConfirmacion || liquidityMagnetConfirmacion || patronCompletoConfirmacion || macdEarlyAFavor || sfpConfirmacion || ema50ShortConfirmacion)){
        const setup = buildSetup(data15, result15, 'balanced');
        const entryPrice = result15.metrics.price; // mismo precio que usó buildSetup para calcular stop/TP, evita descalces

        // VALIDACIÓN CRÍTICA (encontrada analizando una operación real de ZEST que perdió sí o sí):
        // buildSetup calcula los niveles según la dirección que ve el análisis de 15m, pero la tesis
        // tiene su dirección fijada desde el análisis de 4h. Si las dos no coinciden, los niveles
        // salen INVERTIDOS — un LONG con el stop arriba y el TP abajo, condenado a perder pase lo
        // que pase. Acá se chequea que cada nivel esté del lado correcto antes de abrir nada.
        const nivelesCoherentes = thesis.dir==='LONG'
          ? (setup.stop < entryPrice && setup.t1 > entryPrice && setup.t2 > setup.t1)
          : (setup.stop > entryPrice && setup.t1 < entryPrice && setup.t2 < setup.t1);
        if(!nivelesCoherentes){
          journal(thesis, `Confirmación descartada: los niveles calculados no son coherentes con la dirección ${thesis.dir} (entrada $${entryPrice.toFixed(6)}, stop $${setup.stop.toFixed(6)}, TP1 $${setup.t1.toFixed(6)}). Probablemente el análisis de 15m cambió de dirección respecto a la tesis de 4h — se descarta en vez de abrir una operación con stop y objetivo invertidos.`);
          stillWatching.push(thesis);
          continue;
        }

        // Stop demasiado pegado al precio: si está a menos de 0.15% de la entrada, cualquier
        // movimiento normal del mercado lo toca al instante (ZEST tenía el stop a 0.04% — imposible
        // de sostener). Se exige una distancia mínima realista.
        const distanciaStopPct = Math.abs(entryPrice-setup.stop)/entryPrice*100;
        if(distanciaStopPct < 0.15){
          journal(thesis, `Confirmación descartada: el stop quedó a solo ${distanciaStopPct.toFixed(3)}% del precio de entrada — demasiado pegado, cualquier movimiento normal lo tocaría al instante. Se sigue observando.`);
          stillWatching.push(thesis);
          continue;
        }

        const patternQuality = (bosAFavor || bearTrapConfirmacion || liquidityMagnetConfirmacion || patronCompletoConfirmacion) ? 'high' : 'normal';
        const {risk: riskPct, reason} = computeDynamicRisk(acc, result15.confidence, patternQuality, thesis.dir);
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

        // Filtro de "caza de liquidez": si justo arriba (para un LONG) o abajo (para un SHORT) hay
        // una concentración de liquidez mucho más grande y MUY cerca del precio de entrada, lo más
        // probable es que el precio solo esté yendo a buscar esa liquidez (barrer stops) antes de
        // girar — no confirmamos justo antes de esa zona, aunque el resto de la señal se vea bien.
        const liqProfilePre = computeLiquidityProfile(data15.candles, entryPrice);
        const nearestPOC = thesis.dir==='LONG' ? liqProfilePre.pocAbove : liqProfilePre.pocBelow;
        const domDiff = thesis.dir==='LONG' ? (liqProfilePre.domUpPct-liqProfilePre.domDownPct) : (liqProfilePre.domDownPct-liqProfilePre.domUpPct);
        const pocMuyCerca = nearestPOC && Math.abs(nearestPOC.price-entryPrice)/entryPrice < 0.02;
        if(pocMuyCerca && domDiff > 15){
          journal(thesis, `Todavía esperando confirmación: hay una concentración fuerte de liquidez muy cerca (~$${nearestPOC.price.toFixed(6)}, ${thesis.dir==='LONG'?'Dom. Arriba':'Dom. Abajo'} ${(thesis.dir==='LONG'?liqProfilePre.domUpPct:liqProfilePre.domDownPct).toFixed(0)}%) — parece más una caza de liquidez que una entrada real, se espera a que la barra o se aleje.`);
          stillWatching.push(thesis);
          continue;
        }

        // Ajuste de TP1 por barrera de liquidez (encontrado en la operación real de OPEN): el bot
        // reportaba "hay liquidez a $0.195053, el precio ya la tocó 3 veces sin romperla" y ponía el
        // TP1 en $0.198682, o sea DETRÁS de esa barrera. Para llegar al objetivo el precio tenía que
        // atravesar el nivel que ya lo había rechazado 3 veces. Si hay una barrera confirmada (2+
        // toques) entre la entrada y el TP1, el objetivo se mueve justo antes de ella.
        const barrera = thesis.dir==='LONG' ? result15.structure?.eqHighs : result15.structure?.eqLows;
        const toquesBarrera = thesis.dir==='LONG' ? (result15.structure?.eqHighsCount||0) : (result15.structure?.eqLowsCount||0);
        if(barrera!=null && toquesBarrera >= 2){
          const barreraEnElCamino = thesis.dir==='LONG'
            ? (barrera > entryPrice && barrera < setup.t1)
            : (barrera < entryPrice && barrera > setup.t1);
          if(barreraEnElCamino){
            const margen = thesis.dir==='LONG' ? 0.998 : 1.002; // apenas antes del nivel
            const tp1Ajustado = barrera * margen;
            const rrAjustado = Math.abs(tp1Ajustado-entryPrice)/distance;
            if(rrAjustado >= 1.0){
              journal(thesis, `TP1 ajustado de $${setup.t1.toFixed(6)} a $${tp1Ajustado.toFixed(6)}: hay una barrera de liquidez en $${barrera.toFixed(6)} (${toquesBarrera} toques previos sin romper) en el camino. Es más realista tomar ganancia antes de ese nivel que esperar que lo atraviese.`);
              setup.t1 = tp1Ajustado;
            } else {
              journal(thesis, `Confirmación descartada: el TP1 quedaría detrás de una barrera de liquidez ($${barrera.toFixed(6)}, ${toquesBarrera} toques) y ajustarlo antes de esa barrera daría un R:R de solo ${rrAjustado.toFixed(2)}:1. No vale la pena la operación.`);
              stillWatching.push(thesis);
              continue;
            }
          }
        }

        // Filtro de CVD (flujo de compra/venta aproximado): si vamos a COMPRAR pero el CVD muestra
        // divergencia bajista (el precio sube sin volumen comprador real detrás), o vamos a VENDER
        // pero el CVD muestra divergencia alcista, es señal de ruptura débil — no confirmamos.
        const cvdEnContra = thesis.dir==='LONG' ? result15.cvd?.bearishDivergence : result15.cvd?.bullishDivergence;
        if(cvdEnContra){
          journal(thesis, `Todavía esperando confirmación: el CVD (flujo de compra/venta aproximado) muestra que el movimiento actual no tiene volumen real detrás — parece una ruptura débil, se espera a que se confirme con volumen de verdad.`);
          stillWatching.push(thesis);
          continue;
        }

        // Comité con pesos automáticos: cada Dios ya tiene su historial real de aciertos guardado
        // (computeGodPerformance). PERO solo lo usamos como filtro una vez que un Dios tiene AL MENOS
        // 15 votos de muestra — con menos que eso, actuar sobre el número sería repetir el mismo
        // error que ya identificamos (sacar conclusiones de una muestra chica). Hoy (con 1-6 votos
        // por Dios) esto todavía no hace nada — se activa solo cuando la evidencia real alcanza.
        const MIN_VOTOS_PARA_CONFIAR = 15;
        const godPerf = computeGodPerformance(acc.closedTrades);
        const godsAFavor = (result15.committee||[]).filter(g=>g.vote===thesis.dir);
        const godsMaduros = godsAFavor.map(g=>godPerf.find(p=>p.name===g.name)).filter(p=>p && p.agreedTotal>=MIN_VOTOS_PARA_CONFIAR);
        // Válvula de escape (12hs, más conservadora que la de F&G porque acá la protección se basa
        // en evidencia real, no solo cautela): sin esto, si un Dios central (Tendencia, Macro) tiene
        // mal historial, este filtro bloquea toda entrada nueva que dependa de él — y como nunca se
        // generan operaciones nuevas, el historial nunca puede recalcularse ni mejorar. Es una trampa
        // lógica cerrada sobre sí misma. Después de 12hs se libera UNA vez para permitir que la
        // cuenta genere un dato fresco y el promedio pueda moverse de nuevo.
        const escapeValvulaGods = horasEsperando >= 12;
        if(godsMaduros.length>0 && !escapeValvulaGods){
          const avgWinRate = godsMaduros.reduce((s,g)=>s+g.winRate,0)/godsMaduros.length;
          if(avgWinRate < 30){
            journal(thesis, `Todavía esperando confirmación: los Dioses que votan a favor de esta entrada (${godsMaduros.map(g=>g.name).join(', ')}) tienen un historial real flojo (${avgWinRate.toFixed(0)}% de aciertos con ${godsMaduros.reduce((s,g)=>s+g.agreedTotal,0)} votos acumulados) — se pausa esta entrada hasta que mejore ese historial o aparezca otra confirmación más fuerte.`);
            stillWatching.push(thesis);
            continue;
          }
        } else if(godsMaduros.length>0 && escapeValvulaGods){
          const avgWinRate = godsMaduros.reduce((s,g)=>s+g.winRate,0)/godsMaduros.length;
          if(avgWinRate < 30) journal(thesis, `Los Dioses a favor (${godsMaduros.map(g=>g.name).join(', ')}) siguen con historial flojo (${avgWinRate.toFixed(0)}%), pero ya lleva ${horasEsperando.toFixed(1)}hs esperando — se libera una vez para que la cuenta genere un dato fresco y el promedio pueda recalcularse.`);
        }

        thesis.status = 'ACTIVE';
        thesis.entry = entryPrice; thesis.stop = setup.stop; thesis.tp1 = setup.t1; thesis.tp2 = setup.t2; thesis.tp3 = setup.t3; thesis.units = units; thesis.originalUnits = units;
        thesis.riskPct = riskPct; thesis.confirmedAt = Date.now(); thesis.partialTaken = false;
        // Tipo de setup y hora del día, para poder desglosar estadísticas después (win rate por
        // tipo de setup, por moneda, por horario) — se guarda acá y viaja solo a closedTrades
        // porque los cierres usan {...thesis}.
        thesis.tipoSetup = patronCompletoConfirmacion ? 'Patrón completo' : bosAFavor ? 'BOS' : sfpConfirmacion ? 'SFP' : bearTrapConfirmacion ? 'Bear/Bull Trap' : ema50ShortConfirmacion ? 'EMA50+Estocástico' : liquidityMagnetConfirmacion ? 'Imán de liquidez' : pullbackConfirmacion ? 'Pullback' : confluenceAFavor ? 'Confluencia' : macdEarlyAFavor ? 'MACD temprano' : 'Confianza subió';
        thesis.horaConfirmacion = new Date(thesis.confirmedAt).getUTCHours();
        thesis.committeeSnapshot = result15.committee.map(c=>({name:c.name, vote:c.vote})); // para la memoria estadística por Dios
        const motivoConfirmacion = patronCompletoConfirmacion ? `Patrón completo ${thesis.dir==='LONG'?'Acumulación + Bear Trap':'Distribución + Bull Trap'} (rango testeado ${thesis.dir==='LONG'?result15.structure.accBearTrap.testPumpCount:result15.structure.distBullTrap.testDumpCount} veces antes de la barrida)` : bosAFavor ? 'BOS a favor detectado' : sfpConfirmacion ? (thesis.dir==='LONG' ? sfp.bullishNote : sfp.bearishNote) : bearTrapConfirmacion ? `${thesis.dir==='LONG'?'Bear Trap':'Bull Trap'} barrido y rechazado (liquidez tomada en contra del mercado, a favor de la tesis)` : ema50ShortConfirmacion ? `Precio cerca de la EMA50 en 4h (zona de rebote), en tendencia bajista, con el Estocástico en 15m cruzando hacia abajo desde sobrecompra — combo probado con backtest real (profit factor 1.0-2.33 en 3 períodos)` : liquidityMagnetConfirmacion ? `Imán de liquidez multi-timeframe (${htfNote})` : pullbackConfirmacion ? `Momentum Continuation: pullback a ${nearOB?'Order Block':nearEMA20?'EMA20':'EMA50'} dentro de una tendencia ya fuerte` : confluenceAFavor ? `Score de Confluencia (${thesis.dir==='LONG'?confluence.bullConfluence:confluence.bearConfluence}/5: MACD, Stochastic, velas fuertes, volumen, ADX)` : macdEarlyAFavor ? `MACD histograma achicándose (entrada temprana), confirmado con ADX ${confluence.adxVal?.toFixed(0)} (tendencia real) y Estocástico ${confluence.lastStoch?.toFixed(0)} alineado` : `la confianza del motor subió a ${result15.confidence}%`;
        journal(thesis, `Entrada CONFIRMADA en 15m (${motivoConfirmacion}). Entrada: $${entryPrice.toFixed(6)}, Stop: $${setup.stop.toFixed(6)}, TP1: $${setup.t1.toFixed(6)}, TP2: $${setup.t2.toFixed(6)}. ${reason}.`);
        acc.tradesToday.count++;

        const analyst = buildAnalystMode(data15, result15, setup, '15m');
        const rrTp1 = (Math.abs(setup.t1-entryPrice)/distance).toFixed(1);
        const rrTp2 = (Math.abs(setup.t2-entryPrice)/distance).toFixed(1);
        const rrTp3 = (Math.abs(setup.t3-entryPrice)/distance).toFixed(1);
        const invalidacion = (analyst.invalidation||[])[0] || `Cierre de vela más allá del stop ($${setup.stop.toFixed(6)}).`;

        // Datos reales adicionales para el relato numerado — solo lo que realmente se puede conseguir
        // gratis (estructura, OI, funding, flujo spot/futuros, ratio Long/Short de traders grandes).
        // NO se inventan wallets, vesting, flujo OTC ni liquidaciones: esos datos no están disponibles
        // sin una API paga, y no se van a simular como si lo estuvieran.
        const spotFutFlow = await fetchSpotFuturesFlow(thesis.symbol, '15m').catch(()=>null);
        const ratio = await fetchTopTraderRatio(thesis.symbol, '15m').catch(()=>null);
        const liqProfile = liqProfilePre; // ya lo calculamos antes, para el filtro de caza de liquidez
        const st = result15.structure;
        const mt = result15.metrics;

        // Mismo relato que armaba antes en una lista numerada (1️⃣2️⃣3️⃣...), ahora conectado como
        // una historia — mismos datos, mismo respaldo real, pero contado como lo haría un analista
        // explicando su lectura en voz alta, no como una lista de chequeo mecánica.
        const dirTxt = thesis.dir==='LONG' ? 'para arriba' : 'para abajo';
        const relato = [];
        relato.push(analystSummary(result15));

        // Pico de volumen real (no interpretado) — solo se menciona si el número mismo lo justifica
        // (5x+ el promedio), describiendo el hecho tal cual es, sin inventar "por qué" pasó.
        const volSpike = detectVolumeSpike(data15.candles);
        if(volSpike){
          relato.push(`📊 Ojo con esto: la última vela tuvo ${volSpike.multiplo.toFixed(1)}x el volumen promedio de las anteriores${volSpike.precioEstable ? ', mientras el precio se mantuvo bastante estable' : ''} — un volumen así de fuera de lo común suele preceder un movimiento más marcado, aunque no se puede saber con certeza para qué lado ni por qué exactamente pasó.`);
        }

        // Desbloqueo de tokens cercano: para un SHORT es viento a favor (oferta programada entrando),
        // para un LONG ya lo habría bloqueado el filtro, pero puede haber uno chico que igual conviene mencionar.
        if(unlockRisk){
          relato.push(`🔓 Dato de oferta: hay un ${unlockRisk.descripcion}.${thesis.dir==='SHORT' ? ' Eso juega a favor de esta operación — es oferta nueva entrando al mercado.' : ' Es algo a tener en cuenta, aunque no llega al umbral de riesgo alto.'}`);
        }

        // Divergencia RSI+MACD y triángulo de compresión, calculados sobre las velas de 15m que sí
        // están disponibles acá (en este punto del código no hay acceso al análisis de 4h).
        const divergencia15 = detectDivergencia(data15.candles);
        if(divergencia15){
          const aFavor = (divergencia15.tipo==='alcista' && thesis.dir==='LONG') || (divergencia15.tipo==='bajista' && thesis.dir==='SHORT');
          relato.push(`📐 Hay una divergencia ${divergencia15.tipo}: ${divergencia15.descripcion}${aFavor ? ' — y apunta a favor de esta operación' : ', que va en contra de esta operación, así que es algo a tener en cuenta'}.`);
        }
        const triangulo15 = detectTrianguloCompresion(data15.candles);
        if(triangulo15){
          const ruptura = analizarRupturaCompresion(data15.candles, triangulo15);
          relato.push(`📊 Se está formando un ${triangulo15.descripcion}.${ruptura ? ` Mirando hacia dónde puede romper: ${ruptura.resumen}` : ''}`);
        }

        // Liquidez, con más detalle: los dos lados (no solo el de la dirección de la tesis), qué tan
        // lejos está cada nivel del precio actual, y unido con el mapa de volumen (antes eran 2
        // menciones sueltas y desconectadas).
        const priceNow15 = result15.metrics.price;
        const distPct = (nivel) => Math.abs(nivel-priceNow15)/priceNow15*100;
        const liqPartes = [];
        if(st.eqHighs){
          const esObjetivo = thesis.dir==='LONG';
          liqPartes.push(`arriba, a un ${distPct(st.eqHighs).toFixed(1)}% del precio actual (~$${st.eqHighs.toFixed(6)}), hay liquidez compradora acumulada — el precio ya tocó ese nivel ${st.eqHighsCount} veces sin romperlo del todo${esObjetivo ? ', y es justo hacia donde apunta esta operación' : ', un nivel a tener en cuenta como resistencia en el camino'}`);
        }
        if(st.eqLows){
          const esObjetivo = thesis.dir==='SHORT';
          liqPartes.push(`abajo, a un ${distPct(st.eqLows).toFixed(1)}% del precio actual (~$${st.eqLows.toFixed(6)}), hay liquidez vendedora acumulada (${st.eqLowsCount} toques previos)${esObjetivo ? ', y es justo hacia donde apunta esta operación' : ', un nivel a tener en cuenta como soporte en el camino'}`);
        }
        if(liqPartes.length){
          relato.push(`En cuanto a liquidez: ${liqPartes.join('; y ')}. El mercado tiende a moverse hacia estas zonas antes de girar, porque ahí es donde se concentran los stops y las órdenes pendientes que el precio "atrae" como un imán.`);
        }
        relato.push(`Mirando el perfil de volumen completo, la concentración general está ${liqProfile.domUpPct>liqProfile.domDownPct?'más arriba':'más abajo'} del precio actual (${liqProfile.domUpPct.toFixed(0)}% arriba / ${liqProfile.domDownPct.toFixed(0)}% abajo)${liqProfile.pocAbove?`, con el bloque de mayor volumen negociado cerca de $${liqProfile.pocAbove.price.toFixed(6)}`:''}${liqProfile.pocBelow?`${liqProfile.pocAbove?' y otro bloque grande':', con un bloque grande'} cerca de $${liqProfile.pocBelow.price.toFixed(6)}`:''} — son zonas donde ya se negoció mucho volumen antes, así que el precio suele reaccionar (rebotar o frenarse) al volver a pasar por ahí.`);
        if(oiTrendData?.trend){
          relato.push(oiTrendData.trend==='RISING'
            ? 'Mientras tanto, está entrando capital nuevo apalancado (el Open Interest viene subiendo) — hay convicción real detrás del movimiento, no es solo ruido'
            : 'El Open Interest viene bajando, o sea que se está desarmando apalancamiento — el mercado se está \"limpiando\" antes de definir rumbo');
        }
        if(ratio){
          const posTxt = (ratio.ratio>1.3 && thesis.dir==='SHORT')
            ? `y el mercado está muy cargado de largos (${ratio.longPct.toFixed(0)}% long) — eso lo hace vulnerable a una purga justo en la dirección que buscamos`
            : (ratio.ratio<0.77 && thesis.dir==='LONG')
            ? `y el mercado está muy cargado de cortos (${ratio.shortPct.toFixed(0)}% short) — vulnerable a un short squeeze que empuje justo para donde apuntamos`
            : `aunque el posicionamiento de los traders grandes no muestra un sesgo extremo (${ratio.ratio.toFixed(2)}:1)`;
          relato.push(posTxt.charAt(0).toUpperCase()+posTxt.slice(1) + '.');
        }
        if(spotFutFlow){
          relato.push(spotFutFlow.leverageDriven
            ? `Ojo con esto: el movimiento viene más de apalancamiento en futuros (+${spotFutFlow.futChangePct.toFixed(0)}%) que de compra/venta real en spot (${spotFutFlow.spotChangePct>=0?'+':''}${spotFutFlow.spotChangePct.toFixed(0)}%) — no es demanda genuina todavía`
            : `El spot (${spotFutFlow.spotChangePct>=0?'+':''}${spotFutFlow.spotChangePct.toFixed(0)}%) y los futuros (${spotFutFlow.futChangePct>=0?'+':''}${spotFutFlow.futChangePct.toFixed(0)}%) vienen acompañando parejo, sin señal de apalancamiento excesivo`);
        }
        const fomcCheck = getFOMCWindow(24);
        if(fomcCheck.isNear){
          relato.push(fomcCheck.hoursUntil>0
            ? `Un detalle más para tener en cuenta: la Fed anuncia algo en ${fomcCheck.hoursUntil.toFixed(0)}hs, así que puede haber volatilidad extra fuera de lo puramente técnico`
            : `La Fed anunció hace ${Math.abs(fomcCheck.hoursUntil).toFixed(0)}hs, así que todavía puede haber volatilidad extra asentándose`);
        }
        const relatoCompleto = relato.join(' ');

        // Gráfico con los niveles marcados, antes del mensaje de texto con el detalle completo.
        const chartUrl = await buildChartUrl(data15.candles, entryPrice, setup.stop, setup.t1, setup.t2, thesis.dir, thesis.symbol);
        if(chartUrl){
          sendPromises.push(sendTelegramPhoto(chartUrl, `📈 ${thesis.symbol}${thesis.tag||''} ${thesis.dir} — Score ${Math.max(result15.longScore,result15.shortScore).toFixed(1)}/10`));
        }

        sendPromises.push(sendTelegram(
          `📈 <b>$${thesis.symbol}${thesis.tag||''} — parece que va ${dirTxt}</b>\n\n` +
          relatoCompleto + '\n\n' +
          `${thesis.dir==='LONG'?'🟢':'🔴'} <b>${thesis.dir==='LONG'?'COMPRA':'VENTA'} · ${result15.confidence}/100 de confianza</b>\n` +
          `━━━━━━━━━━━━━━\n\n` +
          `📊 <b>Configuración de la operación</b>\n` +
          `📌 Entrada: <code>$${entryPrice.toFixed(6)}</code>\n` +
          `🛑 Stop: <code>$${setup.stop.toFixed(6)}</code>\n` +
          `🎯 TP1: <code>$${setup.t1.toFixed(6)}</code> (R:R ≈ ${rrTp1}:1)\n` +
          `🎯 TP2: <code>$${setup.t2.toFixed(6)}</code> (R:R ≈ ${rrTp2}:1)\n` +
          `🚀 TP Final: <code>$${setup.t3.toFixed(6)}</code> (R:R ≈ ${rrTp3}:1)\n\n` +
          `🛠️ Apalancamiento máx. ${setup.leverage} (aislado), arriesgando ${(riskPct*100).toFixed(1)}% del capital (${reason}). Al tocar TP1 se toma el 50% y el stop pasa al punto de entrada — el resto corre hacia TP2/TP3.\n` +
          `❌ Esto se cae si: ${invalidacion}\n\n` +
          `━━━━━━━━━━━━━━\n` +
          `💰 Capital de la cuenta: ${acc.capital.toFixed(2)} USDT (cuenta #${acc.id})\n\n` +
          `⚠️ Solo con fines educativos. DYOR y gestioná tu riesgo. 🛡️`
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
    // Migración defensiva para el nuevo esquema de 3 tramos (40/40/20): tesis confirmadas antes de
    // este cambio no tienen `originalUnits` ni `tp3` — se las trata como si el 100% restante fuera
    // "original" desde este momento, y si no tienen tp3, se cierran en 2 tramos como antes (sin romper
    // operaciones que ya estaban en curso).
    if(thesis.originalUnits==null) thesis.originalUnits = thesis.units;

    const sinceTs = thesis.lastCheckedAt || thesis.confirmedAt || thesis.detectedAt;
    const range = await fetchPriceRange(thesis.symbol, sinceTs);
    const price = range?.last ?? null;

    if(price==null){
      thesis.priceFailCount = (thesis.priceFailCount||0) + 1;
      console.log(`⚠️ No se pudo obtener precio de ${thesis.symbol} (falla #${thesis.priceFailCount} seguida).`);
      if(thesis.priceFailCount===3){ // se cuenta por corridas fallidas seguidas, no por horas — se adapta solo aunque la cadencia real de GitHub sea irregular
        sendPromises.push(sendTelegram(`⚠️ <b>TheHaton no puede leer el precio de ${thesis.symbol}${thesis.tag||''} hace 3 corridas seguidas.</b>\nLa posición sigue abierta pero no se puede chequear TP/SL. Revisá si el símbolo sigue existiendo en su fuente original (${thesis.source}).`));
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

    // Etapa 1: todavía no tomó ninguna ganancia parcial -> vigila Stop y TP1 (con el rango real, no solo el precio actual)
    if(!thesis.partialTaken){
      let hitTP1=false, hitSL=false;
      if(thesis.dir==='LONG'){ if(range.low<=thesis.stop) hitSL=true; else if(range.high>=thesis.tp1) hitTP1=true; }
      else { if(range.high>=thesis.stop) hitSL=true; else if(range.low<=thesis.tp1) hitTP1=true; }

      if(hitTP1){
        // 40% en TP1 (no 50% como antes) — deja más corriendo para TP2 y TP3, que ahora sí se usan.
        const exitUnits = thesis.originalUnits*0.4;
        const pnl = exitUnits * (thesis.tp1-thesis.entry) * (thesis.dir==='LONG'?1:-1);
        acc.capital = +(acc.capital+pnl).toFixed(4);
        thesis.units = thesis.units - exitUnits; // queda el 60% corriendo
        thesis.partialTaken = true;
        thesis.stop = thesis.entry; // mueve el stop al punto de entrada (breakeven)
        journal(thesis, `TP1 alcanzado ($${thesis.tp1.toFixed(6)}). Se tomó el 40% de la ganancia (+${pnl.toFixed(2)} USDT) y se movió el Stop al punto de entrada. El 60% restante sigue corriendo hacia TP2 ($${thesis.tp2.toFixed(6)}) y TP3 ($${thesis.tp3?.toFixed?.(6)??'—'}).`);
        thesis.partialPnl = pnl;
        sendPromises.push(sendTelegram(
          (isReconciliation ? `🔎 <b>Auditoría/conciliación:</b> se detectó que esto ya había pasado y no estaba reflejado. Corrigiendo:\n\n` : '') +
          `💰 <b>TheHaton tomó 40% de ganancia — ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
          `TP1 alcanzado: $${thesis.tp1.toFixed(6)} (+${pnl.toFixed(2)} USDT realizados)\n` +
          `Stop movido a breakeven ($${thesis.entry.toFixed(6)}): el resto ya no puede terminar en pérdida.\n` +
          `El 60% restante sigue corriendo hacia TP2 (40%) y TP3 (20%).\nCapital: ${acc.capital.toFixed(2)} USDT`
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

    // Etapa 2: ya tomó el 40% en TP1 -> vigila TP2 (otro 40%) o vuelta a breakeven (con el rango real)
    if(!thesis.secondPartialTaken){
      let hitTP2=false, hitBE=false;
      if(thesis.dir==='LONG'){ if(range.low<=thesis.stop) hitBE=true; else if(range.high>=thesis.tp2) hitTP2=true; }
      else { if(range.high>=thesis.stop) hitBE=true; else if(range.low<=thesis.tp2) hitTP2=true; }

      if(hitBE){
        // Sin tp3 (tesis viejas migradas) o sin TP2 tocado -> se cierra todo el resto acá, como antes.
        const pnl = thesis.units * (thesis.stop-thesis.entry) * (thesis.dir==='LONG'?1:-1);
        acc.capital = +(acc.capital+pnl).toFixed(4);
        const totalPnl = (thesis.partialPnl||0) + pnl;
        journal(thesis, `Volvió a breakeven: se cierra el resto (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT). Resultado total de la operación: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT. Capital: ${acc.capital.toFixed(2)}.`);
        acc.closedTrades.push({...thesis, exit:thesis.stop, result: totalPnl>=0?'win':'loss', pnl:+totalPnl.toFixed(4), closedAt: Date.now()});
        sendPromises.push(sendTelegram(
          (isReconciliation ? `🔎 <b>Auditoría/conciliación:</b> se detectó que esto ya había pasado y no estaba reflejado. Corrigiendo:\n\n` : '') +
          `⚖️ <b>TheHaton cerró el resto de ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
          `Volvió al punto de entrada (breakeven en lo que quedaba)\n` +
          `Resultado total de la operación: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT\nCapital actual: ${acc.capital.toFixed(2)} USDT`
        ));
        sendPromises.push(sendPushToAll(`⚖️ Breakeven: ${thesis.symbol}`, `Total: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT`));
        continue;
      }
      if(hitTP2 && thesis.tp3!=null){
        // Con TP3 disponible: 40% más acá, queda 20% corriendo hacia TP3.
        const exitUnits = thesis.originalUnits*0.4;
        const pnl = exitUnits * (thesis.tp2-thesis.entry) * (thesis.dir==='LONG'?1:-1);
        acc.capital = +(acc.capital+pnl).toFixed(4);
        thesis.units = thesis.units - exitUnits;
        thesis.secondPartialTaken = true;
        thesis.partialPnl = (thesis.partialPnl||0) + pnl;
        journal(thesis, `TP2 alcanzado ($${thesis.tp2.toFixed(6)}). Se tomó otro 40% (+${pnl.toFixed(2)} USDT). El 20% final sigue corriendo hacia TP3 ($${thesis.tp3.toFixed(6)}).`);
        sendPromises.push(sendTelegram(
          `💰 <b>TheHaton tomó otro 40% — ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
          `TP2 alcanzado: $${thesis.tp2.toFixed(6)} (+${pnl.toFixed(2)} USDT realizados)\n` +
          `El 20% final sigue corriendo hacia TP3 ($${thesis.tp3.toFixed(6)}).\nCapital: ${acc.capital.toFixed(2)} USDT`
        ));
        sendPromises.push(sendPushToAll(`💰 TP2 alcanzado: ${thesis.symbol}`, `+${pnl.toFixed(2)} USDT · 20% corriendo a TP3`));
        stillOpen.push(thesis);
        continue;
      }
      if(hitTP2){
        // Sin tp3 (tesis vieja migrada) -> se cierra todo acá, como en el esquema de 2 tramos de antes.
        const pnl = thesis.units * (thesis.tp2-thesis.entry) * (thesis.dir==='LONG'?1:-1);
        acc.capital = +(acc.capital+pnl).toFixed(4);
        const totalPnl = (thesis.partialPnl||0) + pnl;
        journal(thesis, `TP2 alcanzado: se cierra el resto (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT). Resultado total: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT. Capital: ${acc.capital.toFixed(2)}.`);
        acc.closedTrades.push({...thesis, exit:thesis.tp2, result: totalPnl>=0?'win':'loss', pnl:+totalPnl.toFixed(4), closedAt: Date.now()});
        sendPromises.push(sendTelegram(
          `🚀 <b>TheHaton cerró el resto de ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\nTP2 alcanzado ✅\nResultado total: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT\nCapital actual: ${acc.capital.toFixed(2)} USDT`
        ));
        sendPromises.push(sendPushToAll(`🚀 TP2 (cierre total): ${thesis.symbol}`, `Total: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT`));
        continue;
      }
      stillOpen.push(thesis);
      continue;
    }

    // Etapa 3: ya tomó 40%+40% -> el 20% final corre hacia TP3, o vuelve a breakeven.
    let hitTP3=false, hitBE3=false;
    if(thesis.dir==='LONG'){ if(range.low<=thesis.stop) hitBE3=true; else if(range.high>=thesis.tp3) hitTP3=true; }
    else { if(range.high>=thesis.stop) hitBE3=true; else if(range.low<=thesis.tp3) hitTP3=true; }

    if(hitTP3 || hitBE3){
      const exit = hitTP3 ? thesis.tp3 : thesis.stop;
      const pnl = thesis.units * (exit-thesis.entry) * (thesis.dir==='LONG'?1:-1);
      acc.capital = +(acc.capital+pnl).toFixed(4);
      const totalPnl = (thesis.partialPnl||0) + pnl;
      journal(thesis, `${hitTP3?'TP3 alcanzado (objetivo final)':'Volvió a breakeven'}: se cierra el 20% final (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT). Resultado total de la operación: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT. Capital: ${acc.capital.toFixed(2)}.`);
      acc.closedTrades.push({...thesis, exit, result: totalPnl>=0?'win':'loss', pnl:+totalPnl.toFixed(4), closedAt: Date.now()});
      sendPromises.push(sendTelegram(
        (isReconciliation ? `🔎 <b>Auditoría/conciliación:</b> se detectó que esto ya había pasado y no estaba reflejado. Corrigiendo:\n\n` : '') +
        `${hitTP3?'🎯':'⚖️'} <b>TheHaton cerró el resto de ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
        `${hitTP3?'TP3 alcanzado ✅ (objetivo final)':'Volvió al punto de entrada (breakeven en el tramo final)'}\n` +
        `Resultado total de la operación: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT\nCapital actual: ${acc.capital.toFixed(2)} USDT`
      ));
      sendPromises.push(sendPushToAll(`${hitTP3?'🎯':'⚖️'} Cierre final: ${thesis.symbol}`, `Total: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT`));
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
