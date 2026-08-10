// Recorre el ciclo COMPLETO con una operación real: detecta → confirma → gestiona → cierra,
// y verifica que los datos lleguen enteros al Research Center.
import fs from 'fs';
process.env.TELEGRAM_BOT_TOKEN='test'; process.env.TELEGRAM_CHAT_ID='123';

function velas(n=300, sesgo=-0.05){
  const out=[]; let p=100;
  for(let i=0;i<n;i++){
    const ch=(Math.random()-0.5+sesgo)*0.02; const o=p; p=p*(1+ch);
    out.push([Date.now()-(n-i)*900000, o, Math.max(o,p)*1.006, Math.min(o,p)*0.994, p, 8000, 0,0,0,0,0,0]);
  }
  return out;
}
// Tesis ACTIVA (ya confirmada) con registro completo, para probar gestión y cierre
const ahora = Date.now();
fs.mkdirSync('telegram-bot', {recursive:true});
fs.writeFileSync('telegram-bot/state.json', JSON.stringify({
  account: { id:1, capital:100, initialCapital:100, peakCapital:100, closedTrades:[], expiredTheses:[],
    tradesToday:{date:null,count:0},
    theses: [{
      symbol:'PIPELINE', tag:' (cap chico)', dir:'SHORT', status:'ACTIVE',
      detectedAt: ahora-5*3600*1000, expiresAt: ahora+13*3600*1000,
      score4h:7.9, score15m:7.4, score:7.9, confianza:61, dataQuality:78,
      marketPhase:'MARKDOWN', tipoSetup:'BOS', horaConfirmacion:14,
      entry:100, stop:107, tp1:93, tp2:88.8, tp3:82.5,
      units:0.28, originalUnits:0.28, partialTaken:false,
      journal:[{ts:ahora,note:'confirmada'}],
      timeline:[{ts:ahora-5*3600*1000,etapa:'🔭 Detectada',detalle:'score 7.9'},{ts:ahora,etapa:'🟢 Confirmada',detalle:'BOS'}],
      registro:{ componentes:[{n:'Estructura',aporte:0.9,senal:1},{n:'Tendencia',aporte:-0.6,senal:-0.8}],
        estocastico:38, liquidezAFavor:'a favor', caminos:'BOS', porValvulaEscape:false,
        gestion:{stopPct:7.0,rTp1:1.0,rTp2:1.6,rTp3:2.5,atrPct:3.1}, mfe:0, mae:0 },
    }],
  }, memory:{}, lastMarketPulse:null, midCapCache:null,
}));

global.fetch = async (url) => {
  if(url.includes('api.telegram.org')) return {ok:true,text:async()=>'{}',json:async()=>({ok:true})};
  if(url.includes('quickchart')) return {ok:true,json:async()=>({success:true,url:'http://t/c.png'})};
  if(url.includes('alternative.me')) return {ok:true,json:async()=>({data:[{value:'45'}]})};
  if(url.includes('/klines')) return {ok:true,json:async()=>velas()};
  // Precio muy por debajo: fuerza que toque TP1 y TP2
  if(url.includes('/ticker/24hr') && url.includes('symbol=')) return {ok:true,json:async()=>({lastPrice:'87',priceChangePercent:'-13',quoteVolume:'500000',highPrice:'101',lowPrice:'86'})};
  if(url.includes('/ticker/24hr')) return {ok:true,json:async()=>[]};
  if(url.includes('exchangerate')) return {ok:true,json:async()=>({rates:{EUR:0.92,GBP:0.79}})};
  if(url.includes('emissions')||url.includes('llama.fi')||url.includes('stablecoin')) return {ok:true,json:async()=>[]};
  if(url.includes('geckoterminal')) return {ok:true,json:async()=>({data:[]})};
  if(url.includes('coingecko')) return {ok:true,json:async()=>[]};
  if(url.includes('exchangeInfo')) return {ok:true,json:async()=>({symbols:[]})};
  if(url.includes('bitunix')) return {ok:true,json:async()=>({data:[]})};
  return {ok:false,json:async()=>({})};
};
await import('./scan.js');
await new Promise(r=>setTimeout(r,1500));

// Verificar el estado final
const final = JSON.parse(fs.readFileSync('telegram-bot/state.json','utf8'));
const cerradas = final.account.closedTrades || [];
const abiertas = final.account.theses || [];
console.log('\n════════ AUDITORÍA DE EXTREMO A EXTREMO ════════');
console.log(`Operaciones cerradas: ${cerradas.length} | Tesis abiertas: ${abiertas.length}`);
const t = cerradas[0] || abiertas.find(x=>x.symbol==='PIPELINE');
if(!t){ console.log('❌ Se perdió la operación'); }
else {
  const chequeos = [
    ['registro completo', !!t.registro],
    ['componentes del score', !!t.registro?.componentes?.length],
    ['datos de gestión', !!t.registro?.gestion?.stopPct],
    ['MFE actualizado', t.registro?.mfe != null && t.registro.mfe !== 0],
    ['MAE presente', t.registro?.mae != null],
    ['timeline', !!t.timeline?.length],
    ['tipoSetup', !!t.tipoSetup],
    ['score4h preservado', t.score4h != null],
    ['marketPhase', !!t.marketPhase],
    ['dataQuality', t.dataQuality != null],
  ];
  chequeos.forEach(([n,ok])=>console.log(`  ${ok?'✅':'❌'} ${n}`));
  const fallos = chequeos.filter(([,ok])=>!ok).length;
  console.log(`\n${fallos===0 ? '✅ Todos los datos sobrevivieron el recorrido' : `⚠️ ${fallos} campos se perdieron`}`);
  if(t.registro) console.log(`  MFE=${t.registro.mfe} MAE=${t.registro.mae} | timeline: ${t.timeline?.map(h=>h.etapa).join(' → ')}`);
}
