// Offline support: serve app files from cache, refresh them in the background.
const CACHE = 'valard-camera-v2';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'stamp.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('valard-camera-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Only app files: skip uploads, map tiles, geocoding and the network-time check (has a query string).
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.search) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request);
    const fresh = fetch(e.request).then(r => {
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    }).catch(() => cached);
    if (cached) { e.waitUntil(fresh); return cached; }
    return fresh;
  }));
});
