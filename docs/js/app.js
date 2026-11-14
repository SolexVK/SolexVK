import {
  state, save, day, peekDay, dateStr, addDays, parseDate, subscribe, isStorageOk,
  getApiKey, setApiKey, exportJSON, importJSON, resetAll,
  coreDone, streak, weekCore, lastValue, series, SESSION_KINDS,
} from './store.js';
import { courseInfo, buildSession, bpMode, BP_TEXT, SESSION_META, SAFETY_RULES, RED_FLAGS, PHASES, phase2Criteria } from './course.js';
import * as voice from './voice.js';
import { cameraSupported } from './pose.js';
import { askMaster, hasKey, MODEL } from './master.js';
import { lineChart, weekBars } from './charts.js';
import { SessionRunner } from './session.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');
const sheet = $('#sheet');
const params = new URLSearchParams(location.search);
if (params.get('mute')) state.settings.voice = false;

let view = 'today';
let diaryDate = dateStr();
let runner = null;

const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const longDate = (s) => { const d = parseDate(s); return `${WD[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const shortDate = (s) => { const d = parseDate(s); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; };
const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
const minutes = (sec) => `≈ ${Math.max(1, Math.round(sec / 60))} мин`;

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------- каркас ----------
const BP_LABEL = { full: 'полное занятие', light: 'лёгкий режим', none: 'не заниматься', unknown: 'не измерено' };
const TITLES = { today: 'Сегодня', diary: 'Дневник', progress: 'Прогресс', master: 'Мастер' };

function render() {
  const onboard = !state.profile.onboarded;
  document.body.classList.toggle('onboarding', onboard);
  if (onboard) return renderOnboard();
  $('#view-title').textContent = TITLES[view];
  $$('.tab').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
  if (view === 'today') renderToday();
  else if (view === 'diary') renderDiary();
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
  const p = state.profile;
  main.innerHTML = `
    <section class="onb">
      <div class="seal-mark big" aria-hidden="true">太極</div>
      <h2>Путь в двенадцать недель</h2>
      <p class="lead">Каждое утро и каждый день по 15–20 минут. Наставник ведёт голосом, камера следит за осанкой, дневник помнит всё.</p>
      <form id="onb-form" class="form" novalidate>
        <label for="onb-name">Как к вам обращаться</label>
        <input id="onb-name" autocomplete="given-name" value="${esc(p.name)}" placeholder="Имя, по желанию">
        <label for="onb-start">Первый день курса</label>
        <input id="onb-start" type="date" value="${esc(p.startDate)}" required>
        <div class="grid2">
          <div><label for="onb-age">Возраст</label><input id="onb-age" inputmode="numeric" value="${esc(p.age ?? '')}"></div>
          <div><label for="onb-height">Рост, см</label><input id="onb-height" inputmode="numeric" value="${esc(p.height ?? '')}"></div>
          <div><label for="onb-weight">Вес, кг</label><input id="onb-weight" inputmode="decimal" value="${esc(p.startWeight ?? '')}"></div>
          <div><label for="onb-waist">Талия на уровне пупка, см</label><input id="onb-waist" inputmode="decimal" value="${esc(p.startWaist ?? '')}"></div>
        </div>
        <label for="onb-health">Что беспокоит и что запрещал врач</label>
        <textarea id="onb-health" rows="3" placeholder="Например: болит спина, повышенное давление, были травмы">${esc(p.health)}</textarea>
        <p class="note">Всё, что вы вводите, хранится только на этом телефоне.</p>
        <div class="callout">
          <strong>Приложение не заменяет врача.</strong> Если есть боль в спине, отдающая в ноги, повышенное давление или болезни сердца, покажитесь врачу в первые недели занятий.
        </div>
        <button class="btn wide" type="submit">Начать путь</button>
      </form>
    </section>`;
  $('#onb-form').addEventListener('submit', (e) => {
    e.preventDefault();
    voice.unlock();
    Object.assign(p, {
      name: $('#onb-name').value.trim(),
      startDate: $('#onb-start').value || dateStr(),
      age: num($('#onb-age').value), height: num($('#onb-height').value),
      startWeight: num($('#onb-weight').value), startWaist: num($('#onb-waist').value),
      health: $('#onb-health').value.trim(), onboarded: true,
    });
    const d = day(p.startDate);
    if (p.startWeight && d.weight == null) d.weight = p.startWeight;
    if (p.startWaist && d.waist == null) d.waist = p.startWaist;
    save();
    go('today');
  });
}

// ---------- сегодня ----------
const START_TASKS = [
  ['doctor', 'Показаться терапевту: давление, ЭКГ, базовые анализы'],
  ['back', 'Если болит спина — показаться неврологу до увеличения нагрузки'],
  ['tonometer', 'Положить тонометр там, где занимаетесь'],
  ['steps', 'Три дня посмотреть в телефоне, сколько шагов выходит сейчас'],
  ['home', 'Добавить приложение на экран «Домой»: «Поделиться» → «На экран „Домой“»'],
];

function sessionCard(kind, ci, d) {
  const meta = SESSION_META[kind];
  const rec = d?.sessions?.[kind];
  const mode = d?.bp?.sys ? bpMode(d.bp.sys, d.bp.dia) : 'full';
  const plan = buildSession(kind, ci.planWeek, mode === 'light' ? 'light' : 'full');
  const blocked = mode === 'none';
  return `
    <article class="sess ${rec?.done ? 'is-done' : ''}" data-kind="${kind}">
      <div class="stamp ${rec?.done ? 'done' : ''}" aria-hidden="true">${meta.seal}</div>
      <div class="sess-body">
        <h3>${meta.title}</h3>
        <p class="sess-sub">${esc(meta.sub)} · ${minutes(plan.dur)}</p>
        ${rec?.done ? `<p class="sess-done">Сделано${rec.partial ? ' частично' : ''}${rec.stolbSec ? ` · столб ${Math.floor(rec.stolbSec / 60)}:${String(rec.stolbSec % 60).padStart(2, '0')}` : ''}${rec.quality != null ? ` · без замечаний ${rec.quality}%` : ''}</p>` : ''}
      </div>
      <button class="btn ${rec?.done ? 'ghost' : ''}" data-start="${kind}" ${blocked ? 'disabled' : ''}>${rec?.done ? 'Ещё раз' : 'Начать'}</button>
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
      <p class="eyebrow">Неделя ${ci.week} · этап ${ci.phase.n} «${esc(ci.phase.name)}»</p>
      <h2>${state.profile.name ? `${esc(state.profile.name)}, д` : 'Д'}ень ${ci.dayN}</h2>
      ${ci.beyond ? '<p class="note">Этап 1 пройден по календарю. Программа этапа 2 появится после пересмотра с наставником; пока продолжаем план четвёртой недели.</p>' : ''}
    </section>

    <section class="bp" aria-labelledby="bp-h">
      <h3 id="bp-h">Давление перед занятием</h3>
      <div class="bp-row">
        <input id="bp-sys" inputmode="numeric" aria-label="Верхнее давление" placeholder="120" value="${esc(d.bp?.sys ?? '')}">
        <span>/</span>
        <input id="bp-dia" inputmode="numeric" aria-label="Нижнее давление" placeholder="80" value="${esc(d.bp?.dia ?? '')}">
        <span class="pill ${mode}" id="bp-pill">${BP_LABEL[mode]}</span>
      </div>
      <p class="note" id="bp-text">${BP_TEXT[mode]}</p>
    </section>

    ${needMeasure ? '<section class="callout"><strong>Понедельник.</strong> Утром натощак взвесьтесь и измерьте талию на уровне пупка, запишите в дневник. <button class="link" data-go="diary">Открыть дневник</button></section>' : ''}

    <section class="sessions" id="sessions" aria-label="Занятия на сегодня">
      ${SESSION_KINDS.map((k) => sessionCard(k, ci, d)).join('')}
    </section>

    <section class="tiles">
      <div class="tile"><span class="tile-v">${streak(today)}</span><span class="tile-l">дней подряд</span></div>
      <div class="tile"><span class="tile-v">${weekCore(today)}<small> / 14</small></span><span class="tile-l">занятий за неделю</span></div>
      <div class="tile"><span class="tile-v">${d.steps ? Number(d.steps).toLocaleString('ru-RU') : '—'}</span><span class="tile-l">шагов сегодня</span></div>
    </section>

    ${openTasks.length ? `<section class="tasks"><h3>Дела на старте</h3>${openTasks.map(([id, text]) => `<label class="check"><input type="checkbox" data-task="${id}"><span>${esc(text)}</span></label>`).join('')}</section>` : ''}

    <details class="rules"><summary>Правила безопасности</summary>
      <dl>${SAFETY_RULES.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <p><strong>Срочно звонить 103 или 112:</strong> ${RED_FLAGS.map(esc).join('; ')}.</p>
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
    const m = bpMode(dd.bp?.sys, dd.bp?.dia);
    const pill = $('#bp-pill');
    pill.className = `pill ${m}`;
    pill.textContent = BP_LABEL[m];
    $('#bp-text').textContent = BP_TEXT[m];
    // Карточки не пересоздаём: иначе касание «Начать» сразу после ввода давления теряется.
    for (const k of SESSION_KINDS) {
      const card = $(`.sess[data-kind="${k}"]`);
      const plan = buildSession(k, ci.planWeek, m === 'light' ? 'light' : 'full');
      card.querySelector('.sess-sub').textContent = `${SESSION_META[k].sub} · ${minutes(plan.dur)}`;
      card.querySelector('[data-start]').disabled = m === 'none';
    }
  };
  $('#bp-sys').addEventListener('change', onBp);
  $('#bp-dia').addEventListener('change', onBp);
}

// ---------- запуск занятия ----------
function openStart(kind) {
  const today = dateStr();
  const ci = courseInfo(today);
  const d = day(today);
  const meta = SESSION_META[kind];
  const dyn = () => {
    const mode = bpMode(d.bp?.sys, d.bp?.dia);
    const plan = buildSession(kind, ci.planWeek, mode === 'light' ? 'light' : 'full');
    const hasPose = plan.steps.some((s) => s.pose);
    return `
      <p class="note"><span class="pill ${mode}">${BP_LABEL[mode]}</span> ${BP_TEXT[mode]}</p>
      ${mode === 'none' ? '<div class="callout danger"><strong>Сегодня без занятия.</strong> Если есть боль в груди, одышка, слабость руки или ноги, нарушение речи — звоните 103 или 112.</div>' : `
      <p class="note">${minutes(plan.dur)}, упражнений: ${plan.steps.filter((s) => s.kind !== 'talk').length}. Неделя ${ci.planWeek} программы.</p>
      ${hasPose && cameraSupported ? `<label class="switch"><input type="checkbox" id="st-cam" ${state.settings.camera ? 'checked' : ''}><span>Камера следит за осанкой и подсказывает</span></label>
        <p class="note">Поставьте телефон вертикально на уровне пояса в двух–трёх метрах, чтобы в кадре были голова и стопы. Видео обрабатывается на телефоне и никуда не отправляется.</p>` : ''}
      ${voice.sttSupported ? `<label class="switch"><input type="checkbox" id="st-hf" ${state.settings.handsFree ? 'checked' : ''}><span>Голосовые команды: «пауза», «дальше», «повтори», «мастер, …»</span></label>` : ''}
      ${voice.ttsSupported ? '' : '<p class="note">Этот браузер не умеет говорить вслух: подсказки будут только на экране.</p>'}
      <button class="btn wide" id="st-go">Начать занятие</button>`}`;
  };
  openSheet(`
    <h3>${meta.title}</h3>
    <label for="st-sys">Давление сейчас</label>
    <div class="bp-row">
      <input id="st-sys" inputmode="numeric" placeholder="120" aria-label="Верхнее давление" value="${esc(d.bp?.sys ?? '')}">
      <span>/</span>
      <input id="st-dia" inputmode="numeric" placeholder="80" aria-label="Нижнее давление" value="${esc(d.bp?.dia ?? '')}">
    </div>
    <div id="st-dyn" class="sheet-dyn">${dyn()}</div>
    <button class="btn ghost wide" data-close>Отмена</button>`);
  let shownMode = bpMode(d.bp?.sys, d.bp?.dia);
  const upd = () => {
    const sys = num($('#st-sys').value);
    const dia = num($('#st-dia').value);
    if (sys && dia) d.bp = { sys, dia };
    else if (!sys && !dia && d.bp) delete d.bp;
    else return;
    save();
    const m = bpMode(d.bp?.sys, d.bp?.dia);
    if (m !== shownMode) { shownMode = m; $('#st-dyn').innerHTML = dyn(); }
  };
  $('#st-sys').addEventListener('change', upd);
  $('#st-dia').addEventListener('change', upd);
  $('#st-dyn').addEventListener('click', (e) => {
    if (!e.target.closest('#st-go')) return;
    const camera = !!$('#st-cam')?.checked;
    const handsFree = !!$('#st-hf')?.checked;
    if ($('#st-cam')) state.settings.camera = camera;
    if ($('#st-hf')) state.settings.handsFree = handsFree;
    save();
    const mode = bpMode(d.bp?.sys, d.bp?.dia) === 'light' ? 'light' : 'full';
    closeSheet();
    runner = new SessionRunner($('#session'), {
      kind, week: ci.planWeek, mode, camera, handsFree,
      onFinish: (recorded) => { runner = null; render(); if (recorded) toast('Занятие записано в дневник'); },
    });
    if (params.get('debug')) window.__runner = runner;
    runner.start();
  });
}

// ---------- дневник ----------
function reportText(date) {
  const d = peekDay(date) || {};
  const ci = courseInfo(date);
  const yn = (k) => (d.sessions?.[k]?.done ? 'да' : 'нет');
  const lines = [`День ${ci.dayN} (${date}). Утро: ${yn('morning')}. День: ${yn('day')}. Вечер: ${yn('evening')}.`];
  const l2 = [];
  if (d.bp?.sys) l2.push(`Давление утром: ${d.bp.sys}/${d.bp.dia}.`);
  if (d.steps) l2.push(`Шаги: ${d.steps}.`);
  if (l2.length) lines.push(l2.join(' '));
  const p = d.pain || {};
  if (p.back != null || p.blades != null || p.legs != null) lines.push(`Боль: поясница ${p.back ?? '—'}, лопатки ${p.blades ?? '—'}, ночью в ноги ${p.legs ?? '—'}.`);
  const m = d.sessions?.morning;
  const dd = d.sessions?.day;
  const extra = [];
  if (m?.stolbSec) extra.push(`столб ${Math.floor(m.stolbSec / 60)}:${String(m.stolbSec % 60).padStart(2, '0')}`);
  if (dd?.chairReps) extra.push(`вставаний со стула ${dd.chairReps}`);
  if (m?.quality != null) extra.push(`утро без замечаний камеры ${m.quality}%`);
  if (extra.length) lines.push(`Показатели: ${extra.join(', ')}.`);
  if (d.weight || d.waist) lines.push(`Вес: ${d.weight ?? '—'} кг. Талия: ${d.waist ?? '—'} см.`);
  if (d.note) lines.push(`Что было трудно: ${d.note}`);
  return lines.join('\n');
}

function weekReport() {
  const today = dateStr();
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const ds = addDays(today, -i);
    if (peekDay(ds)) out.push(reportText(ds));
  }
  out.push(`Итого за неделю курса: ${weekCore(today)} занятий из 14, серия ${streak(today)} дн.`);
  return out.join('\n\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано. Вставьте в чат с наставником.');
  } catch {
    openSheet(`<h3>Скопируйте вручную</h3><textarea class="copybox" rows="10" readonly>${esc(text)}</textarea><button class="btn ghost wide" data-close>Закрыть</button>`);
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
  $('#view-sub').textContent = isToday ? 'Сегодня' : longDate(diaryDate);
  const dates = Object.keys(state.days).sort().reverse().slice(0, 21);
  main.innerHTML = `
    <section class="daynav">
      <button class="icon-btn" id="d-prev" aria-label="Предыдущий день">‹</button>
      <div><strong>${longDate(diaryDate)}</strong><span>день ${courseInfo(diaryDate).dayN} курса</span></div>
      <button class="icon-btn" id="d-next" aria-label="Следующий день" ${isToday ? 'disabled' : ''}>›</button>
    </section>

    <form class="form" id="diary-form" novalidate>
      <fieldset><legend>Утром</legend>
        <label for="f-sys">Давление, сидя после 5 минут покоя</label>
        <div class="bp-row"><input id="f-sys" inputmode="numeric" placeholder="120" aria-label="Верхнее давление" value="${esc(d.bp?.sys ?? '')}"><span>/</span><input id="f-dia" inputmode="numeric" placeholder="80" aria-label="Нижнее давление" value="${esc(d.bp?.dia ?? '')}"></div>
        <div class="grid2 ${monday ? 'hl' : ''}">
          <div><label for="f-weight">Вес, кг${monday ? ' · понедельник' : ''}</label><input id="f-weight" inputmode="decimal" value="${esc(d.weight ?? '')}"></div>
          <div><label for="f-waist">Талия, см</label><input id="f-waist" inputmode="decimal" value="${esc(d.waist ?? '')}"></div>
        </div>
      </fieldset>
      <fieldset><legend>Боль, от 0 до 10</legend>
        ${painRow('back', 'Поясница', d.pain?.back)}
        ${painRow('blades', 'Между лопаток', d.pain?.blades)}
        ${painRow('legs', 'Ночью в ноги', d.pain?.legs)}
      </fieldset>
      <fieldset><legend>Вечером</legend>
        <label for="f-steps">Шагов за день</label>
        <input id="f-steps" inputmode="numeric" value="${esc(d.steps ?? '')}">
        <label for="f-note">Что было трудно, что заметили</label>
        <textarea id="f-note" rows="3" placeholder="Можно надиктовать: микрофон на клавиатуре">${esc(d.note ?? '')}</textarea>
      </fieldset>
      <div class="stamps-row" aria-label="Занятия дня">
        ${SESSION_KINDS.map((k) => `<span class="stamp sm ${d.sessions?.[k]?.done ? 'done' : ''}">${SESSION_META[k].seal}</span><span class="stamp-l">${SESSION_META[k].title}</span>`).join('')}
      </div>
    </form>

    <section class="actions">
      <button class="btn" id="copy-day">Скопировать отчёт за день</button>
      <button class="btn ghost" id="copy-week">Отчёт за неделю</button>
    </section>

    <section class="log"><h3>Записи</h3>
      ${dates.length ? `<div class="table-wrap"><table><thead><tr><th>Дата</th><th>Занятия</th><th>АД</th><th>Поясн.</th><th>Шаги</th><th>Вес</th><th>Талия</th></tr></thead><tbody>
        ${dates.map((ds) => { const x = state.days[ds]; return `<tr data-date="${ds}"><td>${shortDate(ds)}</td><td>${SESSION_KINDS.map((k) => (x.sessions?.[k]?.done ? SESSION_META[k].title[0] : '·')).join(' ')}</td><td>${x.bp?.sys ? `${x.bp.sys}/${x.bp.dia}` : '—'}</td><td>${x.pain?.back ?? '—'}</td><td>${x.steps ?? '—'}</td><td>${x.weight ?? '—'}</td><td>${x.waist ?? '—'}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<p class="note">Здесь появятся ваши записи. Первая — сегодня вечером.</p>'}
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
  if (!dlt) return `<span class="delta">без изменений</span>`;
  // Для веса, талии и боли уменьшение — это хорошо.
  return `<span class="delta ${dlt < 0 ? 'good' : 'bad'}">${dlt < 0 ? '▼' : '▲'} ${String(Math.abs(dlt)).replace('.', ',')} ${unit} от старта</span>`;
}

function renderProgress() {
  const today = dateStr();
  const ci = courseInfo(today);
  $('#view-sub').textContent = `День ${ci.dayN} из 84`;
  const w = lastValue('weight');
  const ws = lastValue('waist');
  const p = state.profile;
  const crit = phase2Criteria(state);
  main.innerHTML = `
    <section class="tiles two">
      <div class="tile"><span class="tile-l">Вес</span><span class="tile-v">${w ? String(w.value).replace('.', ',') : '—'}<small> кг</small></span>${delta(w?.value, p.startWeight, 'кг')}</div>
      <div class="tile"><span class="tile-l">Талия</span><span class="tile-v">${ws ? String(ws.value).replace('.', ',') : '—'}<small> см</small></span>${delta(ws?.value, p.startWaist, 'см')}</div>
    </section>

    <section class="chart-card"><h3>Вес, кг</h3><div id="ch-weight"></div></section>
    <section class="chart-card"><h3>Талия, см</h3><p class="note">Талия отражает висцеральный жир точнее, чем вес.</p><div id="ch-waist"></div></section>
    <section class="chart-card"><h3>Боль, от 0 до 10</h3><div id="ch-pain"></div></section>
    <section class="chart-card"><h3>Давление утром, мм рт. ст.</h3><div id="ch-bp"></div></section>
    <section class="chart-card"><h3>Занятий за неделю</h3><p class="note">Утро и день, максимум 14. Вечерняя разгрузка в счёт не идёт.</p><div id="ch-weeks"></div></section>
    <p class="note center">Все цифры таблицей — во вкладке <button class="link" data-go="diary">«Дневник»</button>.</p>

    <section class="phases"><h3>Этапы курса</h3>
      ${PHASES.map((ph) => `<article class="phase ${ph.n === ci.phase.n ? 'cur' : ''} ${ph.n < ci.phase.n ? 'past' : ''}">
        <div class="phase-n">${ph.n}</div>
        <div><h4>${esc(ph.name)} <small>недели ${ph.weeks[0]}–${ph.weeks[1]}</small></h4><p>${esc(ph.text)}</p></div>
      </article>`).join('')}
      <h4 class="crit-h">Условия перехода на этап 2</h4>
      <ul class="crit">${crit.map((c) => `<li class="${c.ok ? 'ok' : ''}"><span class="crit-mark">${c.ok ? '✓' : '○'}</span><span>${esc(c.text)}<small>${esc(c.have)}</small></span></li>`).join('')}</ul>
    </section>`;

  lineChart($('#ch-weight'), { unit: 'кг', series: [{ name: 'Вес', color: 'var(--series-1)', points: series((x) => x.weight) }] });
  lineChart($('#ch-waist'), { unit: 'см', series: [{ name: 'Талия', color: 'var(--series-1)', points: series((x) => x.waist) }] });
  lineChart($('#ch-pain'), { series: [
    { name: 'Поясница', color: 'var(--series-1)', points: series((x) => x.pain?.back) },
    { name: 'Лопатки', color: 'var(--series-2)', points: series((x) => x.pain?.blades) },
    { name: 'Ночью в ноги', color: 'var(--series-3)', points: series((x) => x.pain?.legs) },
  ] });
  lineChart($('#ch-bp'), { series: [
    { name: 'Верхнее', color: 'var(--series-1)', points: series((x) => x.bp?.sys) },
    { name: 'Нижнее', color: 'var(--series-2)', points: series((x) => x.bp?.dia) },
  ] });
  const weeks = [];
  const nWeeks = Math.min(12, Math.max(1, Math.ceil(ci.dayN / 7)));
  for (let i = 0; i < nWeeks; i++) {
    let n = 0;
    for (let k = 0; k < 7; k++) n += coreDone(addDays(p.startDate, i * 7 + k));
    weeks.push({ label: String(i + 1), value: n });
  }
  weekBars($('#ch-weeks'), { weeks: weeks.some((x) => x.value) ? weeks : [] });
}

// ---------- мастер ----------
const CHIPS = ['Что у меня сегодня?', 'Как стоять столбом?', 'Болит поясница, что делать?', 'Давление 160 на 100, заниматься?'];
let masterBusy = false;
let masterAbort = null;

function bubble(m) {
  const b = document.createElement('div');
  b.className = `msg ${m.role}`;
  b.textContent = m.text;
  return b;
}

function renderMaster() {
  $('#view-sub').textContent = hasKey() ? 'Живой разговор' : 'Базовый режим';
  main.innerHTML = `
    <section class="chat" id="chat" aria-live="polite"></section>
    ${hasKey() ? '' : '<p class="note chat-note">Без ключа наставник отвечает только по курсу. Свободный разговор включается в настройках. <button class="link" data-open="settings">Открыть</button></p>'}
    <div class="chips" id="chips">${CHIPS.map((c) => `<button class="chip">${esc(c)}</button>`).join('')}</div>
    <form class="ask" id="ask-form">
      ${voice.sttSupported ? '<button type="button" class="mic" id="mic" aria-label="Сказать голосом"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' : ''}
      <textarea id="ask-input" rows="1" placeholder="Ваш вопрос" aria-label="Вопрос наставнику"></textarea>
      <button class="btn" type="submit">Спросить</button>
    </form>`;
  const chat = $('#chat');
  if (!state.chat.length) {
    chat.append(bubble({ role: 'assistant', text: 'Я рядом. Спросите о любом упражнении, расскажите, как прошло занятие или что болит.' }));
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
    const out = bubble({ role: 'assistant', text: 'Думаю…' });
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
      out.textContent = err.kind === 'aborted' ? 'Остановлено.' : (err.message || 'Не получилось получить ответ.');
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
      if (text) send(text); else toast('Не расслышал. Попробуйте ещё раз.');
    } catch (err) {
      mic.classList.remove('on');
      toast(err.message === 'denied' ? 'Нет доступа к микрофону. Разрешите его в настройках браузера.' : 'Распознавание речи недоступно. Надиктуйте с клавиатуры.');
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
    <h3>Настройки</h3>
    <form class="form" id="set-form" novalidate>
      <fieldset><legend>О вас</legend>
        <label for="set-name">Имя</label><input id="set-name" value="${esc(p.name)}">
        <label for="set-start">Первый день курса</label><input id="set-start" type="date" value="${esc(p.startDate)}">
        <div class="grid2">
          <div><label for="set-weight">Стартовый вес, кг</label><input id="set-weight" inputmode="decimal" value="${esc(p.startWeight ?? '')}"></div>
          <div><label for="set-waist">Стартовая талия, см</label><input id="set-waist" inputmode="decimal" value="${esc(p.startWaist ?? '')}"></div>
        </div>
        <label for="set-health">Что беспокоит и что запрещал врач</label>
        <textarea id="set-health" rows="3">${esc(p.health)}</textarea>
      </fieldset>
      <fieldset><legend>Голос наставника</legend>
        <label class="switch"><input type="checkbox" id="set-voice" ${s.voice ? 'checked' : ''}><span>Говорить вслух</span></label>
        <label class="switch"><input type="checkbox" id="set-count" ${s.countAloud ? 'checked' : ''}><span>Считать повторы вслух</span></label>
        ${vs.length > 1 ? `<label for="set-voiceuri">Голос</label><select id="set-voiceuri">${vs.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === s.voiceURI ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>` : ''}
        <label for="set-rate">Темп речи: <output id="set-rate-out">${s.rate}</output></label>
        <input type="range" id="set-rate" min="0.7" max="1.2" step="0.05" value="${s.rate}">
        <button type="button" class="btn ghost" id="set-test">Проверить голос</button>
        ${voice.ttsSupported ? '' : '<p class="note">Этот браузер не умеет говорить вслух.</p>'}
      </fieldset>
      <fieldset><legend>Живой разговор с наставником</legend>
        <p class="note">Свободный диалог и разбор кадра с камеры идут через Claude API (модель ${MODEL}) по вашему собственному ключу с console.anthropic.com. Ключ хранится только на этом телефоне. При вопросе наставнику на серверы Anthropic уходят ваш вопрос, записи дневника за неделю и сведения о здоровье из профиля; при «Мастер, посмотри» — ещё один кадр с камеры. Запросы оплачиваются по тарифу API.</p>
        <label for="set-key">Ключ API</label>
        <input id="set-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(getApiKey())}">
      </fieldset>
      <fieldset><legend>Данные</legend>
        <p class="note">Дневник хранится только в этом браузере. Очистка данных сайта или удаление приложения сотрёт его — раз в неделю сохраняйте копию.</p>
        <div class="ov-row"><button type="button" class="btn ghost" id="set-export">Скопировать копию</button><button type="button" class="btn ghost" id="set-import">Восстановить</button></div>
        <button type="button" class="btn ghost danger" id="set-reset">Стереть все данные</button>
      </fieldset>
      ${standalone ? '' : '<p class="note">Чтобы приложение открывалось с главного экрана: в Safari нажмите «Поделиться» и выберите «На экран „Домой“».</p>'}
      <button class="btn wide" type="submit">Сохранить</button>
      <button class="btn ghost wide" type="button" data-close>Закрыть</button>
    </form>`);
  $('#set-rate').addEventListener('input', (e) => { $('#set-rate-out').textContent = e.target.value; });
  $('#set-test').addEventListener('click', () => {
    state.settings.rate = Number($('#set-rate').value);
    if ($('#set-voiceuri')) state.settings.voiceURI = $('#set-voiceuri').value;
    voice.speak('Плечи опущены, дыхание спокойное. Макушка тянется вверх.', { interrupt: true, force: true });
  });
  $('#set-export').addEventListener('click', () => copyText(exportJSON()));
  $('#set-import').addEventListener('click', () => {
    openSheet(`<h3>Восстановить из копии</h3><p class="note">Вставьте текст сохранённой копии. Текущие данные будут заменены.</p>
      <textarea class="copybox" id="imp-text" rows="8"></textarea>
      <button class="btn wide" id="imp-go">Восстановить</button><button class="btn ghost wide" data-close>Отмена</button>`);
    $('#imp-go').addEventListener('click', () => {
      try { importJSON($('#imp-text').value); closeSheet(); render(); toast('Данные восстановлены'); } catch (err) { toast(err.message.includes('копи') ? err.message : 'Не получилось прочитать копию.'); }
    });
  });
  $('#set-reset').addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (b.dataset.armed) { resetAll(); setApiKey(''); closeSheet(); render(); toast('Данные стёрты'); return; }
    b.dataset.armed = '1';
    b.textContent = 'Нажмите ещё раз, чтобы стереть без возврата';
  });
  $('#set-form').addEventListener('submit', (e) => {
    e.preventDefault();
    Object.assign(p, {
      name: $('#set-name').value.trim(), startDate: $('#set-start').value || p.startDate,
      startWeight: num($('#set-weight').value), startWaist: num($('#set-waist').value), health: $('#set-health').value.trim(),
    });
    Object.assign(s, { voice: $('#set-voice').checked, countAloud: $('#set-count').checked, rate: Number($('#set-rate').value) });
    if ($('#set-voiceuri')) s.voiceURI = $('#set-voiceuri').value;
    setApiKey($('#set-key').value);
    save();
    closeSheet();
    render();
    toast('Сохранено');
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

// ---------- события ----------
document.addEventListener('click', (e) => {
  const t = e.target;
  const tab = t.closest('.tab');
  if (tab) return go(tab.dataset.view);
  if (t.closest('[data-close]') || t === sheet) return closeSheet();
  const st = t.closest('[data-start]');
  if (st) { voice.unlock(); return openStart(st.dataset.start); }
  const g = t.closest('[data-go]');
  if (g) return go(g.dataset.go);
  if (t.closest('[data-open="settings"]') || t.closest('#btn-settings')) return openSettings();
  return undefined;
});
document.addEventListener('change', (e) => {
  const task = e.target.closest?.('[data-task]');
  if (task) { state.tasks[task.dataset.task] = true; save(); setTimeout(() => { if (view === 'today') renderToday(); }, 350); }
});

subscribe(() => { if (!isStorageOk()) toast('Не удаётся сохранить данные: проверьте, что браузер не в приватном режиме.'); });

// Новый день: если приложение пролежало открытым ночь, обновляем экран.
let lastDay = dateStr();
document.addEventListener('visibilitychange', () => {
  if (document.hidden || runner) return;
  if (dateStr() !== lastDay) { lastDay = dateStr(); diaryDate = lastDay; render(); }
});

if ('serviceWorker' in navigator && window.isSecureContext && !params.get('nosw')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
