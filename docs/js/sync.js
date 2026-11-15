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
let editGen = 0; // счётчик правок: правка во время отправки не должна потеряться
let pendingAgain = false;
let started = false;
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
  // Новое устройство без своих данных (знакомство не пройдено) не должно затирать данные на сервере.
  dirty = !!state.profile?.onboarded;
  remember();
  setStatus({ state: cfg ? 'idle' : 'off', error: '' });
}

// Ключ доступа отправляем только по защищённому соединению (кроме своего компьютера при отладке).
const secureUrl = (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u);

export async function api(path, init = {}) {
  if (!cfg) throw new Error('no_server');
  if (!secureUrl(cfg.url)) throw Object.assign(new Error(t('Сервер недоступен. Проверьте адрес: он должен начинаться с https://')), { kind: 'insecure' });
  const r = await fetch(cfg.url + path, {
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}`, ...(init.headers || {}) },
  });
  if (r.status === 401) throw Object.assign(new Error(t('Сервер не принял ключ доступа.')), { kind: 'auth' });
  return r;
}

// Объединение копий. Дни объединяются по частям (занятия, боль, давление), записи журнала — из обеих копий,
// программа и память — более свежая. Пустые местные поля (новое устройство) не затирают серверные.
function mergeDay(r = {}, l = {}) {
  const sessions = { ...(r.sessions || {}) };
  for (const [k, v] of Object.entries(l.sessions || {})) {
    const o = sessions[k];
    sessions[k] = o && o.done && !v?.done ? o : { ...(o || {}), ...v };
  }
  // Приёмы пищи — по id из обеих копий (удалённые помечены, поэтому не воскресают).
  const meals = new Map();
  for (const m of [...(r.meals || []), ...(l.meals || [])]) { const o = meals.get(m.id); meals.set(m.id, o?.deleted ? o : m); }
  return { ...r, ...l, sessions, pain: { ...(r.pain || {}), ...(l.pain || {}) }, bp: l.bp || r.bp, checkin: l.checkin || r.checkin, food: { ...(r.food || {}), ...(l.food || {}) }, ...(meals.size ? { meals: [...meals.values()] } : {}) };
}
function merge(local, remote) {
  const out = { ...remote, ...local };
  const days = { ...(remote.days || {}) };
  for (const [d, v] of Object.entries(local.days || {})) days[d] = mergeDay(days[d], v);
  out.days = days;
  out.profile = !local.profile?.onboarded && remote.profile?.onboarded ? remote.profile : { ...(remote.profile || {}), ...(local.profile || {}) };
  out.intake = local.intake || remote.intake || null;
  const tasks = { ...(remote.tasks || {}) };
  for (const [k, v] of Object.entries(local.tasks || {})) tasks[k] = v || tasks[k];
  out.tasks = tasks;
  const rv = new Map();
  for (const r of [...(remote.reviews || []), ...(local.reviews || [])]) rv.set(`${r.date}|${r.decision}`, r);
  out.reviews = [...rv.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const byKey = (arr) => {
    const m = new Map();
    for (const e of arr || []) m.set(`${e.at}|${e.role}|${(e.text || '').slice(0, 40)}`, e);
    return [...m.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
  };
  out.chat = byKey([...(remote.chat || []), ...(local.chat || [])]).slice(-60);
  out.chats = {};
  for (const k of new Set([...Object.keys(remote.chats || {}), ...Object.keys(local.chats || {})])) out.chats[k] = byKey([...(remote.chats?.[k] || []), ...(local.chats?.[k] || [])]).slice(-60);
  out.log = byKey([...(remote.log || []), ...(local.log || [])]).slice(-400);
  if ((remote.memory?.updatedAt || 0) > (local.memory?.updatedAt || 0)) out.memory = remote.memory;
  if (!local.program || (remote.program?.updatedAt || 0) > (local.program?.updatedAt || 0)) out.program = remote.program || local.program;
  return out;
}
export const _merge = merge; // для проверки

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

async function push(attempt = 0) {
  if (!cfg) return;
  if (pushing) { pendingAgain = true; return; }
  pushing = true;
  pendingAgain = false;
  setStatus({ state: 'syncing' });
  let retry = false;
  try {
    const gen = editGen;
    const r = await api('/api/state', { method: 'PUT', body: JSON.stringify({ rev, state }) });
    if (r.status === 409) {
      const data = await r.json();
      applying = true;
      replaceState(merge(state, data.state));
      applying = false;
      rev = data.rev;
      remember();
      retry = attempt < 3;
      if (!retry) throw new Error(t('Нет связи с сервером'));
      return;
    }
    if (!r.ok) throw new Error(`${t('Сервер ответил')} ${r.status}`);
    rev = (await r.json()).rev;
    dirty = editGen !== gen; // правки, сделанные во время отправки, уйдут следующим заходом
    remember();
    setStatus({ state: 'ok', at: Date.now(), error: '', changed: false });
  } catch (e) {
    applying = false;
    setStatus({ state: 'error', error: e.message || t('Нет связи с сервером') });
  } finally {
    pushing = false;
    if (retry) push(attempt + 1);
    else if (pendingAgain || dirty) schedulePush(pendingAgain ? 0 : 2500);
  }
}

function schedulePush(ms = 2500) {
  clearTimeout(timer);
  timer = setTimeout(push, ms);
}

subscribe(() => {
  if (applying) return;
  editGen++;
  dirty = true;
  remember();
  if (cfg) schedulePush();
});

export function startSync() {
  if (!cfg) return;
  pull();
  if (started) return;
  started = true;
  document.addEventListener('visibilitychange', () => { if (!cfg) return; if (!document.hidden) pull(); else if (dirty) push(); });
}
