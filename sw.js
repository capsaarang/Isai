const CACHE = 'isai-v1.4.0';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'vendor/jsmediatags.min.js', 'vendor/mqtt.min.js', 'icons/icon.svg', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first, so updates show up on the next open; fall back to the saved copy when offline.
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(e.request, { cache: 'no-cache', signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    } catch {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      return hit || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error());
    }
  })());
});
