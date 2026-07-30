// KRAX Capital — service worker mínimo, solo para que el navegador reconozca la app como instalable.
// No cachea agresivamente (los datos son en vivo), solo permite que "Agregar a inicio" / "Instalar app" aparezca.
const CACHE_NAME = 'krax-capital-v1';
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
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ---- Notificaciones push de verdad (llegan aunque la app esté cerrada) ----
self.addEventListener('push', (event) => {
  let data = { title: 'KRAX Capital', body: 'Tenés una novedad.' };
  try{ if(event.data) data = event.data.json(); }catch(e){}
  event.waitUntil(
    self.registration.showNotification(data.title || 'KRAX Capital', {
      body: data.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
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
