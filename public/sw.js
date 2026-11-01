// Offline shell: cache static assets (network-first, cache fallback). API calls always go to the network.
const V = 'dlnavi-v20';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/data.js', '/js/parks/dl.js', '/js/parks/dca.js', '/js/engine.js', '/js/map.js', '/js/share.js', '/icon.svg', '/icon-180.png', '/icon-512.png', '/manifest.webmanifest',
  '/fonts/mplus-rounded-1c-500.woff2', '/fonts/mplus-rounded-1c-700.woff2', '/fonts/mplus-rounded-1c-800.woff2',
  ...['land-day', 'land-sunset', 'land-night', 'dca-day', 'dca-sunset', 'dca-night', 'clouds', 'bokeh', 'waves', 'skyline'].map((n) => `/img/park/${n}.webp`),
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  // Network-first (fresh code when online), cache fallback when the signal drops inside the park.
  // Always revalidate app code with the server (no stale JS from the browser's HTTP cache);
  // fonts / vendor files / artwork are immutable and may come from cache.
  const fresh = !/^\/(fonts|vendor|img)\//.test(u.pathname);
  e.respondWith(fetch(e.request, fresh ? { cache: 'no-cache' } : undefined).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(V).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('/'))));
});
