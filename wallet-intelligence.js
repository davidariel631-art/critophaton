// ═══════════════════════════════════════════════════════════════════════════
// WALLET INTELLIGENCE — TheHaton
// ═══════════════════════════════════════════════════════════════════════════
//
// QUÉ HACE Y QUÉ NO:
//
// Esto NO es Arkham. No tiene una base de datos que diga "esta wallet es de Jump Trading".
// Lo que hace es clasificar direcciones por su COMPORTAMIENTO —a dónde manda, de dónde recibe,
// hace cuánto existe— y con eso distinguir un depósito real a un exchange de un movimiento
// interno del propio exchange.
//
// EL PROBLEMA QUE RESUELVE (el error más común al leer datos on-chain):
//
//   Wallet privada → Depósito Binance → Hot wallet Binance → Cold wallet Binance
//        $1M              $1M                 $1M                  $1M
//
//   Un sistema ingenuo ve CUATRO movimientos de $1M y reporta $3M de presión vendedora.
//   La realidad es UN solo movimiento relevante: el primero. Los otros tres son plata
//   moviéndose dentro del mismo exchange, sin cambiar de dueño.
//
// SEPARACIÓN DE RESPONSABILIDADES (a propósito):
//   · Este módulo NO habla con ninguna API: recibe transferencias y las interpreta.
//   · Este módulo NO suma al score: devuelve evidencia estructurada.
//   Así se puede probar sin red, y cambiar de proveedor de datos sin tocar la lógica.
// ═══════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────
// DIRECCIONES CONOCIDAS
// Son públicas y verificables en cualquier explorador. La lista es corta a propósito:
// el sistema se apoya sobre todo en el COMPORTAMIENTO, no en tener etiquetas completas.
// Una lista incompleta no lo rompe, solo lo hace un poco menos preciso.
// ───────────────────────────────────────────────────────────────────────────
const EXCHANGES_CONOCIDOS = {
  ethereum: {
    '0x28c6c06298d514db089934071355e5743bf21d60': { exchange:'Binance', tipo:'HOT' },
    '0x21a31ee1afc51d94c2efccaa2092ad1028285549': { exchange:'Binance', tipo:'HOT' },
    '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': { exchange:'Binance', tipo:'HOT' },
    '0x56eddb7aa87536c09ccc2793473599fd21a8b17f': { exchange:'Binance', tipo:'HOT' },
    '0x9696f59e4d72e237be84ffd425dcad154bf96976': { exchange:'Binance', tipo:'HOT' },
    '0x4976a4a02f38326660d17bf34b431dc6e2eb2327': { exchange:'Binance', tipo:'COLD' },
    '0x1522900b6dafac587d499a862861c0869be6e428': { exchange:'Binance', tipo:'COLD' },
    '0x77696bb39917c91a0c3908d577d5e322095425ca': { exchange:'Binance', tipo:'HOT' },
    '0x0d0707963952f2fba59dd06f2b425ace40b492fe': { exchange:'Gate.io', tipo:'HOT' },
    '0x2b5634c42055806a59e9107ed44d43c426e58258': { exchange:'KuCoin', tipo:'HOT' },
    '0x689c56aef474df92d44a1b70850f808488f9769c': { exchange:'KuCoin', tipo:'HOT' },
    '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b': { exchange:'OKX', tipo:'HOT' },
    '0x236f9f97e0e62388479bf9e5ba4889e46b0273c3': { exchange:'OKX', tipo:'HOT' },
    '0xa7efae728d2936e78bda97dc267687568dd593f3': { exchange:'OKX', tipo:'HOT' },
    '0x46340b20830761efd32832a74d7169b29feb9758': { exchange:'Crypto.com', tipo:'HOT' },
    '0xf89d7b9c864f589bbf53a82105107622b35eaa40': { exchange:'Bybit', tipo:'HOT' },
    '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43': { exchange:'Coinbase', tipo:'HOT' },
    '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': { exchange:'Coinbase', tipo:'HOT' },
    '0x503828976d22510aad0201ac7ec88293211d23da': { exchange:'Coinbase', tipo:'HOT' },
  },
  bsc: {
    '0x8894e0a0c962cb723c1976a4421c95949be2d4e3': { exchange:'Binance', tipo:'HOT' },
    '0xf977814e90da44bfa03b6295a0616a897441acec': { exchange:'Binance', tipo:'COLD' },
    '0x515b72ed8a97f42c568d6a143232775018f133c8': { exchange:'Binance', tipo:'HOT' },
  },
  // Se pueden agregar más redes sin tocar nada de la lógica de abajo
};

// Direcciones especiales que no son de nadie
const DIRECCIONES_ESPECIALES = {
  '0x0000000000000000000000000000000000000000': 'QUEMA',
  '0x000000000000000000000000000000000000dead': 'QUEMA',
};

const norm = (a) => String(a||'').toLowerCase().trim();

// ───────────────────────────────────────────────────────────────────────────
// 1. CLASIFICADOR DE WALLETS
// Decide qué es cada dirección. Primero por lista conocida, después por comportamiento.
// ───────────────────────────────────────────────────────────────────────────
export function clasificarWallet(direccion, red, historial = {}){
  const a = norm(direccion);
  if(!a) return { tipo:'DESCONOCIDA', confianza:0, motivo:'Dirección vacía.' };

  if(DIRECCIONES_ESPECIALES[a]) {
    return { tipo:'QUEMA', confianza:100, motivo:'Dirección de quema: los tokens se destruyen.' };
  }

  // Lista conocida: máxima confianza
  const conocida = EXCHANGES_CONOCIDOS[red]?.[a];
  if(conocida){
    return {
      tipo: conocida.tipo === 'COLD' ? 'EXCHANGE_COLD' : 'EXCHANGE_HOT',
      exchange: conocida.exchange, confianza: 100,
      motivo: `Wallet ${conocida.tipo === 'COLD' ? 'fría' : 'caliente'} conocida de ${conocida.exchange}.`,
    };
  }

  // ═══ CLASIFICACIÓN POR COMPORTAMIENTO ═══
  // historial esperado: { recibidasDe:[], enviadasA:[], primeraTx, totalTx, balanceUsd }
  const { recibidasDe = [], enviadasA = [], primeraTx = null, totalTx = 0, balanceUsd = 0 } = historial;
  const remitentes = new Set(recibidasDe.map(norm));
  const destinos = enviadasA.map(norm);
  const destinosUnicos = new Set(destinos);

  // DEPÓSITO DE EXCHANGE: la huella es inconfundible.
  // Recibe de muchas direcciones distintas pero manda TODO a una sola, que es un exchange.
  // Cada usuario del exchange tiene su propia dirección de depósito con este patrón.
  if(destinos.length >= 2 && destinosUnicos.size <= 2){
    const unico = [...destinosUnicos][0];
    const destinoEsExchange = EXCHANGES_CONOCIDOS[red]?.[unico];
    if(destinoEsExchange){
      return {
        tipo:'EXCHANGE_DEPOSITO', exchange: destinoEsExchange.exchange, confianza: 90,
        motivo: `Manda todo a una wallet de ${destinoEsExchange.exchange}: es una dirección de depósito de un usuario.`,
      };
    }
    // Mismo patrón pero sin saber a qué exchange va
    if(remitentes.size >= 3){
      return { tipo:'EXCHANGE_DEPOSITO', exchange:null, confianza: 55,
        motivo:'Recibe de varias direcciones y manda siempre al mismo lugar: parece una dirección de depósito, pero no se identificó el exchange.' };
    }
  }

  // WALLET NUEVA: creada hace poco y con poca actividad.
  // Interesante porque suele indicar dinero que sale de un exchange a custodia propia.
  if(primeraTx){
    const diasDeVida = (Date.now() - primeraTx) / 86400000;
    if(diasDeVida <= 30 && totalTx <= 20){
      return { tipo:'WALLET_NUEVA', confianza: 80,
        motivo:`Creada hace ${diasDeVida.toFixed(0)} día(s) con ${totalTx} movimientos: dinero que salió de un exchange o alguien empezando una posición.`,
        diasDeVida:+diasDeVida.toFixed(1) };
    }
  }

  // POSIBLE HOT WALLET: muchísima actividad hacia muchos destinos.
  if(totalTx >= 5000 && destinosUnicos.size >= 200){
    return { tipo:'EXCHANGE_HOT', exchange:null, confianza: 60,
      motivo:`${totalTx} movimientos hacia ${destinosUnicos.size} destinos distintos: se comporta como wallet operativa de un exchange o de un creador de mercado.` };
  }

  // BALLENA: mucho dinero y poca actividad. Acumula, no opera.
  if(balanceUsd >= 500000 && totalTx < 500){
    return { tipo:'BALLENA', confianza: 70,
      motivo:`Tiene $${(balanceUsd/1000).toFixed(0)}K con solo ${totalTx} movimientos: parece una posición grande de largo plazo.`,
      balanceUsd };
  }

  return { tipo:'PRIVADA', confianza: 40, motivo:'Wallet particular sin un patrón reconocible.' };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. ANALIZADOR DE FLUJO
// Interpreta qué significa una transferencia según de dónde sale y a dónde va.
// ───────────────────────────────────────────────────────────────────────────
export function analizarFlujo(tipoOrigen, tipoDestino, exchangeOrigen, exchangeDestino){
  const esExchange = t => t==='EXCHANGE_HOT' || t==='EXCHANGE_COLD' || t==='EXCHANGE_DEPOSITO';

  // ═══ MOVIMIENTO INTERNO — EL FILTRO MÁS IMPORTANTE ═══
  // Plata que se mueve dentro del mismo exchange no cambia de dueño ni presiona el precio.
  // Sin este filtro, un solo depósito de $1M se contaría tres o cuatro veces.
  if(esExchange(tipoOrigen) && esExchange(tipoDestino)){
    const mismoExchange = exchangeOrigen && exchangeDestino && exchangeOrigen === exchangeDestino;
    return {
      tipo:'MOVIMIENTO_INTERNO', sesgo:'NEUTRO', cuenta:false,
      texto: mismoExchange
        ? `Movimiento interno de ${exchangeOrigen} (${tipoOrigen==='EXCHANGE_HOT'?'caliente':'depósito'} → ${tipoDestino==='EXCHANGE_COLD'?'fría':'caliente'}): no cambia de dueño, no cuenta como presión.`
        : 'Movimiento entre exchanges: no es presión de compra ni de venta.',
    };
  }

  // ═══ ENTRADA REAL A EXCHANGE ═══
  // Alguien manda tokens a un exchange. La razón habitual es querer venderlos.
  if(!esExchange(tipoOrigen) && esExchange(tipoDestino)){
    return {
      tipo:'ENTRADA_A_EXCHANGE', sesgo:'BAJISTA', cuenta:true,
      texto: `Entraron tokens a ${exchangeDestino || 'un exchange'} desde una wallet ${tipoOrigen==='BALLENA'?'grande':'particular'}: suele ser intención de vender.`,
    };
  }

  // ═══ SALIDA DE EXCHANGE ═══
  // Retirar a custodia propia es lo contrario: sacan los tokens del mercado.
  if(esExchange(tipoOrigen) && !esExchange(tipoDestino)){
    const aNueva = tipoDestino === 'WALLET_NUEVA';
    return {
      tipo:'SALIDA_DE_EXCHANGE', sesgo:'ALCISTA', cuenta:true,
      texto: aNueva
        ? `Salieron tokens de ${exchangeOrigen || 'un exchange'} hacia una wallet recién creada: alguien retirando para guardar, no para vender.`
        : `Salieron tokens de ${exchangeOrigen || 'un exchange'} hacia una wallet particular: se retiran del mercado.`,
    };
  }

  if(tipoDestino === 'QUEMA'){
    return { tipo:'QUEMA', sesgo:'ALCISTA', cuenta:true,
      texto:'Tokens quemados: se reduce la oferta en circulación.' };
  }

  // Entre wallets particulares no se puede saber la intención
  return { tipo:'TRANSFERENCIA_PRIVADA', sesgo:'NEUTRO', cuenta:false,
    texto:'Movimiento entre wallets particulares: sin significado claro para el precio.' };
}

// ───────────────────────────────────────────────────────────────────────────
// 3. MOTOR PRINCIPAL
// Toma las transferencias en crudo y devuelve evidencia estructurada.
// ───────────────────────────────────────────────────────────────────────────
export function analizarTransferencias(transferencias, red, opciones = {}){
  const lista = Array.isArray(transferencias) ? transferencias : [];
  if(!lista.length) return { hayDatos:false, motivo:'No hay transferencias para analizar.' };

  const minUsd = opciones.minUsd ?? 5000;      // por debajo de esto es ruido
  const historiales = opciones.historiales || {};
  const cache = new Map();
  const clasificar = (dir) => {
    const k = norm(dir);
    if(!cache.has(k)) cache.set(k, clasificarWallet(k, red, historiales[k] || {}));
    return cache.get(k);
  };

  const movimientos = [];
  let entradaUsd = 0, salidaUsd = 0, internoUsd = 0, ignoradoUsd = 0;
  let contEntradas = 0, contSalidas = 0, contInternos = 0;
  const walletsNuevas = new Set(), ballenasActivas = new Set();

  for(const t of lista){
    const usd = Number(t.valueUsd ?? t.usd ?? 0);
    if(!Number.isFinite(usd) || usd < minUsd){ ignoradoUsd += Math.max(0, usd||0); continue; }

    const oCls = clasificar(t.from), dCls = clasificar(t.to);
    const flujo = analizarFlujo(oCls.tipo, dCls.tipo, oCls.exchange, dCls.exchange);

    if(dCls.tipo === 'WALLET_NUEVA') walletsNuevas.add(norm(t.to));
    if(oCls.tipo === 'BALLENA' || dCls.tipo === 'BALLENA') ballenasActivas.add(norm(oCls.tipo==='BALLENA' ? t.from : t.to));

    if(!flujo.cuenta){
      if(flujo.tipo === 'MOVIMIENTO_INTERNO'){ internoUsd += usd; contInternos++; }
    } else if(flujo.sesgo === 'BAJISTA'){ entradaUsd += usd; contEntradas++; }
      else if(flujo.sesgo === 'ALCISTA'){ salidaUsd += usd; contSalidas++; }

    movimientos.push({
      usd: +usd.toFixed(0), hash: t.hash || null, ts: t.ts || null,
      origen: { tipo:oCls.tipo, exchange:oCls.exchange || null, confianza:oCls.confianza },
      destino: { tipo:dCls.tipo, exchange:dCls.exchange || null, confianza:dCls.confianza },
      flujo: flujo.tipo, sesgo: flujo.sesgo, cuenta: flujo.cuenta, texto: flujo.texto,
    });
  }

  const relevante = entradaUsd + salidaUsd;
  if(!relevante && !internoUsd){
    return { hayDatos:false, motivo:`Ninguna transferencia superó los $${minUsd.toLocaleString()} de umbral.`, movimientos:[] };
  }

  // El sesgo sale de comparar lo que REALMENTE cuenta, sin los movimientos internos
  const neto = salidaUsd - entradaUsd;
  const presion = relevante > 0 ? Math.max(-1, Math.min(1, neto/relevante)) : 0;
  const direccion = presion > 0.2 ? 'ALCISTA' : presion < -0.2 ? 'BAJISTA' : 'NEUTRO';

  const razones = [];
  if(contSalidas) razones.push(`$${(salidaUsd/1000).toFixed(0)}K salieron de exchanges en ${contSalidas} movimiento(s)`);
  if(contEntradas) razones.push(`$${(entradaUsd/1000).toFixed(0)}K entraron a exchanges en ${contEntradas} movimiento(s)`);
  if(walletsNuevas.size) razones.push(`${walletsNuevas.size} wallet(s) recién creadas recibieron tokens`);
  if(ballenasActivas.size) razones.push(`${ballenasActivas.size} wallet(s) grandes se movieron`);
  if(contInternos) razones.push(`$${(internoUsd/1000).toFixed(0)}K fueron movimientos internos de exchanges (NO se cuentan)`);

  return {
    hayDatos: true,
    red,
    presion: +presion.toFixed(3),
    direccion,
    confianza: Math.min(95, Math.round(Math.abs(presion)*70 + Math.min(25, movimientos.length*2))),
    entradaExchangeUsd: +entradaUsd.toFixed(0),
    salidaExchangeUsd: +salidaUsd.toFixed(0),
    movimientoInternoUsd: +internoUsd.toFixed(0),
    netoUsd: +neto.toFixed(0),
    walletsNuevas: walletsNuevas.size,
    ballenasActivas: ballenasActivas.size,
    movimientos: movimientos.sort((a,b)=>b.usd-a.usd).slice(0, 15),
    razones,
    resumen: direccion === 'NEUTRO'
      ? 'Los flujos de entrada y salida de exchanges están equilibrados.'
      : direccion === 'ALCISTA'
      ? `Salen más tokens de los exchanges de los que entran ($${(Math.abs(neto)/1000).toFixed(0)}K netos): se están retirando del mercado.`
      : `Entran más tokens a los exchanges de los que salen ($${(Math.abs(neto)/1000).toFixed(0)}K netos): suele preceder presión vendedora.`,
    aclaracion: 'Las wallets se clasifican por su comportamiento, no por una base de datos de identidades. Los movimientos internos de exchanges se detectan y se descartan para no contar el mismo dinero dos veces.',
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 4. PUENTE CON EL MOTOR
// Convierte el análisis en la estructura que espera TheHaton.
// NO suma al score: devuelve evidencia para registrar y medir después.
// ───────────────────────────────────────────────────────────────────────────
export function construirEvidenciaOnChain(analisis, dirTesis){
  if(!analisis?.hayDatos) return null;
  const acompana = analisis.direccion === 'NEUTRO' ? null
    : (analisis.direccion === 'ALCISTA' ? 'LONG' : 'SHORT') === dirTesis ? 'acompaña' : 'contradice';
  return {
    presion: analisis.presion,
    direccion: analisis.direccion === 'ALCISTA' ? 'LONG' : analisis.direccion === 'BAJISTA' ? 'SHORT' : 'NEUTRO',
    confianza: analisis.confianza,
    acompana,
    entradaUsd: analisis.entradaExchangeUsd,
    salidaUsd: analisis.salidaExchangeUsd,
    internoUsd: analisis.movimientoInternoUsd,
    walletsNuevas: analisis.walletsNuevas,
    ballenas: analisis.ballenasActivas,
    razones: analisis.razones,
    resumen: analisis.resumen,
  };
}

export const _EXCHANGES_CONOCIDOS = EXCHANGES_CONOCIDOS;
