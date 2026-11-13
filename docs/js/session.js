// Занятие: наставник ведёт по шагам голосом, камера считает повторы и следит за осанкой.
import { state, day, save, dateStr } from './store.js';
import { buildSession, RED_FLAGS, SESSION_META } from './course.js';
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
          <button class="s-chip" data-act="plus" hidden>+1 повтор</button>
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
      pause: q('[data-act="pause"]'), plus: q('[data-act="plus"]'), overlay: q('.s-overlay'),
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
    this.root.hidden = false;
    document.body.classList.add('in-session');
    this.requestWake();
    if (this.o.camera && pose.cameraSupported) this.enableCamera();
    if (this.o.handsFree && voice.sttSupported) {
      voice.startCommands((p) => this.command(p), () => this.flash('Микрофон недоступен. Управляйте кнопками.'));
    }
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), 100);
    this.go(0);
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
        ? 'Нет доступа к камере. Считаю по времени.'
        : 'Камера недоступна. Считаю по времени.');
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
    if (this.st?.mode === 'camera') this.toTempo(false);
  }

  go(i) {
    if (i >= this.steps.length) return this.complete();
    this.i = Math.max(0, i);
    const s = this.cur;
    this.st = { phase: 'intro', t: 0, lead: s.lead || 0, reps: 0, fired: new Set(), token: ++this.tok, mode: null, introLeft: null };
    this.coach = s.pose && POSES[s.pose] ? new Coach(s.pose) : null;
    this.el.group.textContent = s.group || SESSION_META[this.plan.kind].title;
    this.el.title.textContent = s.title;
    this.el.text.textContent = s.text || '';
    this.el.count.textContent = `${this.i + 1}/${this.steps.length}`;
    this.el.plus.hidden = s.kind !== 'reps';
    this.el.cue.textContent = '';
    this.root.dataset.kind = s.kind;
    this.ink.className = 's-ink';
    this.paint();
    this.intro();
  }

  intro() {
    const s = this.cur;
    const tok = this.st.token;
    this.st.introLeft = null;
    voice.speak(s.say, { interrupt: true }).then((ok) => {
      if (this.ended || !this.st || tok !== this.st.token || this.st.phase !== 'intro') return;
      if (this.paused || this.overlayOpen) { this.st.introPending = true; return; }
      if (ok) this.afterIntro();
      else this.st.introLeft = Math.min(9, 1.5 + (s.say || '').length * 0.045);
    });
  }

  afterIntro() {
    const s = this.cur;
    const st = this.st;
    if (s.kind === 'talk') {
      // Пауза после реплики идёт через общий тик: на паузе и при открытом диалоге она стоит.
      st.phase = 'hold';
      st.holdLeft = 0.7;
      return;
    }
    st.phase = st.lead > 0 ? 'lead' : 'run';
    if (st.phase === 'run') this.enterRun();
  }

  enterRun() {
    const s = this.cur;
    const st = this.st;
    st.phase = 'run';
    if (s.kind === 'reps') {
      st.mode = this.coach && this.camOn && this.modelReady ? 'camera' : 'tempo';
      this.lastSeen = performance.now();
    }
  }

  tick() {
    const now = performance.now();
    let dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (this.paused || this.ended || this.overlayOpen || !this.st) return;
    const s = this.cur;
    const st = this.st;
    dt = (s.kind === 'walk' ? dt : Math.min(dt, 0.5)) * SPEED;

    if (st.phase === 'intro') {
      if (st.introLeft != null) { st.introLeft -= dt; if (st.introLeft <= 0) this.afterIntro(); }
    } else if (st.phase === 'hold') {
      st.holdLeft -= dt / SPEED;
      if (st.holdLeft <= 0) { this.doneSteps++; return this.go(this.i + 1); }
    } else if (st.phase === 'lead') {
      st.lead -= dt;
      if (st.lead <= 0) this.enterRun();
    } else if (st.phase === 'run') {
      if (s.kind === 'timer' || s.kind === 'walk') this.runTimer(s, st, dt);
      else if (s.kind === 'breath') this.runBreath(s, st, dt);
      else if (s.kind === 'reps') this.runReps(s, st, dt, now);
    }
    this.paint();
  }

  runTimer(s, st, dt) {
    st.t += dt;
    for (const c of s.cues || []) {
      if (st.t >= c.at && !st.fired.has(c.at)) {
        st.fired.add(c.at);
        if (!voice.isSpeaking()) { voice.speak(c.say); this.showCue(c.say, false); }
      }
    }
    if (st.t >= s.dur) this.finishStep(false);
  }

  runBreath(s, st, dt) {
    const total = s.inh + s.exh;
    st.t += dt;
    const cyc = Math.floor(st.t / total);
    if (cyc >= s.cycles) return this.finishStep(false);
    const ph = st.t - cyc * total < s.inh ? 'in' : 'out';
    if (ph !== st.breath || cyc !== st.cyc) {
      st.breath = ph;
      st.cyc = cyc;
      this.ink.style.transitionDuration = `${(ph === 'in' ? s.inh : s.exh) / SPEED}s`;
      this.ink.className = `s-ink breathing ${ph}`;
      if (cyc < (s.speakCycles ?? s.cycles)) voice.speak(ph === 'in' ? 'вдох' : 'выдох', { interrupt: true });
    }
  }

  runReps(s, st, dt, now) {
    st.t += dt;
    if (st.mode === 'camera') {
      // Камера не видит ученика или полминуты не может засчитать повтор — переходим на счёт по времени.
      if (now - this.lastSeen > 10000) this.toTempo('lost');
      else if (st.t - (st.lastRepT ?? 0) > 30) this.toTempo('stuck');
      if (st.reps >= s.reps) this.finishStep(false);
      return;
    }
    const cycle = s.tempo.reduce((a, p) => a + p.dur, 0);
    st.tt = (st.tt ?? 0) + dt;
    const rep = Math.floor(st.tt / cycle);
    if (rep >= s.reps) { st.reps = s.reps; return this.finishStep(false); }
    let within = st.tt - rep * cycle;
    let idx = 0;
    while (idx < s.tempo.length - 1 && within >= s.tempo[idx].dur) { within -= s.tempo[idx].dur; idx++; }
    if (idx !== st.tempoIdx || rep !== st.tempoRep) {
      st.tempoIdx = idx;
      st.tempoRep = rep;
      st.reps = rep;
      const p = s.tempo[idx];
      const word = Array.isArray(p.say) ? p.say[rep % p.say.length] : p.say;
      voice.speak(word, { interrupt: true });
      this.showCue(word, false);
    }
  }

  toTempo(announce) {
    const s = this.cur;
    const st = this.st;
    if (!s || s.kind !== 'reps') return;
    st.mode = 'tempo';
    st.tt = st.reps * s.tempo.reduce((a, p) => a + p.dur, 0);
    st.tempoIdx = -1;
    if (announce === 'lost') { voice.speak('Я вас не вижу. Считаю по времени.', { interrupt: true }); this.showCue('Не вижу вас, считаю по времени', false); }
    if (announce === 'stuck') { voice.speak('Не получается считать по камере. Считаю по времени.', { interrupt: true }); this.showCue('Считаю по времени', false); }
  }

  onFrame(lm, world, now, aspect) {
    const st = this.st;
    if (!this.coach || this.paused || this.overlayOpen || !st || st.phase !== 'run') return { bad: false };
    const r = this.coach.update(lm, world, now, aspect);
    if (r.visible) this.lastSeen = now;
    for (const e of r.ev) {
      if (e.type === 'rep') this.onRep(e.n);
      else if (e.type === 'cue') { this.results.cues++; this.showCue(e.say, true); voice.speak(e.say, { interrupt: true }); }
    }
    return { bad: r.bad };
  }

  onRep(n) {
    const s = this.cur;
    const st = this.st;
    if (s.kind === 'reps') {
      if (st.mode !== 'camera') return;
      st.reps = n;
      st.lastRepT = st.t;
      if (state.settings.countAloud && n < s.reps && !voice.isSpeaking()) voice.speak(voice.numWord(n));
    } else {
      st.reps = n;
    }
  }

  showCue(text, warn) {
    this.el.cue.textContent = text;
    this.el.cue.classList.toggle('warn', !!warn);
    clearTimeout(this.cueTimer);
    this.cueTimer = setTimeout(() => { this.el.cue.textContent = ''; }, 5000);
  }

  flash(text) { this.showCue(text, true); }

  paint() {
    const s = this.cur;
    const st = this.st;
    if (!s || !st) return;
    let num = '';
    let unit = '';
    if (st.phase === 'intro' || st.phase === 'hold') { unit = s.kind === 'talk' ? '' : 'слушайте наставника'; }
    else if (st.phase === 'lead') { num = String(Math.max(1, Math.ceil(st.lead))); unit = 'займите положение'; }
    else if (s.kind === 'timer' || s.kind === 'walk') {
      num = mmss(s.dur - st.t);
      unit = s.pose === 'shift' && st.reps ? `переносов: ${st.reps}` : 'осталось';
    } else if (s.kind === 'breath') {
      num = st.breath === 'out' ? 'выдох' : 'вдох';
      unit = `осталось дыханий: ${Math.max(0, s.cycles - (st.cyc ?? 0))}`;
    } else if (s.kind === 'reps') {
      num = `${Math.min(st.reps, s.reps)} / ${s.reps}`;
      unit = st.mode === 'camera' ? 'считает камера' : 'считаю по времени';
    }
    if (this.el.num.textContent !== num) this.el.num.textContent = num;
    if (this.el.unit.textContent !== unit) this.el.unit.textContent = unit;
    let frac = 0;
    if (st.phase === 'run') {
      if (s.kind === 'timer' || s.kind === 'walk') frac = st.t / s.dur;
      else if (s.kind === 'breath') frac = st.t / (s.cycles * (s.inh + s.exh));
      else if (s.kind === 'reps') frac = st.reps / s.reps;
    }
    this.el.bar.style.width = `${Math.min(100, ((this.i + Math.min(1, frac)) / this.steps.length) * 100)}%`;
  }

  finishStep(skipped) {
    const s = this.cur;
    const st = this.st;
    if (this.coach) { const q = this.coach.quality(); if (q != null) this.results.quality.push(q); }
    if (s.id === 'stolb') this.results.stolbSec = Math.max(this.results.stolbSec, Math.round(Math.min(st.t, s.dur)));
    if (s.track === 'chair') this.results.chairReps = Math.max(this.results.chairReps, Math.min(st.reps, s.reps));
    if (s.kind === 'reps') this.results.repsTotal += Math.min(st.reps, s.reps);
    if (!skipped) this.doneSteps++;
    this.go(this.i + 1);
  }

  act(name) {
    // После окончания занятия работают только кнопки итогового окна.
    if (this.ended && !['summary-save', 'finish-save', 'finish-drop'].includes(name)) return undefined;
    if (name === 'pause') return this.paused ? this.resume() : this.pause();
    if (name === 'next') return this.finishStep(true);
    if (name === 'prev') return this.go(this.i - 1);
    if (name === 'plus') return this.plus();
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
    this.el.pause.textContent = 'Продолжить';
    this.root.classList.add('paused');
  }

  resume() {
    this.paused = false;
    this.lastTick = performance.now();
    this.lastSeen = performance.now();
    this.el.pause.textContent = 'Пауза';
    this.root.classList.remove('paused');
    if (this.st?.phase === 'intro' && (this.st.introPending || this.st.introLeft == null)) { this.st.introPending = false; this.intro(); }
  }

  plus() {
    const s = this.cur;
    const st = this.st;
    if (!s || s.kind !== 'reps' || st.phase !== 'run') return;
    st.reps++;
    if (st.mode === 'camera' && this.coach) { this.coach.reps = st.reps; st.lastRepT = st.t; }
    else st.tt = st.reps * s.tempo.reduce((a, p) => a + p.dur, 0);
  }

  // ---- голосовые команды ----
  command(p) {
    if (this.ended) return;
    if (this.overlayOpen) return;
    const m = p.match(/^(?:мастер|учитель|вопрос)[,.!\s]+(.+)/);
    if (m && /посмотри/.test(m[1])) return this.ask({ look: true });
    if (m && m[1].length > 3) return this.ask({ text: m[1] });
    if (/нехорошо|плохо|кружится|больно/.test(p)) return this.sos();
    if (/пауза|подожди|стоп/.test(p)) { if (!this.paused) { this.pause(); voice.speak('Пауза. Скажите «продолжай», когда будете готовы.', { force: false }); } return undefined; }
    if (/продолж|поехали/.test(p)) { if (this.paused) this.resume(); return undefined; }
    if (/дальше|следующ|пропус/.test(p)) return this.paused ? this.resume() : this.finishStep(true);
    if (/назад|предыдущ/.test(p)) return this.go(this.i - 1);
    if (/повтори/.test(p)) { this.st.phase = 'intro'; return this.intro(); }
    if (/закончи|хватит/.test(p)) return this.exitDialog();
    return undefined;
  }

  // ---- оверлеи ----
  openOverlay(html) {
    this.overlayOpen = true;
    voice.cancel();
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
    this.lastSeen = performance.now();
    if (!this.paused && this.st?.phase === 'intro') { this.st.introPending = false; this.intro(); }
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
    voice.speak('Остановитесь. Сядьте и дышите спокойно. Если есть боль в груди, одышка, слабость или онемение, звоните сто три.', { interrupt: true });
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
