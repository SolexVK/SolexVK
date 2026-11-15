// Правила мастера: оценка анкеты, программа, решение перед занятием, готовность к переходу.
// Правила — нижняя граница безопасности: нейросеть может сделать программу мягче, но не жёстче.
import { LEVELS, DOSES, EXERCISES, PROGRESSION } from './kb.js';
import { state, dateStr, addDays, daysBetween, peekDay, coreDone } from './store.js';
import { t } from './i18n.js';

const has = (arr, v) => Array.isArray(arr) && arr.includes(v);

// ---- оценка анкеты ----
export function assess(a) {
  const flags = new Set();
  const reasons = [];
  const doctor = [];
  const pain = a.pain || [];
  const diag = a.diagnoses || [];
  const painLevel = has(pain, 'none') ? 0 : Number(a.painLevel ?? 0);

  if (has(diag, 'disc_cervical') || has(pain, 'neck')) flags.add('cervical');
  if (has(diag, 'disc_lumbar') || ['sometimes', 'often', 'weakness'].includes(a.radiating)) flags.add('lumbar_radicular');
  if (has(pain, 'lumbar') && painLevel >= 7) flags.add('lumbar_acute');
  if (has(pain, 'knee') || has(diag, 'arthrosis')) flags.add('knee');
  if (has(pain, 'hip')) flags.add('hip');
  if (has(pain, 'shoulder')) flags.add('shoulder');
  if (has(pain, 'wrist')) flags.add('wrist');
  if (has(diag, 'hypertension') || ['sometimes', 'often', 'treated'].includes(a.bp)) flags.add('hypertension');
  if (has(diag, 'heart')) flags.add('heart');
  if (has(diag, 'osteoporosis') || a.female === 'menopause') flags.add('osteo');
  if (Number(a.balanceTest ?? 99) < 10 || a.falls === 'falls' || Number(a.age) >= 70) flags.add('balance');
  if (a.floor === 'no' || (a.floor === 'hard' && painLevel >= 7)) flags.add('no_floor');
  if (a.female === 'pregnant') flags.add('pregnant');
  if (a.female === 'postpartum') flags.add('postpartum');

  if (a.radiating === 'weakness') doctor.push(t('слабость или онемение в конечностях — нужен осмотр невролога'));
  if (flags.has('heart')) doctor.push(t('болезни сердца — нагрузку согласовать с кардиологом'));
  if (a.bp === 'often') doctor.push(t('часто высокое давление — нужна постоянная терапия от врача'));
  if (a.falls === 'falls') doctor.push(t('падения за последний год — проверить у терапевта'));
  if (flags.has('pregnant')) doctor.push(t('беременность — занятия только по согласованию с врачом и с инструктором для беременных'));
  if (flags.has('postpartum')) doctor.push(t('после родов — начать после разрешения врача, бережно к мышцам живота и тазового дна'));
  if (has(diag, 'surgery')) doctor.push(t('операции на позвоночнике или суставах — согласовать ограничения с хирургом'));

  // Баллы «слабости»: чем больше, тем бережнее старт.
  let w = 0;
  const bmi = a.body?.weight && a.body?.height ? a.body.weight / ((a.body.height / 100) ** 2) : null;
  const chair = a.chairTest == null || a.chairTest === '' ? null : Number(a.chairTest);
  if (chair != null) { if (chair < 8) { w += 2; reasons.push(`${t('за 30 секунд')} ${chair} ${t('вставаний со стула')}`); } else if (chair < 12) w += 1; }
  if (Number(a.balanceTest ?? 99) < 10) { w += 1; reasons.push(t('равновесие на одной ноге меньше 10 секунд')); }
  if (painLevel >= 6) { w += 2; reasons.push(`${t('боль')} ${painLevel} ${t('из 10')}`); } else if (painLevel >= 4) w += 1;
  if (a.radiating === 'weakness') w += 2; else if (a.radiating === 'often') { w += 1; reasons.push(t('боль часто отдаёт в конечности')); }
  if (bmi && bmi >= 35) { w += 1; reasons.push(t('индекс массы тела выше 35')); }
  if (Number(a.age) >= 75) w += 2; else if (Number(a.age) >= 65) w += 1;
  if (a.activity === 'sit') { w += 1; reasons.push(t('малоподвижный образ жизни')); }
  if (flags.has('heart')) w += 2;
  if (a.bp === 'often') w += 1;
  if (flags.has('no_floor')) w += 1;
  if (a.falls !== 'no' && a.falls) w += 1;
  if (a.flex === 'thighs' || a.flex === 'nobend') { w += 1; reasons.push(t('тугая подвижность спины')); }

  // Подготовленный ученик без ограничений начинает сразу с уровня 3: щадящие упражнения ему не нужны.
  const fit = w === 0 && chair != null && chair >= 12 && ['regular', 'sport'].includes(a.activity) && painLevel <= 3
    && (!a.radiating || a.radiating === 'no') && Number(a.balanceTest ?? 0) >= 20
    && !['lumbar_radicular', 'lumbar_acute', 'heart', 'osteo', 'balance', 'knee', 'hip', 'no_floor', 'postpartum'].some((f) => flags.has(f));
  const level = flags.has('pregnant') ? 0 : fit ? 3 : (w >= 4 ? 1 : 2);
  return { level, weakness: w, flags: [...flags], reasons, doctor, bmi: bmi ? Math.round(bmi * 10) / 10 : null };
}

// Новая программа по анкете (до уточнения нейросетью).
export function newProgram(intake) {
  const as = assess(intake);
  return {
    v: 1, createdAt: dateStr(), level: as.level, stage: 1, stageSince: dateStr(), levelSince: dateStr(),
    flags: as.flags, doctor: as.doctor, reasons: as.reasons, weakness: as.weakness,
    exclude: [], doseScale: 1, rationale: '', cautions: [], focus: [], source: 'rules', history: [],
  };
}

// ---- план занятия на сегодня ----
// Превращает программу в параметры для сценария: дозировки, опора, исключения.
export function resolvePlan(prog = state.program) {
  if (!prog || !prog.level) return null;
  const lvl = Math.min(Math.max(prog.level, 1), 4);
  const st = Math.min(Math.max(prog.stage || 1, 1), 4) - 1;
  const D = DOSES[lvl];
  const scale = Math.min(1, Math.max(0.5, prog.doseScale || 1));
  const pick = (k) => (Array.isArray(D[k]) ? D[k][st] : D[k]);
  const reps = (k, min = 3) => (D[k] == null ? 0 : Math.max(min, Math.round(pick(k) * scale)));
  const secs = (k, min = 10) => (D[k] == null ? 0 : Math.max(min, Math.round(pick(k) * scale / 10) * 10)); // круглые числа: голосу так проще
  const flags = new Set(prog.flags || []);
  const exclude = new Set(prog.exclude || []);
  for (const [id, ex] of Object.entries(EXERCISES)) {
    if ((ex.avoid || []).some((f) => flags.has(f))) exclude.add(id);
    if (ex.min > lvl) exclude.add(id);
  }
  const noFloor = flags.has('no_floor');
  if (noFloor) Object.entries(EXERCISES).forEach(([id, ex]) => { if (ex.floor) exclude.add(id); });
  else ['march', 'tilt'].forEach((id) => exclude.add(id));
  return {
    level: lvl, stage: st + 1, noFloor,
    support: lvl === 1 || flags.has('balance'),
    chairHands: !!D.chairHands,
    gentleKnees: flags.has('knee') || flags.has('hip'),
    gentleBack: flags.has('lumbar_radicular') || flags.has('lumbar_acute') || flags.has('osteo'),
    exclude,
    stolbSec: Math.max(30, Math.round(pick('stolbSec') * scale / 15) * 15),
    chairReps: reps('chairReps'), wallReps: reps('wallReps'), bridgeReps: reps('bridgeReps'),
    birdReps: reps('birdReps', 2), bugReps: reps('bugReps', 2), marchReps: reps('marchReps', 6), tiltReps: reps('tiltReps', 6),
    walkMin: pick('walkMin'), skyReps: D.skyReps, qishiReps: D.qishiReps, shiftReps: D.shiftReps, unloadCycles: D.unloadCycles,
    // уровни 3–4
    legsReps: reps('legsReps'), lungeReps: reps('lungeReps', 3), pushReps: reps('pushReps'), plankSec: secs('plankSec'), sideSec: secs('sideSec'),
    calfReps: reps('calfReps', 6), stepReps: reps('stepReps', 2), stretchSec: D.stretchSec || 0, bdjReps: D.bdjReps || 0,
    // щадящие варианты движений цигун
    gentleNeck: flags.has('cervical'), noHeadDown: flags.has('hypertension') || flags.has('lumbar_radicular') || flags.has('osteo') || flags.has('heart'),
    gentleKneesDeep: flags.has('knee'), flags,
  };
}

// Все варианты плана — чтобы заранее озвучить все фразы.
export function allPlans() {
  const out = [];
  for (const level of [1, 2, 3, 4]) for (let stage = 1; stage <= 4; stage++) for (const flags of [[], ['no_floor'], ['balance', 'knee'], ['lumbar_radicular'], ['cervical', 'hypertension']]) {
    for (const doseScale of [0.6, 0.7, 0.8, 0.9, 1]) out.push(resolvePlan({ level, stage, flags, doseScale }));
  }
  return out;
}

// ---- решение перед занятием ----
export function checkinDecision(c) {
  const reasons = [];
  let mode = 'full';
  let key = 'full';
  const down = (m, k, why) => {
    const order = { full: 0, light: 1, rest: 2, none: 3 };
    if (order[m] > order[mode]) { mode = m; key = k; }
    reasons.push(why);
  };
  if (c.warning === 'chest' || c.warning === 'numb') down('none', 'stop_emergency', c.warning === 'chest' ? t('давление или боль в груди') : t('онемение или слабость'));
  const sys = Number(c.bp?.sys) || null;
  const dia = Number(c.bp?.dia) || null;
  if (sys && dia) {
    if (sys > 170 || dia > 105) down('none', 'stop_bp', `${t('давление')} ${sys}/${dia}`);
    else if (sys >= 150 || dia >= 95) down('light', 'light', `${t('давление')} ${sys}/${dia}`);
  }
  if (c.warning === 'dizzy') down('rest', 'rest', t('головокружение'));
  if (c.warning === 'new_pain') down('light', 'light', t('новая боль'));
  if (Number(c.pain) >= 8) down('rest', 'rest', `${t('боль')} ${c.pain} ${t('из 10')}`);
  else if (Number(c.pain) >= 6) down('light', 'light', `${t('боль')} ${c.pain} ${t('из 10')}`);
  if (c.muscles === 'joints') down('light', 'light', t('болят суставы'));
  if (c.muscles === 'sore') down('light', 'light', t('сильная крепатура'));
  if (Number(c.feel) <= 3) down('rest', 'rest', `${t('самочувствие')} ${c.feel} ${t('из 10')}`);
  else if (Number(c.feel) <= 5 && c.sleep === 'bad') down('light', 'light', t('плохой сон и слабое самочувствие'));
  return { mode, key, reasons };
}

// ---- статистика и готовность ----
function windowStats(from, days) {
  let sessions = 0; let stolb = 0; let chair = 0; const pain = []; let bpBad = 0; let quality = [];
  for (let i = 0; i < days; i++) {
    const d = peekDay(addDays(from, i));
    if (!d) continue;
    sessions += coreDone(addDays(from, i));
    stolb = Math.max(stolb, d.sessions?.morning?.stolbSec || 0);
    chair = Math.max(chair, d.sessions?.day?.chairReps || 0);
    if (d.pain?.back != null) pain.push(d.pain.back);
    if (d.checkin?.answers?.pain != null) pain.push(Number(d.checkin.answers.pain));
    if (d.checkin?.decision?.mode === 'none') bpBad++;
    if (d.sessions?.morning?.quality != null) quality.push(d.sessions.morning.quality);
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return { sessions, stolb, chair, pain: avg(pain), bpBad, quality: avg(quality) };
}

export function readiness(today = dateStr(), prog = state.program) {
  if (!prog?.level) return null;
  const lvl = prog.level;
  const target = PROGRESSION.level[lvl];
  const weeksOnLevel = Math.floor(daysBetween(prog.levelSince, today) / 7);
  const w1 = windowStats(addDays(today, -6), 7);
  const w2 = windowStats(addDays(today, -13), 7);
  const levelDef = LEVELS.find((l) => l.n === lvl);
  const crit = target ? [
    { id: 'time', ok: weeksOnLevel >= levelDef.minWeeks, text: `${t('Не меньше')} ${levelDef.minWeeks} ${t('недель на уровне')}`, have: `${weeksOnLevel} ${t('нед.')}` },
    { id: 'adherence', ok: w1.sessions >= target.weekSessions && w2.sessions >= target.weekSessions, text: `${t('Не меньше')} ${target.weekSessions} ${t('занятий в неделю две недели подряд')}`, have: `${w2.sessions} ${t('и')} ${w1.sessions}` },
    { id: 'stolb', ok: Math.max(w1.stolb, w2.stolb) >= target.stolbSec, text: `${t('Столб')} ${Math.round(target.stolbSec / 60 * 10) / 10} ${t('мин без боли')}`, have: `${Math.max(w1.stolb, w2.stolb)} ${t('сек')}` },
    { id: 'chair', ok: Math.max(w1.chair, w2.chair) >= target.chairReps, text: `${target.chairReps} ${t('вставаний со стула подряд')}`, have: `${Math.max(w1.chair, w2.chair)}` },
    { id: 'pain', ok: w1.pain == null || (w1.pain <= target.maxPain && (w2.pain == null || w1.pain <= w2.pain + 0.5)), text: `${t('Боль не выше')} ${target.maxPain} ${t('и не растёт')}`, have: w1.pain == null ? t('нет записей') : `${w1.pain.toFixed(1)}` },
    { id: 'bp', ok: w1.bpBad === 0 && w2.bpBad === 0, text: t('Две недели без отмен из-за давления'), have: `${w1.bpBad + w2.bpBad} ${t('отмен')}` },
  ] : [];
  const parts = {
    adherence: Math.min(1, (w1.sessions + w2.sessions) / (2 * (target?.weekSessions || 10))) * 30,
    stolb: target ? Math.min(1, Math.max(w1.stolb, w2.stolb) / target.stolbSec) * 20 : 0,
    chair: target ? Math.min(1, Math.max(w1.chair, w2.chair) / target.chairReps) * 20 : 0,
    pain: w1.pain == null ? 10 : Math.max(0, Math.min(1, (10 - w1.pain) / (10 - (target?.maxPain ?? 4)))) * 20,
    time: Math.min(1, weeksOnLevel / (levelDef?.minWeeks || 4)) * 10,
  };
  const score = Math.round(Object.values(parts).reduce((a, b) => a + b, 0));
  const ready = !!target && crit.every((c) => c.ok) && score >= 80;
  // Ступень внутри уровня: раз в неделю, если не было ухудшений.
  const daysOnStage = daysBetween(prog.stageSince || prog.levelSince, today);
  const stageUp = (prog.stage || 1) < 4 && daysOnStage >= PROGRESSION.stage.minDays && w1.sessions >= PROGRESSION.stage.minSessions
    && (w1.pain == null || w2.pain == null || w1.pain <= w2.pain + PROGRESSION.stage.maxPainRise);
  const regress = w1.pain != null && w2.pain != null && w1.pain >= w2.pain + PROGRESSION.regress.painRise;
  return { level: lvl, stage: prog.stage || 1, score, ready, crit, stageUp, regress, weeksOnLevel, last: w1, prev: w2, nextScripted: LEVELS.find((l) => l.n === lvl + 1)?.scripted !== false };
}

export function levelInfo(n) { return LEVELS.find((l) => l.n === n) || LEVELS[0]; }
