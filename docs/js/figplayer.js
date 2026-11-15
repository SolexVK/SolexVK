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

  // Новое упражнение: начальная поза.
  setStep(id) {
    if (id === this.id) return;
    this.id = hasFigure(id) ? id : null;
    this.n = this.id ? frameCount(this.id, this.opts) : 0;
    this.seq = this.id ? frameSeq(this.id, this.opts) : null;
    this.cur = 0;
    this.path = [0];
    this.dur = 0;
    this.lastDrawn = '';
    this.el.classList.toggle('on', !!this.id);
    this.draw(0, 0, 0);
  }

  // Плавно пройти через кадры targets (число или список) за sec секунд.
  moveTo(targets, sec) {
    if (!this.id || this.n < 2) return;
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

  stop() { cancelAnimationFrame(this.raf); this.id = null; this.el.innerHTML = ''; this.el.classList.remove('on'); }
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
  if (player.seq) return player.seq[m % player.seq.length];
  if (m === 0 && st.single) { st.alt = !st.alt; return st.alt ? 1 : 0; }
  if (m === 0) st.alt = true;
  return m % 2 === 0 ? 1 : (n >= 3 ? n - 1 : 0);
}
