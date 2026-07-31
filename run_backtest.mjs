// BACKTEST REAL — usa las mismas funciones de producción (computeScore, buildSetup, confluenceScore15m)
// contra datos históricos REALES de BTC (Bitstamp, 2023-01-01 a 2025-01-07, resampleados de 1 minuto).
//
// LIMITACIONES HONESTAS (para no vender un resultado más lindo del que es):
// - Sin funding rate ni Open Interest históricos gratis -> esos "Dioses" del comité no aportan nada
//   en este backtest (quedan en null), aunque en producción sí lo hacen para pares de Binance.
// - Sin Fear&Greed histórico ni calendario FOMC aplicado retroactivamente -> esos filtros del bot
//   real NO están simulados acá (se haría con contexto que no tenemos gratis para 2023-2024).
// - Solo BTC (es la única moneda con datos gratis y confiables de 2+ años que conseguí).
// - Sin comisiones ni slippage simulados en esta primera pasada (se puede sumar después).
// Esto significa: el resultado de acá abajo mide si la LÓGICA CENTRAL (estructura SMC + comité +
// Estocástico/MACD + gestión de TP/SL) tiene alguna ventaja real usando SOLO precio y volumen —
// no es una réplica 100% del bot en vivo (que además tiene filtros macro que este backtest no puede
// aplicar retroactivamente sin pagar un feed de datos históricos).

import fs from 'fs';
import {
  computeScore, buildSetup, confluenceScore15m, stochasticOscillator
} from './thehaton-engine.js';

const file4h = process.argv[2] || './btc_4h.json';
const file15m = process.argv[3] || './btc_15m.json';
const outFile = process.argv[4] || './closed_trades.json';
const candles4h = JSON.parse(fs.readFileSync(file4h, 'utf8'));
const candles15m = JSON.parse(fs.readFileSync(file15m, 'utf8'));


const THRESHOLD = 7.6; // mismo umbral que usa el bot real
const LOOKBACK = 220;  // mismo tamaño de ventana que usa fetchTokenData en producción
const THESIS_EXPIRY_HOURS = 18;

function buildDataObject(candles, idx, lookback=LOOKBACK){
  const window = candles.slice(Math.max(0, idx-lookback+1), idx+1);
  const last = window.at(-1);
  return {
    source:'Binance', symbol:'BTCUSDT', displayName:'BTC',
    price: last.c, change24h: 0, vol24h: window.slice(-6).reduce((s,c)=>s+c.v,0),
    candles: window, funding: null, oi: null, dexUrl: null, contract: null,
  };
}

function findClosest15mIndex(ts){
  // Búsqueda binaria simple sobre el array de 15m (está ordenado por tiempo)
  let lo=0, hi=candles15m.length-1;
  while(lo<hi){
    const mid = (lo+hi)>>1;
    if(candles15m[mid].t < ts) lo = mid+1; else hi = mid;
  }
  return lo;
}

const theses = [];       // tesis observando, esperando confirmación
const closedTrades = []; // operaciones cerradas (ganadas o perdidas)
let expiredCount = 0;

console.log(`Recorriendo ${candles4h.length} velas de 4h (desde vela ${LOOKBACK})...`);

for(let i=LOOKBACK; i<candles4h.length; i++){
  const data4h = buildDataObject(candles4h, i);
  const result4h = computeScore(data4h, null, [], {}, {}, null);
  const best = Math.max(result4h.longScore, result4h.shortScore);

  if(best >= THRESHOLD && result4h.recommendation !== 'NO OPERAR'){
    theses.push({
      dir: result4h.recommendation,
      detectedAtTs: candles4h[i].t,
      detectedAtIdx15m: findClosest15mIndex(candles4h[i].t),
      expiresAtTs: candles4h[i].t + THESIS_EXPIRY_HOURS*3600*1000,
      status:'WATCHING',
    });
  }
}
console.log(`Tesis detectadas en 4h (score>=${THRESHOLD}): ${theses.length}`);

// ---- Fase de confirmación en 15m + gestión de la posición, para cada tesis detectada ----
let processed = 0;
for(const thesis of theses){
  processed++;
  if(processed % 50 === 0) console.log(`  Procesando tesis ${processed}/${theses.length}...`);

  let idx = thesis.detectedAtIdx15m;
  let confirmed = false;
  let entryPrice=null, stop=null, tp1=null, tp2=null;

  // Avanza de a 1 vela de 15m, revisando confirmación en cada paso (igual que el bot real, que
  // corre cada hora y revisa las tesis WATCHING existentes).
  while(idx < candles15m.length-1 && candles15m[idx].t < thesis.expiresAtTs){
    idx++;
    if(idx < LOOKBACK) continue;
    const data15 = buildDataObject(candles15m, idx);
    const result15 = computeScore(data15, null, [], {}, {}, null);
    const alineado = result15.recommendation === thesis.dir;
    if(!alineado) continue;

    const confluence = confluenceScore15m(data15.candles);
    const events = result15.structure.events;
    const bosAFavor = thesis.dir==='LONG' ? events.bos==='bullish' : events.bos==='bullish' ? false : events.bos==='bearish';
    const bosOk = (thesis.dir==='LONG' && events.bos==='bullish') || (thesis.dir==='SHORT' && events.bos==='bearish');
    const confluenceOk = thesis.dir==='LONG' ? confluence.bullConfluence>=3 : confluence.bearConfluence>=3;

    // Mismo filtro de Estocástico recodificado por régimen que ya tiene el bot real
    const stochK = result15.metrics.lastStochK;
    if(stochK!=null && !confluence.adxStrong && (stochK>=80 || stochK<=20)) continue;

    if(bosOk || confluenceOk){
      const setup = buildSetup(data15, result15, 'balanced');
      entryPrice = result15.metrics.price;
      stop = setup.stop; tp1 = setup.t1; tp2 = setup.t2;
      const distance = Math.abs(entryPrice-stop);
      const rrToTp1 = Math.abs(tp1-entryPrice)/distance;
      if(rrToTp1 < 1.5) continue; // mismo filtro de R:R mínimo que usa el bot real
      confirmed = true;
      thesis.originalRiskPct = distance/entryPrice; // para calcular múltiplos de R después
      break;
    }
  }

  if(!confirmed){ expiredCount++; continue; }

  // Comisión + deslizamiento realista: 0.05% de comisión (típico "taker" en futuros de Binance) +
  // 0.05% de deslizamiento estimado = 0.1% de fricción total por cada "pata" de la operación
  // (entrar cuenta como una pata, cada salida -parcial o total- cuenta como otra).
  const FRICTION = 0.001;
  let totalFriction = FRICTION; // la entrada siempre paga esta fricción

  // ---- Gestión de la posición: TP1 (50%) -> breakeven -> TP2, o stop directo ----
  let partialTaken=false, pnlPct=0, exitReason=null;
  for(let j=idx+1; j<candles15m.length; j++){
    const c = candles15m[j];
    if(!partialTaken){
      const hitStop = thesis.dir==='LONG' ? c.l<=stop : c.h>=stop;
      const hitTp1 = thesis.dir==='LONG' ? c.h>=tp1 : c.l<=tp1;
      if(hitStop){ pnlPct = thesis.dir==='LONG' ? (stop-entryPrice)/entryPrice : (entryPrice-stop)/entryPrice; exitReason='stop'; totalFriction+=FRICTION; break; }
      if(hitTp1){
        partialTaken = true;
        const partialPnl = thesis.dir==='LONG' ? (tp1-entryPrice)/entryPrice : (entryPrice-tp1)/entryPrice;
        pnlPct += partialPnl*0.5;
        totalFriction += FRICTION*0.5; // fricción sobre el 50% que se cerró acá
        stop = entryPrice; // breakeven
      }
    } else {
      const hitBE = thesis.dir==='LONG' ? c.l<=stop : c.h>=stop;
      const hitTp2 = thesis.dir==='LONG' ? c.h>=tp2 : c.l<=tp2;
      if(hitBE){ exitReason='breakeven'; totalFriction+=FRICTION*0.5; break; }
      if(hitTp2){
        const restPnl = thesis.dir==='LONG' ? (tp2-entryPrice)/entryPrice : (entryPrice-tp2)/entryPrice;
        pnlPct += restPnl*0.5; exitReason='tp2'; totalFriction+=FRICTION*0.5; break;
      }
    }
    if(j===candles15m.length-1){ exitReason='fin_de_datos'; totalFriction+=FRICTION*(partialTaken?0.5:1); } // se acabaron los datos con la posición abierta
  }
  pnlPct -= totalFriction; // se descuenta la fricción total del resultado de la operación

  closedTrades.push({ dir:thesis.dir, pnlPct, exitReason, entryPrice, detectedAtTs:thesis.detectedAtTs, riskPct: thesis.originalRiskPct });
}

console.log(`\nTesis confirmadas y cerradas: ${closedTrades.length}`);
console.log(`Tesis que expiraron sin confirmar: ${expiredCount}`);

fs.writeFileSync(outFile, JSON.stringify(closedTrades, null, 2));
console.log(`\nGuardado: ${outFile}`);
