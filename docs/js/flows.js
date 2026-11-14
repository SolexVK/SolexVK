// Сценарии беседы с мастером: знакомство и программа, опрос перед занятием, еженедельный пересмотр.
import { state, save, day, dateStr, daysBetween, logEntry } from './store.js';
import { INTAKE, INTAKE_DONE, CHECKIN, CHECKIN_REPLIES, LEVELS } from './kb.js';
import { FLOW_LINES } from './flow-lines.js';
import { newProgram, resolvePlan, checkinDecision, readiness, levelInfo } from './program.js';
import { aiAvailable, designProgram, checkinReply, reviewProgress, remember } from './brain.js';
import { runInterview } from './interview.js';
import * as voice from './voice.js';
import { TAIJI } from './theme.js';
import * as ambient from './ambient.js';
import { t } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FLAG_TEXT = {
  cervical: t('бережно к шее'), lumbar_radicular: t('бережно к пояснице'), lumbar_acute: t('острая боль в пояснице'), knee: t('щадящий режим для коленей'),
  hip: t('щадящий режим для тазобедренных суставов'), shoulder: t('бережно к плечам'), wrist: t('бережно к запястьям'), hypertension: t('контроль давления'),
  heart: t('нагрузка под контролем врача'), osteo: t('без нагрузки на позвоночник в наклоне'), balance: t('упражнения с опорой'), no_floor: t('без упражнений на полу'),
  pregnant: t('беременность'), postpartum: t('восстановление после родов'),
};
const MODE_TEXT = { full: t('Полное занятие'), light: t('Мягкий режим'), rest: t('День восстановления'), none: t('Сегодня без занятия') };

const focusOn = () => { document.body.classList.add('focus'); ambient.start(); ambient.setScene('talk'); };
const focusOff = () => { document.body.classList.remove('focus'); ambient.setScene('home'); };

// План занятия с учётом программы и сегодняшних пропусков.
export function currentPlan(extraSkip = []) {
  const p = resolvePlan(state.program) || resolvePlan({ level: 2, stage: 1, flags: [] });
  extraSkip.forEach((id) => p.exclude.add(id));
  return p;
}

// Режим занятия на сегодня: по опросу, иначе по давлению.
export function todayCheckin(date = dateStr()) {
  return state.days[date]?.checkin || null;
}

// ---- знакомство: анкета → программа ----
export async function startIntake(root, onDone) {
  focusOn();
  voice.unlock();
  const answers = await runInterview(root, { title: t('Знакомство с мастером'), questions: INTAKE, answers: { ...(state.intake || {}) } });
  if (!answers) { focusOff(); return onDone(false); }
  const p = state.profile;
  state.intake = { ...answers, at: dateStr() };
  Object.assign(p, {
    name: answers.name || p.name, sex: answers.sex, age: answers.age ?? p.age,
    height: answers.body?.height ?? p.height, startWeight: p.startWeight ?? answers.body?.weight ?? null,
    startWaist: p.startWaist ?? answers.waist ?? null, onboarded: true,
  });
  if (!p.startDate) p.startDate = dateStr();
  const d = day(dateStr());
  if (answers.body?.weight && d.weight == null) d.weight = answers.body.weight;
  if (answers.waist && d.waist == null) d.waist = answers.waist;
  logEntry('intake', 'user', JSON.stringify(answers));
  save();

  root.innerHTML = `<section class="iv iv-wait">${TAIJI}<h2>${t('Мастер составляет программу')}</h2><p class="note">${t('Обычно это занимает до минуты.')}</p></section>`;
  voice.speak(INTAKE_DONE, { interrupt: true });
  const base = newProgram(state.intake);
  let program = { ...base };
  if (base.level > 0 && aiAvailable()) {
    try {
      const ai = await designProgram(state.intake, base);
      program = { ...program, ...ai, source: 'ai' };
    } catch (e) {
      program.aiError = e.message;
    }
  }
  if (!program.rationale) program.rationale = ruleRationale(program);
  program.updatedAt = Date.now();
  program.history = [{ date: dateStr(), level: program.level, stage: 1, reason: t('программа по анкете') }];
  state.program = program;
  logEntry('intake', 'assistant', program.rationale);
  save();
  remember('intake', `Пройдена анкета. Назначен уровень ${program.level}. ${program.rationale}`);
  await revealProgram(root);
  focusOff();
  return onDone(true);
}

function ruleRationale(pr) {
  if (pr.level === 0) return t('По вашим ответам занятия сейчас можно начинать только после разрешения врача. Я подготовлю бережную программу, когда врач даст согласие.');
  const L = levelInfo(pr.level);
  const parts = [`${t('Начинаем с уровня')} ${pr.level}, «${L.name}».`, L.goal];
  if (pr.reasons?.length) parts.push(`${t('Я учёл:')} ${pr.reasons.slice(0, 3).join(', ')}.`);
  const fl = (pr.flags || []).map((f) => FLAG_TEXT[f]).filter(Boolean);
  if (fl.length) parts.push(`${t('Особое внимание:')} ${fl.slice(0, 4).join(', ')}.`);
  parts.push(t('Нагрузку будем прибавлять постепенно, раз в неделю, по вашему самочувствию.'));
  return parts.join(' ');
}

export function programHtml(pr) {
  const L = levelInfo(pr.level || 1);
  const fl = (pr.flags || []).map((f) => FLAG_TEXT[f]).filter(Boolean);
  return `
    <p class="eyebrow">${t('Ваша программа')}</p>
    <h2>${pr.level ? t('Уровень {n} · «{name}»', { n: pr.level, name: esc(t(L.name)) }) : t('Нужна консультация врача')}</h2>
    <p class="lead">${esc(pr.rationale)}</p>
    ${pr.doctor?.length ? `<div class="callout danger"><strong>${t('Перед нагрузкой покажитесь врачу:')}</strong><ul>${pr.doctor.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${pr.focus?.length ? `<h3>${t('На чём сосредоточимся')}</h3><ul class="bullets">${pr.focus.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${pr.cautions?.length ? `<h3>${t('Что соблюдать')}</h3><ul class="bullets">${pr.cautions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${fl.length ? `<p class="note">${t('Учтено:')} ${esc(fl.join(', '))}.</p>` : ''}
    ${pr.aiError ? `<p class="note">${t('Нейросеть не ответила (')}${esc(pr.aiError)}${t('), программа составлена по правилам.')}</p>` : ''}`;
}

function revealProgram(root) {
  return new Promise((resolve) => {
    const pr = state.program;
    root.innerHTML = `<section class="iv reveal">${programHtml(pr)}<button class="btn wide" data-go-on>${pr.level ? t('Начать путь') : t('Понятно')}</button><button class="btn ghost wide" data-replay>${t('Послушать ещё раз')}</button></section>`;
    voice.speak(FLOW_LINES.programReady, { interrupt: true }).then(() => voice.speak(pr.rationale));
    if (pr.doctor?.length) voice.speak(FLOW_LINES.doctor);
    root.onclick = (e) => {
      if (e.target.closest('[data-replay]')) { voice.speak(pr.rationale, { interrupt: true }); return; }
      if (e.target.closest('[data-go-on]')) { voice.cancel(); root.onclick = null; resolve(); }
    };
  });
}

// ---- опрос перед занятием ----
// Возвращает { mode, skip, say } или null, если ученик закрыл опрос.
export async function runCheckin(root, kind) {
  focusOn();
  voice.unlock();
  voice.speak(FLOW_LINES.checkinIntro, { interrupt: true });
  const answers = await runInterview(root, { title: t('Перед занятием'), questions: CHECKIN });
  if (!answers) { focusOff(); return null; }
  const today = dateStr();
  const d = day(today);
  if (answers.bp?.sys && answers.bp?.dia) d.bp = { sys: answers.bp.sys, dia: answers.bp.dia };
  if (answers.pain != null && d.pain.back == null) d.pain.back = answers.pain;
  const rule = checkinDecision(answers);
  let decision = { mode: rule.mode, skip: [], say: CHECKIN_REPLIES[rule.key], source: 'rules', reasons: rule.reasons };
  if (rule.mode !== 'none' && aiAvailable()) {
    root.innerHTML = `<section class="iv iv-wait">${TAIJI}<h2>${t('Мастер обдумывает ответ')}</h2></section>`;
    try {
      const ai = await checkinReply(answers, rule, kind);
      decision = { ...decision, ...ai, source: 'ai' };
    } catch { /* остаётся ответ по правилам */ }
  }
  d.checkin = { at: Date.now(), kind, answers, decision };
  logEntry('checkin', 'user', JSON.stringify(answers));
  logEntry('checkin', 'assistant', decision.say);
  save();
  remember('checkin', `Опрос перед занятием: ${JSON.stringify(answers)}. Решение: ${decision.mode}. Мастер сказал: ${decision.say}`);

  await new Promise((resolve) => {
    root.innerHTML = `<section class="iv reveal">
      <p class="eyebrow">${t('Слово мастера')}</p>
      <h2>${esc(MODE_TEXT[decision.mode])}</h2>
      <p class="lead">${esc(t(decision.say))}</p>
      ${decision.reasons?.length ? `<p class="note">${t('Учтено:')} ${esc(decision.reasons.join(', '))}.</p>` : ''}
      <button class="btn wide" data-go-on>${decision.mode === 'none' ? t('Понятно') : t('Продолжить')}</button></section>`;
    voice.speak(decision.say, { interrupt: true });
    root.onclick = (e) => { if (e.target.closest('[data-go-on]')) { voice.cancel(); root.onclick = null; resolve(); } };
  });
  focusOff();
  return decision;
}

// ---- еженедельный пересмотр ----
export function reviewDue(today = dateStr()) {
  const pr = state.program;
  if (!pr?.level) return false;
  const last = state.reviews?.length ? state.reviews[state.reviews.length - 1].date : pr.levelSince;
  return daysBetween(last, today) >= 7;
}

export async function runReview(root, onDone) {
  focusOn();
  voice.unlock();
  const pr = state.program;
  const ready = readiness();
  root.innerHTML = `<section class="iv iv-wait">${TAIJI}<h2>${t('Мастер изучает дневник')}</h2></section>`;
  voice.speak(FLOW_LINES.reviewIntro, { interrupt: true });
  let r;
  if (aiAvailable()) {
    try { r = { ...(await reviewProgress(ready)), source: 'ai' }; } catch { r = null; }
  }
  if (!r) {
    const decision = ready.regress ? 'step_back' : ready.ready && ready.nextScripted ? 'level_up' : ready.stageUp ? 'stage_up' : 'stay';
    r = { decision, say: { step_back: FLOW_LINES.stepBack, level_up: FLOW_LINES.levelUp, stage_up: FLOW_LINES.stageUp, stay: FLOW_LINES.stay }[decision], reasons: [], source: 'rules' };
  }
  const titles = { stay: t('Продолжаем в том же темпе'), stage_up: `${t('Ступень')} ${Math.min(4, pr.stage + 1)} ${t('из 4')}`, level_up: `${t('Уровень')} ${pr.level + 1}`, step_back: t('Делаем мягче') };
  await new Promise((resolve) => {
    root.innerHTML = `<section class="iv reveal">
      <p class="eyebrow">${t('Пересмотр недели · готовность')} ${ready.score} ${t('из 100')}</p>
      <h2>${esc(titles[r.decision])}</h2>
      <p class="lead">${esc(t(r.say))}</p>
      ${r.reasons.length ? `<ul class="bullets">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <ul class="crit">${ready.crit.map((c) => `<li class="${c.ok ? 'ok' : ''}"><span class="crit-mark">${c.ok ? '✓' : '○'}</span><span>${esc(c.text)}<small>${esc(c.have)}</small></span></li>`).join('')}</ul>
      <button class="btn wide" data-accept>${r.decision === 'stay' ? t('Понятно') : t('Принять')}</button>
      ${r.decision !== 'stay' ? `<button class="btn ghost wide" data-keep>${t('Пока оставить как есть')}</button>` : ''}</section>`;
    voice.speak(r.say, { interrupt: true });
    root.onclick = (e) => {
      const accept = e.target.closest('[data-accept]');
      const keep = e.target.closest('[data-keep]');
      if (!accept && !keep) return;
      voice.cancel();
      root.onclick = null;
      applyReview(accept ? r.decision : 'stay', r, ready);
      resolve();
    };
  });
  focusOff();
  onDone?.();
}

function applyReview(decision, r, ready) {
  const pr = state.program;
  const today = dateStr();
  if (decision === 'stage_up') { pr.stage = Math.min(4, (pr.stage || 1) + 1); pr.stageSince = today; }
  if (decision === 'level_up') { pr.level = Math.min(LEVELS.length, pr.level + 1); pr.stage = 1; pr.stageSince = today; pr.levelSince = today; }
  if (decision === 'step_back') {
    if ((pr.stage || 1) > 1) { pr.stage -= 1; pr.stageSince = today; } else pr.doseScale = Math.max(0.6, Math.round((pr.doseScale || 1) * 0.85 * 10) / 10);
  }
  pr.updatedAt = Date.now();
  pr.history = [...(pr.history || []), { date: today, level: pr.level, stage: pr.stage, reason: `${decision}: ${r.reasons.join('; ')}` }];
  state.reviews = [...(state.reviews || []), { date: today, decision, score: ready.score, say: r.say, source: r.source }];
  logEntry('review', 'assistant', r.say, { decision });
  save();
  remember('review', `Пересмотр недели: решение ${decision}, готовность ${ready.score}. ${r.say}`);
}
