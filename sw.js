/* Service Worker — Control Vehicular Papeles Nacionales S.A.S. v2.1 */
const CACHE_NAME = 'ctrl-vehicular-v2.1';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
];

/* Instalación: pre-cachear assets */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* Activación: limpiar cachés anteriores */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* Fetch: Network-first para API de Google, Cache-first para assets */
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Para peticiones a Google Apps Script: siempre red (no cachear datos)
  if(url.includes('script.google.com') || url.includes('fonts.googleapis.com') || url.includes('unpkg.com')){
    event.respondWith(
      fetch(event.request)
        .catch(() => new Response('{"error":"offline"}', {
          headers: {'Content-Type': 'application/json'}
        }))
    );
    return;
  }

  // Para assets locales: cache-first con fallback a red
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if(cached) return cached;
        return fetch(event.request)
          .then(response => {
            if(response && response.status === 200 && event.request.method === 'GET'){
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {
            // Fallback a index.html para navegación
            if(event.request.mode === 'navigate'){
              return caches.match('./index.html');
            }
          });
      })
  );
});
