// Офлайн-кэш: оболочка приложения обновляется в фоне, тяжёлые файлы модели берутся из кэша.
const VERSION = 'taichi-v26';
const SHELL = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-180.png',
  'js/app.js', 'js/store.js', 'js/kb.js', 'js/program.js', 'js/brain.js', 'js/ai-request.js', 'js/sync.js', 'js/interview.js', 'js/flows.js', 'js/flow-lines.js', 'js/theme.js', 'js/ambient.js', 'js/course.js', 'js/coach.js', 'js/voice.js', 'js/voicefx.js', 'js/sheet.js', 'js/figures.js', 'js/figplayer.js', 'js/guides.js', 'js/pose.js', 'js/master.js', 'js/charts.js', 'js/session.js', 'js/i18n.js', 'js/lang/en.js',
  'vendor/anthropic-sdk.mjs'];
const HEAVY = /\/(vendor\/mediapipe|models|audio|sounds)\//;

const HEAVY_CACHE = 'taichi-heavy-v1'; // голос, звуки и модель камеры переживают обновления приложения

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== HEAVY_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // Данные сервера никогда не берём из кэша.
  if (url.pathname.includes('/api/')) return;
  // Мелодии играются потоком частями (Range): такие запросы идут прямо в сеть.
  if (req.headers.has('range')) return;
  // Тяжёлые файлы (модель, голос, звуки) — из отдельного постоянного кэша.
  // Новая версия файла (другой ?v=) вытесняет старую, чтобы кэш не рос.
  if (HEAVY.test(url.pathname) && !url.pathname.endsWith('manifest.json')) {
    e.respondWith((async () => {
      const heavy = await caches.open(HEAVY_CACHE);
      const hit = await heavy.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      // Сохраняем в кэш параллельно с отдачей: ждать сохранения нельзя — Safari может зависнуть на копии ответа.
      if (res.ok && res.status === 200) {
        const copy = res.clone();
        e.waitUntil(heavy.delete(req, { ignoreSearch: true }).then(() => heavy.put(req, copy)).catch(() => {}));
      }
      return res;
    })());
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const fresh = () => fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
    // Всё остальное — сначала из сети, чтобы обновления приходили сразу; без сети или при медленном ответе — из кэша.
    try {
      return await Promise.race([fresh(), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), hit ? 4000 : 30000))]);
    } catch (err) {
      if (hit) return hit;
      if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
      throw err;
    }
  })());
});
