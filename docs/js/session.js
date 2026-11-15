// Занятие: наставник ведёт по шагам голосом, камера считает повторы и следит за осанкой.
import { state, day, save, dateStr } from './store.js';
import { buildSession, RED_FLAGS, SESSION_META, SESSION_LINES } from './course.js';
import { COACH_TEXTS } from './coach.js';
import { Coach, POSES, describe } from './coach.js';
import * as voice from './voice.js';
import * as ambient from './ambient.js';
import * as pose from './pose.js';
import { askMaster, hasKey } from './master.js';
import { t } from './i18n.js';
import { FigurePlayer, beatTarget } from './figplayer.js';

const params = new URLSearchParams(location.search);
const SPEED = Math.max(1, Number(params.get('speed')) || 1);
const UNWELL = /нехорошо|плохо|кружит|головокруж|темнеет в глазах|в груди|давит|задыха|онемел|немеет|слабость в|unwell|dizzy|sick|chest pain|can'?t breathe|numb/;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = (sec) => { const s = Math.max(0, Math.ceil(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// Какая музыка звучит на шаге занятия.
function sceneFor(s) {
  if (s.kind === 'talk') return 'talk';
  if (s.id === 'unload') return 'rest';
  if (s.kind === 'breath') return 'breath';
  if (s.id === 'stolb' || s.id === 'walk' || /^rest/.test(s.id)) return 'hold';
  if (s.group === 'Цигун' || s.id === 'sky' || s.id === 'qishi' || s.id === 'shift') return 'qigong';
  if (s.group === 'Суставная разминка') return 'warmup';
  return 'strength';
}

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
    this.date = dateStr(); // занятие после полуночи засчитывается в день начала
    this.build();
  }

  build() {
    this.root.innerHTML = `
      <div class="s-stage">
        <video class="s-video" playsinline muted></video>
        <canvas class="s-canvas"></canvas>
        <div class="s-ink" aria-hidden="true"></div>
        <div class="s-fig" aria-hidden="true"></div>
      </div>
      <div class="s-top">
        <button class="s-icon" data-act="exit" aria-label="${t('Закончить занятие')}">✕</button>
        <div class="s-progress" role="progressbar" aria-label="${t('Ход занятия')}"><i></i></div>
        <span class="s-count"></span>
        <button class="s-chip" data-act="cam" aria-pressed="false">${t('Камера')}</button>
      </div>
      <p class="s-cue" aria-live="polite"></p>
      <div class="s-panel">
        <p class="s-group"></p>
        <h2 class="s-title"></h2>
        <p class="s-text"></p>
        <div class="s-big"><span class="s-num"></span><span class="s-unit"></span></div>
        <div class="s-controls">
          <button class="s-btn" data-act="prev">${t('Назад')}</button>
          <button class="s-btn s-main" data-act="pause">${t('Пауза')}</button>
          <button class="s-btn" data-act="next">${t('Дальше')}</button>
        </div>
        <div class="s-extra">
          <button class="s-chip" data-act="ask">${t('Сказать мастеру')}</button>
          <button class="s-chip" data-act="look">${t('Мастер, посмотри')}</button>
          <button class="s-chip s-danger" data-act="sos">${t('Мне нехорошо')}</button>
        </div>
      </div>
      <div class="s-overlay" hidden></div>`;
    const q = (s) => this.root.querySelector(s);
    this.video = q('.s-video');
    this.canvas = q('.s-canvas');
    this.ink = q('.s-ink');
    const w = typeof this.o.week === 'object' && this.o.week ? this.o.week : {};
    this.fig = new FigurePlayer(q('.s-fig'), { gentleNeck: w.gentleNeck, noHeadDown: w.noHeadDown });
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
    this.onVis = () => {
      if (document.hidden) return;
      this.requestWake();
      voice.resumeAudio(); // после звонка или блокировки экрана айфон «замораживает» звук
    };
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
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), 100);
    // Загружаем записи голоса мастера для этого занятия, но не дольше 12 секунд.
    this.preparing = true;
    this.go(0);
    const texts = this.steps.flatMap((st) => st.items.flatMap((it) => [it.text, ...(it.cues || []).map((c) => c.text)])).filter(Boolean);
    const pre = voice.preload([...texts, ...COACH_TEXTS], (d, n) => { if (this.preparing) this.el.unit.textContent = `${t('готовлю голос мастера:')} ${Math.round((d / n) * 100)}%`; });
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
    if (this.camBusy) return;
    this.camBusy = true;
    this.el.cam.textContent = t('Камера…');
    try {
      await pose.startCamera(this.video);
      if (this.ended) return pose.stopCamera();
      this.camOn = true;
      this.root.classList.add('cam');
      this.el.cam.setAttribute('aria-pressed', 'true');
      this.el.cam.textContent = t('Загружаю зрение…');
      await pose.loadModel();
      if (this.ended || !this.camOn) return;
      this.modelReady = true;
      pose.startLoop(this.video, this.canvas, (lm, world, now, aspect) => this.onFrame(lm, world, now, aspect));
      this.el.cam.textContent = t('Камера вкл.');
    } catch (err) {
      this.disableCamera();
      this.flash(err?.name === 'NotAllowedError'
        ? t('Нет доступа к камере. Занимаемся без неё.')
        : t('Камера недоступна. Занимаемся без неё.'));
    } finally {
      this.camBusy = false;
    }
  }

  disableCamera() {
    pose.stopCamera();
    this.camOn = false;
    this.modelReady = false;
    this.root.classList.remove('cam');
    this.el.cam.setAttribute('aria-pressed', 'false');
    this.el.cam.textContent = t('Камера выкл.');
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  go(i) {
    if (i >= this.steps.length) return this.complete();
    this.i = Math.max(0, i);
    const s = this.cur;
    this.coach = s.pose && POSES[s.pose] ? new Coach(s.pose) : null;
    this.st = { j: 0, token: 0, rep: 0, maxRep: 0, breath: null, holdT: 0, firedCues: new Set(), pendingCue: null, speaking: false };
    this.fig.setStep(String(s.id).replace(/\d+$/, ''));
    this.root.classList.toggle('with-fig', !!this.fig.id);
    this.figSt = {};
    this.el.group.textContent = t(s.group || SESSION_META[this.plan.kind].title);
    this.el.title.textContent = t(s.title);
    this.el.text.textContent = t(s.text || '');
    this.el.count.textContent = `${this.i + 1}/${this.steps.length}`;
    this.el.cue.textContent = '';
    this.root.dataset.kind = s.kind;
    ambient.setScene(sceneFor(s));
    if (s.id === 'end') ambient.chime('end');
    else if (this.i === 0) ambient.chime('start');
    this.ink.className = 's-ink';
    this.startItem();
    this.paint();
    return undefined;
  }

  get item() { return this.cur?.items[this.st.j]; }

  // Произносит фразу; когда договорит (или сразу, если голос выключен), вызывает done.
  sayNow(text, done, fit = 0) {
    const st = this.st;
    const tok = st.token;
    st.speaking = true;
    const t0 = performance.now();
    voice.speak(text, { interrupt: true, fit }).then((ok) => {
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
      ambient.beat({ breath: it.breath, dur: it.dur / SPEED, rep: it.rep });
      // После паузы такт начинается заново — манекен идёт к той же позе, а не к следующей.
      const tg = st.figJ === st.j ? st.figTarget : beatTarget(this.fig, it, this.figSt);
      st.figJ = st.j;
      st.figTarget = tg;
      if (tg != null) this.fig.moveTo(tg, Math.min(6, it.dur / SPEED) * 0.9);
      // Длина такта считается по исходной записи фразы, а не по подстроенному голосу:
      // быстрее или медленнее говорит мастер — счёт идёт в том же темпе.
      const win = Math.max(it.dur, voice.clipSeconds(it.text) * SPEED);
      st.beatLeft = win;
      if (it.rep) { st.rep = it.rep; st.maxRep = Math.max(st.maxRep, it.rep); }
      if (it.breath && it.breath !== st.breath) {
        st.breath = it.breath;
        this.ink.style.transitionDuration = `${it.dur / SPEED}s`;
        this.ink.className = `s-ink breathing ${it.breath}`;
      }
      if (it.text) { this.sayNow(it.text, null, win / SPEED); this.showCue(t(it.text), false); }
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
        else if (due) { st.firedCues.add(due.at); this.sayNow(due.text); this.showCue(t(due.text), false); }
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
      if (e.type === 'cue') { this.results.cues++; this.showCue(t(e.say), true); st.pendingCue = e.say; }
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
    if (this.preparing) { unit = t('готовлю голос мастера'); }
    else if (!it || it.t === 'say' || st.phase === 'cue') { unit = s.kind === 'talk' ? '' : t('слушайте мастера'); }
    else if (it.t === 'hold') { num = mmss(it.dur - st.holdT); unit = t('осталось'); }
    else if (it.t === 'beat' && !it.rep) { num = mmss(st.beatLeft ?? it.dur); unit = it.label || ''; }
    else if (s.kind === 'breath') { num = it.breath === 'out' ? t('выдох') : t('вдох'); unit = `${t('дыхание')} ${it.rep} ${t('из')} ${s.reps}`; }
    else if (it.t === 'beat') { num = `${it.rep} / ${s.reps}`; unit = it.breath === 'in' ? t('вдох') : it.breath === 'out' ? t('выдох') : t('повтор'); }
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
    ambient.setPaused(true);
    this.fig?.pause(true);
    voice.cancel();
    if (this.st) { this.st.token++; this.st.speaking = false; }
    this.el.pause.textContent = t('Продолжить');
    this.root.classList.add('paused');
  }

  resume() {
    voice.unlock();
    voice.resumeAudio();
    this.paused = false;
    ambient.setPaused(false);
    this.fig?.pause(false);
    this.lastTick = performance.now();
    this.el.pause.textContent = t('Пауза');
    this.root.classList.remove('paused');
    // Текущий такт или фразу повторяем с начала, удержание продолжается.
    if (!this.overlayOpen) this.startItem();
  }

  // ---- голосовые команды ----
  // Короткая голосовая команда после нажатия «Сказать мастеру». Возвращает true, если это была команда.
  // Микрофон включается только по нажатию: постоянное прослушивание на айфоне прерывает звук занятия.
  command(raw) {
    const p = String(raw || '').toLowerCase().replace(/^(?:мастер|учитель|master|teacher)[,.!\s]*/, '').trim();
    if (!p) return false;
    // Тревожные слова — в любой фразе, какой бы длинной она ни была.
    if (UNWELL.test(p)) { this.sos(); return true; }
    if (p.split(/\s+/).length > 3) return false;
    const run = (fn) => { this.closeOverlay(); fn(); return true; };
    if (/посмотри|look/.test(p)) { this.ask({ look: true }); return true; }
    if (/пауза|подожди|стоп|pause|wait|stop/.test(p)) return run(() => { if (!this.paused) this.pause(); });
    if (/продолж|поехали|continue|resume|go on/.test(p)) return run(() => { if (this.paused) this.resume(); });
    if (/дальше|следующ|пропус|next|skip/.test(p)) return run(() => (this.paused ? this.resume() : this.finishStep(true)));
    if (/назад|предыдущ|back|previous/.test(p)) return run(() => this.go(this.i - 1));
    if (/повтори|repeat|again/.test(p)) return run(() => this.repeatInstruction());
    if (/закончи|хватит|finish|enough|end/.test(p)) { this.exitDialog(); return true; }
    return false;
  }

  // ---- оверлеи ----
  openOverlay(html) {
    this.abort?.abort(); // прежний ответ мастера не должен говорить поверх нового вопроса
    this.overlayOpen = true;
    voice.cancel();
    if (this.st) { this.st.token++; this.st.speaking = false; }
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
    this.lastTick = performance.now();
    if (!this.paused && !this.ended) this.startItem();
  }

  stepContext() {
    const s = this.cur;
    const parts = [`${t('Сейчас идёт занятие «')}${SESSION_META[this.plan.kind].title}${t('», упражнение «')}${s.title}»: ${s.text || ''}`];
    if (this.coach?.m) parts.push(`${t('Камера измерила:')} ${describe(this.coach.m)}.`);
    else if (s.pose) parts.push(t('Камера сейчас не видит ученика целиком.'));
    return parts.join('\n');
  }

  async ask({ text, look }) {
    if (look && !hasKey()) {
      return this.openOverlay(`<div class="ov-card"><h3>${t('Нужен ключ')}</h3><p>${t('Чтобы наставник посмотрел на кадр с камеры и разобрал осанку, добавьте ключ API в настройках. Без ключа осанку проверяет только встроенный контроль углов.')}</p><button class="btn" data-act="ov-close">${t('Продолжить занятие')}</button></div>`);
    }
    if (look && !(this.camOn && this.video.videoWidth)) {
      return this.openOverlay(`<div class="ov-card"><h3>${t('Камера выключена')}</h3><p>${t('Включите камеру кнопкой вверху и встаньте так, чтобы были видны голова и стопы.')}</p><button class="btn" data-act="ov-close">${t('Продолжить занятие')}</button></div>`);
    }
    const image = look ? pose.snapshot(this.video) : null;
    let question = text || (look ? t('Посмотрите, пожалуйста, как я выполняю это упражнение, и поправьте меня.') : '');
    if (!question) {
      if (voice.sttSupported) {
        this.openOverlay(`<div class="ov-card"><p class="ov-eyebrow">${t('Слушаю')}</p><p class="ov-live">${t('Говорите…')}</p><p class="note">${t('Вопрос или команда: «пауза», «дальше», «назад», «повтори», «посмотри».')}</p><button class="btn ghost" data-act="ov-close">${t('Отмена')}</button></div>`);
        const live = this.el.overlay.querySelector('.ov-live');
        try {
          question = await voice.listenOnce({ onInterim: (txt) => { if (live.isConnected) live.textContent = txt || t('Говорите…'); } });
        } catch { question = null; }
        if (!this.overlayOpen) return undefined;
        if (question && this.command(question)) return undefined;
      }
      if (!question) return this.typedPrompt(question === '' ? t('Не расслышал. Напишите вопрос или попробуйте ещё раз.') : t('Напишите вопрос. Можно надиктовать кнопкой микрофона на клавиатуре.'));
    }
    return this.answer(question, image);
  }

  typedPrompt(hint) {
    this.openOverlay(`<div class="ov-card"><p class="ov-eyebrow">${t('Вопрос наставнику')}</p><p>${esc(hint)}</p>
      <textarea class="ov-input" id="s-ask-input" rows="3" placeholder="${t('Например: как держать руки в столбе?')}"></textarea>
      <div class="ov-row"><button class="btn" data-act="ov-send">${t('Спросить')}</button>${voice.sttSupported ? `<button class="btn ghost" data-act="ov-ask">${t('Голосом')}</button>` : ''}<button class="btn ghost" data-act="ov-close">${t('Отмена')}</button></div></div>`);
  }

  sendTyped() {
    const v = this.el.overlay.querySelector('.ov-input')?.value.trim();
    if (v && UNWELL.test(v.toLowerCase())) { this.sos(); return; }
    if (v) this.answer(v, null);
  }

  async answer(question, image) {
    this.openOverlay(`<div class="ov-card"><p class="ov-eyebrow">${t('Вы спросили')}</p><p class="ov-q"></p><p class="ov-eyebrow">${t('Наставник')}</p><p class="ov-a">${t('Думаю…')}</p>
      <div class="ov-row"><button class="btn" data-act="ov-close">${t('Продолжить занятие')}</button><button class="btn ghost" data-act="ov-ask">${t('Ещё вопрос')}</button></div></div>`);
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
      if (out.isConnected) out.textContent = err.message || t('Не получилось получить ответ.');
    }
  }

  sos() {
    this.pause();
    this.openOverlay(`<div class="ov-card ov-sos"><h3>${t('Остановитесь')}</h3><p>${t('Сядьте или лягте. Дышите спокойно, без задержек.')}</p>
      <p><strong>${t('Сразу звоните 103 или 112')}</strong>${t(', если есть хотя бы одно:')}</p>
      <ul>${RED_FLAGS.map((f) => `<li>${esc(t(f))}</li>`).join('')}</ul>
      <div class="ov-row"><a class="btn danger" href="tel:103">${t('Позвонить 103')}</a><a class="btn danger" href="tel:112">${t('Позвонить 112')}</a></div>
      <p>${t('Если просто закружилась голова или стало больно, на сегодня достаточно. Измерьте давление и запишите в дневник, что случилось.')}</p>
      <div class="ov-row"><button class="btn" data-act="finish-save">${t('Закончить занятие')}</button><button class="btn ghost" data-act="ov-close">${t('Мне лучше, вернуться')}</button></div></div>`);
    voice.speak(SESSION_LINES.sos, { interrupt: true });
  }

  exitDialog() {
    this.pause();
    this.openOverlay(`<div class="ov-card"><h3>${t('Закончить занятие?')}</h3><p>${t('Пройдено шагов:')} ${this.i} ${t('из')} ${this.steps.length}.</p>
      <div class="ov-col"><button class="btn" data-act="ov-close">${t('Вернуться к занятию')}</button>
      <button class="btn ghost" data-act="finish-save">${t('Закончить и засчитать')}</button>
      <button class="btn ghost" data-act="finish-drop">${t('Выйти без записи')}</button></div></div>`);
  }

  complete() {
    this.completed = true;
    this.stopEngines();
    const r = this.results;
    const q = r.quality.length ? Math.round(r.quality.reduce((a, b) => a + b, 0) / r.quality.length) : null;
    const dur = Math.round((Date.now() - this.startedAt) / 1000);
    const rows = [
      [t('Длительность'), mmss(dur)],
      r.repsTotal ? [t('Повторов'), String(r.repsTotal)] : null,
      r.stolbSec ? [t('Столб'), mmss(r.stolbSec)] : null,
      q != null ? [t('Без замечаний камеры'), `${q}${t('% времени')}`] : null,
    ].filter(Boolean);
    const cur = day().pain?.back;
    this.openOverlay(`<div class="ov-card ov-summary"><div class="stamp done big">${SESSION_META[this.plan.kind].seal}</div><h3>${t('Занятие окончено')}</h3>
      <dl class="ov-stats">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      <label class="ov-label" for="s-pain">${t('Боль в пояснице сейчас:')} <output id="s-pain-out">${cur ?? '—'}</output></label>
      <input type="range" id="s-pain" min="0" max="10" step="1" value="${cur ?? 0}" data-touched="${cur != null ? 1 : 0}">
      <button class="btn" data-act="summary-save">${t('Сохранить')}</button></div>`);
    const range = this.el.overlay.querySelector('#s-pain');
    range.addEventListener('input', () => { range.dataset.touched = '1'; this.el.overlay.querySelector('#s-pain-out').textContent = range.value; });
  }

  stopEngines() {
    clearInterval(this.timer);
    this.ended = true;
    this.fig?.stop();
    pose.stopCamera();
    try { this.wake?.release(); } catch { /* noop */ }
  }

  finish(record, fromSummary = false) {
    const kind = this.plan.kind;
    if (record) {
      const d = day(this.date || dateStr());
      const r = this.results;
      // Незавершённый шаг тоже учитываем: время столба и повторы до выхода.
      if (!this.completed && this.st && this.cur) {
        if (this.cur.id === 'stolb') r.stolbSec = Math.max(r.stolbSec, Math.round(Math.min(this.st.holdT || 0, this.cur.dur || 0)));
        if (this.cur.track === 'chair') r.chairReps = Math.max(r.chairReps, Math.max(0, (this.st.maxRep || 1) - 1), this.coach?.reps || 0);
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
    ambient.setPaused(false);
    ambient.setScene('home');
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
