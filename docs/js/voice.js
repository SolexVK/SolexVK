// Голос: синтез речи (говорит наставник) и распознавание (говорит ученик).
// Оба работают средствами самого телефона, без сторонних сервисов.
import { state } from './store.js';

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export const ttsSupported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';
export const sttSupported = !!SR;

let voices = [];
let queue = [];
let busy = false;
let lastCancel = 0;
const speakingSubs = new Set();

function loadVoices() {
  if (!ttsSupported) return;
  voices = synth.getVoices().filter((v) => /^ru/i.test(v.lang));
}
if (ttsSupported) {
  loadVoices();
  synth.addEventListener?.('voiceschanged', loadVoices);
}
export function ruVoices() { if (!voices.length) loadVoices(); return voices; }
function pickVoice() {
  const list = ruVoices();
  if (!list.length) return null;
  return list.find((v) => v.voiceURI === state.settings.voiceURI)
    || list.find((v) => /enhanced|premium|улучш/i.test(v.name))
    || list.find((v) => v.localService) || list[0];
}

export function isSpeaking() { return busy; }
export function onSpeaking(fn) { speakingSubs.add(fn); return () => speakingSubs.delete(fn); }
const notify = () => speakingSubs.forEach((fn) => fn(busy));

function split(text) {
  // Короткие фразы: длинные реплики некоторые браузеры обрывают.
  const parts = String(text).replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]*\s*/g) || [];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > 200 && cur) { out.push(cur.trim()); cur = p; } else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Первое произнесение на айфоне должно случиться прямо в обработчике касания.
let unlocked = false;
export function unlock() {
  if (!ttsSupported || unlocked) return;
  unlocked = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.lang = 'ru-RU';
    synth.speak(u);
  } catch { /* не критично */ }
}

export function speak(text, { interrupt = false, force = false } = {}) {
  return new Promise((resolve) => {
    if (!ttsSupported || (!state.settings.voice && !force) || !text) return resolve(false);
    if (interrupt) cancel();
    unlocked = true;
    const parts = split(text);
    if (!parts.length) return resolve(false);
    parts.forEach((t, i) => queue.push({ text: t, resolve: i === parts.length - 1 ? resolve : null }));
    pump();
    return undefined;
  });
}

let current = null;

function pump() {
  if (busy || !queue.length) return;
  busy = true;
  notify();
  // Сразу после отмены айфон может «проглотить» новую фразу — даём короткую паузу.
  // Если отмены не было, говорим синхронно: так первая фраза остаётся внутри касания.
  const wait = Math.max(0, 90 - (Date.now() - lastCancel));
  if (wait > 0) setTimeout(run, wait); else run();
}

function run() {
  const item = queue.shift();
  if (!item) { busy = false; notify(); return; }
  const u = new SpeechSynthesisUtterance(item.text);
  u.lang = 'ru-RU';
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = state.settings.rate || 0.95;
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    clearTimeout(wd);
    if (current === me) current = null;
    busy = false;
    item.resolve?.(ok);
    if (queue.length) pump(); else notify();
  };
  const me = { finish };
  current = me;
  u.onend = () => finish(true);
  u.onerror = () => finish(false);
  // Иногда событие окончания не приходит — страхуемся таймером.
  const wd = setTimeout(() => finish(false), 5000 + item.text.length * 130);
  try { synth.speak(u); } catch { finish(false); }
}

export function cancel() {
  const active = busy || queue.length > 0 || (ttsSupported && (synth.speaking || synth.pending));
  const pending = queue;
  queue = [];
  pending.forEach((i) => i.resolve?.(false));
  if (!active) return;
  lastCancel = Date.now();
  if (ttsSupported) { try { synth.cancel(); } catch { /* noop */ } }
  // Не ждём события от браузера: после отмены оно приходит не всегда.
  current?.finish(false);
}

// Озвучивание потокового ответа: говорим по мере появления законченных фраз.
export function sentenceStream() {
  let buf = '';
  let last = Promise.resolve();
  return {
    push(delta) {
      buf += delta;
      let m;
      while ((m = buf.match(/^([\s\S]*?[.!?…]+)(\s+|$)/)) && m[1].trim().length > 1) {
        last = speak(m[1].trim());
        buf = buf.slice(m[0].length);
        if (!buf) break;
      }
    },
    end() {
      if (buf.trim()) last = speak(buf.trim());
      buf = '';
      return last;
    },
  };
}

// ---- распознавание ----
let rec = null;

// Одна реплика: слушаем до паузы и возвращаем текст ('' — ничего не услышано).
export function listenOnce({ onInterim, maxMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!sttSupported) return reject(new Error('unsupported'));
    stopListening();
    const r = new SR();
    rec = r;
    r.lang = 'ru-RU';
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = '';
    let interim = '';
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); if (rec === r) rec = null; try { r.abort(); } catch { /* noop */ } fn(v); };
    const timer = setTimeout(() => {
      try { r.stop(); } catch { /* noop */ }
      // Если браузер так и не сообщил об окончании, завершаем сами.
      setTimeout(() => done(resolve, (finalText + ' ' + interim).trim()), 2500);
    }, maxMs);
    // Если распознавание не запустилось за несколько секунд, считаем его недоступным.
    let started = false;
    r.onstart = () => { started = true; };
    setTimeout(() => { if (!started) done(reject, new Error('unavailable')); }, 3500);
    r.onresult = (e) => {
      started = true;
      finalText = '';
      interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      onInterim?.((finalText + ' ' + interim).trim());
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') done(reject, new Error('denied'));
      else if (e.error === 'no-speech' || e.error === 'aborted') done(resolve, '');
      else done(reject, new Error(e.error || 'stt'));
    };
    // На айфоне признак «окончательно» иногда не выставляется — берём то, что есть.
    r.onend = () => done(resolve, (finalText + ' ' + interim).trim());
    try { r.start(); } catch (err) { done(reject, err); }
  });
}

export function stopListening() {
  if (rec) { try { rec.abort(); } catch { /* noop */ } rec = null; }
}

// Постоянное прослушивание голосовых команд во время занятия.
let cmd = null;
export function startCommands(onPhrase, onError) {
  if (!sttSupported) return false;
  stopCommands();
  cmd = { active: true, r: null, off: null };
  const me = cmd;
  const loop = () => {
    if (!me.active || busy || me.r) return;
    const r = new SR();
    me.r = r;
    r.lang = 'ru-RU';
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) onPhrase(e.results[i][0].transcript.trim().toLowerCase());
      }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { me.active = false; onError?.(e.error); }
    };
    r.onend = () => { me.r = null; if (me.active) setTimeout(loop, 400); };
    try { r.start(); } catch { me.r = null; setTimeout(loop, 1500); }
  };
  // Пока говорит наставник, микрофон молчит, иначе он услышит сам себя.
  me.off = onSpeaking((speaking) => {
    if (!me.active) return;
    if (speaking) { try { me.r?.abort(); } catch { /* noop */ } } else setTimeout(loop, 350);
  });
  me.loop = loop;
  loop();
  return true;
}
export function pauseCommands() { if (cmd) { cmd.active = false; try { cmd.r?.abort(); } catch { /* noop */ } } }
export function resumeCommands() { if (cmd) { cmd.active = true; setTimeout(cmd.loop, 300); } }
export function stopCommands() {
  if (!cmd) return;
  cmd.active = false;
  cmd.off?.();
  try { cmd.r?.abort(); } catch { /* noop */ }
  cmd = null;
}

const NUM = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать', 'двадцать'];
export const numWord = (n) => NUM[n] ?? String(n);
