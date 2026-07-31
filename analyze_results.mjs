// Analiza los resultados de run_backtest.mjs: win rate, profit factor, drawdown,
// y comparación contra "comprar y mantener" en el mismo período.
//
// Uso: node analyze_results.mjs closed_trades.json data/btc_4h_2022.json

import fs from 'fs';

const tradesFile = process.argv[2];
const candlesFile = process.argv[3];
if(!tradesFile || !candlesFile){
  console.log('Uso: node analyze_results.mjs <closed_trades.json> <archivo_de_velas_4h.json>');
  process.exit(1);
}

const trades = JSON.parse(fs.readFileSync(tradesFile, 'utf8'));
trades.sort((a,b)=>a.detectedAtTs-b.detectedAtTs);
const candles = JSON.parse(fs.readFileSync(candlesFile, 'utf8'));

const RISK_PCT = 0.01; // mismo riesgo base que usa el bot real (1% del capital por operación)

let equity = 100, peak = 100, maxDd = 0;
for(const t of trades){
  const rMultiple = t.riskPct ? t.pnlPct/t.riskPct : 0;
  equity *= (1 + RISK_PCT*rMultiple);
  peak = Math.max(peak, equity);
  maxDd = Math.max(maxDd, (peak-equity)/peak*100);
}

const wins = trades.filter(t=>t.pnlPct>0);
const losses = trades.filter(t=>t.pnlPct<=0);
const grossWin = wins.reduce((s,t)=>s+t.pnlPct,0);
const grossLoss = Math.abs(losses.reduce((s,t)=>s+t.pnlPct,0));
const profitFactor = grossLoss>0 ? grossWin/grossLoss : Infinity;

console.log(`=== RESULTADO DEL BOT (simulado, 1% de riesgo por operación) ===`);
console.log(`Operaciones: ${trades.length} | Win rate: ${(wins.length/trades.length*100).toFixed(1)}% (${wins.length}G/${losses.length}P)`);
console.log(`Profit factor: ${profitFactor.toFixed(2)}`);
console.log(`Capital: 100 -> ${equity.toFixed(2)} (${(equity-100).toFixed(1)}%)`);
console.log(`Máximo drawdown: ${maxDd.toFixed(1)}%`);

// Comprar y mantener, mismo período
const firstPrice = candles[0].c, lastPrice = candles.at(-1).c;
let peakBh = firstPrice, maxDdBh = 0;
for(const c of candles){ peakBh = Math.max(peakBh, c.c); maxDdBh = Math.max(maxDdBh, (peakBh-c.c)/peakBh*100); }
const bhReturn = (lastPrice/firstPrice-1)*100;

console.log(`\n=== COMPRAR Y MANTENER (mismo período) ===`);
console.log(`$${firstPrice.toFixed(0)} -> $${lastPrice.toFixed(0)} = ${bhReturn.toFixed(1)}%`);
console.log(`Máximo drawdown: ${maxDdBh.toFixed(1)}%`);

console.log(`\n=== VEREDICTO ===`);
console.log(`Bot: ${(equity-100).toFixed(1)}% (drawdown ${maxDd.toFixed(1)}%)`);
console.log(`Buy & Hold: ${bhReturn.toFixed(1)}% (drawdown ${maxDdBh.toFixed(1)}%)`);
console.log(`¿El bot le ganó a comprar y mantener?: ${(equity-100)>bhReturn ? 'SÍ' : 'NO'}`);
