// Фоновое звучание из живых записей (папка sounds/).
// Три слоя: тихая мелодия задаёт настроение; поверх — природа (фонтан, капли, ветер, птицы);
// по ходу упражнений — колокольчики, поющая чаша, гонг и деревянный блок на счёт.
// Пока говорит мастер, всё приглушается.
import { state } from './store.js';
import { audioContext, onSpeaking } from './voice.js';

const DIR = 'sounds/';
const BASE = 0.8; // общий уровень при громкости 100 %
// Баланс (единицы громкости LUFS при полной громкости): мелодия около −29,5 — чуть громче всего остального;
// вода, ветер, птицы фоном около −39; колокольчики, чаша, гонг, блок и редкие птицы — около −38, на уровне воды.
const MUSIC = 0.5;
const TRACKS = ['kalimba', 'xiao', 'dizi', 'healing', 'wisdom', 'temple', 'shakuhachi'];
// Мелодии по времени суток: утром светлые флейты и калимба, днём спокойные, вечером храмовые.
const DAYPART = { morning: ['kalimba', 'xiao', 'dizi'], day: ['healing', 'wisdom', 'dizi'], evening: ['temple', 'shakuhachi', 'wisdom'] };
// Редкие птичьи трели вдали: дрозд, зарянка, крапивник.
const BIRDS = ['bird_blackbird1', 'bird_blackbird2', 'bird_blackbird3', 'bird_blackbird4', 'bird_robin1', 'bird_robin2', 'bird_robin3', 'bird_wren1', 'bird_wren2', 'bird_wren3'];
const BIRD_GAP = 75; // не чаще, чем раз в столько секунд
// Петли: файл содержит поля по 0,5 с, играем только область между ними — без щелчков на стыке.
const LOOPS = {
  fountain: [0.5, 52.5],
  wind: [0.5, 60.5],
  birds: [0.5, 75.5],
  drops: [0.5, 18.5],
  trickle: [0.5, 60.5], // тихое журчание по камням
};
const SHOTS = ['bowl', 'gong', 'chime1', 'chime2', 'chime3', 'windchime1', 'windchime2', 'wood1', 'wood2'];

// Сцены: громкость слоёв природы и события.
const SCENES = {
  off: { music: 0 },
  home: { music: 1, fountain: 0.23, windchime: 1 / 150, bird: 1 / 120, shishi: true },
  talk: { music: 0.8, fountain: 0.14 },
  breath: { music: 1, wind: 0.36, bird: 1 / 150 },
  warmup: { music: 0.9, fountain: 0.19, wood: 0.19 },
  qigong: { music: 1, wind: 0.18, trickle: 0.2, breathChime: true, bird: 1 / 150, shishi: true },
  hold: { music: 1, trickle: 0.2, drops: 0.12, minuteChime: true, bird: 1 / 180, shishi: true },
  strength: { music: 0.9, fountain: 0.16, wood: 0.21 },
  rest: { music: 1, birds: 0.25, wind: 0.12, trickle: 0.14, bird: 1 / 200 },
};

let ctx = null;
let out = null; // громкость из настроек
let duck = null; // приглушение под голос
let musicGain = null;
let musicEl = null;
let trackIdx = 0;
const beds = {}; // name -> { gain, src }
const buffers = new Map(); // name -> AudioBuffer | Promise
let scene = 'off';
let cfg = SCENES.off;
let running = false;
let paused = false;
let timer = 0;
let holdStart = 0;
let lastChime = 0;
let lastBird = 0;
let nextShishi = 20; // сисиодоси: бамбук наполняется и ударяет раз в 25–45 с
let speakingNow = false;

const now = () => ctx.currentTime;
const ramp = (param, v, t = 1.5) => { param.cancelScheduledValues(now()); param.setTargetAtTime(v, now(), t / 3); };
const enabled = () => state.settings.music !== false;
const level = () => (enabled() ? BASE * (state.settings.musicVolume ?? 0.5) : 0);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---- загрузка ----
function load(name) {
  if (buffers.has(name)) return buffers.get(name);
  const p = fetch(DIR + name + '.mp3')
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
    .then((b) => new Promise((res, rej) => ctx.decodeAudioData(b, res, rej)))
    .then((buf) => { buffers.set(name, buf); return buf; })
    .catch(() => { buffers.delete(name); return null; });
  buffers.set(name, p);
  return p;
}
const ready = (name) => { const b = buffers.get(name); return b && !(b instanceof Promise) ? b : null; };

// ---- мелодия ----
function startMusic() {
  // Элемент создаётся и запускается внутри касания: так iPhone разрешает воспроизведение.
  if (musicEl) return;
  musicEl = new Audio();
  musicEl.preload = 'auto';
  musicEl.crossOrigin = 'anonymous';
  const h = new Date().getHours();
  const part = DAYPART[h >= 17 ? 'evening' : h >= 12 ? 'day' : 'morning'];
  // Сначала мелодии своего времени суток (с разной стартовой каждый день), потом остальные.
  const shift = new Date().getDate() % part.length;
  const playlist = [...part.slice(shift), ...part.slice(0, shift), ...TRACKS.filter((x) => !part.includes(x))];
  trackIdx = 0;
  musicEl.src = DIR + playlist[0] + '.mp3';
  musicEl.addEventListener('ended', () => {
    trackIdx = (trackIdx + 1) % playlist.length;
    musicEl.src = DIR + playlist[trackIdx] + '.mp3';
    playMusic();
  });
  try {
    ctx.createMediaElementSource(musicEl).connect(musicGain);
  } catch { /* без маршрута через AudioContext мелодия не играет */ }
  playMusic();
}
function playMusic() {
  if (!musicEl || paused || !enabled() || !cfg.music || document.hidden) return;
  const p = musicEl.play();
  if (p && p.catch) p.catch(() => {});
}
function stopMusicLater() {
  // Пауза после затухания, чтобы не тратить батарею.
  setTimeout(() => { if (musicEl && (paused || !enabled() || !cfg.music || document.hidden)) musicEl.pause(); }, 1500);
}

// ---- природа (петли) ----
function bed(name) {
  if (beds[name]) return beds[name];
  const g = ctx.createGain();
  g.gain.value = 0;
  g.connect(out);
  beds[name] = { gain: g, src: null };
  return beds[name];
}
async function ensureBed(name) {
  const b = bed(name);
  if (b.src) return b;
  const buf = await load(name);
  if (!buf || b.src) return b;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  [src.loopStart, src.loopEnd] = LOOPS[name];
  src.connect(b.gain);
  // Начинаем с разных мест петли, чтобы повторы не узнавались.
  src.start(0, LOOPS[name][0] + Math.random() * (LOOPS[name][1] - LOOPS[name][0] - 1));
  b.src = src;
  return b;
}

// ---- одиночные звуки ----
function play(name, vel = 0.7, when = 0, pan = 0) {
  if (!ctx || !running || paused || !enabled()) return;
  const buf = ready(name);
  if (!buf) { load(name); return; }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 0.97 + Math.random() * 0.06; // живая неровность
  const g = ctx.createGain();
  g.gain.value = vel;
  let node = src.connect(g);
  if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
  node.connect(out);
  src.start(now() + when);
}

// ---- планировщик ----
function tick() {
  if (!running || paused || document.hidden || !enabled()) return;
  if (cfg.windchime && Math.random() < cfg.windchime) play(pick(['windchime1', 'windchime2']), 0.17);
  // Сисиодоси (запись из сада храма Сисэн-до, Киото): журчание, бамбук выливает воду и ударяет о камень.
  if (cfg.shishi && !speakingNow && now() >= nextShishi) {
    if (ready('shishi')) { play('shishi', 0.16, 0, Math.random() * 0.5 - 0.25); nextShishi = now() + 25 + Math.random() * 20; } else load('shishi');
  }
  // Птица где-то вдали: редко, тихо, с разных сторон и не поверх голоса мастера.
  if (cfg.bird && !speakingNow && now() - lastBird > BIRD_GAP && Math.random() < cfg.bird) {
    const b = pick(BIRDS);
    if (ready(b)) { play(b, 0.09 + Math.random() * 0.04, 0, (Math.random() * 1.2 - 0.6)); lastBird = now(); } else load(b);
  }
  if (cfg.minuteChime && holdStart && now() - holdStart >= 60 && now() - lastChime > 55) {
    play(pick(['chime1', 'chime2', 'chime3']), 0.18);
    lastChime = now();
    holdStart = now();
  }
}

function apply() {
  if (!ctx) return;
  const on = !paused && enabled() && !document.hidden;
  ramp(out.gain, on ? level() : 0, 1.2);
  ramp(musicGain.gain, MUSIC * (cfg.music || 0), 2);
  if (on && cfg.music) playMusic(); else stopMusicLater();
  for (const name of Object.keys(LOOPS)) {
    const v = cfg[name] || 0;
    if (v && on) ensureBed(name).then((b) => ramp(b.gain.gain, cfg[name] || 0, 2.5));
    else if (beds[name]) ramp(beds[name].gain.gain, 0, 2);
  }
}

function build() {
  ctx = audioContext();
  if (!ctx) return false;
  out = ctx.createGain();
  out.gain.value = 0;
  duck = ctx.createGain();
  duck.gain.value = 1;
  out.connect(duck).connect(ctx.destination);
  musicGain = ctx.createGain();
  musicGain.gain.value = 0;
  musicGain.connect(out);
  SHOTS.forEach(load);
  onSpeaking((speaking) => {
    speakingNow = speaking;
    if (!ctx || !duck) return;
    duck.gain.cancelScheduledValues(now());
    duck.gain.setTargetAtTime(speaking ? 0.35 : 1, now(), speaking ? 0.08 : 0.6);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    apply();
  });
  return true;
}

// ---- открытый интерфейс ----
export function start() {
  if (!enabled()) return;
  if (!ctx && !build()) return;
  if (!musicEl) startMusic();
  if (running) { playMusic(); return; }
  running = true;
  timer = setInterval(tick, 1000);
  apply();
}

export function setScene(name) {
  if (!SCENES[name] || name === scene) return;
  scene = name;
  cfg = SCENES[name];
  if (name === 'hold') { holdStart = ctx ? now() : 0; lastChime = ctx ? now() : 0; }
  if (ctx) apply();
}

export function setPaused(p) {
  paused = !!p;
  if (ctx) apply();
}

// Обновить громкость после изменения настроек.
export function refresh() {
  if (ctx) { if (enabled() && !musicEl) startMusic(); apply(); } else if (enabled()) start();
}

// Такт упражнения: звуки следуют счёту и дыханию.
export function beat({ breath, rep = 0 } = {}) {
  if (!ctx || !running || paused || !enabled()) return;
  if (cfg.wood && rep) play(rep % 2 ? 'wood1' : 'wood2', cfg.wood);
  if (breath === 'in' && rep === 1 && (scene === 'breath' || scene === 'rest')) play('bowl', 0.24);
  if (cfg.breathChime && breath === 'in' && (rep === 1 || rep % 4 === 0)) play(pick(['chime1', 'chime2', 'chime3']), 0.17);
}

export function chime(kind = 'bell') {
  if (!ctx || !running || !enabled()) return;
  if (kind === 'end') { play('gong', 0.17); play('bowl', 0.24, 3); }
  else if (kind === 'start') play('bowl', 0.25);
  else if (kind === 'bowl') play('bowl', 0.24);
  else play(pick(['chime1', 'chime2', 'chime3']), 0.18);
}

// Для проверки: доступ к выходу (запись пробных фрагментов).
export const debugTap = () => ({ ctx, out: duck });
