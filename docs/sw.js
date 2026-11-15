// Офлайн-кэш: оболочка приложения обновляется в фоне, тяжёлые файлы модели берутся из кэша.
const VERSION = 'taichi-v12';
const SHELL = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon-192.png',
  'js/app.js', 'js/store.js', 'js/kb.js', 'js/program.js', 'js/brain.js', 'js/ai-request.js', 'js/sync.js', 'js/interview.js', 'js/flows.js', 'js/flow-lines.js', 'js/theme.js', 'js/ambient.js', 'js/course.js', 'js/coach.js', 'js/voice.js', 'js/voicefx.js', 'js/sheet.js', 'js/figures.js', 'js/guides.js', 'js/pose.js', 'js/master.js', 'js/charts.js', 'js/session.js', 'js/i18n.js', 'js/lang/en.js',
  'vendor/anthropic-sdk.mjs'];
const HEAVY = /\/(vendor\/mediapipe|models|audio|sounds)\//;

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
  // Мелодии играются потоком частями (Range): такие запросы идут прямо в сеть.
  if (req.headers.has('range')) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const fresh = () => fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
    // Тяжёлые файлы (модель, голос) — из кэша. Всё остальное — сначала из сети, чтобы обновления
    // приходили сразу; без сети или при медленном ответе — из кэша.
    if (hit && HEAVY.test(url.pathname) && !url.pathname.endsWith('manifest.json')) return hit;
    try {
      return await Promise.race([fresh(), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), hit ? 4000 : 30000))]);
    } catch (err) {
      if (hit) return hit;
      if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
      throw err;
    }
  })());
});
