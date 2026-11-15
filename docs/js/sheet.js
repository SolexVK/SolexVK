// Лист программы: все упражнения утра, дня и вечера с дозировкой, ограничениями и схемой.
// Строится той же функцией, что и сами занятия (buildSession), поэтому всегда совпадает с ними:
// пересмотр мастера, новый уровень или исключённое упражнение сразу видны здесь.
import { state, save, dateStr } from './store.js';
import { buildSession, SESSION_META } from './course.js';
import { resolvePlan, levelInfo } from './program.js';
import { EXERCISES } from './kb.js';
import { FLAG_TEXT } from './flows.js';
import { t } from './i18n.js';
import { figureSvg, hasFigure } from './figures.js';
import { GUIDES } from './guides.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KINDS = ['morning', 'day', 'evening'];
const baseId = (id) => String(id).replace(/\d+$/, '');
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// Дозировка шага в виде, не зависящем от языка: h:секунды, b:дыханий:вдох:выдох, r:блок+блок.
export function doseRaw(s) {
  const holds = s.items.filter((it) => it.t === 'hold');
  if (holds.length) return `h:${holds.reduce((a, it) => a + it.dur, 0)}`;
  const beats = s.items.filter((it) => it.t === 'beat' && it.rep);
  if (s.kind === 'breath') {
    const ins = beats.filter((it) => it.breath === 'in');
    const ex = beats.find((it) => it.breath === 'out');
    return ins.length ? `b:${ins.length}:${ins[0].dur}:${ex?.dur || 6}` : '';
  }
  // Блоки счёта: номер повтора начинается заново — новый блок (например, повороты и кивки).
  const blocks = [];
  let last = 0;
  for (const it of beats) {
    if (it.rep < last) blocks.push(last);
    last = it.rep;
  }
  if (last) blocks.push(last);
  return blocks.length ? `r:${blocks.join('+')}` : '';
}

export function fmtDose(raw) {
  const [k, a, b, c] = String(raw || '').split(':');
  if (k === 'h') { const sec = Number(a); return sec >= 120 && sec % 60 === 0 ? `${sec / 60} ${t('мин')}` : mmss(sec); }
  if (k === 'b') return `${a} ${t('дыханий')} · ${b}/${c}`;
  if (k === 'r') return `${a.split('+').join(' + ')} ${t('повт.')}`;
  return '';
}
export const doseOf = (s) => fmtDose(doseRaw(s));

// Снимок программы: что входит в каждое занятие и с какой дозировкой.
export function sheetSnapshot(plan = resolvePlan(state.program)) {
  if (!plan) return null;
  const snap = {};
  for (const kind of KINDS) {
    for (const s of buildSession(kind, plan, 'full').steps) {
      if (s.kind === 'talk') continue;
      snap[`${kind}:${baseId(s.id)}`] = { title: s.title, dose: doseRaw(s) };
    }
  }
  return snap;
}

// Сравниваем с прошлым снимком; если программа изменилась — запоминаем, что именно и почему.
export function trackChanges() {
  const pr = state.program;
  if (!pr?.level) return;
  const snap = sheetSnapshot();
  if (!snap) return;
  const sig = JSON.stringify(snap);
  if (state.sheet && state.sheet.v !== 2) state.sheet = null;
  const sh = state.sheet || (state.sheet = { v: 2, sig: '', snap: null, changes: [] });
  if (sh.sig === sig) return;
  if (sh.snap) {
    const items = [];
    for (const [k, v] of Object.entries(snap)) {
      const o = sh.snap[k];
      if (!o) items.push({ k, type: 'add', title: v.title, dose: v.dose });
      else if (o.dose !== v.dose) items.push({ k, type: 'dose', title: v.title, from: o.dose, dose: v.dose });
    }
    for (const [k, o] of Object.entries(sh.snap)) if (!snap[k]) items.push({ k, type: 'del', title: o.title, dose: o.dose });
    const h = (pr.history || []).at(-1);
    if (items.length) sh.changes = [{ date: dateStr(), level: pr.level, stage: pr.stage, reason: h?.reason || '', items }, ...(sh.changes || [])].slice(0, 6);
  }
  sh.sig = sig;
  sh.snap = snap;
  save();
}

const DECISION = { stage_up: () => t('Мастер поднял ступень нагрузки'), level_up: () => t('Новый уровень'), step_back: () => t('Мастер облегчил нагрузку'), stay: () => t('Нагрузка без изменений') };
function reasonText(r) {
  const m = String(r || '').match(/^(\w+):\s*(.*)$/);
  if (!m || !DECISION[m[1]]) return r || '';
  return m[2] ? `${DECISION[m[1]]()}: ${m[2]}` : DECISION[m[1]]();
}

const CHANGE_WORD = { add: () => t('добавлено'), del: () => t('убрано'), dose: () => t('нагрузка') };

function changeBadge(k) {
  const last = state.sheet?.changes?.[0];
  if (!last) return '';
  const it = last.items.find((x) => x.k === k);
  if (!it) return '';
  return `<span class="ex-new">${it.type === 'add' ? t('новое') : `${esc(fmtDose(it.from))} → ${esc(fmtDose(it.dose))}`}</span>`;
}

function cautionNote(id, flags) {
  const ex = EXERCISES[id];
  const hit = (ex?.caution || []).filter((f) => flags.has(f)).map((f) => FLAG_TEXT[f]).filter(Boolean);
  return hit.length ? `<p class="ex-caution">${t('Щадящий вариант:')} ${esc(hit.join(', '))}</p>` : '';
}

function card(kind, s, flags, skipped) {
  const id = baseId(s.id);
  const k = `${kind}:${id}`;
  const g = GUIDES[id];
  return `<article class="ex ${skipped ? 'ex-off' : ''}" data-ex="${esc(id)}">
    <div class="ex-fig">${hasFigure(id) ? figureSvg(id, { noFloor: id === 'unload' && state.program?.flags?.includes('no_floor') }) : ''}</div>
    <div class="ex-body">
      <h4>${esc(t(s.title))} ${changeBadge(k)}</h4>
      <p class="ex-dose">${esc(doseOf(s))}${skipped ? ` · <em>${t('сегодня пропускаем')}</em>` : ''}</p>
      <p class="ex-text">${esc(t(s.text || ''))}</p>
      ${cautionNote(id, flags)}
      ${g ? `<button type="button" class="btn ghost small" data-guide="${esc(id)}">▶ ${t('Как выполнять')}</button>` : ''}
    </div>
  </article>`;
}

// todayMode — облегчение на сегодня (из опроса или давления), todaySkip — пропуски на сегодня.
export function renderSheet(root, { todayMode = 'full', todaySkip = [] } = {}) {
  const pr = state.program;
  const plan = resolvePlan(pr);
  if (!plan) {
    root.innerHTML = `<p class="note center">${t('Программа появится после знакомства с мастером.')}</p>`;
    return;
  }
  trackChanges();
  const flags = new Set(pr.flags || []);
  const L = levelInfo(pr.level);
  // Что реально будет сегодня: занятие в сегодняшнем режиме с пропусками.
  const todayPlan = resolvePlan(pr);
  todaySkip.forEach((id) => todayPlan.exclude.add(id));
  const todayIds = {};
  for (const kind of KINDS) todayIds[kind] = new Set(buildSession(kind, todayPlan, todayMode === 'none' ? 'rest' : todayMode).steps.map((s) => baseId(s.id)));
  const ch = state.sheet?.changes?.[0];
  const fl = [...flags].map((f) => FLAG_TEXT[f]).filter(Boolean);
  root.innerHTML = `
    <section class="sheet-head">
      <p class="eyebrow">${t('Моя программа')}</p>
      <h2>${t('Уровень {n} · «{name}»', { n: pr.level, name: esc(t(L.name)) })}</h2>
      <p class="lead">${t('Ступень нагрузки {s} из 4', { s: plan.stage })}${pr.doseScale && pr.doseScale < 1 ? ` · ${t('облегчение')} ${Math.round((1 - pr.doseScale) * 100)}%` : ''}</p>
      ${fl.length ? `<p class="note">${t('Учтено:')} ${esc(fl.join(', '))}.</p>` : ''}
      ${todayMode !== 'full' ? `<div class="callout">${todayMode === 'none' ? t('Сегодня занятия нет: мастер отменил его по самочувствию или давлению.') : todayMode === 'rest' ? t('Сегодня день восстановления: упражнения, отмеченные бледным, пропускаем.') : t('Сегодня мягкий режим: упражнения, отмеченные бледным, пропускаем.')}</div>` : ''}
      ${ch ? `<details class="sheet-changes" ${ch.date === dateStr() ? 'open' : ''}><summary>${t('Что изменилось')} · ${esc(ch.date.split('-').reverse().join('.'))}</summary>
        ${ch.reason ? `<p class="note">${esc(reasonText(ch.reason))}</p>` : ''}
        <ul>${ch.items.map((it) => `<li><b>${esc(CHANGE_WORD[it.type]())}:</b> ${esc(t(it.title))}${it.type === 'dose' ? ` — ${esc(fmtDose(it.from))} → ${esc(fmtDose(it.dose))}` : it.dose ? ` — ${esc(fmtDose(it.dose))}` : ''}</li>`).join('')}</ul>
      </details>` : ''}
    </section>
    ${KINDS.map((kind) => {
      const steps = buildSession(kind, plan, 'full').steps.filter((s) => s.kind !== 'talk');
      const M = SESSION_META[kind];
      return `<section class="sheet-sec">
        <h3><span class="seal">${M.seal}</span> ${esc(t(M.title))} <small>${esc(t(M.sub))}</small></h3>
        ${steps.map((s) => card(kind, s, flags, todayMode !== 'full' && !todayIds[kind].has(baseId(s.id)))).join('')}
      </section>`;
    }).join('')}
    <p class="note center">${t('Лист перестраивается сам, когда мастер меняет программу.')}</p>`;
}
