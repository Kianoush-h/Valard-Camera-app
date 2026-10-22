// Offline support: serve app files from cache, refresh them in the background.
const CACHE = 'valard-camera-v9';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'stamp.js', 'ui.js', 'config.js', 'manifest.webmanifest', 'vendor/gsap.min.js',
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
  // Network first so phones always get the latest version; cache only when offline / slow signal.
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request);
    const fresh = fetch(e.request, { cache: 'no-cache' }).then(r => {
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    });
    if (!cached) return fresh;
    const timeout = new Promise(res => setTimeout(() => res(cached), 4000));
    return Promise.race([fresh.catch(() => cached), timeout]);
  }));
});
