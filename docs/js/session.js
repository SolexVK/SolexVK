// Занятие: наставник ведёт по шагам голосом, камера считает повторы и следит за осанкой.
import { state, day, save, dateStr } from './store.js';
import { buildSession, RED_FLAGS, SESSION_META, SESSION_LINES } from './course.js';
import { COACH_TEXTS } from './coach.js';
import { Coach, POSES, describe } from './coach.js';
import * as voice from './voice.js';
import * as pose from './pose.js';
import { askMaster, hasKey } from './master.js';

const params = new URLSearchParams(location.search);
const SPEED = Math.max(1, Number(params.get('speed')) || 1);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = (sec) => { const s = Math.max(0, Math.ceil(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export class SessionRunner {
  constructor(root, opts) {
    this.root = root;
    this.o = opts;
    this.plan = buildSession(opts.kind, opts.week, opts.mode);
    this.steps = this.plan.steps;
    this.i = -1;
    this.tok = 0;
    this.paused = false;
    this.ended = false;
    this.overlayOpen = false;
    this.camOn = false;
    this.modelReady = false;
    this.doneSteps = 0;
    this.results = { quality: [], stolbSec: 0, chairReps: 0, repsTotal: 0, cues: 0 };
    this.startedAt = Date.now();
    this.build();
  }

  build() {
    this.root.innerHTML = `
      <div class="s-stage">
        <video class="s-video" playsinline muted></video>
        <canvas class="s-canvas"></canvas>
        <div class="s-ink" aria-hidden="true"></div>
      </div>
      <div class="s-top">
        <button class="s-icon" data-act="exit" aria-label="Закончить занятие">✕</button>
        <div class="s-progress" role="progressbar" aria-label="Ход занятия"><i></i></div>
        <span class="s-count"></span>
        <button class="s-chip" data-act="cam" aria-pressed="false">Камера</button>
      </div>
      <p class="s-cue" aria-live="assertive"></p>
      <div class="s-panel">
        <p class="s-group"></p>
        <h2 class="s-title"></h2>
        <p class="s-text"></p>
        <div class="s-big"><span class="s-num"></span><span class="s-unit"></span></div>
        <div class="s-controls">
          <button class="s-btn" data-act="prev">Назад</button>
          <button class="s-btn s-main" data-act="pause">Пауза</button>
          <button class="s-btn" data-act="next">Дальше</button>
        </div>
        <div class="s-extra">
          <button class="s-chip" data-act="ask">Спросить мастера</button>
          <button class="s-chip" data-act="look">Мастер, посмотри</button>
          <button class="s-chip s-danger" data-act="sos">Мне нехорошо</button>
        </div>
      </div>
      <div class="s-overlay" hidden></div>`;
    const q = (s) => this.root.querySelector(s);
    this.video = q('.s-video');
    this.canvas = q('.s-canvas');
    this.ink = q('.s-ink');
    this.el = {
      bar: q('.s-progress i'), count: q('.s-count'), cam: q('[data-act="cam"]'), cue: q('.s-cue'),
      group: q('.s-group'), title: q('.s-title'), text: q('.s-text'), num: q('.s-num'), unit: q('.s-unit'),
      pause: q('[data-act="pause"]'), overlay: q('.s-overlay'),
    };
    this.onClick = (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      this.act(b.dataset.act);
    };
    this.root.addEventListener('click', this.onClick);
    this.onVis = () => { if (!document.hidden) this.requestWake(); };
    document.addEventListener('visibilitychange', this.onVis);
  }

  get cur() { return this.steps[this.i]; }

  // Вызывается из обработчика касания: только так айфон разрешит звук и камеру.
  start() {
    voice.unlock();
    this.root.hidden = false;
    document.body.classList.add('in-session');
    this.requestWake();
    if (this.o.camera && pose.cameraSupported) this.enableCamera();
    if (this.o.handsFree && voice.sttSupported) {
      voice.startCommands((p) => this.command(p), () => this.flash('Микрофон недоступен. Управляйте кнопками.'));
    }
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), 100);
    // Загружаем записи голоса мастера для этого занятия, но не дольше 12 секунд.
    this.preparing = true;
    this.go(0);
    const texts = this.steps.flatMap((st) => st.items.flatMap((it) => [it.text, ...(it.cues || []).map((c) => c.text)])).filter(Boolean);
    const pre = voice.preload([...texts, ...COACH_TEXTS], (d, n) => { if (this.preparing) this.el.unit.textContent = `готовлю голос мастера: ${Math.round((d / n) * 100)}%`; });
    Promise.race([pre, new Promise((r) => setTimeout(r, 12000))]).catch(() => {}).then(() => {
      if (this.ended) return;
      this.preparing = false;
      this.lastTick = performance.now();
      this.startItem();
    });
  }

  async requestWake() {
    try { if (!this.ended && navigator.wakeLock) this.wake = await navigator.wakeLock.request('screen'); } catch { /* не критично */ }
  }

  async enableCamera() {
    this.el.cam.textContent = 'Камера…';
    try {
      await pose.startCamera(this.video);
      if (this.ended) return pose.stopCamera();
      this.camOn = true;
      this.root.classList.add('cam');
      this.el.cam.setAttribute('aria-pressed', 'true');
      this.el.cam.textContent = 'Загружаю зрение…';
      await pose.loadModel();
      if (this.ended || !this.camOn) return;
      this.modelReady = true;
      pose.startLoop(this.video, this.canvas, (lm, world, now, aspect) => this.onFrame(lm, world, now, aspect));
      this.el.cam.textContent = 'Камера вкл.';
    } catch (err) {
      this.disableCamera();
      this.flash(err?.name === 'NotAllowedError'
        ? 'Нет доступа к камере. Занимаемся без неё.'
        : 'Камера недоступна. Занимаемся без неё.');
    }
  }

  disableCamera() {
    pose.stopCamera();
    this.camOn = false;
    this.modelReady = false;
    this.root.classList.remove('cam');
    this.el.cam.setAttribute('aria-pressed', 'false');
    this.el.cam.textContent = 'Камера выкл.';
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  go(i) {
    if (i >= this.steps.length) return this.complete();
    this.i = Math.max(0, i);
    const s = this.cur;
    this.coach = s.pose && POSES[s.pose] ? new Coach(s.pose) : null;
    this.st = { j: 0, token: 0, rep: 0, maxRep: 0, breath: null, holdT: 0, firedCues: new Set(), pendingCue: null, speaking: false };
    this.el.group.textContent = s.group || SESSION_META[this.plan.kind].title;
    this.el.title.textContent = s.title;
    this.el.text.textContent = s.text || '';
    this.el.count.textContent = `${this.i + 1}/${this.steps.length}`;
    this.el.cue.textContent = '';
    this.root.dataset.kind = s.kind;
    this.ink.className = 's-ink';
    this.startItem();
    this.paint();
    return undefined;
  }

  get item() { return this.cur?.items[this.st.j]; }

  // Произносит фразу; когда договорит (или сразу, если голос выключен), вызывает done.
  sayNow(text, done) {
    const st = this.st;
    const tok = st.token;
    st.speaking = true;
    const t0 = performance.now();
    voice.speak(text, { interrupt: true }).then((ok) => {
      if (this.st !== st || tok !== st.token) return;
      // Голос выключен или недоступен: выдерживаем примерное время фразы.
      const est = ok ? 0 : Math.max(0, (0.5 + text.length * 0.07) / SPEED - (performance.now() - t0) / 1000);
      const fin = () => { if (this.st === st && tok === st.token) { st.speaking = false; done?.(); } };
      if (est > 0) setTimeout(fin, est * 1000); else fin();
    });
  }

  startItem() {
    const st = this.st;
    st.token++;
    st.speaking = false;
    const it = this.item;
    if (!it) return this.finishStep(false);
    if (this.paused || this.overlayOpen || this.preparing) return undefined;
    st.phase = it.t;
    if (it.t === 'say') {
      this.sayNow(it.text, () => this.nextItem());
    } else if (it.t === 'beat') {
      st.beatLeft = it.dur;
      if (it.rep) { st.rep = it.rep; st.maxRep = Math.max(st.maxRep, it.rep); }
      if (it.breath && it.breath !== st.breath) {
        st.breath = it.breath;
        this.ink.style.transitionDuration = `${it.dur / SPEED}s`;
        this.ink.className = `s-ink breathing ${it.breath}`;
      }
      if (it.text) { this.sayNow(it.text); this.showCue(it.text, false); }
    } else if (it.t === 'hold') {
      // Удержание продолжается с того места, где остановились (после паузы).
    }
    this.paint();
    return undefined;
  }

  nextItem() {
    const st = this.st;
    // Замечание камеры мастер говорит между тактами, не перебивая счёт.
    if (st.pendingCue && !this.paused && !this.overlayOpen) {
      const c = st.pendingCue;
      st.pendingCue = null;
      st.token++;
      st.phase = 'cue';
      this.sayNow(c, () => this.nextItem());
      return;
    }
    st.j++;
    this.startItem();
  }

  tick() {
    const now = performance.now();
    const dt = Math.min(0.5, (now - this.lastTick) / 1000) * SPEED;
    this.lastTick = now;
    if (this.paused || this.ended || this.overlayOpen || this.preparing || !this.st) return;
    const it = this.item;
    const st = this.st;
    if (!it) return;
    if (st.phase === 'beat') {
      st.beatLeft -= dt;
      if (st.beatLeft <= 0 && !st.speaking) this.nextItem();
    } else if (st.phase === 'hold') {
      st.holdT += dt;
      if (!st.speaking) {
        const due = (it.cues || []).find((c) => st.holdT >= c.at && !st.firedCues.has(c.at));
        if (st.pendingCue) { const c = st.pendingCue; st.pendingCue = null; this.sayNow(c); }
        else if (due) { st.firedCues.add(due.at); this.sayNow(due.text); this.showCue(due.text, false); }
      }
      if (st.holdT >= it.dur) { st.holdT = it.dur; this.nextItem(); }
    }
    this.paint();
  }

  onFrame(lm, world, now, aspect) {
    const st = this.st;
    const it = this.item;
    // Камера следит, только когда ученик выполняет движение, а не слушает объяснение.
    if (!this.coach || this.paused || this.overlayOpen || !st || !it || (it.t !== 'beat' && it.t !== 'hold')) return { bad: false };
    const r = this.coach.update(lm, world, now, aspect);
    for (const e of r.ev) {
      if (e.type === 'cue') { this.results.cues++; this.showCue(e.say, true); st.pendingCue = e.say; }
    }
    return { bad: r.bad };
  }

  showCue(text, warn) {
    this.el.cue.textContent = text;
    this.el.cue.classList.toggle('warn', !!warn);
    clearTimeout(this.cueTimer);
    this.cueTimer = setTimeout(() => { this.el.cue.textContent = ''; }, warn ? 5000 : 2500);
  }

  flash(text) { this.showCue(text, true); }

  paint() {
    const s = this.cur;
    const st = this.st;
    if (!s || !st) return;
    const it = this.item;
    let num = '';
    let unit = '';
    if (this.preparing) { unit = 'готовлю голос мастера'; }
    else if (!it || it.t === 'say' || st.phase === 'cue') { unit = s.kind === 'talk' ? '' : 'слушайте мастера'; }
    else if (it.t === 'hold') { num = mmss(it.dur - st.holdT); unit = 'осталось'; }
    else if (it.t === 'beat' && !it.rep) { num = mmss(st.beatLeft ?? it.dur); unit = it.label || ''; }
    else if (s.kind === 'breath') { num = it.breath === 'out' ? 'выдох' : 'вдох'; unit = `дыхание ${it.rep} из ${s.reps}`; }
    else if (it.t === 'beat') { num = `${it.rep} / ${s.reps}`; unit = it.breath === 'in' ? 'вдох' : it.breath === 'out' ? 'выдох' : 'повтор'; }
    if (this.el.num.textContent !== num) this.el.num.textContent = num;
    if (this.el.unit.textContent !== unit) this.el.unit.textContent = unit;
    const frac = s.items.length ? Math.min(1, (st.j + (it?.t === 'hold' ? st.holdT / it.dur : 0)) / s.items.length) : 0;
    this.el.bar.style.width = `${Math.min(100, ((this.i + frac) / this.steps.length) * 100)}%`;
  }

  // Конец шага: сохраняем показатели и переходим к следующему.
  finishStep(skipped) {
    const s = this.cur;
    const st = this.st;
    if (!s || !st) return;
    if (this.coach) { const q = this.coach.quality(); if (q != null) this.results.quality.push(q); }
    if (s.id === 'stolb') this.results.stolbSec = Math.max(this.results.stolbSec, Math.round(st.holdT));
    if (s.track === 'chair') this.results.chairReps = Math.max(this.results.chairReps, skipped ? st.maxRep - 1 : st.maxRep, this.coach?.reps || 0);
    if (s.kind === 'move' && s.reps) this.results.repsTotal += skipped ? Math.max(0, st.maxRep - 1) : st.maxRep;
    if (!skipped) this.doneSteps++;
    this.go(this.i + 1);
  }

  // Повторить объяснение текущего упражнения: возвращаемся к началу блока фраз.
  repeatInstruction() {
    const items = this.cur.items;
    let j = Math.min(this.st.j, items.length - 1);
    while (j > 0 && items[j].t !== 'say') j--;
    while (j > 0 && items[j - 1].t === 'say') j--;
    this.st.j = j;
    this.startItem();
  }

  act(name) {
    // После окончания занятия работают только кнопки итогового окна.
    if (this.ended && !['summary-save', 'finish-save', 'finish-drop'].includes(name)) return undefined;
    if (name === 'pause') return this.paused ? this.resume() : this.pause();
    if (name === 'next') return this.finishStep(true);
    if (name === 'prev') return this.go(this.i - 1);
    if (name === 'cam') return this.camOn ? this.disableCamera() : this.enableCamera();
    if (name === 'ask') return this.ask({});
    if (name === 'look') return this.ask({ look: true });
    if (name === 'sos') return this.sos();
    if (name === 'exit') return this.exitDialog();
    if (name === 'ov-close') return this.closeOverlay();
    if (name === 'ov-ask') return this.ask({});
    if (name === 'ov-send') return this.sendTyped();
    if (name === 'finish-save') return this.finish(true);
    if (name === 'finish-drop') return this.finish(false);
    if (name === 'summary-save') return this.finish(true, true);
    return undefined;
  }

  pause() {
    this.paused = true;
    voice.cancel();
    if (this.st) { this.st.token++; this.st.speaking = false; }
    this.el.pause.textContent = 'Продолжить';
    this.root.classList.add('paused');
  }

  resume() {
    this.paused = false;
    this.lastTick = performance.now();
    this.el.pause.textContent = 'Пауза';
    this.root.classList.remove('paused');
    // Текущий такт или фразу повторяем с начала, удержание продолжается.
    if (!this.overlayOpen) this.startItem();
  }

  // ---- голосовые команды ----
  command(p) {
    if (this.ended) return;
    if (this.overlayOpen) return;
    const m = p.match(/^(?:мастер|учитель|вопрос)[,.!\s]+(.+)/);
    if (m && /посмотри/.test(m[1])) return this.ask({ look: true });
    if (m && m[1].length > 3) return this.ask({ text: m[1] });
    if (/нехорошо|плохо|кружится|больно/.test(p)) return this.sos();
    if (/пауза|подожди|стоп/.test(p)) { if (!this.paused) { this.pause(); voice.speak(SESSION_LINES.paused); } return undefined; }
    if (/продолж|поехали/.test(p)) { if (this.paused) this.resume(); return undefined; }
    if (/дальше|следующ|пропус/.test(p)) return this.paused ? this.resume() : this.finishStep(true);
    if (/назад|предыдущ/.test(p)) return this.go(this.i - 1);
    if (/повтори/.test(p)) return this.repeatInstruction();
    if (/закончи|хватит/.test(p)) return this.exitDialog();
    return undefined;
  }

  // ---- оверлеи ----
  openOverlay(html) {
    this.overlayOpen = true;
    voice.cancel();
    if (this.st) { this.st.token++; this.st.speaking = false; }
    voice.pauseCommands();
    this.el.overlay.innerHTML = html;
    this.el.overlay.hidden = false;
  }

  closeOverlay() {
    this.abort?.abort();
    voice.stopListening();
    voice.cancel();
    this.el.overlay.hidden = true;
    this.el.overlay.innerHTML = '';
    this.overlayOpen = false;
    voice.resumeCommands();
    this.lastTick = performance.now();
    if (!this.paused && !this.ended) this.startItem();
  }

  stepContext() {
    const s = this.cur;
    const parts = [`Сейчас идёт занятие «${SESSION_META[this.plan.kind].title}», упражнение «${s.title}»: ${s.text || ''}`];
    if (this.coach?.m) parts.push(`Камера измерила: ${describe(this.coach.m)}.`);
    else if (s.pose) parts.push('Камера сейчас не видит ученика целиком.');
    return parts.join('\n');
  }

  async ask({ text, look }) {
    if (look && !hasKey()) {
      return this.openOverlay(`<div class="ov-card"><h3>Нужен ключ</h3><p>Чтобы наставник посмотрел на кадр с камеры и разобрал осанку, добавьте ключ API в настройках. Без ключа осанку проверяет только встроенный контроль углов.</p><button class="btn" data-act="ov-close">Продолжить занятие</button></div>`);
    }
    if (look && !(this.camOn && this.video.videoWidth)) {
      return this.openOverlay(`<div class="ov-card"><h3>Камера выключена</h3><p>Включите камеру кнопкой вверху и встаньте так, чтобы были видны голова и стопы.</p><button class="btn" data-act="ov-close">Продолжить занятие</button></div>`);
    }
    const image = look ? pose.snapshot(this.video) : null;
    let question = text || (look ? 'Посмотрите, пожалуйста, как я выполняю это упражнение, и поправьте меня.' : '');
    if (!question) {
      if (voice.sttSupported) {
        this.openOverlay(`<div class="ov-card"><p class="ov-eyebrow">Слушаю</p><p class="ov-live">Говорите…</p><button class="btn ghost" data-act="ov-close">Отмена</button></div>`);
        const live = this.el.overlay.querySelector('.ov-live');
        try {
          question = await voice.listenOnce({ onInterim: (t) => { if (live.isConnected) live.textContent = t || 'Говорите…'; } });
        } catch { question = null; }
        if (!this.overlayOpen) return undefined;
      }
      if (!question) return this.typedPrompt(question === '' ? 'Не расслышал. Напишите вопрос или попробуйте ещё раз.' : 'Напишите вопрос. Можно надиктовать кнопкой микрофона на клавиатуре.');
    }
    return this.answer(question, image);
  }

  typedPrompt(hint) {
    this.openOverlay(`<div class="ov-card"><p class="ov-eyebrow">Вопрос наставнику</p><p>${esc(hint)}</p>
      <textarea class="ov-input" id="s-ask-input" rows="3" placeholder="Например: как держать руки в столбе?"></textarea>
      <div class="ov-row"><button class="btn" data-act="ov-send">Спросить</button>${voice.sttSupported ? '<button class="btn ghost" data-act="ov-ask">Голосом</button>' : ''}<button class="btn ghost" data-act="ov-close">Отмена</button></div></div>`);
  }

  sendTyped() {
    const v = this.el.overlay.querySelector('.ov-input')?.value.trim();
    if (v) this.answer(v, null);
  }

  async answer(question, image) {
    this.openOverlay(`<div class="ov-card"><p class="ov-eyebrow">Вы спросили</p><p class="ov-q"></p><p class="ov-eyebrow">Наставник</p><p class="ov-a">Думаю…</p>
      <div class="ov-row"><button class="btn" data-act="ov-close">Продолжить занятие</button><button class="btn ghost" data-act="ov-ask">Ещё вопрос</button></div></div>`);
    this.el.overlay.querySelector('.ov-q').textContent = question;
    const out = this.el.overlay.querySelector('.ov-a');
    const say = voice.sentenceStream();
    let acc = '';
    this.abort = new AbortController();
    try {
      const res = await askMaster({
        text: question, image, extra: this.stepContext(), signal: this.abort.signal,
        onDelta: (d) => { acc += d; if (out.isConnected) out.textContent = acc; if (this.overlayOpen) say.push(d); },
      });
      if (out.isConnected) out.textContent = res.text || acc;
      state.chat.push({ role: 'user', text: question, at: Date.now() }, { role: 'assistant', text: res.text || acc, at: Date.now() });
      state.chat = state.chat.slice(-40);
      save();
      if (this.overlayOpen) say.end();
    } catch (err) {
      if (err.kind === 'aborted') return;
      if (out.isConnected) out.textContent = err.message || 'Не получилось получить ответ.';
    }
  }

  sos() {
    this.pause();
    this.openOverlay(`<div class="ov-card ov-sos"><h3>Остановитесь</h3><p>Сядьте или лягте. Дышите спокойно, без задержек.</p>
      <p><strong>Сразу звоните 103 или 112</strong>, если есть хотя бы одно:</p>
      <ul>${RED_FLAGS.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      <p>Если просто закружилась голова или стало больно, на сегодня достаточно. Измерьте давление и запишите в дневник, что случилось.</p>
      <div class="ov-row"><button class="btn" data-act="finish-save">Закончить занятие</button><button class="btn ghost" data-act="ov-close">Мне лучше, вернуться</button></div></div>`);
    voice.speak(SESSION_LINES.sos, { interrupt: true });
  }

  exitDialog() {
    this.pause();
    this.openOverlay(`<div class="ov-card"><h3>Закончить занятие?</h3><p>Пройдено шагов: ${this.i} из ${this.steps.length}.</p>
      <div class="ov-col"><button class="btn" data-act="ov-close">Вернуться к занятию</button>
      <button class="btn ghost" data-act="finish-save">Закончить и засчитать</button>
      <button class="btn ghost" data-act="finish-drop">Выйти без записи</button></div></div>`);
  }

  complete() {
    this.completed = true;
    this.stopEngines();
    const r = this.results;
    const q = r.quality.length ? Math.round(r.quality.reduce((a, b) => a + b, 0) / r.quality.length) : null;
    const dur = Math.round((Date.now() - this.startedAt) / 1000);
    const rows = [
      ['Длительность', mmss(dur)],
      r.repsTotal ? ['Повторов', String(r.repsTotal)] : null,
      r.stolbSec ? ['Столб', mmss(r.stolbSec)] : null,
      q != null ? ['Без замечаний камеры', `${q}% времени`] : null,
    ].filter(Boolean);
    const cur = day().pain?.back;
    this.openOverlay(`<div class="ov-card ov-summary"><div class="stamp done big">${SESSION_META[this.plan.kind].seal}</div><h3>Занятие окончено</h3>
      <dl class="ov-stats">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      <label class="ov-label" for="s-pain">Боль в пояснице сейчас: <output id="s-pain-out">${cur ?? '—'}</output></label>
      <input type="range" id="s-pain" min="0" max="10" step="1" value="${cur ?? 0}" data-touched="${cur != null ? 1 : 0}">
      <button class="btn" data-act="summary-save">Сохранить</button></div>`);
    const range = this.el.overlay.querySelector('#s-pain');
    range.addEventListener('input', () => { range.dataset.touched = '1'; this.el.overlay.querySelector('#s-pain-out').textContent = range.value; });
  }

  stopEngines() {
    clearInterval(this.timer);
    this.ended = true;
    pose.stopCamera();
    voice.stopCommands();
    try { this.wake?.release(); } catch { /* noop */ }
  }

  finish(record, fromSummary = false) {
    const kind = this.plan.kind;
    if (record) {
      const d = day(dateStr());
      const r = this.results;
      // Незавершённый шаг тоже учитываем: время столба и повторы до выхода.
      if (!this.completed && this.st && this.cur) {
        if (this.cur.id === 'stolb') r.stolbSec = Math.max(r.stolbSec, Math.round(Math.min(this.st.t, this.cur.dur)));
        if (this.cur.track === 'chair') r.chairReps = Math.max(r.chairReps, this.st.reps);
      }
      const prev = d.sessions[kind] || {};
      const q = r.quality.length ? Math.round(r.quality.reduce((a, b) => a + b, 0) / r.quality.length) : null;
      d.sessions[kind] = {
        done: true, at: new Date().toISOString(), durSec: Math.round((Date.now() - this.startedAt) / 1000),
        mode: this.plan.mode, partial: !this.completed, quality: q ?? prev.quality ?? null,
        stolbSec: Math.max(r.stolbSec, prev.stolbSec || 0), chairReps: Math.max(r.chairReps, prev.chairReps || 0),
        reps: r.repsTotal,
      };
      if (fromSummary) {
        const range = this.el.overlay.querySelector('#s-pain');
        if (range?.dataset.touched === '1') d.pain.back = Number(range.value);
      }
      save();
    }
    this.destroy();
    this.o.onFinish?.(record);
  }

  destroy() {
    this.stopEngines();
    voice.cancel();
    voice.stopListening();
    clearTimeout(this.cueTimer);
    this.root.removeEventListener('click', this.onClick);
    document.removeEventListener('visibilitychange', this.onVis);
    this.root.hidden = true;
    this.root.innerHTML = '';
    this.root.className = '';
    document.body.classList.remove('in-session');
  }
}
