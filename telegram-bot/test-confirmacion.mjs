// Prueba que FUERZA el camino de confirmación — el que el smoke test nunca ejercitaba,
// y por eso el bug de priceNow pasó desapercibido durante días.
import fs from 'fs';
process.env.TELEGRAM_BOT_TOKEN='test'; process.env.TELEGRAM_CHAT_ID='123';

// Velas sintéticas con tendencia, suficientes para todos los indicadores
function velas(n=300, sesgo=-0.05){
  const out=[]; let p=100;
  for(let i=0;i<n;i++){
    const ch=(Math.random()-0.5+sesgo)*0.02; const o=p; p=p*(1+ch);
    out.push([Date.now()-(n-i)*900000, o, Math.max(o,p)*1.005, Math.min(o,p)*0.995, p, 5000+Math.random()*5000, 0,0,0,0,0,0]);
  }
  return out;
}
// Un estado con una tesis WATCHING lista para confirmar
const estado = {
  account: {
    id:1, capital:100, initialCapital:100, peakCapital:100, closedTrades:[], expiredTheses:[],
    theses: [{
      symbol:'TESTCOIN', tag:' (cap chico)', dir:'LONG', status:'WATCHING',
      detectedAt: Date.now()-3*3600*1000, expiresAt: Date.now()+15*3600*1000,
      score:7.8, journal:[{ts:Date.now(),note:'tesis de prueba'}],
      theoStop:95, theoTp1:108,
    }],
  },
  memory:{}, lastMarketPulse:null, midCapCache:null,
};
fs.writeFileSync('./thehaton-state.json', JSON.stringify(estado));

global.fetch = async (url) => {
  if(url.includes('api.telegram.org')) return {ok:true,text:async()=>'{}',json:async()=>({ok:true})};
  if(url.includes('quickchart')) return {ok:true,json:async()=>({success:true,url:'http://t/c.png'})};
  if(url.includes('alternative.me')) return {ok:true,json:async()=>({data:[{value:'45'}]})};
  if(url.includes('/klines')) return {ok:true,json:async()=>velas()};
  if(url.includes('/ticker/24hr') && url.includes('symbol=')) return {ok:true,json:async()=>({lastPrice:'110',priceChangePercent:'3',quoteVolume:'500000'})};
  if(url.includes('/ticker/24hr')) return {ok:true,json:async()=>[]};
  if(url.includes('exchangerate')) return {ok:true,json:async()=>({rates:{EUR:0.92,GBP:0.79}})};
  if(url.includes('emissions')) return {ok:true,json:async()=>[]};
  if(url.includes('llama.fi')||url.includes('stablecoin')) return {ok:true,json:async()=>[]};
  if(url.includes('geckoterminal')) return {ok:true,json:async()=>({data:[]})};
  if(url.includes('coingecko')) return {ok:true,json:async()=>[]};
  if(url.includes('exchangeInfo')) return {ok:true,json:async()=>({symbols:[]})};
  if(url.includes('bitunix')) return {ok:true,json:async()=>({data:[]})};
  if(url.includes('openInterest')||url.includes('fundingRate')||url.includes('Ratio')) return {ok:true,json:async()=>[]};
  return {ok:false,json:async()=>({})};
};
let errores = [];
const origErr = console.error;
console.error = (...a) => { errores.push(a.join(' ')); origErr(...a); };

try{
  await import('./scan.js');
  const conError = errores.filter(e=>e.includes('Error confirmando'));
  console.log('\n════════════════════════════════════');
  console.log(conError.length===0 ? '✅ La confirmación corrió SIN errores' : `❌ ${conError.length} errores en confirmación:`);
  conError.forEach(e=>console.log('   ', e));
}catch(e){ console.log('❌ CRASHEÓ:', e.message); }
