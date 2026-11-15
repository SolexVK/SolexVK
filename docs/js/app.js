import {
  state, save, day, peekDay, dateStr, addDays, parseDate, subscribe, isStorageOk,
  getApiKey, setApiKey, exportJSON, importJSON, resetAll,
  coreDone, streak, weekCore, lastValue, series, SESSION_KINDS,
} from './store.js';
import { courseInfo, buildSession, bpMode, BP_TEXT, SESSION_META, SAFETY_RULES, RED_FLAGS } from './course.js';
import * as voice from './voice.js';
import { cameraSupported } from './pose.js';
import { askMaster, hasKey } from './master.js';
import { lineChart, weekBars } from './charts.js';
import { SessionRunner } from './session.js';
import { PALETTES, applyPalette, CLOUD_RULE } from './theme.js';
import * as ambient from './ambient.js';
import { startIntake, runCheckin, runReview, reviewDue, currentPlan, todayCheckin, programHtml } from './flows.js';
import { readiness, levelInfo, SESSION_MIN } from './program.js';
import { renderSheet } from './sheet.js';
import { renderFood } from './food.js';
import { targets } from './nutrition.js';
import { GUIDES } from './guides.js';
import { LEVELS } from './kb.js';
import { aiAvailable, remember } from './brain.js';
import { startSync, serverConfig, setServer, syncStatus, onSyncStatus, pull, api } from './sync.js';
import { t, locale, lang, LANGS } from './i18n.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmtSpeed = (v) => `${Number(v).toFixed(2).replace('.', ',')}×`;
const fmtPitch = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0').replace('.', ',') + (v ? ` ${t('полутона')}` : ` (${t('как записано')})`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');
const sheet = $('#sheet');
const params = new URLSearchParams(location.search);
if (params.get('mute')) state.settings.voice = false;

let view = 'today';
let diaryDate = dateStr();
let runner = null;

const WD = [t('воскресенье'), t('понедельник'), t('вторник'), t('среда'), t('четверг'), t('пятница'), t('суббота')];
const MONTHS = [t('января'), t('февраля'), t('марта'), t('апреля'), t('мая'), t('июня'), t('июля'), t('августа'), t('сентября'), t('октября'), t('ноября'), t('декабря')];
const longDate = (s) => { const d = parseDate(s); return `${WD[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const shortDate = (s) => { const d = parseDate(s); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; };
const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
const minutes = (sec) => `≈ ${Math.max(1, Math.round(sec / 60))} ${t('мин')}`;

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------- каркас ----------
const BP_LABEL = { full: t('полное занятие'), light: t('лёгкий режим'), none: t('не заниматься'), unknown: t('не измерено') };
const MODE_ORDER = { full: 0, light: 1, rest: 2, none: 3 };
const MODE_LABEL = { full: t('полное занятие'), light: t('мягкий режим'), rest: t('день восстановления'), none: t('без занятия') };
// Режим на сегодня: самое бережное из решения опроса и правила давления.
function effectiveMode(d) {
  const bp = bpMode(d?.bp?.sys, d?.bp?.dia);
  let m = bp === 'unknown' ? 'full' : bp;
  const c = d?.checkin?.decision?.mode;
  if (c && MODE_ORDER[c] > MODE_ORDER[m]) m = c;
  return m;
}
const todaySkip = (d) => d?.checkin?.decision?.skip || [];
const TITLES = { today: t('Сегодня'), program: t('Программа'), food: t('Питание'), diary: t('Дневник'), progress: t('Прогресс'), master: t('Мастер') };

function render() {
  if (!runner) ambient.setScene(document.body.classList.contains('focus') ? 'talk' : 'home');
  const onboard = !state.profile.onboarded;
  document.body.classList.toggle('onboarding', onboard);
  if (onboard) return renderOnboard();
  $('#view-title').textContent = TITLES[view];
  $$('.tab').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
  if (view === 'today') renderToday();
  else if (view === 'diary') renderDiary();
  else if (view === 'program') renderProgram();
  else if (view === 'food') renderFoodView();
  else if (view === 'progress') renderProgress();
  else if (view === 'master') renderMaster();
  return undefined;
}

function go(v) {
  view = v;
  render();
  main.scrollTop = 0;
  window.scrollTo(0, 0);
}

// ---------- первое знакомство ----------
function renderOnboard() {
  main.innerHTML = `
    <section class="onb">
      <div class="seal-mark big" aria-hidden="true">太極</div>
      <h2>${t('Ваш мастер тайцзи')}</h2>
      <p class="lead">${t('Мастер начнёт со знакомства: голосом задаст около двадцати вопросов о здоровье, подвижности и целях, проведёт три простые проверки и подберёт программу под вас. Отвечать можно кнопками или голосом.')}</p>
      <div class="callout">
        <strong>${t('Приложение не заменяет врача.')}</strong> ${t('Если есть боль в спине, отдающая в ноги, повышенное давление или болезни сердца, покажитесь врачу в первые недели занятий.')}
      </div>
      <p class="note">${t('Для проверок понадобятся устойчивый стул и опора рядом. Займёт около десяти минут.')}</p>
      <button class="btn wide" data-intake>${t('Познакомиться с мастером')}</button>
      ${serverConfig() ? '' : `<button class="btn ghost wide" data-open="settings">${t('У меня уже есть сервер с данными')}</button>`}
    </section>`;
}

function openIntake() {
  startIntake(main, () => go('today'));
}

// ---------- сегодня ----------
const START_TASKS = [
  ['doctor', t('Показаться терапевту: давление, ЭКГ, базовые анализы')],
  ['back', t('Если болит спина — показаться неврологу до увеличения нагрузки')],
  ['tonometer', t('Положить тонометр там, где занимаетесь')],
  ['steps', t('Три дня посмотреть в телефоне, сколько шагов выходит сейчас')],
  ['home', t('Добавить приложение на экран «Домой»: «Поделиться» → «На экран „Домой“»')],
];

function sessionCard(kind, ci, d) {
  const meta = SESSION_META[kind];
  const rec = d?.sessions?.[kind];
  const mode = effectiveMode(d);
  const plan = buildSession(kind, currentPlan(todaySkip(d)), mode === 'none' ? 'full' : mode);
  const blocked = mode === 'none';
  return `
    <article class="sess ${rec?.done ? 'is-done' : ''}" data-kind="${kind}">
      <div class="stamp ${rec?.done ? 'done' : ''}" aria-hidden="true">${meta.seal}</div>
      <div class="sess-body">
        <h3>${t(meta.title)}</h3>
        <p class="sess-sub">${esc(t(meta.sub))} · ${minutes(plan.dur)}</p>
        ${rec?.done ? `<p class="sess-done">${t('Сделано')}${rec.partial ? t(' частично') : ''}${rec.stolbSec ? ` ${t('· столб')} ${Math.floor(rec.stolbSec / 60)}:${String(rec.stolbSec % 60).padStart(2, '0')}` : ''}${rec.quality != null ? ` ${t('· без замечаний')} ${rec.quality}%` : ''}</p>` : ''}
      </div>
      <button class="btn ${rec?.done ? 'ghost' : ''}" data-start="${kind}" ${blocked ? 'disabled' : ''}>${rec?.done ? t('Ещё раз') : t('Начать')}</button>
    </article>`;
}

function renderToday() {
  const today = dateStr();
  const ci = courseInfo(today);
  const d = peekDay(today) || {};
  const mode = bpMode(d.bp?.sys, d.bp?.dia);
  const monday = parseDate(today).getDay() === 1;
  const needMeasure = monday && (d.weight == null || d.waist == null);
  const openTasks = START_TASKS.filter(([id]) => !state.tasks[id]);
  $('#view-sub').textContent = longDate(today);
  main.innerHTML = `
    <section class="hero">
      <p class="eyebrow">${state.program?.level ? t('Уровень {n} «{name}» · ступень {s} из 4', { n: state.program.level, name: esc(t(levelInfo(state.program.level).name)), s: state.program.stage }) : t('Неделя {n}', { n: ci.week })}</p>
      <h2>${state.profile.name ? `${esc(state.profile.name)}, ${t('день {n}', { n: ci.dayN })}` : t('День {n}', { n: ci.dayN })}</h2>
      ${d.checkin ? `<p class="note">${t('Мастер сегодня:')} ${esc(MODE_LABEL[d.checkin.decision.mode])}. ${esc(t(d.checkin.decision.say))}</p>` : ''}
    </section>

    ${!state.program ? `<section class="callout"><strong>${t('Познакомьтесь с мастером.')}</strong> ${t('Он задаст около двадцати вопросов о здоровье и подготовке и подберёт программу под вас.')} <button class="btn" data-intake>${t('Начать знакомство')}</button></section>` : ''}
    ${reviewDue(today) ? `<section class="callout"><strong>${t('Прошла неделя.')}</strong> ${t('Мастер хочет посмотреть ваш дневник и решить, как двигаться дальше.')} <button class="btn" data-review>${t('Обсудить неделю')}</button></section>` : ''}

    <section class="bp" aria-labelledby="bp-h">
      <h3 id="bp-h">${t('Давление перед занятием')}</h3>
      <div class="bp-row">
        <input id="bp-sys" inputmode="numeric" aria-label="${t('Верхнее давление')}" placeholder="120" value="${esc(d.bp?.sys ?? '')}">
        <span>/</span>
        <input id="bp-dia" inputmode="numeric" aria-label="${t('Нижнее давление')}" placeholder="80" value="${esc(d.bp?.dia ?? '')}">
        <span class="pill ${mode}" id="bp-pill">${BP_LABEL[mode]}</span>
      </div>
      <p class="note" id="bp-text">${t(BP_TEXT[mode])}</p>
    </section>

    ${needMeasure ? `<section class="callout"><strong>${t('Понедельник.')}</strong> ${t('Утром натощак взвесьтесь и измерьте талию на уровне пупка, запишите в дневник.')} <button class="link" data-go="diary">${t('Открыть дневник')}</button></section>` : ''}

    ${CLOUD_RULE}
    <section class="sessions" id="sessions" aria-label="${t('Занятия на сегодня')}">
      ${SESSION_KINDS.map((k) => sessionCard(k, ci, d)).join('')}
    </section>

    <section class="tiles">
      <div class="tile"><span class="tile-v">${streak(today)}</span><span class="tile-l">${t('дней подряд')}</span></div>
      <div class="tile"><span class="tile-v">${weekCore(today)}<small> / 14</small></span><span class="tile-l">${t('занятий за неделю')}</span></div>
      <div class="tile"><span class="tile-v">${d.steps ? Number(d.steps).toLocaleString(locale()) : '—'}</span><span class="tile-l">${t('шагов сегодня')}</span></div>
    </section>

    ${openTasks.length ? `<section class="tasks"><h3>${t('Дела на старте')}</h3>${openTasks.map(([id, text]) => `<label class="check"><input type="checkbox" data-task="${id}"><span>${esc(text)}</span></label>`).join('')}</section>` : ''}

    <details class="rules"><summary>${t('Правила безопасности')}</summary>
      <dl>${SAFETY_RULES.map(([k, v]) => `<dt>${esc(t(k))}</dt><dd>${esc(t(v))}</dd>`).join('')}</dl>
      <p><strong>${t('Срочно звонить 103 или 112:')}</strong> ${RED_FLAGS.map((x) => esc(t(x))).join('; ')}.</p>
    </details>`;

  const onBp = () => {
    const sys = num($('#bp-sys').value);
    const dia = num($('#bp-dia').value);
    const dd = day(today);
    // Пока введена только одна цифра, экран не перерисовываем: иначе она пропадёт.
    if (sys && dia) dd.bp = { sys, dia };
    else if (!sys && !dia && dd.bp) delete dd.bp;
    else return;
    save();
    // Обновляем только зависимые части, чтобы поле ввода не теряло фокус.
    const bm = bpMode(dd.bp?.sys, dd.bp?.dia);
    const m = effectiveMode(dd);
    const pill = $('#bp-pill');
    pill.className = `pill ${bm}`;
    pill.textContent = BP_LABEL[bm];
    $('#bp-text').textContent = t(BP_TEXT[bm]);
    // Карточки не пересоздаём: иначе касание «Начать» сразу после ввода давления теряется.
    for (const k of SESSION_KINDS) {
      const card = $(`.sess[data-kind="${k}"]`);
      const plan = buildSession(k, currentPlan(todaySkip(dd)), m === 'none' ? 'full' : m);
      card.querySelector('.sess-sub').textContent = `${t(SESSION_META[k].sub)} · ${minutes(plan.dur)}`;
      card.querySelector('[data-start]').disabled = m === 'none';
    }
  };
  $('#bp-sys').addEventListener('change', onBp);
  $('#bp-dia').addEventListener('change', onBp);
}

// ---------- запуск занятия ----------
async function openStart(kind) {
  const today = dateStr();
  if (state.program && state.program.level === 0) {
    toast(t('По вашим ответам занятия сейчас можно начинать только после разрешения врача. Я подготовлю бережную программу, когда врач даст согласие.'));
    return;
  }
  // Перед первым занятием дня мастер спрашивает о самочувствии.
  if (state.program?.level && kind !== 'evening' && !todayCheckin(today)) {
    const dec = await runCheckin(main, kind);
    render();
    if (!dec || dec.mode === 'none') return;
  }
  const d = day(today);
  const meta = SESSION_META[kind];
  const dyn = () => {
    const mode = effectiveMode(d);
    const plan = buildSession(kind, currentPlan(todaySkip(d)), mode === 'none' ? 'full' : mode);
    const hasPose = plan.steps.some((s) => s.pose);
    return `
      <p class="note"><span class="pill ${mode}">${MODE_LABEL[mode]}</span> ${d.checkin ? esc(t(d.checkin.decision.say)) : t(BP_TEXT[bpMode(d.bp?.sys, d.bp?.dia)])}</p>
      ${mode === 'none' ? `<div class="callout danger"><strong>${t('Сегодня без занятия.')}</strong> ${t('Если есть боль в груди, одышка, слабость руки или ноги, нарушение речи — звоните 103 или 112.')}</div>` : `
      <p class="note">${t('{min}, упражнений: {n}. Уровень {level}, ступень {stage}.', { min: minutes(plan.dur), n: plan.steps.filter((s) => s.kind !== 'talk').length, level: plan.level, stage: plan.stage })}</p>
      ${hasPose && cameraSupported ? `<label class="switch"><input type="checkbox" id="st-cam" ${state.settings.camera ? 'checked' : ''}><span>${t('Камера следит за осанкой и подсказывает')}</span></label>
        <p class="note">${t('Поставьте телефон вертикально на уровне пояса в двух–трёх метрах, чтобы в кадре были голова и стопы. Видео обрабатывается на телефоне и никуда не отправляется.')}</p>` : ''}
      ${voice.sttSupported ? `<p class="note">${t('Микрофон включается только по кнопке «Сказать мастеру»: задайте вопрос или скажите «пауза», «дальше», «повтори».')}</p>` : ''}
      ${voice.ttsSupported ? '' : `<p class="note">${t('Этот браузер не умеет говорить вслух: подсказки будут только на экране.')}</p>`}
      <button class="btn wide" id="st-go">${t('Начать занятие')}</button>`}`;
  };
  openSheet(`
    <h3>${t(meta.title)}</h3>
    <label for="st-sys">${t('Давление сейчас')}</label>
    <div class="bp-row">
      <input id="st-sys" inputmode="numeric" placeholder="120" aria-label="${t('Верхнее давление')}" value="${esc(d.bp?.sys ?? '')}">
      <span>/</span>
      <input id="st-dia" inputmode="numeric" placeholder="80" aria-label="${t('Нижнее давление')}" value="${esc(d.bp?.dia ?? '')}">
    </div>
    <div id="st-dyn" class="sheet-dyn">${dyn()}</div>
    <button class="btn ghost wide" data-close>${t('Отмена')}</button>`);
  let shownMode = effectiveMode(d);
  const upd = () => {
    const sys = num($('#st-sys').value);
    const dia = num($('#st-dia').value);
    if (sys && dia) d.bp = { sys, dia };
    else if (!sys && !dia && d.bp) delete d.bp;
    else return;
    save();
    const m = effectiveMode(d);
    if (m !== shownMode) { shownMode = m; $('#st-dyn').innerHTML = dyn(); }
  };
  $('#st-sys').addEventListener('change', upd);
  $('#st-dia').addEventListener('change', upd);
  $('#st-dyn').addEventListener('click', (e) => {
    if (!e.target.closest('#st-go')) return;
    const camera = !!$('#st-cam')?.checked;
    if ($('#st-cam')) state.settings.camera = camera;
    save();
    const mode = effectiveMode(d);
    if (mode === 'none') return;
    closeSheet();
    runner = new SessionRunner($('#session'), {
      kind, week: currentPlan(todaySkip(d)), mode, camera,
      onFinish: (recorded) => {
        runner = null;
        render();
        if (!recorded) return;
        toast(t('Занятие записано в дневник'));
        const rec = day(dateStr()).sessions[kind] || {};
        remember('session', `Занятие «${SESSION_META[kind].title}» в режиме ${MODE_LABEL[mode]}${rec.partial ? ', частично' : ''}: ${Math.round((rec.durSec || 0) / 60)} мин${rec.stolbSec ? `, столб ${rec.stolbSec} с` : ''}${rec.chairReps ? `, вставаний со стула ${rec.chairReps}` : ''}${rec.quality != null ? `, без замечаний камеры ${rec.quality}%` : ''}.`);
      },
    });
    if (params.get('debug')) window.__runner = runner;
    runner.start();
  });
}

// ---------- дневник ----------
function reportText(date) {
  const d = peekDay(date) || {};
  const ci = courseInfo(date);
  const yn = (k) => (d.sessions?.[k]?.done ? t('да') : t('нет'));
  const lines = [t('День {n} ({date}). Утро: {m}. День: {d}. Вечер: {e}.', { n: ci.dayN, date, m: yn('morning'), d: yn('day'), e: yn('evening') })];
  const l2 = [];
  if (d.bp?.sys) l2.push(`${t('Давление утром:')} ${d.bp.sys}/${d.bp.dia}.`);
  if (d.steps) l2.push(`${t('Шаги:')} ${d.steps}.`);
  if (l2.length) lines.push(l2.join(' '));
  const p = d.pain || {};
  if (p.back != null || p.blades != null || p.legs != null) lines.push(t('Боль: поясница {a}, лопатки {b}, ночью в ноги {c}.', { a: p.back ?? '—', b: p.blades ?? '—', c: p.legs ?? '—' }));
  const m = d.sessions?.morning;
  const dd = d.sessions?.day;
  const extra = [];
  if (m?.stolbSec) extra.push(`${t('столб')} ${Math.floor(m.stolbSec / 60)}:${String(m.stolbSec % 60).padStart(2, '0')}`);
  if (dd?.chairReps) extra.push(`${t('вставаний со стула')} ${dd.chairReps}`);
  if (m?.quality != null) extra.push(`${t('утро без замечаний камеры')} ${m.quality}%`);
  if (extra.length) lines.push(`${t('Показатели:')} ${extra.join(', ')}.`);
  if (d.weight || d.waist) lines.push(t('Вес: {w} кг. Талия: {c} см.', { w: d.weight ?? '—', c: d.waist ?? '—' }));
  if (d.note) lines.push(`${t('Что было трудно:')} ${d.note}`);
  return lines.join('\n');
}

function weekReport() {
  const today = dateStr();
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const ds = addDays(today, -i);
    if (peekDay(ds)) out.push(reportText(ds));
  }
  out.push(`${t('Итого за неделю курса:')} ${weekCore(today)} ${t('занятий из 14, серия')} ${streak(today)} ${t('дн.')}`);
  return out.join('\n\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('Скопировано. Вставьте в чат с наставником.'));
  } catch {
    openSheet(`<h3>${t('Скопируйте вручную')}</h3><textarea class="copybox" rows="10" readonly>${esc(text)}</textarea><button class="btn ghost wide" data-close>${t('Закрыть')}</button>`);
    $('.copybox').select();
  }
}

function painRow(key, label, v) {
  return `<div class="pain"><label for="pain-${key}">${label}</label><output id="pain-${key}-out">${v ?? '—'}</output>
    <input type="range" id="pain-${key}" data-pain="${key}" min="0" max="10" step="1" value="${v ?? 0}"></div>`;
}

function renderDiary() {
  const today = dateStr();
  const d = peekDay(diaryDate) || {};
  const isToday = diaryDate === today;
  const monday = parseDate(diaryDate).getDay() === 1;
  $('#view-sub').textContent = isToday ? t('Сегодня') : longDate(diaryDate);
  const dates = Object.keys(state.days).sort().reverse().slice(0, 21);
  main.innerHTML = `
    <section class="daynav">
      <button class="icon-btn" id="d-prev" aria-label="${t('Предыдущий день')}">‹</button>
      <div><strong>${longDate(diaryDate)}</strong><span>${t('день')} ${courseInfo(diaryDate).dayN} ${t('курса')}</span></div>
      <button class="icon-btn" id="d-next" aria-label="${t('Следующий день')}" ${isToday ? 'disabled' : ''}>›</button>
    </section>

    <form class="form" id="diary-form" novalidate>
      <fieldset><legend>${t('Утром')}</legend>
        <label for="f-sys">${t('Давление, сидя после 5 минут покоя')}</label>
        <div class="bp-row"><input id="f-sys" inputmode="numeric" placeholder="120" aria-label="${t('Верхнее давление')}" value="${esc(d.bp?.sys ?? '')}"><span>/</span><input id="f-dia" inputmode="numeric" placeholder="80" aria-label="${t('Нижнее давление')}" value="${esc(d.bp?.dia ?? '')}"></div>
        <div class="grid2 ${monday ? 'hl' : ''}">
          <div><label for="f-weight">${t('Вес, кг')}${monday ? t(' · понедельник') : ''}</label><input id="f-weight" inputmode="decimal" value="${esc(d.weight ?? '')}"></div>
          <div><label for="f-waist">${t('Талия, см')}</label><input id="f-waist" inputmode="decimal" value="${esc(d.waist ?? '')}"></div>
        </div>
      </fieldset>
      <fieldset><legend>${t('Боль, от 0 до 10')}</legend>
        ${painRow('back', t('Поясница'), d.pain?.back)}
        ${painRow('blades', t('Между лопаток'), d.pain?.blades)}
        ${painRow('legs', t('Ночью в ноги'), d.pain?.legs)}
      </fieldset>
      <fieldset><legend>${t('Вечером')}</legend>
        <label for="f-steps">${t('Шагов за день')}</label>
        <input id="f-steps" inputmode="numeric" value="${esc(d.steps ?? '')}">
        <label for="f-note">${t('Что было трудно, что заметили')}</label>
        <textarea id="f-note" rows="3" placeholder="${t('Можно надиктовать: микрофон на клавиатуре')}">${esc(d.note ?? '')}</textarea>
      </fieldset>
      <div class="stamps-row" aria-label="${t('Занятия дня')}">
        ${SESSION_KINDS.map((k) => `<span class="stamp sm ${d.sessions?.[k]?.done ? 'done' : ''}">${SESSION_META[k].seal}</span><span class="stamp-l">${t(SESSION_META[k].title)}</span>`).join('')}
      </div>
    </form>

    <section class="actions">
      <button class="btn" id="copy-day">${t('Скопировать отчёт за день')}</button>
      <button class="btn ghost" id="copy-week">${t('Отчёт за неделю')}</button>
    </section>

    <section class="log"><h3>${t('Записи')}</h3>
      ${dates.length ? `<div class="table-wrap"><table><thead><tr><th>${t('Дата')}</th><th>${t('Занятия')}</th><th>${t('АД')}</th><th>${t('Поясн.')}</th><th>${t('Шаги')}</th><th>${t('Вес')}</th><th>${t('Талия')}</th></tr></thead><tbody>
        ${dates.map((ds) => { const x = state.days[ds]; return `<tr data-date="${ds}"><td>${shortDate(ds)}</td><td>${SESSION_KINDS.map((k) => (x.sessions?.[k]?.done ? t(SESSION_META[k].title)[0] : '·')).join(' ')}</td><td>${x.bp?.sys ? `${esc(x.bp.sys)}/${esc(x.bp.dia)}` : '—'}</td><td>${esc(x.pain?.back ?? '—')}</td><td>${esc(x.steps ?? '—')}</td><td>${esc(x.weight ?? '—')}</td><td>${esc(x.waist ?? '—')}</td></tr>`; }).join('')}
      </tbody></table></div>` : `<p class="note">${t('Здесь появятся ваши записи. Первая — сегодня вечером.')}</p>`}
    </section>`;

  const write = () => {
    const dd = day(diaryDate);
    const sys = num($('#f-sys').value);
    const dia = num($('#f-dia').value);
    if (sys && dia) dd.bp = { sys, dia }; else delete dd.bp;
    for (const [id, key] of [['f-weight', 'weight'], ['f-waist', 'waist'], ['f-steps', 'steps']]) {
      const v = num($(`#${id}`).value);
      if (v != null && !Number.isNaN(v)) dd[key] = v; else delete dd[key];
    }
    const note = $('#f-note').value.trim();
    if (note) dd.note = note; else delete dd.note;
    save();
  };
  $('#diary-form').addEventListener('change', write);
  $$('[data-pain]').forEach((r) => r.addEventListener('input', () => {
    $(`#pain-${r.dataset.pain}-out`).textContent = r.value;
    day(diaryDate).pain[r.dataset.pain] = Number(r.value);
    save();
  }));
  $('#d-prev').addEventListener('click', () => { diaryDate = addDays(diaryDate, -1); renderDiary(); });
  $('#d-next').addEventListener('click', () => { if (diaryDate < today) { diaryDate = addDays(diaryDate, 1); renderDiary(); } });
  $('#copy-day').addEventListener('click', () => { write(); copyText(reportText(diaryDate)); });
  $('#copy-week').addEventListener('click', () => { write(); copyText(weekReport()); });
  $$('.log tr[data-date]').forEach((tr) => tr.addEventListener('click', () => { diaryDate = tr.dataset.date; renderDiary(); window.scrollTo(0, 0); }));
}

// ---------- прогресс ----------
function delta(cur, start, unit) {
  if (cur == null || start == null) return '';
  const dlt = Math.round((cur - start) * 10) / 10;
  if (!dlt) return `<span class="delta">${t('без изменений')}</span>`;
  // Для веса, талии и боли уменьшение — это хорошо.
  return `<span class="delta ${dlt < 0 ? 'good' : 'bad'}">${dlt < 0 ? '▼' : '▲'} ${String(Math.abs(dlt)).replace('.', ',')} ${unit} ${t('от старта')}</span>`;
}

function renderProgress() {
  const today = dateStr();
  const ci = courseInfo(today);
  $('#view-sub').textContent = `${t('День')} ${ci.dayN} ${t('из 84')}`;
  const w = lastValue('weight');
  const ws = lastValue('waist');
  const p = state.profile;
  const rd = readiness();
  main.innerHTML = `
    <section class="tiles two">
      <div class="tile"><span class="tile-l">${t('Вес')}</span><span class="tile-v">${w ? String(w.value).replace('.', ',') : '—'}<small> ${t('кг')}</small></span>${delta(w?.value, p.startWeight, t('кг'))}</div>
      <div class="tile"><span class="tile-l">${t('Талия')}</span><span class="tile-v">${ws ? String(ws.value).replace('.', ',') : '—'}<small> ${t('см')}</small></span>${delta(ws?.value, p.startWaist, t('см'))}</div>
    </section>

    <section class="chart-card"><h3>${t('Вес, кг')}</h3><div id="ch-weight"></div></section>
    <section class="chart-card"><h3>${t('Талия, см')}</h3><p class="note">${t('Талия отражает висцеральный жир точнее, чем вес.')}</p><div id="ch-waist"></div></section>
    <section class="chart-card"><h3>${t('Боль, от 0 до 10')}</h3><div id="ch-pain"></div></section>
    <section class="chart-card"><h3>${t('Давление утром, мм рт. ст.')}</h3><div id="ch-bp"></div></section>
    <section class="chart-card"><h3>${t('Занятий за неделю')}</h3><p class="note">${t('Утро и день, максимум 14. Вечерняя разгрузка в счёт не идёт.')}</p><div id="ch-weeks"></div></section>
    <p class="note center">${t('Все цифры таблицей — во вкладке')} <button class="link" data-go="diary">${t('«Дневник»')}</button>.</p>

    <section class="phases"><h3>${t('Уровни')}</h3>
      ${LEVELS.map((L) => `<article class="phase ${L.n === state.program?.level ? 'cur' : ''} ${L.n < (state.program?.level || 0) ? 'past' : ''}">
        <div class="phase-n">${L.n}</div>
        <div><h4>${esc(t(L.name))}${L.scripted === false ? ` <small>${t('сценарии в работе')}</small>` : ''}</h4><p>${esc(t(L.goal))}</p></div>
      </article>`).join('')}
      ${rd ? `<h4 class="crit-h">${t('Готовность к следующему уровню:')} ${rd.score} ${t('из 100')}</h4>
      <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${rd.score}"><i style="width:${rd.score}%"></i></div>
      <ul class="crit">${rd.crit.map((c) => `<li class="${c.ok ? 'ok' : ''}"><span class="crit-mark">${c.ok ? '✓' : '○'}</span><span>${esc(c.text)}<small>${esc(c.have)}</small></span></li>`).join('')}</ul>
      <p class="note">${t('Ступень нагрузки внутри уровня меняется раз в неделю на пересмотре с мастером. Решение о новом уровне — только когда выполнены все условия.')}</p>` : `<p class="note">${t('Готовность появится после знакомства с мастером.')}</p>`}
    </section>
    ${state.program ? `<section class="program-card">${programHtml(state.program)}<button class="btn ghost" data-intake>${t('Пройти знакомство заново')}</button></section>` : ''}`;

  lineChart($('#ch-weight'), { unit: t('кг'), series: [{ name: t('Вес'), color: 'var(--series-1)', points: series((x) => x.weight) }] });
  lineChart($('#ch-waist'), { unit: t('см'), series: [{ name: t('Талия'), color: 'var(--series-1)', points: series((x) => x.waist) }] });
  lineChart($('#ch-pain'), { series: [
    { name: t('Поясница'), color: 'var(--series-1)', points: series((x) => x.pain?.back) },
    { name: t('Лопатки'), color: 'var(--series-2)', points: series((x) => x.pain?.blades) },
    { name: t('Ночью в ноги'), color: 'var(--series-3)', points: series((x) => x.pain?.legs) },
  ] });
  lineChart($('#ch-bp'), { series: [
    { name: t('Верхнее'), color: 'var(--series-1)', points: series((x) => x.bp?.sys) },
    { name: t('Нижнее'), color: 'var(--series-2)', points: series((x) => x.bp?.dia) },
  ] });
  const weeks = [];
  // Последние 12 недель (после 84-го дня график сдвигается, а не замирает).
  const nAll = Math.max(1, Math.ceil(ci.dayN / 7));
  for (let i = Math.max(0, nAll - 12); i < nAll; i++) {
    let n = 0;
    for (let k = 0; k < 7; k++) n += coreDone(addDays(p.startDate, i * 7 + k));
    weeks.push({ label: String(i + 1), value: n });
  }
  weekBars($('#ch-weeks'), { weeks: weeks.some((x) => x.value) ? weeks : [] });
}

// ---------- питание ----------
function renderFoodView() {
  const T = targets();
  $('#view-sub').textContent = t('Норма {k} ккал, белок {p} г', { k: T.kcal, p: T.protein });
  renderFood(main, { openSheet, closeSheet, toast, render });
}

// ---------- программа ----------
function renderProgram() {
  const d = peekDay(dateStr());
  $('#view-sub').textContent = state.program?.level ? t('Все упражнения и нагрузка') : '';
  renderSheet(main, { todayMode: effectiveMode(d), todaySkip: todaySkip(d) });
}

// ---------- мастер ----------
const CHIPS = [t('Что у меня сегодня?'), t('Как стоять столбом?'), t('Болит поясница, что делать?'), t('Давление 160 на 100, заниматься?')];
let masterBusy = false;
let masterAbort = null;

function bubble(m) {
  const b = document.createElement('div');
  b.className = `msg ${m.role}`;
  b.textContent = m.text;
  return b;
}

function renderMaster() {
  $('#view-sub').textContent = hasKey() ? t('Живой разговор') : t('Базовый режим');
  main.innerHTML = `
    ${state.memory?.summary || state.log?.length ? `<details class="memory"><summary>${t('Что мастер помнит о вас')}</summary>
      <p>${esc(state.memory?.summary || t('Заметок пока нет: они появятся, когда подключена нейросеть.'))}</p>
      ${state.log?.length ? `<h4>${t('Последние беседы')}</h4><ul class="journal">${state.log.slice(-12).reverse().map((e) => `<li><span>${new Date(e.at).toLocaleDateString(locale())} · ${esc({ intake: t('знакомство'), checkin: t('перед занятием'), review: t('пересмотр'), session: t('занятие'), chat: t('беседа') }[e.kind] || e.kind)}</span>${esc(e.role === 'user' ? t('Вы ответили на вопросы') : String(e.text).slice(0, 220))}</li>`).join('')}</ul>` : ''}
    </details>` : ''}
    <section class="chat" id="chat" aria-live="polite"></section>
    ${hasKey() ? '' : `<p class="note chat-note">${t('Без ключа наставник отвечает только по курсу. Свободный разговор включается в настройках.')} <button class="link" data-open="settings">${t('Открыть')}</button></p>`}
    <div class="chips" id="chips">${CHIPS.map((c) => `<button class="chip">${esc(c)}</button>`).join('')}</div>
    <form class="ask" id="ask-form">
      ${voice.sttSupported ? `<button type="button" class="mic" id="mic" aria-label="${t('Сказать голосом')}"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>` : ''}
      <textarea id="ask-input" rows="1" placeholder="${t('Ваш вопрос')}" aria-label="${t('Вопрос наставнику')}"></textarea>
      <button class="btn" type="submit">${t('Спросить')}</button>
    </form>`;
  const chat = $('#chat');
  if (!state.chat.length) {
    chat.append(bubble({ role: 'assistant', text: t('Я рядом. Спросите о любом упражнении, расскажите, как прошло занятие или что болит.') }));
  }
  state.chat.slice(-30).forEach((m) => chat.append(bubble(m)));
  // Чат прокручивается вместе со страницей: держим последнюю реплику над строкой ввода.
  const toEnd = () => window.scrollTo(0, document.documentElement.scrollHeight);
  requestAnimationFrame(toEnd);

  const send = async (text) => {
    text = text.trim();
    if (!text || masterBusy) return;
    voice.unlock();
    masterBusy = true;
    $('#ask-input').value = '';
    chat.append(bubble({ role: 'user', text }));
    const out = bubble({ role: 'assistant', text: t('Думаю…') });
    out.classList.add('pending');
    chat.append(out);
    toEnd();
    const say = voice.sentenceStream();
    let acc = '';
    masterAbort = new AbortController();
    try {
      const res = await askMaster({
        text, signal: masterAbort.signal,
        onDelta: (dlt) => { acc += dlt; out.textContent = acc; out.classList.remove('pending'); toEnd(); if (view === 'master') say.push(dlt); },
      });
      out.textContent = res.text || acc;
      out.classList.remove('pending');
      toEnd();
      state.chat.push({ role: 'user', text, at: Date.now() }, { role: 'assistant', text: res.text || acc, at: Date.now() });
      state.chat = state.chat.slice(-40);
      save();
      if (view === 'master') say.end();
    } catch (err) {
      out.classList.remove('pending');
      out.classList.add('error');
      out.textContent = err.kind === 'aborted' ? t('Остановлено.') : (err.message || t('Не получилось получить ответ.'));
    } finally {
      masterBusy = false;
    }
  };

  $('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); send($('#ask-input').value); });
  $('#ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('#ask-input').value); } });
  $('#chips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) send(c.textContent); });
  $('#mic')?.addEventListener('click', async () => {
    const mic = $('#mic');
    if (mic.classList.contains('on')) { voice.stopListening(); return; }
    voice.unlock();
    voice.cancel();
    mic.classList.add('on');
    const input = $('#ask-input');
    try {
      const text = await voice.listenOnce({ onInterim: (t) => { input.value = t; } });
      mic.classList.remove('on');
      if (text) send(text); else toast(t('Не расслышал. Попробуйте ещё раз.'));
    } catch (err) {
      mic.classList.remove('on');
      toast(err.message === 'denied' ? t('Нет доступа к микрофону. Разрешите его в настройках браузера.') : t('Распознавание речи недоступно. Надиктуйте с клавиатуры.'));
    }
  });
}

// ---------- настройки ----------
function openSettings() {
  const p = state.profile;
  const s = state.settings;
  const vs = voice.ruVoices();
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  openSheet(`
    <h3>${t('Настройки')}</h3>
    <form class="form" id="set-form" novalidate>
      <fieldset><legend>${t('О вас')}</legend>
        <label for="set-name">${t('Имя')}</label><input id="set-name" value="${esc(p.name)}">
        <label for="set-start">${t('Первый день курса')}</label><input id="set-start" type="date" value="${esc(p.startDate)}">
        <div class="grid2">
          <div><label for="set-weight">${t('Стартовый вес, кг')}</label><input id="set-weight" inputmode="decimal" value="${esc(p.startWeight ?? '')}"></div>
          <div><label for="set-waist">${t('Стартовая талия, см')}</label><input id="set-waist" inputmode="decimal" value="${esc(p.startWaist ?? '')}"></div>
        </div>
        <label for="set-health">${t('Что беспокоит и что запрещал врач')}</label>
        <textarea id="set-health" rows="3">${esc(p.health)}</textarea>
      </fieldset>
      <fieldset><legend>${t('Язык')}</legend>
        <div class="ov-row" role="group" aria-label="${t('Язык интерфейса')}">${LANGS.map((l) => `<button type="button" class="btn ${l.id === lang ? '' : 'ghost'}" data-lang="${l.id}" aria-pressed="${l.id === lang}">${l.name}</button>`).join('')}</div>
        <p class="note">${t('Голос мастера на занятиях пока русский. Ответы нейросети — на выбранном языке.')}</p>
      </fieldset>
      <fieldset><legend>${t('Оформление')}</legend>
        <div class="palettes" role="group" aria-label="${t('Цветовая тема')}">
          ${[{ id: 'auto', name: t('Как в системе'), bg: 'linear-gradient(135deg, #f2ebdd 50%, #121110 50%)', accent: '#2e5b4e', seal: '#b0362a' }, ...PALETTES].map((p) => `<button type="button" class="pal" data-palette="${p.id}" aria-pressed="${(s.palette || 'auto') === p.id}">
            <span class="pal-sw" style="background:${p.bg}"><i style="background:${p.seal}"></i><b style="background:${p.accent}"></b></span>${esc(p.name)}</button>`).join('')}
        </div>
      </fieldset>
      <fieldset><legend>${t('Фоновая музыка')}</legend>
        <label class="switch"><input type="checkbox" id="set-music" ${s.music !== false ? 'checked' : ''}><span>${t('Тихая мелодия, вода, ветер, птицы, колокольчики и чаша. Под голос мастера приглушается')}</span></label>
        <label for="set-mvol">${t('Громкость музыки:')} <output id="set-mvol-out">${Math.round((s.musicVolume ?? 0.5) * 100)}%</output></label>
        <input type="range" id="set-mvol" min="0.1" max="1" step="0.05" value="${s.musicVolume ?? 0.5}">
        <details class="credits"><summary>${t('Авторы музыки и звуков')}</summary>
          <p class="note">«Ethereal Xiao Flute — Tranquil Chinese Melody», «Calming Dizi — Inspirational Chinese Flute», «Wisdom of the Ancient — Soothing Asian Flute», «Ancient Temple — Meditative Shakuhachi Flute» — MemoryMusic; «Ancient Temple» — Siarhei Korbut (Jamendo, CC BY-NC-ND 3.0).<br>
          «Healing», «Kalimba Relaxation Music» — Kevin MacLeod (incompetech.com), CC BY 4.0.<br>
          ${t('Звуки природы и инструментов')} — BigSoundBank (bigsoundbank.com), CC0.<br>
          ${t('Сисиодоси в саду храма Сисэн-до, Киото')} — Fg2, Wikimedia Commons, public domain.</p>
        </details>
      </fieldset>
      <fieldset><legend>${t('Время на одно занятие')}</legend>
        <select id="set-smin">${[['', `${t('По анкете')}: ${SESSION_MIN[state.intake?.time] ? `${SESSION_MIN[state.intake?.time]} ${t('мин')}` : t('без ограничения')}`], ['15', `15 ${t('мин')}`], ['20', `20 ${t('мин')}`], ['30', `30 ${t('мин')}`], ['45', `45 ${t('мин')}`], ['0', t('без ограничения')]].map(([v, l]) => `<option value="${v}" ${String(s.sessionMin ?? '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <p class="note">${t('Если занятие не помещается, мастер убирает менее важные упражнения и укорачивает ходьбу. Дыхание, столб, вставание со стула, разгрузка поясницы и завершение остаются всегда.')}</p>
      </fieldset>
      <fieldset><legend>${t('Голос наставника')}</legend>
        <label class="switch"><input type="checkbox" id="set-voice" ${s.voice ? 'checked' : ''}><span>${t('Говорить вслух')}</span></label>
        <label class="switch"><input type="checkbox" id="set-count" ${s.countAloud ? 'checked' : ''}><span>${t('Считать повторы вслух')}</span></label>
        ${vs.length > 1 ? `<label for="set-voiceuri">${t('Голос')}</label><select id="set-voiceuri">${vs.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === s.voiceURI ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>` : ''}
        <label for="set-vspeed">${t('Скорость речи:')} <output id="set-vspeed-out">${fmtSpeed(voice.voiceSpeed())}</output></label>
        <input type="range" id="set-vspeed" min="${voice.SPEED_RANGE[0]}" max="${voice.SPEED_RANGE[1]}" step="0.05" value="${voice.voiceSpeed()}">
        <label for="set-vpitch">${t('Высота голоса:')} <output id="set-vpitch-out">${fmtPitch(voice.voicePitch())}</output></label>
        <input type="range" id="set-vpitch" min="${voice.PITCH_RANGE[0]}" max="${voice.PITCH_RANGE[1]}" step="0.5" value="${voice.voicePitch()}">
        <p class="note">${t('Настройка общая для всех фраз мастера. Темп упражнений и счёт от неё не меняются.')}</p>
        <div class="row-btns"><button type="button" class="btn ghost" id="set-test">${t('Послушать')}</button>
        <button type="button" class="btn ghost" id="set-vreset">${t('Как записано')}</button></div>
        ${voice.ttsSupported ? '' : `<p class="note">${t('Этот браузер не умеет говорить вслух.')}</p>`}
      </fieldset>
      <fieldset><legend>${t('Ваш сервер')}</legend>
        <p class="note">${t('На сервере хранятся дневник, анкета, программа, беседы и память мастера, а также ключ Claude API. Через него мастер обращается к нейросети: Claude Haiku 5.5 для ежедневных бесед, Claude Sonnet 5.5 для программы и пересмотров.')}</p>
        <label for="set-srv">${t('Адрес сервера')}</label>
        <input id="set-srv" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://taichi.example.ru" value="${esc(serverConfig()?.url || '')}">
        <label for="set-tok">${t('Ключ доступа к серверу')}</label>
        <input id="set-tok" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(serverConfig()?.token || '')}">
        <button type="button" class="btn" id="set-srv-test">${t('Проверить связь')}</button>
        <p class="srv-status" id="set-srv-status" role="status">${esc(syncLabel())}</p>
      </fieldset>
      <fieldset><legend>${t('Без сервера: ключ Claude API на телефоне')}</legend>
        <p class="note">${t('Если сервера нет, можно ввести ключ с console.anthropic.com прямо сюда; он хранится только на этом телефоне. Без сервера и ключа мастер работает по встроенным правилам. При обращении к нейросети на серверы Anthropic уходят ваши ответы, записи дневника за две недели, анкета и заметки мастера; при «Мастер, посмотри» — ещё один кадр с камеры.')}</p>
        <label for="set-key">${t('Ключ API')}</label>
        <input id="set-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(getApiKey())}">
      </fieldset>
      <fieldset><legend>${t('Данные')}</legend>
        <p class="note">${serverConfig() ? t('Данные хранятся на телефоне и на вашем сервере.') : t('Без сервера данные хранятся только в этом браузере. Очистка данных сайта сотрёт их — раз в неделю сохраняйте копию.')}</p>
        <div class="ov-row"><button type="button" class="btn ghost" id="set-export">${t('Скопировать копию')}</button><button type="button" class="btn ghost" id="set-import">${t('Восстановить')}</button></div>
        <button type="button" class="btn ghost danger" id="set-reset">${t('Стереть все данные')}</button>
      </fieldset>
      ${standalone ? '' : `<p class="note">${t('Чтобы приложение открывалось с главного экрана: в Safari нажмите «Поделиться» и выберите «На экран „Домой“».')}</p>`}
      <button class="btn wide" type="submit">${t('Сохранить')}</button>
      <button class="btn ghost wide" type="button" data-close>${t('Закрыть')}</button>
    </form>`);
  $$('[data-lang]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.lang === lang) return;
    // Сначала сохраняем то, что уже введено в форме (имя, сервер, ключ), — иначе перезапуск это сотрёт.
    try { $('#set-form')?.requestSubmit?.(); } catch { /* noop */ }
    s.lang = b.dataset.lang;
    save();
    // Язык подхватывается при загрузке: перезапускаем приложение.
    setTimeout(() => location.reload(), 300);
  }));
  $$('.pal').forEach((b) => b.addEventListener('click', () => {
    s.palette = b.dataset.palette;
    applyPalette(s.palette);
    save();
    $$('.pal').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('#set-music').addEventListener('change', (e) => { s.music = e.target.checked; save(); ambient.refresh(); });
  $('#set-mvol').addEventListener('input', (e) => { s.musicVolume = Number(e.target.value); $('#set-mvol-out').textContent = `${Math.round(s.musicVolume * 100)}%`; ambient.refresh(); });
  $('#set-mvol').addEventListener('change', () => save());
  $('#set-smin').addEventListener('change', (e) => { s.sessionMin = e.target.value === '' ? null : Number(e.target.value); save(); render(); });
  const showVoiceFx = () => {
    $('#set-vspeed-out').textContent = fmtSpeed(voice.voiceSpeed());
    $('#set-vpitch-out').textContent = fmtPitch(voice.voicePitch());
  };
  $('#set-vspeed').addEventListener('input', (e) => { s.voiceSpeed = Number(e.target.value); showVoiceFx(); });
  $('#set-vpitch').addEventListener('input', (e) => { s.voicePitch = Number(e.target.value); showVoiceFx(); });
  $('#set-vspeed').addEventListener('change', () => save());
  $('#set-vpitch').addEventListener('change', () => save());
  $('#set-vreset').addEventListener('click', () => {
    s.voiceSpeed = 1; s.voicePitch = 0;
    $('#set-vspeed').value = 1; $('#set-vpitch').value = 0;
    showVoiceFx(); save();
  });
  $('#set-test').addEventListener('click', () => {
    voice.unlock();
    if ($('#set-voiceuri')) state.settings.voiceURI = $('#set-voiceuri').value;
    voice.speak('Колени чуть согнуты. Макушка тянется вверх, подбородок слегка опущен, плечи расслаблены.', { interrupt: true, force: true });
  });
  $('#set-srv-test').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const out = $('#set-srv-status');
    const url = normUrl($('#set-srv').value);
    const show = (text, kind) => { out.textContent = text; out.className = `srv-status ${kind || ''}`; toast(text); };
    if (!url) { show(t('Введите адрес сервера.'), 'bad'); return; }
    $('#set-srv').value = url;
    btn.disabled = true;
    btn.textContent = t('Проверяю…');
    out.textContent = t('Проверяю связь с сервером…');
    out.className = 'srv-status';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const h = await (await fetch(`${url}/api/health`, { signal: ctl.signal, cache: 'no-store' })).json();
      const r = await fetch(`${url}/api/state`, { signal: ctl.signal, cache: 'no-store', headers: { Authorization: `Bearer ${$('#set-tok').value.trim()}` } });
      if (r.status === 401) show(t('Сервер отвечает, но ключ доступа не подходит. Проверьте строку APP_TOKEN.'), 'bad');
      else if (r.ok) show(`${t('Связь есть.')}${h.ai ? t(' Нейросеть подключена.') : t(' Нейросеть на сервере не настроена.')} ${t('Нажмите «Сохранить».')}`, 'good');
      else show(`${t('Сервер ответил ошибкой')} ${r.status}.`, 'bad');
    } catch (err) {
      show(err?.name === 'AbortError' ? t('Сервер не ответил за 12 секунд.') : t('Сервер недоступен. Проверьте адрес: он должен начинаться с https://'), 'bad');
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
      btn.textContent = t('Проверить связь');
    }
  });
  $('#set-export').addEventListener('click', () => copyText(exportJSON()));
  $('#set-import').addEventListener('click', () => {
    openSheet(`<h3>${t('Восстановить из копии')}</h3><p class="note">${t('Вставьте текст сохранённой копии. Текущие данные будут заменены.')}</p>
      <textarea class="copybox" id="imp-text" rows="8"></textarea>
      <button class="btn wide" id="imp-go">${t('Восстановить')}</button><button class="btn ghost wide" data-close>${t('Отмена')}</button>`);
    $('#imp-go').addEventListener('click', () => {
      try { importJSON($('#imp-text').value); closeSheet(); render(); toast(t('Данные восстановлены')); } catch (err) { toast(err.message.includes('копи') ? err.message : t('Не получилось прочитать копию.')); }
    });
  });
  $('#set-reset').addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (b.dataset.armed) { resetAll(); setApiKey(''); closeSheet(); render(); toast(t('Данные стёрты')); return; }
    b.dataset.armed = '1';
    b.textContent = t('Нажмите ещё раз, чтобы стереть без возврата');
  });
  $('#set-form').addEventListener('submit', (e) => {
    e.preventDefault();
    Object.assign(p, {
      name: $('#set-name').value.trim(), startDate: $('#set-start').value || p.startDate,
      startWeight: num($('#set-weight').value), startWaist: num($('#set-waist').value), health: $('#set-health').value.trim(),
    });
    Object.assign(s, { voice: $('#set-voice').checked, countAloud: $('#set-count').checked, voiceSpeed: Number($('#set-vspeed').value), voicePitch: Number($('#set-vpitch').value) });
    if ($('#set-voiceuri')) s.voiceURI = $('#set-voiceuri').value;
    setApiKey($('#set-key').value);
    const srv = normUrl($('#set-srv').value);
    const tok = $('#set-tok').value.trim();
    if (srv !== (serverConfig()?.url || '') || tok !== (serverConfig()?.token || '')) { setServer(srv, tok); if (srv && tok) startSync(); }
    save();
    closeSheet();
    render();
    toast(t('Сохранено'));
  });
}

// ---------- нижний лист ----------
function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  sheet.hidden = false;
  document.body.classList.add('sheet-open');
  $('#sheet-body').scrollTop = 0;
}
function closeSheet() {
  sheet.hidden = true;
  document.body.classList.remove('sheet-open');
  $('#sheet-body').innerHTML = '';
}

// Объяснение упражнения голосом мастера: каждое предложение — отдельная запись.
let guideBtn = null;
function playGuide(id, btn) {
  const lines = GUIDES[id];
  if (!lines) return;
  const stop = () => { if (guideBtn) { guideBtn.classList.remove('playing'); guideBtn.textContent = `▶ ${t('Как выполнять')}`; } guideBtn = null; };
  if (guideBtn === btn) { voice.cancel(); stop(); return; }
  voice.cancel();
  stop();
  guideBtn = btn;
  btn.classList.add('playing');
  btn.textContent = `■ ${t('Стоп')}`;
  btn.closest('.ex')?.classList.add('open');
  let last = null;
  lines.forEach((line, i) => { last = voice.speak(line, { interrupt: i === 0, force: true }); });
  last.then(() => { if (guideBtn === btn) stop(); });
}

// ---------- события ----------
document.addEventListener('click', (e) => {
  const t = e.target;
  const tab = t.closest('.tab');
  if (tab) return go(tab.dataset.view);
  if (t.closest('[data-close]') || t === sheet) return closeSheet();
  const gb = t.closest('[data-guide]');
  if (gb) { voice.unlock(); return playGuide(gb.dataset.guide, gb); }
  const exCard = t.closest('.ex');
  if (exCard && !t.closest('button')) { exCard.classList.toggle('open'); return undefined; }
  const st = t.closest('[data-start]');
  if (st) { voice.unlock(); return openStart(st.dataset.start); }
  const g = t.closest('[data-go]');
  if (g) return go(g.dataset.go);
  if (t.closest('[data-open="settings"]') || t.closest('#btn-settings')) return openSettings();
  if (t.closest('[data-intake]')) { voice.unlock(); return openIntake(); }
  if (t.closest('[data-review]')) { voice.unlock(); return runReview(main, () => go('today')); }
  return undefined;
});
document.addEventListener('change', (e) => {
  const task = e.target.closest?.('[data-task]');
  if (task) { state.tasks[task.dataset.task] = true; save(); setTimeout(() => { if (view === 'today') renderToday(); }, 350); }
});

subscribe(() => { if (!isStorageOk()) toast(t('Не удаётся сохранить данные: проверьте, что браузер не в приватном режиме.')); });

// Новый день: если приложение пролежало открытым ночь, обновляем экран.
let lastDay = dateStr();
document.addEventListener('visibilitychange', () => {
  if (document.hidden || runner) return;
  if (dateStr() !== lastDay) { lastDay = dateStr(); diaryDate = lastDay; render(); }
});

// Адрес сервера: добавляем https://, убираем лишние пробелы и слэши в конце.
function normUrl(v) {
  let u = String(v || '').trim().replace(/\s+/g, '').replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function syncLabel(st = syncStatus()) {
  if (!serverConfig()) return t('Сервер не подключён.');
  if (st.state === 'syncing') return t('Синхронизация…');
  if (st.state === 'error') return `${t('Нет связи с сервером:')} ${st.error}`;
  if (st.state === 'ok') return `${t('Синхронизировано')} ${new Date(st.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}.`;
  return t('Сервер подключён.');
}
onSyncStatus((st) => {
  const el = document.getElementById('set-srv-status');
  if (el) el.textContent = syncLabel(st);
  // Пришли данные с сервера — перерисовываем экран, если не идёт занятие или беседа.
  if (st.state === 'ok' && st.changed && !runner && !document.body.classList.contains('focus') && sheet.hidden) render();
});
startSync();

if ('serviceWorker' in navigator && window.isSecureContext && !params.get('nosw')) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  // Пришла новая версия приложения — перезагружаемся, если сейчас не идёт занятие или беседа.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || runner || document.body.classList.contains('focus')) return;
    reloaded = true;
    location.reload();
  });
}

// Звук на айфоне можно включить только по касанию: запускаем голос и музыку при первом.
document.addEventListener('pointerdown', () => { voice.unlock(); ambient.start(); ambient.setScene(runner ? 'talk' : document.body.classList.contains('focus') ? 'talk' : 'home'); }, { once: true, capture: true });

// Тексты из index.html на языке интерфейса.
document.title = t('Тайцзи');
$$('.tab span').forEach((el) => { el.textContent = t(el.textContent.trim()); });
$$('[aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('aria-label'))); });

applyPalette();
render();
