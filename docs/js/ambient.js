// Фоновое звучание: ручей, тянущийся фон, струны в пятиступенной гамме, колокольчик, поющая чаша, бамбук.
// Всё синтезируется на телефоне в реальном времени и меняется по экрану, упражнению и ритму.
// Пока говорит мастер, музыка приглушается.
import { state } from './store.js';
import { audioContext, onSpeaking } from './voice.js';

const BASE = 0.3; // общий уровень при громкости 100 %: фон всегда заметно тише голоса
// Пятиступенная гамма гун от соль: G A B D E.
const SCALE = [196.0, 220.0, 246.94, 293.66, 329.63, 392.0, 440.0, 493.88, 587.33, 659.25];
const ROOT = 98.0; // соль большой октавы

// Сцены: уровни слоёв и плотность событий (событий в секунду).
const SCENES = {
  off: { water: 0, drone: 0, pluck: 0, bell: 0 },
  home: { water: 0.5, drone: 0.22, pluck: 0.07, bell: 0.015, bright: 1400 },
  talk: { water: 0.22, drone: 0.28, pluck: 0.025, bell: 0.008, bright: 1100 },
  breath: { water: 0.18, drone: 0.42, pluck: 0, bell: 0, bright: 900 },
  warmup: { water: 0.3, drone: 0.18, pluck: 0.03, bell: 0, bamboo: 0.45, bright: 1500 },
  qigong: { water: 0.28, drone: 0.32, pluck: 0, bell: 0, breathPluck: true, bright: 1200 },
  hold: { water: 0.42, drone: 0.3, pluck: 0.05, bell: 0, minuteBell: true, bright: 1000 },
  strength: { water: 0.2, drone: 0.22, pluck: 0.05, bell: 0, bamboo: 0.65, bright: 1700 },
  rest: { water: 0.32, drone: 0.45, pluck: 0.015, bell: 0, bright: 700, slow: true },
};

let ctx = null;
let out = null; // громкость из настроек
let duck = null; // приглушение под голос
let water = null;
let waterFilter = null;
let drone = null;
let droneFilter = null;
let droneGain = null;
let scene = 'off';
let cfg = SCENES.off;
let running = false;
let paused = false;
let timer = 0;
let lastBell = 0;
let holdStart = 0;
const plucks = new Map();
let noiseBuf = null;

const now = () => ctx.currentTime;
const ramp = (param, v, t = 1.5) => { param.cancelScheduledValues(now()); param.setTargetAtTime(v, now(), t / 3); };
const enabled = () => state.settings.music !== false;
const level = () => (enabled() ? BASE * (state.settings.musicVolume ?? 0.5) : 0);

function noise() {
  if (noiseBuf) return noiseBuf;
  const len = ctx.sampleRate * 4;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  // «Розоватый» шум: сглаженный белый, мягче для слуха.
  let b0 = 0; let b1 = 0; let b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.997 * b0 + w * 0.029591;
    b1 = 0.985 * b1 + w * 0.032534;
    b2 = 0.95 * b2 + w * 0.048056;
    d[i] = (b0 + b1 + b2 + w * 0.04) * 0.6;
  }
  return noiseBuf;
}

function build() {
  ctx = audioContext();
  if (!ctx) return false;
  out = ctx.createGain();
  out.gain.value = 0;
  duck = ctx.createGain();
  duck.gain.value = 1;
  out.connect(duck).connect(ctx.destination);

  // Ручей: шум через два полосовых фильтра, частоты медленно блуждают.
  water = ctx.createGain();
  water.gain.value = 0;
  const src = ctx.createBufferSource();
  src.buffer = noise();
  src.loop = true;
  waterFilter = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
  waterFilter.forEach((f, k) => { f.type = 'bandpass'; f.frequency.value = k ? 2400 : 900; f.Q.value = k ? 3 : 1.4; src.connect(f).connect(water); });
  water.connect(out);
  src.start();

  // Тянущийся фон: основной тон и квинта, мягко через фильтр.
  droneGain = ctx.createGain();
  droneGain.gain.value = 0;
  droneFilter = ctx.createBiquadFilter();
  droneFilter.type = 'lowpass';
  droneFilter.frequency.value = 900;
  drone = [ROOT, ROOT * 1.5, ROOT * 2.003].map((f, k) => {
    const o = ctx.createOscillator();
    o.type = k === 1 ? 'triangle' : 'sine';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = [0.5, 0.22, 0.14][k];
    o.connect(g).connect(droneFilter);
    o.start();
    return o;
  });
  // Медленное «дыхание» фона.
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.07;
  lfoGain.gain.value = 0.12;
  lfo.connect(lfoGain).connect(droneGain.gain);
  lfo.start();
  droneFilter.connect(droneGain).connect(out);

  onSpeaking((speaking) => {
    if (!ctx || !duck) return;
    // Пока говорит мастер — тише; после фразы плавно возвращаемся.
    duck.gain.cancelScheduledValues(now());
    duck.gain.setTargetAtTime(speaking ? 0.32 : 1, now(), speaking ? 0.08 : 0.5);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) mute(); else apply(); });
  return true;
}

// ---- события ----
function pluckBuffer(f) {
  const key = Math.round(f);
  if (plucks.has(key)) return plucks.get(key);
  // Карплус — Стронг: щипок струны, похожий на гучжэн.
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 2.6);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const N = Math.max(2, Math.round(sr / f));
  const ring = new Float32Array(N);
  for (let i = 0; i < N; i++) ring[i] = (Math.random() * 2 - 1) * (1 - i / N);
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const a = ring[idx];
    const b = ring[(idx + 1) % N];
    ring[idx] = 0.4985 * (a + b);
    d[i] = a;
    idx = (idx + 1) % N;
  }
  plucks.set(key, buf);
  return buf;
}

function pluck(f, vel = 0.5, when = 0) {
  const t = now() + when;
  const s = ctx.createBufferSource();
  s.buffer = pluckBuffer(f);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cfg.bright || 1300;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel * 0.9, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 2.5);
  s.connect(lp).connect(g).connect(out);
  s.start(t);
  s.stop(t + 2.6);
}

function bell(f = 1318.5, vel = 0.4, when = 0) {
  // Колокольчик: частотная модуляция с негармоническим отношением.
  const t = now() + when;
  const car = ctx.createOscillator();
  const mod = ctx.createOscillator();
  const mg = ctx.createGain();
  const g = ctx.createGain();
  car.frequency.value = f;
  mod.frequency.value = f * 1.41;
  mg.gain.setValueAtTime(f * 1.2, t);
  mg.gain.exponentialRampToValueAtTime(f * 0.02, t + 2.5);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vel * 0.35, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 4.5);
  mod.connect(mg).connect(car.frequency);
  car.connect(g).connect(out);
  car.start(t); mod.start(t);
  car.stop(t + 4.6); mod.stop(t + 4.6);
}

function bowl(f = 196, vel = 0.5, when = 0) {
  // Поющая чаша: несколько негармонических призвуков с биениями, долгое затухание.
  const t = now() + when;
  [[1, 1], [1.004, 0.6], [2.76, 0.35], [2.765, 0.25], [5.4, 0.12]].forEach(([r, a]) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f * r;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel * a * 0.3, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 9 / Math.sqrt(r));
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 9.2);
  });
}

function bamboo(vel = 0.5, when = 0) {
  // Удар по бамбуку: короткий тон с падением высоты и щелчок.
  const t = now() + when;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(620, t);
  o.frequency.exponentialRampToValueAtTime(430, t + 0.06);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vel * 0.5, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  o.connect(g).connect(out);
  o.start(t); o.stop(t + 0.2);
  const n = ctx.createBufferSource();
  n.buffer = noise();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 9;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(vel * 0.6, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  n.connect(bp).connect(ng).connect(out);
  n.start(t, Math.random() * 3, 0.06);
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---- планировщик ----
function tick() {
  if (!running || paused || document.hidden || !enabled()) return;
  const dt = 0.25;
  const slow = cfg.slow ? 0.6 : 1;
  if (cfg.pluck && Math.random() < cfg.pluck * dt * slow) {
    // Короткая фраза из 1–3 нот гаммы.
    const start = Math.floor(Math.random() * 6);
    const n = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) pluck(SCALE[Math.min(SCALE.length - 1, start + k * (Math.random() < 0.5 ? 1 : 2))], 0.32 - k * 0.06, k * (0.35 + Math.random() * 0.3) / slow);
  }
  if (cfg.bell && Math.random() < cfg.bell * dt) bell(pick([1174.7, 1318.5, 1568]), 0.25);
  if (cfg.minuteBell && holdStart && now() - holdStart >= 60 && now() - lastBell > 55) { bell(1568, 0.3); lastBell = now(); holdStart = now(); }
  // Блуждание ручья.
  waterFilter[0].frequency.setTargetAtTime(700 + Math.random() * 700, now(), 1.2);
  waterFilter[1].frequency.setTargetAtTime(1900 + Math.random() * 1400, now(), 0.6);
}

function apply() {
  if (!ctx) return;
  const lv = paused ? 0 : level();
  ramp(out.gain, lv, 1.2);
  ramp(water.gain, cfg.water || 0, 2);
  ramp(droneGain.gain, (cfg.drone || 0) * 0.5, 2.5);
  ramp(droneFilter.frequency, cfg.bright ? cfg.bright * 0.6 : 600, 2);
}

function mute() { if (out) ramp(out.gain, 0, 0.6); }

// ---- открытый интерфейс ----
export function start() {
  if (running) return;
  if (!ctx && !build()) return;
  running = true;
  timer = setInterval(tick, 250);
  apply();
}

export function setScene(name) {
  if (!SCENES[name] || name === scene) return;
  scene = name;
  cfg = SCENES[name];
  if (name === 'hold') { holdStart = ctx ? now() : 0; lastBell = 0; }
  if (ctx) apply();
}

export function setPaused(p) {
  paused = !!p;
  if (ctx) apply();
}

// Обновить громкость после изменения настроек.
export function refresh() { if (ctx) apply(); else if (enabled()) start(); }

// Такт упражнения: музыка следует ритму счёта и дыхания.
export function beat({ breath, dur = 2, rep = 0 } = {}) {
  if (!ctx || !running || paused || !enabled()) return;
  if (cfg.bamboo && rep) bamboo(cfg.bamboo * (rep % 4 === 1 ? 1 : 0.7));
  if (breath && (scene === 'breath' || scene === 'rest')) {
    // Фон нарастает на вдохе и стихает на выдохе.
    const peak = (cfg.drone || 0.3) * (breath === 'in' ? 0.85 : 0.35);
    droneGain.gain.cancelScheduledValues(now());
    droneGain.gain.setTargetAtTime(peak, now(), dur / 3);
    droneFilter.frequency.setTargetAtTime(breath === 'in' ? 1200 : 500, now(), dur / 3);
    if (breath === 'in' && rep === 1) bowl(ROOT * 2, 0.45);
  }
  if (cfg.breathPluck && breath) {
    // Арпеджио вверх на вдохе, вниз на выдохе.
    const notes = breath === 'in' ? [0, 1, 2, 3, 4] : [7, 5, 4, 2, 0];
    const step = Math.min(0.9, dur / notes.length);
    notes.forEach((n, k) => pluck(SCALE[n], 0.26 - k * 0.025, k * step));
  }
}

export function chime(kind = 'bell') {
  if (!ctx || !running || !enabled()) return;
  if (kind === 'end') { [0, 1.6, 3.2].forEach((w) => bell(1318.5, 0.35, w)); bowl(ROOT * 2, 0.4, 0.2); }
  else if (kind === 'bowl') bowl(ROOT * 2, 0.45);
  else bell(1568, 0.3);
}

// Для проверки: доступ к выходу музыки (запись пробных фрагментов).
export const debugTap = () => ({ ctx, out: duck });
