// Офлайн-кэш: оболочка приложения обновляется в фоне, тяжёлые файлы модели берутся из кэша.
const VERSION = 'taichi-v2';
const SHELL = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon-192.png',
  'js/app.js', 'js/store.js', 'js/course.js', 'js/coach.js', 'js/voice.js', 'js/pose.js', 'js/master.js', 'js/charts.js', 'js/session.js',
  'vendor/anthropic-sdk.mjs'];
const HEAVY = /\/(vendor\/mediapipe|models|audio)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const fresh = () => fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
    if (hit && HEAVY.test(url.pathname) && !url.pathname.endsWith('manifest.json')) return hit;
    if (hit) { fresh().catch(() => {}); return hit; }
    try { return await fresh(); } catch (err) {
      if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
      throw err;
    }
  })());
});
