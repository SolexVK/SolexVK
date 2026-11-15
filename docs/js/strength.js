// Ли Ган — наставник по силовым тренировкам. Резинки-эспандеры и вес тела, 2 раза в неделю.
// Этапы: «Подготовка» (до разрешения врача, легко–умеренно) → «Основа» → «Сила». Переход — по критериям.
// После каждого упражнения ученик оценивает: легко / в самый раз / тяжело / больно — от этого зависит нагрузка дальше.
import { state, save, dateStr, peekDay, addDays, daysBetween } from './store.js';
import { say, cycle, step, count, breathing, gap } from './course.js';

export const VOICE = 'ligan';
export const PHASES = {
  prep: { name: 'Подготовка', sets: 2, rest: 60, minReps: 10, maxReps: 12, maxBand: 2 },
  base: { name: 'Основа', sets: 3, rest: 75, minReps: 10, maxReps: 14, maxBand: 3 },
  power: { name: 'Сила', sets: 3, rest: 90, minReps: 8, maxReps: 12, maxBand: 4 },
};
const BAND_SAY = { 1: 'Возьмите самую лёгкую резинку.', 2: 'Возьмите резинку средней жёсткости.', 3: 'Возьмите тугую резинку.', 4: 'Возьмите самую тугую резинку.' };
export const BAND_NAME = { 1: 'лёгкая', 2: 'средняя', 3: 'тугая', 4: 'очень тугая' };
const SET_SAY = ['Подход первый.', 'Подход второй.', 'Подход третий.'];

export function st() {
  if (!state.strength) state.strength = { phase: 'prep', since: dateStr(), doctorOk: false, days: [2, 5], bands: [1, 2, 3], ex: {}, log: [] };
  return state.strength;
}
export const phaseDef = () => PHASES[st().phase] || PHASES.prep;

// Упражнения: id, название, описание, слова при выполнении, нужен ли пол.
export const LIGAN_EX = [
  { id: 'band_row', title: 'Тяга резинки к поясу сидя', band: true,
    text: 'Сидя на краю стула, ноги вперёд, резинка через стопы. Тянем локти назад вдоль тела, лопатки сводим. Спина прямая.',
    intro: ['Тяга резинки к поясу. Сядьте на край стула, ноги вытяните вперёд, резинку заведите за стопы.', 'Спина прямая, плечи опущены. На выдохе тянем локти назад вдоль тела и сводим лопатки. На вдохе медленно возвращаем.'],
    phases: [['Тянем.', 2, 'out'], ['Возвращаем.', 3, 'in']] },
  { id: 'band_press', title: 'Жим резинки от груди', band: true,
    text: 'Стоя, резинка за спиной на уровне лопаток, концы в руках у груди. Выжимаем руки вперёд и медленно возвращаем.',
    intro: ['Жим резинки от груди. Заведите резинку за спину на уровне лопаток, концы держите у груди.', 'Стойка устойчивая, колени мягкие. На выдохе выжимаем руки вперёд, на вдохе медленно возвращаем. Плечи не поднимаем.'],
    phases: [['Жмём.', 2, 'out'], ['Возвращаем.', 3, 'in']] },
  { id: 'band_pullapart', title: 'Разведение рук с резинкой', band: true,
    text: 'Руки перед грудью, резинка между ладонями. Разводим руки в стороны, сводим лопатки. Плечи опущены, шея свободна.',
    intro: ['Разведение рук с резинкой. Руки вытяните перед грудью, резинку держите хватом сверху.', 'На выдохе разводим руки в стороны и сводим лопатки. На вдохе медленно возвращаем. Плечи к ушам не поднимаем.'],
    phases: [['Разводим.', 2, 'out'], ['Возвращаем.', 3, 'in']] },
  { id: 'band_curl', title: 'Сгибание рук с резинкой', band: true,
    text: 'Стоя на резинке, локти прижаты к бокам. Сгибаем руки к плечам и медленно опускаем. Корпус не раскачиваем.',
    intro: ['Сгибание рук. Встаньте на середину резинки, концы в руках, ладони вперёд.', 'Локти прижаты к бокам. На выдохе сгибаем руки к плечам, на вдохе медленно опускаем. Корпус не раскачиваем.'],
    phases: [['Сгибаем.', 2, 'out'], ['Опускаем.', 3, 'in']] },
  { id: 'band_squat', title: 'Присед к стулу с резинкой над коленями', band: true,
    text: 'Резинка чуть выше коленей, стул позади. Садимся до касания стула, колени давят наружу на резинку. Встаём на выдохе.',
    intro: ['Присед к стулу. Наденьте резинку чуть выше коленей, стул позади.', 'На вдохе садимся до касания стула, колени давят наружу на резинку. На выдохе встаём, опираясь на пятки. Спина прямая.'],
    phases: [['Садимся.', 3, 'in'], ['Встаём.', 2, 'out']] },
  { id: 'band_bridge', title: 'Мост с резинкой над коленями', band: true, floor: true,
    text: 'Лёжа на спине, резинка над коленями. Поднимаем таз, колени давят наружу. Поясницу не прогибаем.',
    intro: ['Мост с резинкой. Лягте на спину через бок, резинку наденьте над коленями, стопы на ширине таза.', 'На выдохе поднимаем таз, колени давят наружу на резинку. Поясницу не прогибаем. На вдохе медленно опускаемся.'],
    phases: [['Вверх.', 2, 'out'], ['Вниз.', 3, 'in']] },
  { id: 'band_sidestep', title: 'Шаги в сторону с резинкой', band: true,
    text: 'Резинка над коленями, колени чуть согнуты. Небольшие шаги в сторону, натяжение не отпускаем. Корпус ровный.',
    intro: ['Шаги в сторону. Резинка над коленями, колени чуть согнуты, руки на поясе.', 'Делаем небольшие шаги вправо, натяжение резинки не отпускаем. Затем столько же влево. Корпус не раскачиваем.'],
    phases: [['Шаг.', 1.6, null]] },
  { id: 'pallof', title: 'Паллоф-пресс', band: true,
    text: 'Резинка закреплена на ручке закрытой двери сбоку. Выжимаем руки от груди вперёд и держим — корпус не даёт резинке себя повернуть.',
    intro: ['Паллоф-пресс. Закрепите резинку на ручке закрытой двери и встаньте боком к ней.', 'Руки у груди, колени мягкие. На выдохе выжимаем руки вперёд и задерживаемся. Корпус не поворачивается. На вдохе возвращаем руки к груди.', 'Пресс работает без скручиваний — так поясница в безопасности.'],
    phases: [['Вперёд.', 2, 'out'], ['Держим.', 2, null], ['К груди.', 2, 'in']] },
];

// Нагрузка упражнения сейчас: повторы и резинка.
export function exLoad(id) {
  const P = phaseDef();
  const e = st().ex[id] || {};
  const owned = st().bands?.length ? Math.max(...st().bands) : 2;
  return { reps: Math.min(P.maxReps, Math.max(P.minReps, e.reps || P.minReps)), band: Math.min(P.maxBand, owned, Math.max(1, e.band || 1)), sets: P.sets };
}

// Занятие «Сила». p — план мастера Лао (ограничения, без пола), mode — режим дня.
export function buildStrength(p) {
  const P = phaseDef();
  const steps = [];
  steps.push(step({ id: 'lg_hello', kind: 'talk', title: 'Сила с Ли Ганом', text: 'Резинки и вес тела. Выдох на усилии, дыхание не задерживаем.',
    items: say('Здравствуйте. Я Ли Ган, ваш наставник по силе.', 'Сегодня работаем с резинками и весом тела. Выдох на усилии, дыхание не задерживаем. Боль — сразу стоп.') }));
  // Разминка
  steps.push(step({ id: 'walk', title: 'Шаги на месте', group: 'Разминка', kind: 'hold', dur: 60,
    text: 'Спокойные шаги на месте, руки двигаются свободно.',
    items: [say('Разминка. Шагаем на месте, руки двигаются свободно.'), { t: 'hold', dur: 60, cues: [{ at: 30, text: 'Дышим свободно.' }] }] }));
  steps.push(step({ id: 'shoulders', title: 'Плечи', group: 'Разминка',
    text: 'Круги плечами назад и вперёд.',
    items: [say('Круги плечами назад.'), count(8, 2.4), say('Теперь вперёд.'), count(8, 2.4)] }));
  steps.push(step({ id: 'pelvis', title: 'Таз', group: 'Разминка',
    text: 'Небольшие круги тазом, руки на поясе.',
    items: [say('Руки на пояс, небольшие круги тазом.'), count(8, 2.6)] }));
  // Основные упражнения
  for (const ex of LIGAN_EX) {
    if (ex.floor && p?.noFloor) continue;
    if (p?.exclude?.has?.(ex.id)) continue;
    const L = exLoad(ex.id);
    const items = [say(...ex.intro, BAND_SAY[L.band])];
    for (let s = 0; s < L.sets; s++) {
      items.push(say(s === L.sets - 1 && L.sets > 1 ? 'Последний подход.' : SET_SAY[s]));
      items.push(cycle(L.reps, ex.phases.map(([w, dur, breath], k) => ({ first: w, say: w, dur, breath: breath || undefined, numbered: k === 0 })), 0));
      if (s < L.sets - 1) items.push(say('Отдых. Дышим спокойно.'), { t: 'hold', dur: P.rest, cues: [{ at: P.rest - 10, text: 'Готовимся к следующему подходу.' }] });
    }
    steps.push(step({ id: ex.id, title: ex.title, group: 'Сила', text: ex.text, rate: true, items }));
  }
  // Заминка
  steps.push(step({ id: 'hip_stretch', title: 'Растяжка передней поверхности бедра', group: 'Заминка',
    text: 'Шаг назад, таз подкручен и мягко смещается вперёд. Корпус вертикальный.',
    items: [say('Заминка. Растяжка передней поверхности бедра. Шаг назад, таз подкрутите и мягко сместите вперёд.'), { t: 'hold', dur: 30, cues: [] }, say('Смените ногу.'), gap(5, 'смена стороны'), { t: 'hold', dur: 30, cues: [] }] }));
  steps.push(step({ id: 'breath', title: 'Дыхание', group: 'Заминка', kind: 'breath',
    text: 'Ладони на живот, спокойное дыхание: вдох на 4, выдох на 6.',
    items: [say('Ладони на живот. Спокойно дышим: вдох на четыре, выдох на шесть.'), breathing(5, 4, 6)] }));
  steps.push(step({ id: 'end', kind: 'talk', title: 'Занятие окончено', text: 'Отметьте самочувствие в дневнике.',
    items: say('Отличная работа. Выпейте воды. Мышцы растут во время отдыха, следующее силовое — через день или два.') }));
  return { kind: 'strength', voice: VOICE, level: 0, stage: 0, mode: 'full', steps };
}

// ---- оценки и прогрессия ----
// Оценка после упражнения: easy, ok, hard, pain.
export function applyRatings(ratings) {
  const S = st();
  const P = phaseDef();
  const today = dateStr();
  for (const [id, r] of Object.entries(ratings)) {
    const e = S.ex[id] || (S.ex[id] = { reps: P.minReps, band: 1, hist: [] });
    e.hist = [...(e.hist || []), { date: today, r }].slice(-12);
    const last2 = e.hist.slice(-2).map((h) => h.r);
    if (r === 'pain') {
      // Больно: облегчаем сразу и запоминаем.
      e.reps = Math.max(P.minReps, (e.reps || P.minReps) - 2);
      if ((e.band || 1) > 1) e.band -= 1;
      e.painAt = today;
    } else if (r === 'hard') {
      if ((e.reps || P.minReps) > P.minReps) e.reps -= 2; else if ((e.band || 1) > 1) { e.band -= 1; e.reps = P.maxReps - 2; }
    } else if (r === 'easy' && last2.length === 2 && last2.every((x) => x === 'easy')) {
      // Два раза подряд легко: сначала повторы, на верхней границе — резинка туже.
      const owned = S.bands?.length ? Math.max(...S.bands) : 2;
      if ((e.reps || P.minReps) < P.maxReps) e.reps = Math.min(P.maxReps, (e.reps || P.minReps) + 2);
      else if ((e.band || 1) < Math.min(P.maxBand, owned)) { e.band = (e.band || 1) + 1; e.reps = P.minReps; }
    }
  }
  S.log = [...(S.log || []), { date: today, ratings }].slice(-60);
  save();
}

// ---- этапы ----
export function sessionsSince(date) { return (st().log || []).filter((l) => l.date >= date).length; }
export function phaseCriteria() {
  const S = st();
  const pain = [];
  for (let i = 0; i < 14; i++) { const d = peekDay(addDays(dateStr(), -i)); const v = d?.checkin?.answers?.pain ?? d?.pain?.back; if (v != null) pain.push(Number(v)); }
  const avgPain = pain.length ? pain.reduce((a, b) => a + b, 0) / pain.length : null;
  const recentPain = (S.log || []).slice(-4).some((l) => Object.values(l.ratings || {}).includes('pain'));
  const n = sessionsSince(S.since);
  const weeks = Math.floor(daysBetween(S.since, dateStr()) / 7);
  if (S.phase === 'prep') {
    return { next: 'base', crit: [
      { ok: !!S.doctorOk, text: 'Врач разрешил силовые нагрузки' },
      { ok: n >= 6, text: 'Не меньше 6 занятий на этапе', have: `${n}` },
      { ok: avgPain == null || avgPain <= 3, text: 'Боль в спине не выше 3 из 10 за две недели', have: avgPain == null ? '—' : avgPain.toFixed(1) },
      { ok: !recentPain, text: 'Последние 4 занятия без оценки «больно»' },
    ] };
  }
  if (S.phase === 'base') {
    return { next: 'power', crit: [
      { ok: weeks >= 8, text: 'Не меньше 8 недель на этапе', have: `${weeks}` },
      { ok: n >= 14, text: 'Не меньше 14 занятий', have: `${n}` },
      { ok: avgPain == null || avgPain <= 3, text: 'Боль не выше 3 из 10', have: avgPain == null ? '—' : avgPain.toFixed(1) },
      { ok: !recentPain, text: 'Без оценки «больно» в последних занятиях' },
    ] };
  }
  return { next: null, crit: [] };
}
export function nextPhase() {
  const c = phaseCriteria();
  if (!c.next || !c.crit.every((x) => x.ok)) return false;
  const S = st();
  S.phase = c.next;
  S.since = dateStr();
  save();
  return true;
}

// Сегодня день силовой? Только если утро не облегчено из-за давления или самочувствия.
export function strengthToday(date = dateStr()) {
  const S = st();
  const dow = new Date(`${date}T12:00:00`).getDay(); // 0 — воскресенье
  const planned = (S.days || []).includes(dow);
  const mode = peekDay(date)?.checkin?.decision?.mode;
  const done = !!peekDay(date)?.sessions?.strength?.done;
  return { planned, blocked: mode && mode !== 'full', done };
}

// Все фразы Ли Гана — для озвучки.
export function liganTexts() {
  const set = new Set();
  const saved = state.strength;
  for (const ph of Object.keys(PHASES)) {
    state.strength = { phase: ph, since: dateStr(), bands: [1, 2, 3, 4], ex: {}, log: [] };
    for (const b of [1, 2, 3, 4]) {
      for (const ex of LIGAN_EX) state.strength.ex[ex.id] = { reps: 0, band: b };
      for (const reps of [8, 10, 12, 14]) {
        for (const ex of LIGAN_EX) state.strength.ex[ex.id].reps = reps;
        for (const s of buildStrength({ noFloor: false }).steps) for (const it of s.items) { if (it.text) set.add(it.text); for (const c of it.cues || []) set.add(c.text); }
      }
    }
  }
  state.strength = saved;
  return [...set];
}
