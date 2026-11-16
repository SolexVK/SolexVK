// Переезд приложения на собственный адрес (например, https://taichi.aidemiko.ru).
// У браузера данные хранятся отдельно для каждого адреса, поэтому на новом адресе приложение открывается пустым,
// а всё приходит с сервера. Здесь:
//   1) старая копия (GitHub Pages) узнаёт от сервера новый адрес (`home` в /api/health), досылает свои правки
//      и предлагает перейти, скопировав ключ доступа;
//   2) новая копия на адресе сервера сама предлагает подключиться: нужен только ключ доступа (или #connect=… в адресе).
import { serverConfig, setServer, startSync, pull, flushSync } from './sync.js';
import { t } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SKIP = 'taichi.move.later';
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/; // только для проверки на своём компьютере

async function health(base) {
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(`${base}/api/health`, { cache: 'no-store', signal: ctl.signal });
    if (!r.ok || !/json/.test(r.headers.get('content-type') || '')) return null;
    return await r.json();
  } catch { return null; }
}

export async function checkMove(ui) {
  // Новый адрес: ключ в адресе (#connect=…) — подключаемся сразу и убираем ключ из адресной строки.
  const m = location.hash.match(/^#connect=([^&]+)/);
  if (m) {
    const token = decodeURIComponent(m[1]);
    history.replaceState(null, '', location.pathname + location.search);
    if (!serverConfig()) return connect(ui, location.origin, token);
  }
  const cfg = serverConfig();
  if (cfg) {
    // Старая копия: сервер сообщает, где теперь живёт приложение.
    if (new URL(cfg.url).origin === location.origin) return;
    try { if (sessionStorage.getItem(SKIP)) return; } catch { /* нет хранилища */ }
    const h = await health(cfg.url);
    const home = h?.home && String(h.home).replace(/\/+$/, '');
    if (!home || home === location.origin || !(/^https:\/\//.test(home) || LOCAL.test(home))) return;
    return offerMove(ui, home, cfg.token);
  }
  // Приложение открыто с адреса сервера и ещё не подключено — предлагаем ввести ключ.
  if (location.protocol !== 'https:' && !LOCAL.test(location.origin)) return;
  const h = await health(location.origin);
  if (h?.ok) offerConnect(ui);
}

function offerMove(ui, home, token) {
  ui.openSheet(`<h3>${t('Приложение переехало')}</h3>
    <p>${t('Теперь «Тайцзи» работает с вашего сервера: {h}. Все данные уже на сервере и перейдут вместе с вами.', { h: `<b>${esc(home.replace(/^https:\/\//, ''))}</b>` })}</p>
    <ol class="move-steps">
      <li>${t('Нажмите «Скопировать ключ доступа».')}</li>
      <li>${t('Нажмите «Открыть новый адрес» — он откроется в Safari.')}</li>
      <li>${t('В Safari: «Поделиться» → «На экран „Домой“».')}</li>
      <li>${t('Откройте новый значок и вставьте ключ — данные загрузятся сами.')}</li>
      <li>${t('Старый значок после этого можно удалить.')}</li>
    </ol>
    <button type="button" class="btn wide" id="mv-copy">${t('Скопировать ключ доступа')}</button>
    <button type="button" class="btn wide" id="mv-open">${t('Открыть новый адрес')}</button>
    <button type="button" class="btn ghost wide" id="mv-later">${t('Напомнить позже')}</button>`);
  document.getElementById('mv-copy').addEventListener('click', () => ui.copyText(token));
  document.getElementById('mv-open').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    await flushSync(); // последние правки — на сервер до перехода
    location.href = `${home}/#connect=${encodeURIComponent(token)}`;
  });
  document.getElementById('mv-later').addEventListener('click', () => { try { sessionStorage.setItem(SKIP, '1'); } catch { /* нет хранилища */ } ui.closeSheet(); });
}

function offerConnect(ui) {
  ui.openSheet(`<h3>${t('Подключение к вашему серверу')}</h3>
    <p>${t('Приложение открыто с вашего сервера. Вставьте ключ доступа — дневник, программа, питание и беседы с мастерами загрузятся с сервера.')}</p>
    <label for="mv-tok">${t('Ключ доступа к серверу')}</label>
    <input id="mv-tok" type="password" autocomplete="off" autocapitalize="off" spellcheck="false">
    <p class="srv-status" id="mv-status" role="status"></p>
    <button type="button" class="btn wide" id="mv-go">${t('Подключить')}</button>
    <button type="button" class="btn ghost wide" id="mv-skip">${t('Начать без сервера')}</button>`);
  document.getElementById('mv-go').addEventListener('click', () => connect(ui, location.origin, document.getElementById('mv-tok').value.trim()));
  document.getElementById('mv-skip').addEventListener('click', () => ui.closeSheet());
}

async function connect(ui, url, token) {
  const st = document.getElementById('mv-status');
  const say = (x) => { if (st) st.textContent = x; else ui.toast(x); };
  if (token.length < 16) return say(t('Ключ слишком короткий. Скопируйте его целиком.'));
  say(t('Проверяю…'));
  try {
    const r = await fetch(`${url}/api/state`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401) return say(t('Сервер не принял ключ доступа.'));
    if (!r.ok) return say(t('Сервер ответил ошибкой {n}.', { n: r.status }));
  } catch { return say(t('Нет связи. Проверьте интернет.')); }
  setServer(url, token);
  await pull();
  startSync();
  ui.closeSheet();
  ui.toast(t('Сервер подключён, данные загружены.'));
  ui.render();
}
