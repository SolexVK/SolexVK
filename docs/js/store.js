// Хранилище: всё лежит только на этом устройстве (localStorage).
const KEY = 'taichi.state.v1';
const KEY_API = 'taichi.apiKey';

export function dateStr(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return dateStr(d);
}
export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

function defaults() {
  return {
    v: 1,
    profile: {
      onboarded: false, name: '', startDate: dateStr(),
      age: null, height: null, startWeight: null, startWaist: null, health: '',
    },
    settings: { voice: true, voiceURI: '', rate: 0.95, camera: true, handsFree: false, countAloud: true },
    days: {},
    tasks: {},
    chat: [],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const s = JSON.parse(raw);
    const d = defaults();
    return {
      ...d, ...s,
      profile: { ...d.profile, ...(s.profile || {}) },
      settings: { ...d.settings, ...(s.settings || {}) },
      days: s.days || {}, tasks: s.tasks || {}, chat: s.chat || [],
    };
  } catch {
    return defaults();
  }
}

export const state = load();
const subs = new Set();
let storageOk = true;

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    storageOk = true;
  } catch {
    storageOk = false;
  }
  subs.forEach((fn) => fn());
}
export const isStorageOk = () => storageOk;
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

export function day(date = dateStr()) {
  if (!state.days[date]) state.days[date] = { sessions: {}, pain: {} };
  const d = state.days[date];
  d.sessions ||= {};
  d.pain ||= {};
  return d;
}
export function peekDay(date) { return state.days[date] || null; }

export function getApiKey() {
  try { return localStorage.getItem(KEY_API) || ''; } catch { return ''; }
}
export function setApiKey(k) {
  try {
    if (k) localStorage.setItem(KEY_API, k.trim()); else localStorage.removeItem(KEY_API);
  } catch { /* хранилище недоступно */ }
}

// Экспорт без ключа API: ключ не должен попадать в файлы и переписку.
export function exportJSON() { return JSON.stringify(state, null, 2); }
export function importJSON(text) {
  const s = JSON.parse(text);
  if (!s || typeof s !== 'object' || !s.days) throw new Error('Это не похоже на копию данных приложения.');
  const d = defaults();
  Object.assign(state, d, s, {
    profile: { ...d.profile, ...(s.profile || {}) },
    settings: { ...d.settings, ...(s.settings || {}) },
  });
  save();
}
export function resetAll() {
  const d = defaults();
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, d);
  save();
}

// ---- производные величины ----
export const SESSION_KINDS = ['morning', 'day', 'evening'];

export function sessionsDone(date) {
  const d = peekDay(date);
  if (!d) return 0;
  return SESSION_KINDS.filter((k) => d.sessions?.[k]?.done).length;
}
// Основных занятий в день два (утро и день); вечер — отдых, в счёт 14 не идёт.
export function coreDone(date) {
  const d = peekDay(date);
  if (!d) return 0;
  return ['morning', 'day'].filter((k) => d.sessions?.[k]?.done).length;
}
export function streak(today = dateStr()) {
  let n = 0;
  let cur = today;
  if (coreDone(cur) === 0) cur = addDays(cur, -1);
  while (coreDone(cur) > 0) { n++; cur = addDays(cur, -1); }
  return n;
}
export function weekStart(date) {
  // Недели курса считаются от даты старта.
  const off = ((daysBetween(state.profile.startDate, date) % 7) + 7) % 7;
  return addDays(date, -off);
}
export function weekCore(date = dateStr()) {
  const ws = weekStart(date);
  let n = 0;
  for (let i = 0; i < 7; i++) n += coreDone(addDays(ws, i));
  return n;
}
export function lastValue(field, upTo = dateStr()) {
  const dates = Object.keys(state.days).filter((d) => d <= upTo).sort().reverse();
  for (const d of dates) {
    const v = state.days[d][field];
    if (v != null && v !== '') return { date: d, value: v };
  }
  return null;
}
export function series(getter) {
  return Object.keys(state.days).sort()
    .map((d) => ({ date: d, value: getter(state.days[d]) }))
    .filter((p) => p.value != null && p.value !== '' && !Number.isNaN(Number(p.value)))
    .map((p) => ({ date: p.date, value: Number(p.value) }));
}
