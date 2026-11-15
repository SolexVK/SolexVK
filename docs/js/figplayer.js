// Живой манекен на экране занятия: плавно переходит между позами упражнения в такт счёту мастера.
// Время движения задаёт длина такта, а не голос, поэтому настройка скорости речи на него не влияет.
import { figureAt, frameCount, frameSeq, hasFigure } from './figures.js';

const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

export class FigurePlayer {
  constructor(el, opts = {}) {
    this.el = el;
    this.opts = opts;
    this.id = null;
    this.n = 0;
    this.seq = null;
    this.path = [0];
    this.cur = 0;
    this.t0 = 0;
    this.dur = 0;
    this.raf = 0;
    this.paused = false;
    this.lastDrawn = '';
  }

  // Новое упражнение: начальная поза, затем показ движения по кругу, пока не начнётся счёт.
  setStep(id) {
    if (id === this.id) return;
    this.stopDemo();
    this.id = hasFigure(id) ? id : null;
    this.n = this.id ? frameCount(this.id, this.opts) : 0;
    this.seq = this.id ? frameSeq(this.id, this.opts) : null;
    this.cur = 0;
    this.path = [0];
    this.dur = 0;
    this.lastDrawn = '';
    this.el.classList.toggle('on', !!this.id);
    this.draw(0, 0, 0);
    this.startDemo();
  }

  startDemo() {
    const path = this.id ? demoPath(this.id, this.opts) : null;
    if (!path) return;
    this.demo = { path, t0: performance.now() };
    const tick = (now) => {
      if (!this.demo || !this.id) return;
      if (!this.paused) {
        const [a, b, k] = demoPose(this.demo.path, (now - this.demo.t0) / 1000);
        this.draw(a, b, k);
      } else this.demo.t0 += 16;
      this.demoRaf = requestAnimationFrame(tick);
    };
    this.demoRaf = requestAnimationFrame(tick);
  }

  stopDemo() {
    cancelAnimationFrame(this.demoRaf);
    if (this.demo) { this.demo = null; this.cur = 0; }
  }

  // Плавно пройти через кадры targets (число или список) за sec секунд.
  moveTo(targets, sec) {
    if (!this.id || this.n < 2) return;
    if (this.demo) { this.stopDemo(); this.draw(0, 0, 0); } // начался счёт — дальше в такт мастеру
    const list = (Array.isArray(targets) ? targets : [targets]).map((x) => Math.max(0, Math.min(this.n - 1, x)));
    this.path = [this.cur, ...list];
    this.cur = list[list.length - 1];
    this.dur = Math.max(0.25, sec) * 1000;
    this.t0 = performance.now();
    this.loop();
  }

  pause(p) {
    if (p && !this.paused) this.pausedAt = performance.now();
    if (!p && this.paused && this.pausedAt) this.t0 += performance.now() - this.pausedAt;
    this.paused = !!p;
    if (!p) this.loop();
  }

  loop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (this.paused || !this.id) return;
      const k = this.dur ? Math.min(1, (performance.now() - this.t0) / this.dur) : 1;
      const segs = this.path.length - 1;
      const x = ease(k) * segs;
      const i = Math.min(segs - 1, Math.floor(x));
      this.draw(this.path[i], this.path[i + 1], x - i);
      if (k < 1) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  draw(a, b, k) {
    if (!this.id) { this.el.innerHTML = ''; return; }
    const key = `${a}|${b}|${Math.round(k * 200)}`;
    if (key === this.lastDrawn) return;
    this.lastDrawn = key;
    this.el.innerHTML = figureAt(this.id, this.opts, a, b, k);
  }

  stop() { this.stopDemo(); cancelAnimationFrame(this.raf); this.id = null; this.el.innerHTML = ''; this.el.classList.remove('on'); }
}

// Куда двигаться на такте. Фазы одного повтора по очереди ведут в конечную позу и обратно
// (для трёх кадров — в средний и последний); «Держим», «Тянемся» — стоим на месте.
// Если в повторе одна фаза (простой счёт), позы чередуются от счёта к счёту.
export function beatTarget(player, it, st) {
  const n = player.n;
  if (n < 2) return null;
  const word = String(it.text || '').replace(/^(Раз|Два|Три|Четыре|Пять|Шесть|Семь|Восемь|Девять|Десять|\S+надцать|Двадцать)\.\s*/, '');
  if (/^(Держим|Тянемся)/.test(word)) return null;
  if (it.rep !== st.rep) {
    st.single = st.moves === 1;
    st.rep = it.rep;
    st.moves = 0;
  }
  const m = st.moves++;
  // Особый порядок поз — по всем движениям подряд, в том числе при простом счёте.
  if (player.seq) { st.k = (st.k ?? -1) + 1; return player.seq[st.k % player.seq.length]; }
  if (m === 0 && st.single) { st.alt = !st.alt; return st.alt ? 1 : 0; }
  if (m === 0) st.alt = true;
  return m % 2 === 0 ? 1 : (n >= 3 ? n - 1 : 0);
}

// ---- показ движения по кругу: на листе программы и пока мастер объясняет упражнение ----
const MOVE = 1.7; // секунд на переход между позами
const REST = 0.6; // пауза в крайней позе
export function demoPath(id, opts) {
  const n = frameCount(id, opts);
  if (n < 2) return null;
  const seq = frameSeq(id, opts);
  if (seq) return [0, ...seq.flat()];
  return n === 2 ? [0, 1, 0] : [...Array.from({ length: n }, (_, i) => i), 0];
}
// Поза в момент времени t (сек) для зацикленного показа: [a, b, k].
export function demoPose(path, t) {
  const segs = path.length - 1;
  const per = MOVE + REST;
  const x = (t % (segs * per)) / per;
  const i = Math.floor(x);
  const f = Math.min(1, ((x - i) * per) / MOVE);
  return [path[i], path[i + 1], ease(f)];
}

// Общий таймер для всех видимых показов на странице (не чаще 30 кадров в секунду).
const demos = new Set();
let raf = 0;
let lastFrame = 0;
function loopDemos(now) {
  raf = 0;
  if (!demos.size) return;
  if (now - lastFrame > 33) {
    lastFrame = now;
    for (const d of demos) {
      if (!d.el.isConnected) { demos.delete(d); continue; }
      const [a, b, k] = demoPose(d.path, (now - d.t0) / 1000);
      const key = `${a}|${b}|${Math.round(k * 60)}`;
      if (key !== d.key) { d.key = key; d.el.innerHTML = figureAt(d.id, d.opts, a, b, k); }
    }
  }
  if (demos.size) raf = requestAnimationFrame(loopDemos);
}
let observer = null;
// Оживить элемент: показ идёт, только пока элемент виден на экране.
export function animateFigure(el, id, opts = {}) {
  const path = demoPath(id, opts);
  if (!path) { el.innerHTML = figureAt(id, opts, 0, 0, 0); return; }
  const d = { el, id, opts, path, t0: performance.now() - Math.random() * 1500, key: '' };
  el.__demo = d;
  el.innerHTML = figureAt(id, opts, 0, 0, 0);
  if (typeof IntersectionObserver === 'undefined') { demos.add(d); if (!raf) raf = requestAnimationFrame(loopDemos); return; }
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const dd = e.target.__demo;
        if (!dd) continue;
        if (e.isIntersecting) demos.add(dd); else demos.delete(dd);
      }
      if (demos.size && !raf) raf = requestAnimationFrame(loopDemos);
    });
  }
  observer.observe(el);
}
