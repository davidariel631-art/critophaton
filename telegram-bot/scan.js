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
  fetchOpenInterestTrend, fetchFundingTrend, fetchCapitalFlowContext, fetchBTCReference, fetchUnlockRisk, fetchUsdStrength,
  confluenceScore15m, fetchFearGreedIndex, getFOMCWindow, getHighImpactMacroWindow, fetchTopTraderRatio, fetchSpotFuturesFlow, computeLiquidityProfile, rsi, stochasticOscillator, macd, adx,
  computeScore, buildSetup, buildAnalystMode, computeGodPerformance, detectSFP, ema, detectVolumeSpike, detectDivergencia, detectTrianguloCompresion, analizarRupturaCompresion, detectIFVG, detectActividadAnomala, verificarDatosSanos, analizarCorrelacion, detectZonasOfertaDemanda, detectNivelesEstructurales, computeVolumeProbability, detectLiquidezPorHorizonte, detectMarketPhase, explicarAnalisis, buscarTesisParecidas, postMortem
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
      const mc = { oiTrend: oiTrendData?.trend||null, fundingTrend: fundingTrendData?.trend||null, capitalFlow, usdStrength: await fetchUsdStrength().catch(()=>null) };
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

    const lecturaLiqWS = lecturaDeLiquidez(results['4h'].rawData?.candles || [], results['4h'].structure, results['4h'].recommendation);
    const DIVW = '━━━━━━━━━━━━━━━━━━━━';
    sendPromises.push(sendTelegram(
      `${label} — <b>BTC/USDT</b>\n` +
      `${DIVW}\n` +
      `💰 Precio: <code>$${price.toFixed(0)}</code>\n` +
      `📊 Sesgo: <b>${lean}</b>\n` +
      `<i>${contexto}</i>\n\n` +

      `${DIVW}\n📊 <b>MULTI-TIMEFRAME</b>\n` +
      `1h → ${results['1h'].recommendation}\n` +
      `4h → ${results['4h'].recommendation}\n` +
      `1D → ${results['1d'].recommendation}\n\n` +

      `${DIVW}\n📍 <b>NIVELES</b>\n` +
      `Soporte: <code>$${(m4h.support||0).toFixed(0)}</code>\n` +
      `Resistencia: <code>$${(m4h.resistance||0).toFixed(0)}</code>\n` +
      `Liquidez arriba: ${eqHighsTxt}\n` +
      `Liquidez abajo: ${eqLowsTxt}\n` +
      `⚖️ Long/Short (top traders): ${ratioTxt}\n\n` +

      (lecturaLiqWS ? `${DIVW}\n${lecturaLiqWS.texto}\n\n` : '') +

      `${DIVW}\n📌 <b>TESIS</b>\n${tesis}\n\n` +
      `${parrafo}\n\n` +
      `⚠️ Pulso informativo del mercado, no es una señal de entrada.`
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

// ═══════════════════════════════════════════════════════════════════════
// LECTURA DE LIQUIDEZ INTERPRETADA
// No alcanza con mostrar los números de liquidez: hay que decir qué es PROBABLE que haga el precio.
// Combina la liquidez cercana (equal highs/lows, con cantidad de toques como medida de fuerza),
// el POC del perfil de volumen, y el Estocástico — porque el mismo nivel de liquidez significa algo
// distinto según si el momentum tiene espacio o ya está agotado.
// ═══════════════════════════════════════════════════════════════════════
function lecturaDeLiquidez(candles, estructura, dirTesis){
  try{
    const precio = candles.at(-1).c;
    const liq = detectLiquidezPorHorizonte(candles);
    const perfil = computeLiquidityProfile(candles, precio, 200);
    const st = stochasticOscillator(candles);
    const k = st.k.at(-1);

    if(!liq && !perfil) return null;

    const lineas = [];
    const fuerzaTxt = t => t>=4 ? 'fuerte' : t>=3 ? 'media' : 'débil';

    // 1 y 2: liquidez más cercana arriba y abajo, con su fuerza
    const arriba = liq?.cercanaArriba || liq?.lejanaArriba;
    const abajo  = liq?.cercanaAbajo  || liq?.lejanaAbajo;
    if(arriba) lineas.push(`• Más cercana arriba: <code>$${arriba.precio.toFixed(6)}</code> (${arriba.distPct.toFixed(1)}%) — ${fuerzaTxt(arriba.toques)} (${arriba.toques} toques)${arriba.consumida?' · ya barrida':''}`);
    if(abajo)  lineas.push(`• Más cercana abajo: <code>$${abajo.precio.toFixed(6)}</code> (${abajo.distPct.toFixed(1)}%) — ${fuerzaTxt(abajo.toques)} (${abajo.toques} toques)${abajo.consumida?' · ya barrida':''}`);

    // 3: cuál es la más fuerte
    let ladoFuerte = null;
    if(arriba && abajo){
      ladoFuerte = arriba.toques > abajo.toques ? 'arriba' : abajo.toques > arriba.toques ? 'abajo' : 'pareja';
      lineas.push(`• Liquidez más fuerte: <b>${ladoFuerte==='pareja'?'pareja de los dos lados':ladoFuerte}</b>`);
    } else if(arriba){ ladoFuerte='arriba'; lineas.push('• Liquidez más fuerte: <b>arriba</b> (abajo no hay nivel claro)'); }
    else if(abajo){ ladoFuerte='abajo'; lineas.push('• Liquidez más fuerte: <b>abajo</b> (arriba no hay nivel claro)'); }

    if(perfil?.poc) lineas.push(`• POC (mayor volumen): <code>$${perfil.poc.toFixed(6)}</code>`);

    // Estado del Estocástico
    let estadoStoch = 'sin datos';
    if(k!=null) estadoStoch = k>=80 ? 'sobrecomprado' : k<=20 ? 'sobrevendido' : k>=60 ? 'alto, con poco espacio' : k<=40 ? 'bajo, con espacio' : 'neutral';

    // 4: QUÉ ES PROBABLE QUE HAGA EL PRECIO
    // Acá está el valor: el mismo nivel significa algo distinto según el momentum.
    const interpretacion = [];
    if(k!=null){
      const cercaArriba = arriba && !arriba.consumida && arriba.distPct <= 2;
      const cercaAbajo  = abajo  && !abajo.consumida  && abajo.distPct  <= 2;

      if(cercaArriba && k >= 70){
        interpretacion.push(`Hay liquidez a solo ${arriba.distPct.toFixed(1)}% arriba y el Estocástico está en ${k.toFixed(0)} (agotado). Lo más probable es que el precio vaya a buscar esa liquidez y después se dé vuelta — sería un barrido, no una continuación.`);
      } else if(cercaAbajo && k <= 30){
        interpretacion.push(`Hay liquidez a solo ${abajo.distPct.toFixed(1)}% abajo y el Estocástico está en ${k.toFixed(0)} (agotado a la baja). Lo más probable es que el precio vaya a buscar esa liquidez y después rebote.`);
      } else if(cercaArriba && k < 60){
        interpretacion.push(`Hay liquidez a ${arriba.distPct.toFixed(1)}% arriba y el Estocástico en ${k.toFixed(0)} todavía tiene recorrido. Hay espacio real para que el precio llegue hasta esa zona.`);
      } else if(cercaAbajo && k > 40){
        interpretacion.push(`Hay liquidez a ${abajo.distPct.toFixed(1)}% abajo y el Estocástico en ${k.toFixed(0)} tiene espacio para bajar. Hay recorrido hacia esa zona.`);
      } else if(ladoFuerte && ladoFuerte!=='pareja'){
        const obj = ladoFuerte==='arriba' ? arriba : abajo;
        interpretacion.push(`La liquidez más fuerte está ${ladoFuerte}, a ${obj.distPct.toFixed(1)}%, con el Estocástico en ${k.toFixed(0)}. Ese es el imán principal del precio por ahora.`);
      }

      // Advertencia si la liquidez fuerte va en contra de la tesis
      if(dirTesis && ladoFuerte && ladoFuerte!=='pareja'){
        const enContra = (dirTesis==='LONG' && ladoFuerte==='abajo') || (dirTesis==='SHORT' && ladoFuerte==='arriba');
        if(enContra) interpretacion.push(`⚠️ Ojo: la liquidez más fuerte está ${ladoFuerte}, o sea en contra de esta operación. El precio puede ir a buscarla primero antes de girar a favor.`);
      }
    }

    return {
      lineas, estadoStoch, k,
      interpretacion: interpretacion.join(' '),
      ladoFuerte,
      texto: `💧 <b>LECTURA DE LIQUIDEZ</b>\n${lineas.join('\n')}\n\n📊 Estocástico: <b>${estadoStoch}</b>${k!=null?` (${k.toFixed(0)})`:''}\n\n🧠 <i>${interpretacion.join(' ') || 'Sin una lectura clara todavía: no hay niveles de liquidez suficientemente definidos cerca del precio.'}</i>`,
    };
  }catch(e){ return null; }
}

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
async function buildChartUrl(candles, entry, stop, tp1, tp2, dir, symbol, extras){
  try{
    const N = 60; // más velas que antes (40) para que se vea el contexto
    const recent = candles.slice(-N);
    const closes = recent.map(c=>c.c);
    const closesFull = candles.map(c=>c.c);

    // Velas japonesas de verdad, en vez de una línea
    const ohlc = recent.map((c,i)=>({ x:i, o:c.o, h:c.h, l:c.l, c:c.c }));

    // Medias móviles: se calculan con TODO el histórico y después se recortan, para que los
    // primeros valores no salgan distorsionados por falta de datos previos.
    const cortar = arr => arr.slice(-N);
    const e20 = cortar(ema(closesFull, 20));
    const e50 = cortar(ema(closesFull, 50));
    const e200 = cortar(ema(closesFull, 200));

    const esLong = dir === 'LONG';
    const anotaciones = [];

    // --- Zonas de oferta/demanda: las "cajas" donde el precio suele reaccionar ---
    const zonas = extras?.zonas;
    if(zonas){
      zonas.oferta?.forEach(z => anotaciones.push({
        type:'box', xScaleID:'x-axis-0', yScaleID:'y-axis-0',
        yMin:z.piso, yMax:z.techo,
        backgroundColor:'rgba(239,68,68,0.13)', borderColor:'rgba(239,68,68,0.45)', borderWidth:1,
      }));
      zonas.demanda?.forEach(z => anotaciones.push({
        type:'box', xScaleID:'x-axis-0', yScaleID:'y-axis-0',
        yMin:z.piso, yMax:z.techo,
        backgroundColor:'rgba(16,185,129,0.13)', borderColor:'rgba(16,185,129,0.45)', borderWidth:1,
      }));
    }

    // --- Máximo y mínimo estructurales importantes (donde está la liquidez acumulada) ---
    const niveles = extras?.niveles;
    if(niveles?.maxImportante){
      anotaciones.push({ type:'line', mode:'horizontal', scaleID:'y-axis-0', value:niveles.maxImportante.valor,
        borderColor:'rgba(255,255,255,0.35)', borderWidth:1, borderDash:[6,4],
        label:{ enabled:true, content:'Máx. clave', backgroundColor:'rgba(0,0,0,0.6)', fontColor:'#cfd6e0', fontSize:9, position:'right' } });
    }
    if(niveles?.minImportante){
      anotaciones.push({ type:'line', mode:'horizontal', scaleID:'y-axis-0', value:niveles.minImportante.valor,
        borderColor:'rgba(255,255,255,0.35)', borderWidth:1, borderDash:[6,4],
        label:{ enabled:true, content:'Mín. clave', backgroundColor:'rgba(0,0,0,0.6)', fontColor:'#cfd6e0', fontSize:9, position:'right' } });
    }

    // --- Niveles de la operación: etiquetas cortas y alternadas para que no se amontonen ---
    anotaciones.push(
      { type:'line', mode:'horizontal', scaleID:'y-axis-0', value:entry, borderColor:'#00d9ff', borderWidth:2,
        label:{ enabled:true, content:'ENTRADA', backgroundColor:'#00d9ff', fontColor:'#00131a', fontSize:10, position:'left' } },
      { type:'line', mode:'horizontal', scaleID:'y-axis-0', value:stop, borderColor:'#ef4444', borderWidth:2,
        label:{ enabled:true, content:'STOP', backgroundColor:'#ef4444', fontSize:10, position:'left' } },
      { type:'line', mode:'horizontal', scaleID:'y-axis-0', value:tp1, borderColor:'#10b981', borderWidth:2,
        label:{ enabled:true, content:'TP1', backgroundColor:'#10b981', fontSize:10, position:'right' } },
      { type:'line', mode:'horizontal', scaleID:'y-axis-0', value:tp2, borderColor:'#10b981', borderWidth:1, borderDash:[4,3],
        label:{ enabled:true, content:'TP2', backgroundColor:'#10b981', fontSize:10, position:'right' } },
    );

    // --- Triángulo de compresión, si lo hay ---
    const tri = extras?.triangulo;
    if(tri){
      anotaciones.push(
        { type:'line', mode:'horizontal', scaleID:'y-axis-0', value:tri.techo, borderColor:'rgba(250,204,21,0.6)', borderWidth:1, borderDash:[3,3] },
        { type:'line', mode:'horizontal', scaleID:'y-axis-0', value:tri.piso, borderColor:'rgba(250,204,21,0.6)', borderWidth:1, borderDash:[3,3] },
      );
    }

    // Línea central del índice de fuerza (la naranja de la sección Liquidez): marca el punto medio
    // del rango donde el precio reacciona más seguido.
    if(extras?.fuerza?.centerPrice){
      anotaciones.push({ type:'line', mode:'horizontal', scaleID:'y-axis-0', value:extras.fuerza.centerPrice,
        borderColor:'#f59e0b', borderWidth:1.5 });
    }

    // Zona dorada de Fibonacci (0,5–0,618): donde suelen frenar los retrocesos.
    const fibX = extras?.fib;
    if(fibX?.l500 && fibX?.l618){
      anotaciones.push({ type:'box', xScaleID:'x-axis-0', yScaleID:'y-axis-0',
        yMin: Math.min(fibX.l500, fibX.l618), yMax: Math.max(fibX.l500, fibX.l618),
        backgroundColor:'rgba(250,204,21,0.10)', borderColor:'rgba(250,204,21,0.4)', borderWidth:1 });
    }

    const config = {
      type:'candlestick',
      data:{
        datasets:[
          { label:symbol, data:ohlc, type:'candlestick',
            color:{ up:'#10b981', down:'#ef4444', unchanged:'#8b98a8' },
            borderColor:{ up:'#10b981', down:'#ef4444', unchanged:'#8b98a8' } },
          { label:'EMA20', data:e20.map((y,x)=>({x,y})), type:'line', fill:false, borderColor:'#facc15', borderWidth:1.2, pointRadius:0 },
          { label:'EMA50', data:e50.map((y,x)=>({x,y})), type:'line', fill:false, borderColor:'#60a5fa', borderWidth:1.4, pointRadius:0 },
          { label:'EMA200', data:e200.map((y,x)=>({x,y})), type:'line', fill:false, borderColor:'#c084fc', borderWidth:1.6, pointRadius:0 },
        ]
      },
      options:{
        title:{ display:true, text:`${symbol}  ·  ${esLong?'COMPRA':'VENTA'}`, fontColor:'#eef3f8', fontSize:16 },
        // Leyenda desactivada: ocupaba espacio arriba y las EMAs ya se distinguen por color.
        legend:{ display:false },
        scales:{
          xAxes:[{ type:'linear', gridLines:{ color:'rgba(255,255,255,0.04)' }, ticks:{ display:false } }],
          yAxes:[{ position:'right', gridLines:{ color:'rgba(255,255,255,0.04)' }, ticks:{ fontColor:'#8b98a8', fontSize:11 } }]
        },
        annotation:{ annotations: anotaciones }
      }
    };

    const res = await fetch('https://quickchart.io/chart/create', {
      method:'POST', headers:{'Content-Type':'application/json'},
      // Más grande que antes (era 700x450) para que se lea bien en el celular
      body: JSON.stringify({ width:1000, height:620, backgroundColor:'#000000', version:'2', chart: config })
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

async function sendPushToAll(title, body, url, grupo, symbol){
  if(!VAPID_PRIVATE_KEY) return; // sin la clave privada (secret de GitHub) no se puede firmar el push, se omite en silencio
  const subs = await fetchPushSubscribers();
  // Cada notificación lleva un tag ÚNICO para que Android no reemplace la anterior, y un grupo
  // para que las junte visualmente por tipo: señales, gestión de operaciones y cierres.
  const tag = `krax-${grupo||'general'}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  const payload = JSON.stringify({ title, body, url: url||'./index.html', tag, grupo: grupo||'general', symbol: symbol||null });
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

// ═══ TIMELINE DE LA TESIS ═══
// El diario guarda TODO lo que pasa (incluidos los "sigo esperando" repetidos cada 30 min, que
// terminan siendo decenas de entradas iguales). El timeline guarda solo los HITOS: detectada,
// confirmada, entrada, TP1, breakeven, cierre. Sirve para ver de un vistazo qué pasó con cada
// operación, y para después medir cuánto tarda cada etapa.
// ═══ CIERRE UNIFICADO ═══
// Hay 5 caminos distintos por los que una operación puede cerrarse, y tres de ellos NO guardaban
// pnlPct — o sea que el Research Center no podía analizarlas. Esta función garantiza que todos
// registren exactamente los mismos campos y disparen el post-mortem.
function cerrarOperacion(acc, thesis, exit, pnlUsd, motivo, sendPromises){
  // ═══ pnlPct CONTANDO LAS GANANCIAS PARCIALES ═══
  // BUG CORREGIDO (caso INX): antes solo comparaba el precio de salida final contra la entrada.
  // Si una operación alcanzaba TP1, tomaba el 40% con ganancia real, y después el resto cerraba
  // en breakeven, el cálculo daba 0% — ignorando la plata ya realizada.
  // Eso hacía que el post-mortem dijera "PERDIDA" sobre una operación que ganó, y que el Research
  // Center la contara como perdedora, ensuciando todas las estadísticas.
  // Ahora se usa el resultado REAL en dólares como referencia cuando existe.
  let pnlPct = null;
  if(thesis.entry && exit){
    const pctTramoFinal = (exit-thesis.entry)/thesis.entry*100*(thesis.dir==='LONG'?1:-1);
    if(thesis.partialTaken && Number.isFinite(pnlUsd) && thesis.originalUnits > 0){
      // Con toma parcial, el porcentaje se deriva del resultado real en dólares sobre el tamaño
      // original de la posición — así refleja lo que efectivamente entró a la cuenta.
      const valorPosicionOriginal = thesis.originalUnits * thesis.entry;
      pnlPct = valorPosicionOriginal > 0
        ? +(pnlUsd / valorPosicionOriginal * 100).toFixed(3)
        : +pctTramoFinal.toFixed(3);
    } else {
      pnlPct = +pctTramoFinal.toFixed(3);
    }
  }
  const cerrada = {
    ...thesis, exit,
    // Datos que el post-mortem necesita para no confundir "cerró en breakeven" con "perdió"
    alcanzoTp1: !!thesis.partialTaken,
    pnlPctTramoFinal: thesis.entry && exit
      ? +((exit-thesis.entry)/thesis.entry*100*(thesis.dir==='LONG'?1:-1)).toFixed(3) : null,
    result: pnlUsd>=0 ? 'win' : 'loss',
    pnl: +pnlUsd.toFixed(4),
    pnlUsd: +pnlUsd.toFixed(4),
    pnlPct,
    motivoCierre: motivo,
    closedAt: Date.now(),
  };
  acc.closedTrades.push(cerrada);
  // Post-mortem: qué esperaba, qué pasó, qué componente acertó. Solo con datos registrados.
  try{
    const pm = postMortem(cerrada, acc.closedTrades.slice(0,-1));
    if(pm?.texto && sendPromises) sendPromises.push(sendTelegram(`🔍 <b>POST-MORTEM</b>\n━━━━━━━━━━━━━━━━━━━━\n${pm.texto}`));
  }catch(e){ console.error('Error en post-mortem', thesis.symbol, e.message); }
  return cerrada;
}

function hito(thesis, etapa, detalle){
  if(!thesis.timeline) thesis.timeline = [];
  // No se repite el mismo hito dos veces (por ejemplo si una corrida se solapa con otra)
  if(thesis.timeline.some(h=>h.etapa===etapa)) return;
  thesis.timeline.push({ ts: Date.now(), etapa, detalle: detalle||'' });
}

// Arma el timeline en texto para mostrarlo en Telegram o en la web.
function timelineTexto(thesis){
  if(!thesis.timeline?.length) return '';
  const inicio = thesis.timeline[0].ts;
  return thesis.timeline.map(h=>{
    const min = Math.round((h.ts-inicio)/60000);
    const cuando = min===0 ? 'inicio' : min<60 ? `+${min}min` : `+${(min/60).toFixed(1)}hs`;
    return `${h.etapa} <i>(${cuando})</i>${h.detalle?` — ${h.detalle}`:''}`;
  }).join('\n');
}

// ═══ EVALUAR SEÑALES SOMBRA ═══
// Revisa las señales que se rechazaron por poco y comprueba qué habría pasado.
// Se evalúan 24 horas después de registrarlas, comparando contra el precio actual.
async function evaluarShadowSignals(state){
  const pendientes = (state.shadowSignals||[]).filter(s => !s.evaluada && (Date.now()-s.detectadaEn) > 24*3600*1000);
  if(!pendientes.length) return;
  console.log(`--- Evaluando ${pendientes.length} señal(es) sombra de hace 24hs ---`);

  for(const s of pendientes.slice(0, 12)){ // de a 12 por corrida, para no saturar las APIs
    try{
      const d = await fetchTokenData(s.symbol, '15m');
      if(!d?.candles?.length){ s.evaluada = true; s.resultado = 'sin datos'; continue; }
      // Se busca si tocó el TP1 o el stop en las velas posteriores
      const desde = d.candles.filter(v => v.t >= s.detectadaEn);
      if(desde.length < 4){ continue; } // todavía no hay suficientes velas, se reintenta después
      let tocoTp = false, tocoStop = false;
      for(const v of desde){
        if(s.dir === 'LONG'){
          if(v.l <= s.stop){ tocoStop = true; break; }
          if(v.h >= s.tp1){ tocoTp = true; break; }
        } else {
          if(v.h >= s.stop){ tocoStop = true; break; }
          if(v.l <= s.tp1){ tocoTp = true; break; }
        }
      }
      s.evaluada = true;
      s.resultado = tocoTp ? 'habría ganado' : tocoStop ? 'habría perdido' : 'sin definir';
      s.evaluadaEn = Date.now();
    }catch(e){ /* se reintenta en la próxima corrida */ }
    await new Promise(r=>setTimeout(r, 250));
  }

  // Resumen: ¿el umbral está bien puesto?
  const evaluadas = (state.shadowSignals||[]).filter(s => s.evaluada && ['habría ganado','habría perdido'].includes(s.resultado));
  if(evaluadas.length >= 10){
    const ganadoras = evaluadas.filter(s => s.resultado === 'habría ganado').length;
    const wr = (ganadoras/evaluadas.length*100).toFixed(1);
    console.log(`  → Señales sombra: ${evaluadas.length} evaluadas, ${wr}% habrían ganado.`);
    if(parseFloat(wr) >= 55) console.log(`     ⚠️ Las señales rechazadas por poco están ganando ${wr}%. El umbral de ${THRESHOLD} podría estar demasiado alto.`);
    else if(parseFloat(wr) <= 40) console.log(`     ✅ Solo ganan ${wr}%: el umbral está filtrando bien.`);
  }
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

      // ═══ SEÑALES SOMBRA ═══
      // Las que quedaron cerca del umbral pero no llegaron. Se registran con lo que hubiera sido
      // el setup, para después poder responder: "¿las que rechazamos por 0,2 puntos habrían ganado?".
      // Permite ajustar el umbral con evidencia, sin arriesgar plata.
      if(result.recommendation !== 'NO OPERAR' && best >= THRESHOLD - 0.8 && best < THRESHOLD){
        try{
          const setupSombra = buildSetup(data, result, 'balanced', null, (tag||'').includes('cap chico'));
          state.shadowSignals = state.shadowSignals || [];
          state.shadowSignals.push({
            symbol, tag: tag||'', dir: result.recommendation,
            score: +best.toFixed(2), faltaba: +(THRESHOLD - best).toFixed(2),
            confianza: result.confidence,
            precio: result.metrics.price,
            stop: setupSombra.stop, tp1: setupSombra.t1, tp2: setupSombra.t2,
            marketPhase: (()=>{ try{ return detectMarketPhase(data.candles)?.fase ?? null; }catch(e){ return null; } })(),
            detectadaEn: Date.now(),
            // Se evalúa sola más adelante, comparando contra el precio de ese momento
            evaluada: false, resultado: null,
          });
          // Se guardan las últimas 200 para no inflar el archivo de estado
          if(state.shadowSignals.length > 200) state.shadowSignals = state.shadowSignals.slice(-200);
          console.log(`  ${symbol}: señal sombra registrada (${best.toFixed(2)}, le faltaban ${(THRESHOLD-best).toFixed(2)} puntos).`);
        }catch(e){ /* si falla, no se interrumpe el escaneo */ }
      }

      if(best < THRESHOLD || result.recommendation === 'NO OPERAR') continue;

      // Filtro de sobre-extensión TAMBIÉN en la detección, no solo en la confirmación.
      // Si no está acá, una moneda que subió 500% igual aparece en el radar y manda mensaje —
      // pasó con BICO: subió +674% y el bot lo puso en radar recomendando LONG.
      {
        const v24 = data.candles.slice(-96); // 24hs en velas de 15m
        if(v24.length >= 40){
          const precioAhora = data.candles.at(-1).c;
          const minV = Math.min(...v24.map(c=>c.l));
          const maxV = Math.max(...v24.map(c=>c.h));
          const subio = (precioAhora-minV)/minV*100;
          const cayo = (maxV-precioAhora)/maxV*100;
          if(result.recommendation==='LONG' && subio >= 60){
            console.log(`  ${symbol}: descartado — ya subió ${subio.toFixed(0)}% en 24hs, no se recomienda comprar el techo.`);
            continue;
          }
          if(result.recommendation==='SHORT' && cayo >= 45){
            console.log(`  ${symbol}: descartado — ya cayó ${cayo.toFixed(0)}% en 24hs, no se recomienda vender el piso.`);
            continue;
          }
        }
      }

      const hour = argentinaHourNow();
      if(hour < WORK_HOUR_START || hour >= WORK_HOUR_END) continue;
      const today = todayKey();
      // Defensa: un estado guardado por una versión anterior puede no tener tradesToday, y sin
      // esta guarda la lectura de .date lanza un error que tira abajo el escaneo de esa moneda.
      if(!acc.tradesToday || acc.tradesToday.date !== today) acc.tradesToday = {date:today, count:0};
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
        hito(thesis, '🔭 Detectada', `score ${best.toFixed(1)}/10 en 4h`);
        thesis.score4h = +best.toFixed(1);
      acc.theses.push(thesis);

      // Mensaje de "en radar" — a propósito con formato bien distinto al de la SEÑAL confirmada
      // (más corto, sin la caja de "Configuración/Riesgo"), para que de un vistazo se note que
      // esto todavía NO es una entrada real, solo algo a seguir.
      const razonesDeteccion = result.committee.filter(c=>c.vote===result.recommendation).slice(0,3).map(c=>c.name.replace(/^[^\s]+\s/,'')).join(', ');
      const nivelClave = result.recommendation==='LONG' ? result.metrics.resistance : result.metrics.support;
      const nivelLabel = result.recommendation==='LONG' ? 'resistencia' : 'soporte';
      const lecturaLiqRadar = lecturaDeLiquidez(data.candles, result.structure, result.recommendation);
      const DIVR = '━━━━━━━━━━━━━━━━━━━━';
      const pctR = (v) => ((v-result.metrics.price)/result.metrics.price*100);
      sendPromises.push(sendTelegram(
        `🔭 <b>EN RADAR — $${symbol}${tag||''}</b>\n` +
        `${DIVR}\n` +
        `📊 Score: <b>${best.toFixed(1)}/10</b>\n` +
        `🎯 Confianza: <b>${result.confidence}%</b>\n` +
        `${result.recommendation==='LONG'?'📈':'📉'} Dirección probable: <b>${result.recommendation}</b>\n` +
        `🧩 Detectado por: ${razonesDeteccion || 'confluencia general del comité'}\n\n` +

        `${DIVR}\n⏳ <b>QUÉ TIENE QUE PASAR EN 15m</b>\n` +
        `Se confirma si:\n` +
        `1. Rompe <code>$${nivelClave?.toFixed(6)}</code> (${nivelLabel} en 4h) con volumen\n` +
        `2. Aparece un Bear/Bull Trap a favor\n` +
        `3. Confluencia fuerte (MACD + Estocástico + estructura)\n\n` +

        `${DIVR}\n📐 <b>SETUP ESTIMADO</b> <i>(puede cambiar)</i>\n` +
        `Entrada: <code>$${result.metrics.price.toFixed(6)}</code>\n` +
        `Stop: <code>$${theoSetup.stop.toFixed(6)}</code> (${pctR(theoSetup.stop).toFixed(2)}%)\n` +
        `TP1: <code>$${theoSetup.t1.toFixed(6)}</code> (${pctR(theoSetup.t1)>=0?'+':''}${pctR(theoSetup.t1).toFixed(2)}%)\n` +
        `TP2: <code>$${theoSetup.t2.toFixed(6)}</code> (${pctR(theoSetup.t2)>=0?'+':''}${pctR(theoSetup.t2).toFixed(2)}%)\n\n` +

        (lecturaLiqRadar ? `${DIVR}\n${lecturaLiqRadar.texto}\n\n` : '') +

        `${DIVR}\n⚠️ <b>Todavía NO es una entrada.</b> Te aviso si se confirma.`
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
  // Contabilidad de la fase: sin esto, una tesis que falla por un error de red vuelve a la lista
  // como si nada y nunca te enterás de que en realidad no se analizó.
  const _cuenta = { total: 0, analizadas: 0, fallidas: 0, expiradas: 0, confirmadas: 0, fallos: [] };
  for(const thesis of acc.theses){
    if(thesis.status !== 'WATCHING'){ stillWatching.push(thesis); continue; }
    _cuenta.total++;

    if(Date.now() > thesis.expiresAt){
      _cuenta.expiradas++;
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
      const marketContext15 = { oiTrend: oiTrendData?.trend||null, fundingTrend: fundingTrendData?.trend||null, capitalFlow, usdStrength: await fetchUsdStrength().catch(()=>null) };
      const result15 = computeScore(data15, macro, [], state.memory, marketContext15, btcReference);
      // priceNow se declara ACÁ, apenas existe result15. Antes estaba declarado ~170 líneas más
      // abajo pero se usaba mucho antes (en la entrada anticipada en zona y en el Fibonacci), lo
      // que en JavaScript lanza "Cannot access 'priceNow' before initialization" — la Temporal Dead
      // Zone de const. El catch de cada moneda lo capturaba y la dejaba en WATCHING, así que el
      // proceso no moría: simplemente NINGUNA tesis podía confirmar nunca. Eso explica los días
      // enteros sin abrir una sola operación.
      const priceNow = result15?.metrics?.price ?? data15?.price;
      if(!Number.isFinite(priceNow)) throw new Error(`Precio actual inválido para ${thesis.symbol}`);

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
      // data4h se carga acá arriba (antes se usaba sin estar definido y este camino crasheaba
      // siempre que la tesis era SHORT — bug que existía desde antes). También lo usan el filtro
      // de salud de momentum y buildSetup para calcular el stop con el marco mayor.
      let data4h = null;
      try{ data4h = await fetchTokenData(thesis.symbol, '4h'); }catch(e){ data4h = null; }
      if(thesis.dir==='SHORT' && data4h?.candles?.length){
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

      // ═══ ENTRADA ANTICIPADA EN LA ZONA (arregla el problema de entrar tarde) ═══
      // Los otros caminos exigen que el movimiento YA haya arrancado: BOS = la estructura ya se
      // rompió, pullback = ya rebotó, patrón completo = el trap ya se confirmó. Para cuando
      // confirman, buena parte del recorrido ya pasó.
      // Acá se entra EN la zona de reacción, sin esperar la vela de confirmación: el precio está
      // tocando una zona de oferta/demanda sin mitigar, o un nivel de liquidez sin barrer, y el
      // Estocástico acompaña. Es entrar donde el precio va a reaccionar, no después de que reaccionó.
      let entradaEnZona = false, zonaNota = '';
      {
        const zonasE = detectZonasOfertaDemanda(data15.candles);
        const liqE = detectLiquidezPorHorizonte(data15.candles);
        const kArrE = stochasticOscillator(data15.candles).k;
        const kE = kArrE.at(-1), kPe = kArrE.at(-2);

        if(kE!=null && kPe!=null){
          if(thesis.dir==='LONG'){
            // El precio entró en una zona de demanda sin mitigar
            const enDemanda = zonasE.demanda.find(z => priceNow <= z.techo*1.005 && priceNow >= z.piso*0.99);
            // O está tocando liquidez de abajo que todavía no fue barrida
            const liqAbajo = liqE?.cercanaAbajo;
            const tocandoLiq = liqAbajo && !liqAbajo.consumida && Math.abs(priceNow - liqAbajo.precio)/priceNow < 0.008;
            // El Estocástico no tiene que estar todavía subiendo — alcanza con que esté bajo y
            // dejando de caer, que es justo antes del giro.
            const estocBajoYFrenando = kE <= 40 && kE >= kPe;
            if((enDemanda || tocandoLiq) && estocBajoYFrenando){
              entradaEnZona = true;
              zonaNota = enDemanda
                ? `el precio entró en una zona de demanda sin mitigar ($${enDemanda.piso.toFixed(6)}–$${enDemanda.techo.toFixed(6)}) con el Estocástico en ${kE.toFixed(0)} dejando de caer`
                : `el precio está tocando liquidez sin barrer en $${liqAbajo.precio.toFixed(6)} (${liqAbajo.toques} toques) con el Estocástico en ${kE.toFixed(0)} frenando`;
            }
          } else {
            const enOferta = zonasE.oferta.find(z => priceNow >= z.piso*0.995 && priceNow <= z.techo*1.01);
            const liqArriba = liqE?.cercanaArriba;
            const tocandoLiq = liqArriba && !liqArriba.consumida && Math.abs(priceNow - liqArriba.precio)/priceNow < 0.008;
            const estocAltoYFrenando = kE >= 60 && kE <= kPe;
            if((enOferta || tocandoLiq) && estocAltoYFrenando){
              entradaEnZona = true;
              zonaNota = enOferta
                ? `el precio entró en una zona de oferta sin mitigar ($${enOferta.piso.toFixed(6)}–$${enOferta.techo.toFixed(6)}) con el Estocástico en ${kE.toFixed(0)} dejando de subir`
                : `el precio está tocando liquidez sin barrer en $${liqArriba.precio.toFixed(6)} (${liqArriba.toques} toques) con el Estocástico en ${kE.toFixed(0)} frenando`;
            }
          }
        }
      }

      // ENTRADA POR FIBONACCI EN LA MITAD DEL SWING, CONFIRMADA CON LIQUIDEZ.
      // La zona 0,5–0,618 es donde el precio suele frenar el retroceso y retomar la dirección del
      // swing. Sola no alcanza (cualquier precio pasa por ahí en algún momento), así que se exige
      // que además haya liquidez a favor: o el precio está tocando una zona de demanda/oferta sin
      // mitigar, o el índice de fuerza del volumen apunta al mismo lado.
      let fibConLiquidez = false, fibNota = '';
      {
        const fib = result15.structure?.fib;
        if(fib && fib.l500 && fib.l618){
          const zonaAlta = Math.max(fib.l500, fib.l618);
          const zonaBaja = Math.min(fib.l500, fib.l618);
          const enZonaDorada = priceNow >= zonaBaja && priceNow <= zonaAlta;
          if(enZonaDorada){
            // Liquidez a favor: zona de oferta/demanda sin mitigar tocando el precio
            const zonasFib = detectZonasOfertaDemanda(data15.candles);
            const enDemanda = zonasFib.demanda.some(z => priceNow >= z.piso*0.995 && priceNow <= z.techo*1.005);
            const enOferta = zonasFib.oferta.some(z => priceNow >= z.piso*0.995 && priceNow <= z.techo*1.005);
            // Índice de fuerza del volumen (la línea naranja de la sección Liquidez)
            const fuerza = computeVolumeProbability(data15.candles, 20);
            const fuerzaAFavor = fuerza && (thesis.dir==='LONG' ? fuerza.probUp >= 55 : fuerza.probDown >= 55);
            const liquidezAFavor = thesis.dir==='LONG' ? (enDemanda || fuerzaAFavor) : (enOferta || fuerzaAFavor);
            if(liquidezAFavor){
              fibConLiquidez = true;
              const motivo = thesis.dir==='LONG'
                ? (enDemanda ? 'sobre una zona de demanda sin mitigar' : `con la fuerza del volumen del lado comprador (${fuerza.probUp.toFixed(0)}%)`)
                : (enOferta ? 'sobre una zona de oferta sin mitigar' : `con la fuerza del volumen del lado vendedor (${fuerza.probDown.toFixed(0)}%)`);
              fibNota = `el precio retrocedió justo a la mitad del swing (zona Fibonacci 0,5–0,618, entre $${zonaBaja.toFixed(6)} y $${zonaAlta.toFixed(6)}) y llegó ahí ${motivo}`;
            }
          }
        }
      }

      // GATILLO PROFESIONAL DE ESTOCÁSTICO (uso de GRANMAGO y de la bibliografía clásica):
      // el bot históricamente usa el estocástico como FILTRO — bloquea cuando está en extremo.
      // El uso profesional es al revés: el extremo es la OPORTUNIDAD, siempre que venga acompañado
      // del cruce de K sobre D (o al revés). El extremo solo avisa que hay agotamiento; el cruce
      // confirma que el giro empezó. Sin cruce no hay entrada, con cruce sí.
      // Se agrega como camino ADICIONAL (no reemplaza a los otros) para no romper lo que ya funciona.
      let gatilloEstocastico = false;
      {
        const kArrG = stochasticOscillator(data15.candles).k;
        const dArrG = stochasticOscillator(data15.candles).d;
        const kG = kArrG.at(-1), kPg = kArrG.at(-2), dG = dArrG.at(-1), dPg = dArrG.at(-2);
        if(kG!=null && kPg!=null && dG!=null && dPg!=null){
          if(thesis.dir==='LONG'){
            // Venía de sobreventa (<=25) Y K cruzó hacia arriba sobre D
            gatilloEstocastico = kPg <= 25 && kPg <= dPg && kG > dG;
          } else {
            // Venía de sobrecompra (>=75) Y K cruzó hacia abajo bajo D
            gatilloEstocastico = kPg >= 75 && kPg >= dPg && kG < dG;
          }
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
      // Válvula de escape por tiempo: los filtros de CAUTELA (no los de bug real) se liberan
      // después de 8 horas. Sin esto, con 22 filtros encadenados podía pasar que ninguna tesis
      // confirmara nunca — pasó en la práctica: 5 días seguidos sin abrir una sola operación.
      const horasEsperando = (Date.now()-thesis.detectedAt)/3600000;
      const escapeValvulaTiempo = horasEsperando >= 8;

      let liquidityMagnetConfirmacion = false, htfNote = '';
      let momentumHealthOk = true, momentumHealthNote = '';
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

          // "¿Tiene tiempo/espacio real de subir (o bajar)?" — no alcanza con que el marco de entrada
          // (15m) se vea bien: si el Estocástico del marco MAYOR (4h/1D) ya está muy extendido, o el
          // MACD/ADX muestran que la fuerza se está yendo, es más probable que no llegue ni a TP1
          // antes de girar (exactamente lo que puede pasar si el precio primero va a buscar liquidez
          // cercana, como un cluster de Equal Highs/Lows fuerte, y ahí revierte).
          const problems = [];
          // BLOQUEO DURO por Estocástico 4h en extremo CONTRA la dirección de la tesis.
          // Antes esto era solo "un problema más" y hacían falta dos para frenar, con umbral 85.
          // El resultado era abrir LONGs con el Estocástico 4h arriba de 80 (caso real: OPEN a 80,59),
          // que es comprar justo donde el movimiento ya se agotó. Ahora alcanza por sí solo y el
          // umbral baja a 80/20, que es la definición clásica de sobrecompra/sobreventa.
          let stochHTFBloquea = false, stochHTFNota = '';
          if(data4h?.candles?.length>=20){
            const stoch4h = stochasticOscillator(data4h.candles).k.filter(v=>v!=null).at(-1);
            if(stoch4h!=null){
              if(thesis.dir==='LONG' && stoch4h>=80){
                stochHTFBloquea = true;
                stochHTFNota = `Estocástico 4h en ${stoch4h.toFixed(0)} (sobrecompra) — abrir un LONG acá es comprar en el techo del movimiento`;
              }
              if(thesis.dir==='SHORT' && stoch4h<=20){
                stochHTFBloquea = true;
                stochHTFNota = `Estocástico 4h en ${stoch4h.toFixed(0)} (sobreventa) — abrir un SHORT acá es vender en el piso del movimiento`;
              }
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
          if(stochHTFBloquea){
            momentumHealthOk = false;
            momentumHealthNote = stochHTFNota + '.';
          } else if(problems.length>=2){ // el resto de señales sí exige 2, para no ser demasiado estricto
            momentumHealthOk = false;
            momentumHealthNote = problems.join('; ') + '.';
          }
        }
      }catch(e){ /* si falla, simplemente no aporta este camino, no rompe el resto */ }

      // La válvula de escape NO aplica cuando el bloqueo es por Estocástico en extremo.
      // Motivo: puse la válvula para destrabar el bot cuando no abría operaciones, pero la causa
      // real de eso era el bug de priceNow, no los filtros. Y comprar con el Estocástico en 97 no
      // se vuelve buena idea porque pasaron 8 horas — el agotamiento sigue estando.
      // Caso real que lo motivó: LISTA confirmó un LONG con el Estocástico en 97 porque la tesis
      // llevaba más de 8hs esperando y la válvula desactivó el bloqueo.
      const bloqueoEsPorExtremo = momentumHealthNote.includes('sobrecompra') || momentumHealthNote.includes('sobreventa');
      if(!momentumHealthOk && (bloqueoEsPorExtremo || !escapeValvulaTiempo)){
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
      // ═══ PROTECCIÓN DEL MOTOR ═══
      // Antes que cualquier otro filtro: si los datos no tienen sentido, no se opera.
      // Un precio absurdo o desactualizado produce señales bien formadas pero equivocadas.
      const sanidad = verificarDatosSanos(data15);
      if(!sanidad.sano){
        journal(thesis, `🛑 No se opera por protección del motor: ${sanidad.problemas.join(' ')}`);
        stillWatching.push(thesis);
        continue;
      }

      // ═══ RIESGO DE CORRELACIÓN ═══
      // Cinco LONG en cinco altcoins no son cinco apuestas independientes.
      // Solo bloquea si el riesgo es alto Y la operación va en la MISMA dirección que la mayoría.
      // Antes bloqueaba cualquier tesis con riesgo alto, y como el riesgo siempre daba alto, el bot
      // quedaba paralizado: en una corrida real bloqueó 22 de 25 tesis.
      // Una operación en dirección contraria a la mayoría en realidad REDUCE la correlación.
      const correl = analizarCorrelacion(acc.theses, { riesgoPorOperacion: 2, btcCambio24h: btcReference?.changePct ?? null });
      if(correl.nivel === 'alto'){
        const mayoria = correl.longs > correl.shorts ? 'LONG' : 'SHORT';
        const sumaAlRiesgo = thesis.dir === mayoria;
        if(sumaAlRiesgo){
          journal(thesis, `⚠️ Riesgo de correlación alto y esta operación es ${thesis.dir}, igual que la mayoría (${correl.longs} LONG / ${correl.shorts} SHORT). ${correl.alertas[0]} Se sigue observando para no concentrar más de un solo lado.`);
          stillWatching.push(thesis);
          continue;
        }
        // Si va al lado contrario, se deja pasar y solo se anota
        journal(thesis, `ℹ️ Hay riesgo de correlación, pero esta operación es ${thesis.dir} y la mayoría va ${mayoria}: en realidad ayuda a repartir el riesgo.`);
      }

      // ═══ FILTRO DE SOBRE-EXTENSIÓN PARABÓLICA ═══
      // Caso real que lo motivó: BICO subió +675% desde la base y el bot recomendó LONG justo ahí.
      // Después cayó -19% en una vela. Comprar al final de una subida vertical es comprar el techo:
      // el movimiento ya se hizo y lo que queda es la corrección.
      // Se mide cuánto subió (o cayó) el precio desde la base del movimiento reciente.
      {
        const velas = data15.candles;
        const ventana = velas.slice(-96); // últimas 24hs en velas de 15m
        if(ventana.length >= 40){
          const minVentana = Math.min(...ventana.map(c=>c.l));
          const maxVentana = Math.max(...ventana.map(c=>c.h));
          const subidaPct = (priceNow - minVentana)/minVentana*100;
          const bajadaPct = (maxVentana - priceNow)/maxVentana*100;

          // LONG después de una subida enorme = comprar el techo
          if(thesis.dir==='LONG' && subidaPct >= 60){
            journal(thesis, `Confirmación descartada: el precio ya subió ${subidaPct.toFixed(0)}% desde el mínimo reciente ($${minVentana.toFixed(6)}). Comprar al final de un movimiento vertical es comprar el techo — lo que suele venir después es la corrección, no la continuación.`);
            stillWatching.push(thesis);
            continue;
          }
          // SHORT después de una caída enorme = vender el piso
          if(thesis.dir==='SHORT' && bajadaPct >= 45){
            journal(thesis, `Confirmación descartada: el precio ya cayó ${bajadaPct.toFixed(0)}% desde el máximo reciente ($${maxVentana.toFixed(6)}). Vender al final de una caída vertical es vender el piso — el riesgo de rebote es alto.`);
            stillWatching.push(thesis);
            continue;
          }
        }
      }

      const stochK = result15.metrics.lastStochK;
      const enRegimenDeTendencia = confluence.adxStrong; // ADX>=20, mismo umbral que ya usa el motor
      // El gatillo profesional busca EXACTAMENTE el extremo + cruce, así que este filtro no debe
      // vetarlo — si lo bloqueara, el camino nuevo nunca podría dispararse. Son dos lecturas
      // opuestas del mismo dato: el filtro dice "extremo = peligro", el gatillo dice "extremo +
      // cruce = oportunidad". El cruce confirmado es lo que decide cuál de las dos aplica.
      if(stochK!=null && !enRegimenDeTendencia && !gatilloEstocastico && !escapeValvulaTiempo && (stochK>=80 || stochK<=20)){
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
        if(dominanciaEnContra && !bosAFavor && !bearTrapConfirmacion && !escapeValvulaTiempo){
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
      // Diagnóstico: qué camino confirmó (o cuáles faltaron). Sin esto no hay forma de saber
      // cuál de los 12 caminos está haciendo el trabajo real y cuál nunca se activa.
      const _caminos = {
        BOS: bosAFavor, Confianza: confianzaSubio, Confluencia: confluenceAFavor,
        Trap: bearTrapConfirmacion, Pullback: pullbackConfirmacion, ImanLiq: liquidityMagnetConfirmacion,
        Patron: patronCompletoConfirmacion, MACDtemprano: macdEarlyAFavor, SFP: sfpConfirmacion,
        EMA50short: ema50ShortConfirmacion, GatilloStoch: gatilloEstocastico,
        Fibonacci: fibConLiquidez, EntradaZona: entradaEnZona,
      };
      const _activos = Object.entries(_caminos).filter(([,v])=>v).map(([k])=>k);
      console.log(`  [${thesis.symbol}] alineado:${alineado?'✅':'❌'} | caminos: ${_activos.length? _activos.join(', ') : 'ninguno'}`);

      if(alineado && (bosAFavor || confianzaSubio || confluenceAFavor || bearTrapConfirmacion || pullbackConfirmacion || liquidityMagnetConfirmacion || patronCompletoConfirmacion || macdEarlyAFavor || sfpConfirmacion || ema50ShortConfirmacion || gatilloEstocastico || fibConLiquidez || entradaEnZona)){
        // Las monedas de cap chico llevan el tag ' (cap chico)' — se les aplica stop ancho (10-15%)
        // y apalancamiento fijo 5x, porque se mueven mucho más que las grandes y un stop de 1-2%
        // lo toca el ruido normal antes de que la idea tenga chance.
        const esCapChico = (thesis.tag||'').includes('cap chico');
        const setup = buildSetup(data15, result15, 'balanced', data4h, esCapChico);
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
        // En cap chico el TP1 usa un múltiplo más chico (0,6R) para que sea alcanzable con el stop
        // ancho, así que el mínimo exigido baja a 0,5:1. La ganancia real viene de TP2 y TP3, que
        // sí conservan buena relación — TP1 acá cumple la función de asegurar parte de la posición.
        // ═══ R:R MÍNIMO REAL ═══
        // Antes cap chico exigía apenas 0,5:1 — o sea que se aceptaba arriesgar el doble de lo que
        // se buscaba. Eso venía del stop fijo del 10%, que obligaba a bajar el umbral para que algo
        // pasara. Con el stop ahora definido por la estructura, se puede exigir 1:1 de verdad.
        // Una señal con score 8 pero R:R de 0,6 sigue siendo una mala operación.
        const rrMinimo = esCapChico ? 1.0 : 1.5;

        // Stop demasiado ancho: si para que la tesis no quede invalidada hace falta arriesgar más
        // del 15%, la moneda directamente no entra. No se fuerza el stop a 15% "porque sí".
        const distStopPct = Math.abs(entryPrice - setup.stop)/entryPrice*100;
        if(distStopPct > 15){
          journal(thesis, `Confirmación descartada: para que la idea no quede invalidada haría falta un stop a ${distStopPct.toFixed(1)}% del precio. Más del 15% no entra — no se fuerza el stop a un número arbitrario, se descarta la operación.`);
          stillWatching.push(thesis);
          continue;
        }
        if(rrToTp1 < rrMinimo){
          journal(thesis, `Confirmación técnica presente pero R:R a TP1 es solo ${rrToTp1.toFixed(2)}:1 (mínimo exigido ${rrMinimo}:1). Se sigue observando en vez de forzar una entrada con mala relación riesgo/beneficio.`);
          stillWatching.push(thesis);
          continue;
        }
        // ═══ TP APUNTANDO A LA LIQUIDEZ REAL ═══
        // Los TP por múltiplos de R son un número matemático, no un lugar donde el precio realmente
        // vaya. La liquidez sí es un destino real: ahí están las órdenes que atraen al precio.
        // Se busca el nivel de liquidez más importante en la dirección de la operación y se usa
        // como objetivo, siempre que quede más cerca que el TP calculado (nunca más lejos).
        const liqObjetivo = detectLiquidezPorHorizonte(data15.candles);
        if(liqObjetivo){
          const candidatosTP = thesis.dir==='LONG'
            ? [liqObjetivo.cercanaArriba, liqObjetivo.lejanaArriba].filter(l => l && l.precio > entryPrice)
            : [liqObjetivo.cercanaAbajo, liqObjetivo.lejanaAbajo].filter(l => l && l.precio < entryPrice);
          if(candidatosTP.length){
            // El más importante = el que más toques tiene (más liquidez acumulada ahí)
            const objetivo = candidatosTP.reduce((a,b) => (b.toques||0) > (a.toques||0) ? b : a);
            const masCercaQueTP2 = thesis.dir==='LONG'
              ? (objetivo.precio < setup.t2 && objetivo.precio > setup.t1)
              : (objetivo.precio > setup.t2 && objetivo.precio < setup.t1);
            if(masCercaQueTP2){
              journal(thesis, `TP2 ajustado a $${objetivo.precio.toFixed(6)}: ahí hay liquidez acumulada (${objetivo.toques} toques previos), que es un objetivo real hacia donde el precio tiende a ir — más realista que el múltiplo de R calculado.`);
              setup.t2 = objetivo.precio;
            }
          }
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
        // Datos que necesita la Biblioteca de tesis para poder filtrar y comparar después.
        // ═══ REGISTRO COMPLETO PARA MEDIR DESPUÉS ═══
        // Se guarda TODO lo que influyó en esta decisión, para poder responder más adelante
        // preguntas como "¿el score 8+ acierta más que el 7.6?" o "¿cuánto aporta cada Dios?".
        // Sin este registro, cualquier ajuste de pesos sería adivinar de nuevo.
        thesis.score15m = +Math.max(result15.longScore, result15.shortScore).toFixed(1);

        thesis.score = thesis.score4h ?? thesis.score15m; // el score 'oficial' es el que creó la tesis
        thesis.confianza = result15.confidence;
        thesis.dataQuality = result15.dataQuality?.score ?? null;
        thesis.marketPhase = detectMarketPhase(data15.candles)?.fase ?? null;
        // Qué caminos confirmaron la entrada. Se declara ACÁ, antes del primer uso: estaba
        // declarado ~180 líneas más abajo y el hito de confirmación lo usaba antes, lo que
        // lanzaba "Cannot access 'setupsActivos' before initialization" y tiraba abajo toda la
        // confirmación de esa moneda. Mismo tipo de error que tuvo priceNow.
        const setupsActivos = [
          bosAFavor && 'BOS', confluenceAFavor && 'Confluencia', bearTrapConfirmacion && 'Bear/Bull Trap',
          pullbackConfirmacion && 'Pullback', liquidityMagnetConfirmacion && 'Imán de liquidez',
          patronCompletoConfirmacion && 'Patrón completo', gatilloEstocastico && 'Gatillo Estocástico',
          fibConLiquidez && 'Fibonacci', entradaEnZona && 'Entrada en zona', macdEarlyAFavor && 'MACD temprano',
        ].filter(Boolean).join(' + ') || 'Confluencia general';

        thesis.registro = {
          // Los 6 componentes con su aporte real al score
          componentes: (result15.explainEngine?.componentes||[]).map(cp=>({ n:cp.nombre, aporte:cp.aporte, senal:cp.senal })),
          ajusteCalidad: result15.explainEngine?.ajusteCalidad?.efectoEnScore ?? null,
          // Contexto
          estocastico: result15.metrics?.lastStochK ?? null,
          rsi: result15.metrics?.lastRSI ?? null,
          adx: (()=>{ try{ return adx(data15.candles); }catch(e){ return null; } })(),
          divergencia: result15.metrics?.divergencia?.tipo ?? null,
          triangulo: result15.metrics?.triangulo?.tipo ?? null,
          // Liquidez: si estaba a favor o en contra
          liquidezAFavor: (()=>{ try{
            const l = detectLiquidezPorHorizonte(data15.candles); if(!l) return null;
            const a = l.cercanaArriba, b = l.cercanaAbajo;
            if(!a || !b) return null;
            const fuerte = a.toques > b.toques ? 'arriba' : b.toques > a.toques ? 'abajo' : 'pareja';
            if(fuerte==='pareja') return 'pareja';
            return (thesis.dir==='LONG' && fuerte==='arriba') || (thesis.dir==='SHORT' && fuerte==='abajo') ? 'a favor' : 'en contra';
          }catch(e){ return null; } })(),
          fuerzaVolumen: (()=>{ try{ const f = computeVolumeProbability(data15.candles,20); return f ? +f.probUp.toFixed(0) : null; }catch(e){ return null; } })(),
          // Caminos que confirmaron
          caminos: setupsActivos,
          // Cuánto tardó desde la detección
          horasHastaConfirmar: +((Date.now()-thesis.detectedAt)/3600000).toFixed(1),
          // Si entró por válvula de escape (importante: son entradas de menor calidad)
          porValvulaEscape: horasEsperando >= 8,
          // ═══ DATOS DE GESTIÓN — para saber si 1R/1.6R/2.5R son los múltiplos correctos ═══
          // Sin esto no se puede responder: ¿las monedas chicas necesitan 3-9% de stop o 10-15%?
          // ¿los movimientos llegan a 2.5R o se quedan en 1.4R? Hoy esos números son una hipótesis.
          gestion: (()=>{
            const riesgo = Math.abs(entryPrice - setup.stop);
            if(riesgo <= 0) return null;
            return {
              stopPct: +(riesgo/entryPrice*100).toFixed(2),
              rTp1: +(Math.abs(setup.t1-entryPrice)/riesgo).toFixed(2),
              rTp2: +(Math.abs(setup.t2-entryPrice)/riesgo).toFixed(2),
              rTp3: +(Math.abs(setup.t3-entryPrice)/riesgo).toFixed(2),
              atrPct: result15.metrics?.lastATR!=null ? +(result15.metrics.lastATR/entryPrice*100).toFixed(2) : null,
              // Si el stop salió de un nivel estructural o del cálculo por ATR
              stopEstructural: setup.stopEstructural ?? null,
            };
          })(),
          // MFE/MAE: hasta dónde llegó a favor y en contra antes de cerrar. Se van actualizando
          // mientras la operación está abierta (en la fase de gestión).
          mfe: 0, mae: 0,
          // Señales estructurales que le dimos peso al score SIN medirlas. Registrarlas es la
          // única forma de saber después si aportan o si les dimos influencia por intuición.
          ifvg: (()=>{ try{ const l = detectIFVG(data15.candles); return l?.length ? l[0].rolNuevo : null; }catch(e){ return null; } })(),
          imbalance: (()=>{ try{
            const fv = result15.structure?.fvgs || [];
            if(!fv.length) return null;
            const dentro = fv.find(g => entryPrice >= g.bottom*0.998 && entryPrice <= g.top*1.002);
            return dentro ? `dentro de imbalance ${dentro.type}` : `imbalance ${fv[0].type} cerca`;
          }catch(e){ return null; } })(),
          rupturaTriangulo: (()=>{ try{
            const tri = detectTrianguloCompresion(data15.candles);
            if(!tri) return null;
            const rup = analizarRupturaCompresion(data15.candles, tri);
            return rup ? `${tri.tipo}/${rup.sesgo}` : tri.tipo;
          }catch(e){ return null; } })(),
          // Qué dioses votaron a favor en el momento de entrar
          actividadAnomala: (()=>{ try{
            const a = detectActividadAnomala(data15.candles, { funding: data15.funding!=null?data15.funding*100:null });
            return a?.hayAlgo ? { nivel:a.nivel, puntaje:a.puntaje, tipos:a.señales.map(s=>s.tipo) } : null;
          }catch(e){ return null; } })(),
          diosesAFavor: (result15.committee||[]).filter(g=>g.vote===thesis.dir).map(g=>g.name.replace(/^[^\s]+\s/,'')),
          // Cómo venían las operaciones parecidas ANTES de abrir esta (para comparar después)
          parecidasAlEntrar: (()=>{ try{
            const p = buscarTesisParecidas(acc.closedTrades||[], { dir: thesis.dir, tipoSetup: setupsActivos, score: thesis.score4h, tag: thesis.tag||'', symbol: thesis.symbol });
            return p?.encontradas ? { cantidad: p.encontradas, winRate: p.winRate } : null;
          }catch(e){ return null; } })(),
        };
        hito(thesis, '🟢 Confirmada', `por ${setupsActivos || 'confluencia'}`);
        hito(thesis, '🚀 Entrada', `$${entryPrice.toFixed(6)}`);
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
        if(!acc.tradesToday) acc.tradesToday = {date: todayKey(), count:0};
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

        // Liquidez cercana vs de mayor plazo: la cercana es la que el precio busca primero.
        const liqHor = detectLiquidezPorHorizonte(data15.candles);
        if(liqHor){
          const partes = [];
          const cA = liqHor.cercanaArriba, cB = liqHor.cercanaAbajo;
          if(cA) partes.push(`arriba a ${cA.distPct.toFixed(1)}% (${cA.toques} toques${cA.consumida ? ', YA BARRIDA' : ', sin barrer'})`);
          if(cB) partes.push(`abajo a ${cB.distPct.toFixed(1)}% (${cB.toques} toques${cB.consumida ? ', YA BARRIDA' : ', sin barrer'})`);
          if(partes.length){
            relato.push(`💧 Liquidez cercana: ${partes.join(' y ')}. La que todavía no fue barrida es la que el precio suele ir a buscar primero.`);
          }
          const lA = liqHor.lejanaArriba, lB = liqHor.lejanaAbajo;
          if(lA || lB){
            const pl = [];
            if(lA) pl.push(`arriba a ${lA.distPct.toFixed(1)}%`);
            if(lB) pl.push(`abajo a ${lB.distPct.toFixed(1)}%`);
            relato.push(`🌊 Después, la liquidez de mayor plazo está ${pl.join(' y ')} — ese es el objetivo más grande una vez que se consume la cercana.`);
          }
        }

        // Actividad anómala: detecta que algo raro está pasando, sin identificar quién.
        // No reemplaza a Arkham (eso es de pago) pero sí deja ver las huellas de alguien grande.
        const anomalo = detectActividadAnomala(data15.candles, {
          funding: data15.funding != null ? data15.funding*100 : null,
          oiCambioPct: marketContext15?.oiTrend === 'RISING' ? 15 : marketContext15?.oiTrend === 'FALLING' ? -15 : null,
        });
        if(anomalo?.hayAlgo){
          relato.push(`${anomalo.nivel==='MUY ALTA'?'🚨':'⚠️'} <b>Actividad inusual (${anomalo.nivel.toLowerCase()})</b>: ${anomalo.detalle}`);
        }

        // Índice de fuerza del volumen — es la misma línea naranja que ya se dibuja en la sección
        // Liquidez de la web: mide qué porcentaje del volumen reciente vino de velas alcistas vs
        // bajistas. La línea central marca el punto medio del rango donde el precio suele reaccionar.
        const fuerzaVol = computeVolumeProbability(data15.candles, 20);
        if(fuerzaVol){
          const dominante = fuerzaVol.probUp >= fuerzaVol.probDown ? 'compradora' : 'vendedora';
          const pct = Math.max(fuerzaVol.probUp, fuerzaVol.probDown);
          const aFavor = (thesis.dir==='LONG' && fuerzaVol.probUp > fuerzaVol.probDown) || (thesis.dir==='SHORT' && fuerzaVol.probDown > fuerzaVol.probUp);
          relato.push(`⚡ Índice de fuerza: el ${pct.toFixed(0)}% del volumen reciente es de presión ${dominante}${aFavor ? ', o sea a favor de esta operación' : ', que va en contra de esta operación'}. La línea central del rango está en $${fuerzaVol.centerPrice.toFixed(6)} — ahí es donde el precio suele reaccionar más seguido.`);
        }

        // Modo reversión / lateral: explica por qué se opera contra la tendencia aparente.
        if(result15.reversionNota) relato.push(result15.reversionNota);

        // Entrada anticipada en zona: se entra donde el precio va a reaccionar, no después.
        if(entradaEnZona && zonaNota){
          relato.push(`🎯 Entrada anticipada: ${zonaNota}. En vez de esperar la vela de confirmación (que llega cuando parte del movimiento ya pasó), se entra en la zona donde el precio debería reaccionar.`);
        }

        // Fibonacci: si la entrada salió de la zona 0,5–0,618 confirmada con liquidez, se explica.
        if(fibConLiquidez && fibNota){
          relato.push(`📐 Sobre el Fibonacci: ${fibNota}. Esa es la zona donde los retrocesos suelen frenar y el precio retoma la dirección del swing.`);
        }
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
        // Se mira dónde está el nivel DE VERDAD respecto al precio. Antes se asumía que eqHighs
        // estaba siempre arriba y eqLows siempre abajo, pero si el precio ya superó ese nivel queda
        // del otro lado — y el mensaje decía "arriba" sobre un nivel que estaba abajo (pasó real en
        // LISTA y CROSS: el bot informaba liquidez "arriba, a 0,6%" cuando el número era menor que
        // la entrada). Eso confunde la lectura y hace que el nivel no se tenga en cuenta como debe.
        if(st.eqHighs){
          const estaArriba = st.eqHighs > priceNow15;
          const esObjetivo = thesis.dir==='LONG' && estaArriba;
          const rol = estaArriba
            ? (esObjetivo ? ', y es justo hacia donde apunta esta operación' : ', un nivel a tener en cuenta como resistencia en el camino')
            : ' — el precio ya lo superó, así que ahora funciona como soporte por debajo';
          liqPartes.push(`${estaArriba?'arriba':'abajo'}, a un ${distPct(st.eqHighs).toFixed(1)}% del precio actual (~$${st.eqHighs.toFixed(6)}), hay liquidez compradora acumulada — el precio ya tocó ese nivel ${st.eqHighsCount} veces sin romperlo del todo${rol}`);
        }
        if(st.eqLows){
          const estaAbajo = st.eqLows < priceNow15;
          const esObjetivo = thesis.dir==='SHORT' && estaAbajo;
          const rol = estaAbajo
            ? (esObjetivo ? ', y es justo hacia donde apunta esta operación' : ', un nivel a tener en cuenta como soporte en el camino')
            : ' — el precio ya lo perforó, así que ahora funciona como resistencia por encima';
          liqPartes.push(`${estaAbajo?'abajo':'arriba'}, a un ${distPct(st.eqLows).toFixed(1)}% del precio actual (~$${st.eqLows.toFixed(6)}), hay liquidez vendedora acumulada (${st.eqLowsCount} toques previos)${rol}`);
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
        const chartUrl = await buildChartUrl(data15.candles, entryPrice, setup.stop, setup.t1, setup.t2, thesis.dir, thesis.symbol, {
          zonas: detectZonasOfertaDemanda(data15.candles),
          niveles: detectNivelesEstructurales(data15.candles),
          triangulo: triangulo15,
          fuerza: computeVolumeProbability(data15.candles, 20),
          fib: result15.structure?.fib,
        });
        if(chartUrl){
          sendPromises.push(sendTelegramPhoto(chartUrl, `📈 ${thesis.symbol}${thesis.tag||''} ${thesis.dir} — Score ${Math.max(result15.longScore,result15.shortScore).toFixed(1)}/10`));
        }

        // Lectura de liquidez interpretada, no solo los números
        const lecturaLiq = lecturaDeLiquidez(data15.candles, result15.structure, thesis.dir);
        const DIV = '━━━━━━━━━━━━━━━━━━━━';
        // Qué caminos confirmaron: da contexto sobre la CALIDAD de la entrada

        const pct = (v) => ((v-entryPrice)/entryPrice*100);
        const confluenciaLineas = (result15.committee||[])
          .filter(g=>g.vote===thesis.dir).slice(0,4)
          .map(g=>`✅ ${g.name.replace(/^[^\s]+\s/,'')}`).join('\n');

        sendPromises.push(sendTelegram(
          `${thesis.dir==='LONG'?'🟢':'🔴'} <b>SEÑAL CONFIRMADA — $${thesis.symbol}${thesis.tag||''}</b>\n` +
          `${DIV}\n` +
          // Se muestran los DOS scores: el de 4h (que es el que pasó el umbral de 7.6 y creó la
          // tesis) y el de 15m (recalculado al confirmar). Antes solo se veía el de 15m, y como
          // puede ser más bajo, parecía que una señal de 6.8 había pasado un umbral de 7.6.
          `📊 Score: <b>${Math.max(result15.longScore,result15.shortScore).toFixed(1)}/10</b> en 15m` +
          (thesis.score4h ? ` · <b>${thesis.score4h}/10</b> en 4h <i>(el que creó la tesis)</i>` : '') + `\n` +
          `🎯 Confianza: <b>${result15.confidence}%</b>\n` +
          `🧩 Setup: ${setupsActivos}\n` +
          `📈 Dirección: <b>${thesis.dir}</b>\n` +
          `⏱ 4h → Confirmado en 15m\n\n` +

          `${DIV}\n📌 <b>OPERACIÓN</b>\n` +
          `Entrada: <code>$${entryPrice.toFixed(6)}</code>\n` +
          `Stop: <code>$${setup.stop.toFixed(6)}</code> (${pct(setup.stop).toFixed(2)}%)\n` +
          `TP1: <code>$${setup.t1.toFixed(6)}</code> (${pct(setup.t1)>=0?'+':''}${pct(setup.t1).toFixed(2)}%) · R:R ${rrTp1}\n` +
          `TP2: <code>$${setup.t2.toFixed(6)}</code> (${pct(setup.t2)>=0?'+':''}${pct(setup.t2).toFixed(2)}%) · R:R ${rrTp2}\n` +
          `TP3: <code>$${setup.t3.toFixed(6)}</code> (${pct(setup.t3)>=0?'+':''}${pct(setup.t3).toFixed(2)}%) · R:R ${rrTp3}\n\n` +
          `Riesgo: ${(riskPct*100).toFixed(1)}% del capital · Apalancamiento ${setup.leverage}\n` +
          `Gestión: 50% en TP1 + stop a break even\n\n` +

          (lecturaLiq ? `${DIV}\n${lecturaLiq.texto}\n\n` : '') +

          `${DIV}\n🧠 <b>CONFLUENCIA</b>\n${confluenciaLineas}\n\n` +

          // EXPLAIN ENGINE: de dónde sale el score, componente por componente.
          (result15.explainEngine ? `${DIV}\n🔬 <b>DE DÓNDE SALE EL SCORE</b>\n` +
            result15.explainEngine.componentes
              .filter(cp => Math.abs(cp.aporte) >= 0.01)
              .map(cp => `${cp.aporte>=0?'🟢':'🔴'} ${cp.nombre}: <b>${cp.aporte>=0?'+':''}${cp.aporte}</b> <i>(${cp.detalle})</i>`)
              .join('\n') +
            `\n⚪ Base: +${result15.explainEngine.base}` +
            (result15.explainEngine.ajusteCalidad ? `\n⚙️ Ajuste por volumen/volatilidad: ${result15.explainEngine.ajusteCalidad.efectoEnScore>=0?'+':''}${result15.explainEngine.ajusteCalidad.efectoEnScore}` : '') +
            `\n<i>${result15.explainEngine.informativos.length} señales más se calculan pero no votan en el score.</i>\n\n` : '') +

          `${DIV}\n📖 <b>LECTURA COMPLETA</b>\n<i>${relatoCompleto}</i>\n\n` +

          // Timeline: los hitos de esta tesis, no el diario completo
          // Market Phase: en qué etapa del ciclo está. Un score de 8 en clímax no es lo mismo que
          // un score de 8 en expansión temprana.
          (()=>{ const fase = detectMarketPhase(data15.candles);
            if(!fase || fase.fase==='DESCONOCIDA') return '';
            const encaja = fase.favorable===thesis.dir ? '✅ la fase acompaña esta operación'
              : fase.favorable==='ninguna' ? '⚠️ fase de agotamiento — operar acá es a contramano'
              : `⚠️ la fase favorece ${fase.favorable}, no ${thesis.dir}`;
            return `${DIV}\n${fase.emoji} <b>FASE DEL MERCADO: ${fase.fase}</b>\n<i>${fase.motivo}</i>\n${encaja}\n\n`;
          })() +

          (thesis.timeline?.length ? `${DIV}\n⏱ <b>RECORRIDO</b>\n${timelineTexto(thesis)}\n\n` : '') +

          // Calidad de datos: cuánta confianza merecen los datos detrás de este score
          (result15.dataQuality?.score!=null ? `${DIV}\n🔌 <b>CALIDAD DE DATOS: ${result15.dataQuality.score}/100</b> (${result15.dataQuality.nivel})` +
            (result15.dataQuality.faltantes?.length ? `\n<i>Falta: ${result15.dataQuality.faltantes.join(', ')}</i>` : '') + `\n\n` : '') +

          // MEMORIA: cómo salieron las operaciones parecidas a esta. Es la pregunta más útil que
          // se puede hacer antes de abrir — y hasta ahora la función existía pero no se usaba.
          (()=>{ const par = buscarTesisParecidas(acc.closedTrades||[], {
              dir: thesis.dir, tipoSetup: thesis.tipoSetup,
              score: +Math.max(result15.longScore, result15.shortScore).toFixed(1),
              tag: thesis.tag||'', symbol: thesis.symbol });
            if(!par || !par.encontradas) return '';
            const icono = !par.suficienteMuestra ? '🔍' : par.winRate >= 55 ? '✅' : par.winRate <= 40 ? '⚠️' : '➖';
            return `${DIV}\n${icono} <b>OPERACIONES PARECIDAS</b>\n<i>${par.resumen}</i>\n\n`;
          })() +

          // ANALISTA: lectura en lenguaje natural de todo lo anterior. No es IA — es un narrador
          // por reglas que solo puede decir lo que está en los datos, así que nunca inventa.
          (()=>{ const ex = explicarAnalisis(result15, { marketPhase: detectMarketPhase(data15.candles) });
            return ex?.texto ? `${DIV}\n🗣 <b>LECTURA DEL ANALISTA</b>\n<i>${ex.texto}</i>\n\n` : '';
          })() +

          `${DIV}\n❌ Invalidación: ${invalidacion}\n` +
          `💰 Capital: ${acc.capital.toFixed(2)} USDT (cuenta #${acc.id})\n\n` +
          `⚠️ Solo educativo. DYOR y gestioná tu riesgo. 🛡️`
        ));
        sendPromises.push(sendPushToAll(
          `${thesis.dir==='LONG'?'🟢':'🔴'} Señal: ${thesis.symbol} ${thesis.dir}`,
          `Entrada $${entryPrice.toFixed(6)} · Score ${Math.max(result15.longScore,result15.shortScore).toFixed(1)}/10`, null, 'senal', thesis.symbol));
        stillWatching.push(thesis); // CRÍTICO: sin esto, la tesis recién confirmada se perdía al reemplazar acc.theses al final
      } else {
        journal(thesis, `Todavía esperando confirmación en 15m (no hay BOS a favor ni suba de confianza). Sigue observando.`);
        stillWatching.push(thesis);
      }
    }catch(e){
      // Un solo reintento: la mayoría de estos fallos son de red (rate limit, timeout puntual),
      // y sin reintento esa moneda se queda sin analizar hasta la próxima corrida.
      let recuperada = false;
      try{
        await new Promise(res=>setTimeout(res, 1200));
        const reintento = await fetchTokenData(thesis.symbol, '15m');
        if(reintento?.candles?.length){
          recuperada = true;
          console.log(`  [${thesis.symbol}] falló y se recuperó en el reintento — se revisa en la próxima corrida.`);
        }
      }catch(e2){ /* si el reintento también falla, se registra abajo */ }
      _cuenta.fallidas++;
      _cuenta.fallos.push(`${thesis.symbol}: ${e.message}`);
      if(!recuperada) console.error('Error confirmando', thesis.symbol, e.message);
      stillWatching.push(thesis);
    }
    await new Promise(res=>setTimeout(res, 300));
  }
  const _ok = _cuenta.total - _cuenta.fallidas - _cuenta.expiradas;
  console.log(`  → Fase 2: ${_cuenta.total} tesis en espera · ${_ok} analizadas · ${_cuenta.expiradas} expiradas · ${_cuenta.fallidas} con error`);
  if(_cuenta.fallidas > 0) console.log(`     Fallaron: ${_cuenta.fallos.slice(0,8).join(' | ')}${_cuenta.fallos.length>8?' …':''}`);
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

    // ═══ MFE / MAE ═══
    // MFE = hasta dónde llegó a favor. MAE = hasta dónde llegó en contra.
    // Sirven para responder si los TP están bien puestos: si el MFE promedio es 1.4R, poner TP3
    // en 2.5R significa que casi nunca se alcanza. Y si el MAE promedio es 0.8R, un stop a 1R
    // está justo al borde de lo que el precio suele retroceder antes de girar.
    if(price!=null && thesis.entry && thesis.stop && thesis.registro){
      const riesgo = Math.abs(thesis.entry - thesis.stop);
      if(riesgo > 0){
        const aFavor = thesis.dir==='LONG' ? (price-thesis.entry)/riesgo : (thesis.entry-price)/riesgo;
        thesis.registro.mfe = Math.max(thesis.registro.mfe ?? 0, +aFavor.toFixed(2));
        thesis.registro.mae = Math.min(thesis.registro.mae ?? 0, +aFavor.toFixed(2));
      }
    }

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
      cerrarOperacion(acc, thesis, price, pnl, 'antigüedad', sendPromises);
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
        hito(thesis, '🎯 TP1 alcanzado', 'se tomó el 50% y el stop pasó a breakeven');
        sendPromises.push(sendPushToAll(`💰 TP1 alcanzado: ${thesis.symbol}`, `+${pnl.toFixed(2)} USDT · Stop movido a breakeven`, null, 'gestion', thesis.symbol));
        stillOpen.push(thesis);
      } else if(hitSL){
        const pnl = thesis.units * (thesis.stop-thesis.entry) * (thesis.dir==='LONG'?1:-1);
        acc.capital = +(acc.capital+pnl).toFixed(4);
        journal(thesis, `Stop tocado antes de TP1 (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT). Capital: ${acc.capital.toFixed(2)}.`);
        hito(thesis, '🛑 Cerrada por stop', `${pnl>=0?'+':''}${pnl.toFixed(2)} USDT`);
        cerrarOperacion(acc, thesis, thesis.stop, pnl, 'stop antes de TP1', sendPromises);
        sendPromises.push(sendTelegram(
          (isReconciliation ? `🔎 <b>Auditoría/conciliación:</b> se detectó que esto ya había pasado y no estaba reflejado. Corrigiendo:\n\n` : '') +
          `🛑 <b>TheHaton cerró ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
          `PERDIÓ (${pnl.toFixed(2)} USDT)\nCapital actual: ${acc.capital.toFixed(2)} USDT`
        ));
        sendPromises.push(sendPushToAll(`🛑 Stop tocado: ${thesis.symbol}`, `${pnl.toFixed(2)} USDT`, null, 'cierre', thesis.symbol));
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
        cerrarOperacion(acc, thesis, thesis.stop, totalPnl, 'stop tras toma parcial', sendPromises);
        sendPromises.push(sendTelegram(
          (isReconciliation ? `🔎 <b>Auditoría/conciliación:</b> se detectó que esto ya había pasado y no estaba reflejado. Corrigiendo:\n\n` : '') +
          `⚖️ <b>TheHaton cerró el resto de ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
          `Volvió al punto de entrada (breakeven en lo que quedaba)\n` +
          `Resultado total de la operación: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT\nCapital actual: ${acc.capital.toFixed(2)} USDT`
        ));
        sendPromises.push(sendPushToAll(`⚖️ Breakeven: ${thesis.symbol}`, `Total: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT`, null, 'cierre', thesis.symbol));
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
        sendPromises.push(sendPushToAll(`💰 TP2 alcanzado: ${thesis.symbol}`, `+${pnl.toFixed(2)} USDT · 20% corriendo a TP3`, null, 'gestion', thesis.symbol));
        stillOpen.push(thesis);
        continue;
      }
      if(hitTP2){
        // Sin tp3 (tesis vieja migrada) -> se cierra todo acá, como en el esquema de 2 tramos de antes.
        const pnl = thesis.units * (thesis.tp2-thesis.entry) * (thesis.dir==='LONG'?1:-1);
        acc.capital = +(acc.capital+pnl).toFixed(4);
        const totalPnl = (thesis.partialPnl||0) + pnl;
        journal(thesis, `TP2 alcanzado: se cierra el resto (${pnl>=0?'+':''}${pnl.toFixed(2)} USDT). Resultado total: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT. Capital: ${acc.capital.toFixed(2)}.`);
        cerrarOperacion(acc, thesis, thesis.tp2, totalPnl, 'TP2', sendPromises);
        sendPromises.push(sendTelegram(
          `🚀 <b>TheHaton cerró el resto de ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\nTP2 alcanzado ✅\nResultado total: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT\nCapital actual: ${acc.capital.toFixed(2)} USDT`
        ));
        sendPromises.push(sendPushToAll(`🚀 TP2 (cierre total): ${thesis.symbol}`, `Total: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT`, null, 'cierre', thesis.symbol));
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
      cerrarOperacion(acc, thesis, exit, totalPnl, 'TP final', sendPromises);
      sendPromises.push(sendTelegram(
        (isReconciliation ? `🔎 <b>Auditoría/conciliación:</b> se detectó que esto ya había pasado y no estaba reflejado. Corrigiendo:\n\n` : '') +
        `${hitTP3?'🎯':'⚖️'} <b>TheHaton cerró el resto de ${thesis.symbol}${thesis.tag||''} ${thesis.dir}</b>\n` +
        `${hitTP3?'TP3 alcanzado ✅ (objetivo final)':'Volvió al punto de entrada (breakeven en el tramo final)'}\n` +
        `Resultado total de la operación: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT\nCapital actual: ${acc.capital.toFixed(2)} USDT`
      ));
      sendPromises.push(sendPushToAll(`${hitTP3?'🎯':'⚖️'} Cierre final: ${thesis.symbol}`, `Total: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} USDT`, null, 'cierre', thesis.symbol));
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

  // Se evalúan las señales sombra de hace 24hs antes de seguir
  await evaluarShadowSignals(state).catch(e=>console.error('Error evaluando sombras:', e.message));

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
  // Desglose por estado: "47 tesis" no dice nada si no se sabe cuántas están esperando y cuántas
  // realmente abiertas. Con el bug de priceNow, TODAS quedaban atascadas en WATCHING y el número
  // total no lo dejaba ver.
  const _tesis = state.account.theses || [];
  const _watching = _tesis.filter(t => !t.entry).length;
  const _active = _tesis.filter(t => t.entry).length;
  console.log('--- Listo. Capital de TheHaton:', state.account.capital,
    `· Tesis: ${_tesis.length} (🟡 esperando confirmación: ${_watching} · 🟢 operaciones abiertas: ${_active}) ---`);
}

main().catch(e=>{ console.error('Error fatal:', e); process.exit(1); });
