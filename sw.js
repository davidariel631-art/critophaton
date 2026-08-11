// KRAX Capital — service worker mínimo, solo para que el navegador reconozca la app como instalable.
// No cachea agresivamente (los datos son en vivo), solo permite que "Agregar a inicio" / "Instalar app" aparezca.
const CACHE_NAME = 'krax-capital-v2';
const CORE_ASSETS = ['./', './index.html', './thehaton-engine.js', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Solo intervenimos en pedidos al propio sitio (no APIs externas) — pass-through para todo lo demás.
  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return;
  event.respondWith(
    // 'no-store' asegura que el pedido a la red nunca use una copia vieja guardada por el navegador
    // (el caché de la Service Worker es distinto, ese lo manejamos nosotros abajo) — así, si subiste
    // un archivo nuevo, la próxima vez que se abra la app se trae la versión real, no una vieja.
    fetch(event.request, {cache:'no-store'}).catch(() => caches.match(event.request))
  );
});

// Si la web le pide a este service worker que tome el control ya mismo (en vez de esperar a que se
// cierren todas las pestañas viejas), lo hacemos — así el botón de "hay una versión nueva" funciona
// de verdad en el momento, sin tener que cerrar y volver a abrir la app.
self.addEventListener('message', (event) => {
  if(event.data === 'skipWaiting') self.skipWaiting();
});

// ---- Notificaciones push de verdad (llegan aunque la app esté cerrada) ----
// El sistema operativo controla el color/estilo visual de la notificación en sí (eso no se puede
// tocar desde acá, es una limitación real de las notificaciones web) — pero sí se puede mejorar
// todo lo que SÍ está bajo control: vibración, botón de acción directo, y que se agrupen bien
// las notificaciones de una misma moneda en vez de amontonarse todas sueltas.
self.addEventListener('push', (event) => {
  let data = { title: 'KRAX Capital', body: 'Tenés una novedad.' };
  try{ if(event.data) data = event.data.json(); }catch(e){}
  event.waitUntil(
    self.registration.showNotification(data.title || 'KRAX Capital', {
      body: data.body || '',
      // El logo de KRAX a color, que se ve dentro de la notificación
      icon: 'icons/krax-notification.png',
      // El badge va a la barra de estado y Android lo convierte a SILUETA monocromática.
      // Por eso es una versión blanca sobre transparente: si tuviera color o fondo, el sistema
      // lo mostraría como un cuadrado gris genérico.
      badge: 'icons/krax-badge.png',
      vibrate: [120, 60, 120],
      // CADA notificación necesita un tag ÚNICO. Antes todas usaban 'krax-general', y Android
      // interpreta que es la misma notificación actualizándose: la nueva reemplazaba a la anterior
      // y solo se veía una. Con un tag único cada señal queda apilada hasta que la descartes.
      tag: data.tag || `krax-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      // Se agrupan bajo KRAX para que Android las junte visualmente sin pisarlas.
      // Así ves "KRAX CAPITAL" con todas adentro, y las podés expandir.
      renotify: false,
      requireInteraction: !!data.important,
      // Al expandir la notificación se ve la marca. Solo en señales, para no cargar los avisos
      // de gestión que llegan más seguido.
      // Una sola propiedad `image`: si el payload trae una, se usa esa; si no, el banner de
      // marca en las señales. Antes había dos declaraciones y la segunda anulaba a la primera.
      image: data.image || (data.grupo === 'senal' ? 'icons/krax-banner.png' : undefined),
      actions: [{ action:'ver', title: data.grupo === 'senal' ? '👁 Ver análisis' : '👁 Ver gestión' }],
      // Se guarda el grupo y la moneda para poder abrir la pantalla que corresponde:
      // una señal lleva al análisis de esa moneda, un cierre lleva al panel de TheHaton.
      data: { url: data.url || './index.html', grupo: data.grupo || 'general', symbol: data.symbol || null },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // La URL se resuelve a absoluta contra el alcance del service worker. Una URL relativa como
  // './index.html' puede resolverse distinto según desde dónde se abra, sobre todo con la app
  // instalada como PWA — y ahí el "Ver" no llevaba a ningún lado.
  const d = event.notification.data || {};
  // Cada tipo de aviso abre donde corresponde: una señal va al análisis de esa moneda,
  // los avisos de gestión y cierre van al panel de TheHaton.
  let destino = d.url || './index.html';
  if(d.symbol && d.grupo === 'senal') destino = `./index.html#analizar=${encodeURIComponent(d.symbol)}`;
  else if(d.grupo === 'gestion' || d.grupo === 'cierre') destino = './index.html#thehaton';
  const urlAbsoluta = new URL(destino, self.registration.scope).href;

  event.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type:'window', includeUncontrolled:true });

    for(const cliente of ventanas){
      // BUG CORREGIDO: antes hacía focus() y retornaba SIN navegar. Si la app ya estaba abierta,
      // tocar "Ver" solo la traía al frente y parecía que no hacía nada.
      // Ahora primero navega a la pantalla correcta y después enfoca.
      try{
        if('navigate' in cliente && cliente.url !== urlAbsoluta){
          const navegado = await cliente.navigate(urlAbsoluta);
          if(navegado && 'focus' in navegado) return navegado.focus();
        }
        if('focus' in cliente) return cliente.focus();
      }catch(e){
        // Algunos navegadores no permiten navigate() desde el SW: al menos se enfoca la ventana.
        if('focus' in cliente) return cliente.focus();
      }
    }

    // No había ninguna ventana abierta: se abre una nueva
    if(self.clients.openWindow) return self.clients.openWindow(urlAbsoluta);
  })());
});
