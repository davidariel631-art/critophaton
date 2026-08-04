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
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      image: data.image || undefined,
      vibrate: [120, 60, 120],
      tag: data.tag || 'krax-general',
      renotify: true,
      requireInteraction: !!data.important,
      actions: [{ action: 'ver', title: '👁️ Ver' }],
      data: { url: data.url || './index.html' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './index.html';
  event.waitUntil(
    self.clients.matchAll({type:'window'}).then(clientList=>{
      for(const client of clientList){ if('focus' in client) return client.focus(); }
      if(self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
