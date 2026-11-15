// Синхронизация с собственным сервером ученика: дневник, анкета, программа, диалоги и память мастера.
// Приложение работает и без сервера; при настроенном сервере данные хранятся там и на телефоне.
import { state, replaceState, subscribe } from './store.js';
import { t } from './i18n.js';

const KEY = 'taichi.server';
let cfg = load();
let rev = Number(localStorage.getItem('taichi.server.rev') || 0);
let dirty = localStorage.getItem('taichi.server.dirty') === '1';
let timer = null;
let pushing = false;
let applying = false;
const subs = new Set();
let status = { state: cfg ? 'idle' : 'off', at: null, error: '' };

function load() {
  try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); return c?.url && c?.token ? c : null; } catch { return null; }
}
const setStatus = (s) => { status = { ...status, ...s }; subs.forEach((fn) => fn(status)); };
const remember = () => {
  try { localStorage.setItem('taichi.server.rev', String(rev)); localStorage.setItem('taichi.server.dirty', dirty ? '1' : '0'); } catch { /* noop */ }
};

export const serverConfig = () => cfg;
export const syncStatus = () => status;
export function onSyncStatus(fn) { subs.add(fn); return () => subs.delete(fn); }

export function setServer(url, token) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  cfg = u && token ? { url: u, token: String(token).trim() } : null;
  try { if (cfg) localStorage.setItem(KEY, JSON.stringify(cfg)); else localStorage.removeItem(KEY); } catch { /* noop */ }
  rev = 0;
  dirty = true;
  remember();
  setStatus({ state: cfg ? 'idle' : 'off', error: '' });
}

// Ключ доступа отправляем только по защищённому соединению (кроме своего компьютера при отладке).
const secureUrl = (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u);

export async function api(path, init = {}) {
  if (!cfg) throw new Error('no_server');
  if (!secureUrl(cfg.url)) throw Object.assign(new Error(t('Сервер недоступен. Проверьте адрес: он должен начинаться с https://')), { kind: 'insecure' });
  const r = await fetch(cfg.url + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}`, ...(init.headers || {}) },
  });
  if (r.status === 401) throw Object.assign(new Error(t('Сервер не принял ключ доступа.')), { kind: 'auth' });
  return r;
}

// Объединение копий: дни и записи берём из обеих, при совпадении — свежую локальную версию.
function merge(local, remote) {
  const out = { ...remote, ...local };
  out.days = { ...(remote.days || {}), ...(local.days || {}) };
  const byKey = (arr) => {
    const m = new Map();
    for (const e of arr || []) m.set(`${e.at}|${e.role}|${(e.text || '').slice(0, 40)}`, e);
    return [...m.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
  };
  out.chat = byKey([...(remote.chat || []), ...(local.chat || [])]).slice(-60);
  out.log = byKey([...(remote.log || []), ...(local.log || [])]).slice(-400);
  if ((remote.memory?.updatedAt || 0) > (local.memory?.updatedAt || 0)) out.memory = remote.memory;
  if ((remote.program?.updatedAt || 0) > (local.program?.updatedAt || 0)) out.program = remote.program;
  return out;
}

export async function pull() {
  if (!cfg) return false;
  setStatus({ state: 'syncing' });
  try {
    const r = await api('/api/state');
    if (!r.ok) throw new Error(`${t('Сервер ответил')} ${r.status}`);
    const data = await r.json();
    let changed = false;
    if (data.state && data.rev !== rev) {
      changed = true;
      applying = true;
      replaceState(dirty ? merge(state, data.state) : data.state);
      applying = false;
      rev = data.rev;
      remember();
    }
    setStatus({ state: 'ok', at: Date.now(), error: '', changed });
    if (dirty) schedulePush(0);
    return true;
  } catch (e) {
    applying = false;
    setStatus({ state: 'error', error: e.message || t('Нет связи с сервером') });
    return false;
  }
}

async function push() {
  if (!cfg || pushing) return;
  pushing = true;
  setStatus({ state: 'syncing' });
  try {
    const r = await api('/api/state', { method: 'PUT', body: JSON.stringify({ rev, state }) });
    if (r.status === 409) {
      const data = await r.json();
      applying = true;
      replaceState(merge(state, data.state));
      applying = false;
      rev = data.rev;
      pushing = false;
      return push();
    }
    if (!r.ok) throw new Error(`${t('Сервер ответил')} ${r.status}`);
    rev = (await r.json()).rev;
    dirty = false;
    remember();
    setStatus({ state: 'ok', at: Date.now(), error: '', changed: false });
  } catch (e) {
    applying = false;
    setStatus({ state: 'error', error: e.message || t('Нет связи с сервером') });
  } finally {
    pushing = false;
  }
}

function schedulePush(ms = 2500) {
  clearTimeout(timer);
  timer = setTimeout(push, ms);
}

subscribe(() => {
  if (applying) return;
  dirty = true;
  remember();
  if (cfg) schedulePush();
});

export function startSync() {
  if (!cfg) return;
  pull();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); else if (dirty) push(); });
}
