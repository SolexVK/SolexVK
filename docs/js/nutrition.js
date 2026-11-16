// Мастер-диетолог: норма калорий и БЖУ, распознавание еды по фото с уточняющими вопросами, итог дня, разбор недели.
// Нейросеть видит фото тарелки и ответы ученика; оценка по фото приблизительная, важен тренд за неделю.
import { state, save, dateStr, day, peekDay, addDays } from './store.js';
import { MODELS } from './ai-request.js';
import { callJSON } from './brain.js';
import { meilinSystem } from './meilin.js';
import { t, aiLanguage } from './i18n.js';

// ---- норма ----
export function latestWeight() {
  for (let i = 0; i < 60; i++) {
    const w = peekDay(addDays(dateStr(), -i))?.weight;
    if (w) return Number(w);
  }
  return Number(state.profile.startWeight || state.intake?.body?.weight || 0) || null;
}

// Средний вес за 7 дней: дневные колебания воды не пугают.
export function weightAvg(endDate = dateStr(), days = 7) {
  const v = [];
  for (let i = 0; i < days; i++) { const w = peekDay(addDays(endDate, -i))?.weight; if (w) v.push(Number(w)); }
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function targets() {
  const it = state.intake || {};
  const male = it.sex !== 'f';
  const age = Number(it.age || state.profile.age || 50);
  const h = Number(it.body?.height || state.profile.height || 175);
  const w = latestWeight() || 80;
  // Расход в покое (Миффлин — Сан Жеор) и за день при лёгкой активности (ходьба, тайцзи).
  const bmr = 10 * w + 6.25 * h - 5 * age + (male ? 5 : -161);
  const tdee = bmr * 1.3;
  // Дефицит около 20 %, но не ниже безопасного минимума.
  const floor = male ? 1500 : 1200;
  // Этап «поддержание и мышцы» (после достижения цели): без дефицита, белка больше.
  const keep = state.nutrition?.phase === 'maintain';
  const kcal = Math.max(floor, Math.round((tdee * (keep ? 1 : 0.8) + (state.nutrition?.adjust || 0)) / 10) * 10);
  // Белок и жир — на «скорректированный» вес: идеальный (ИМТ 25) плюс 40 % лишнего.
  const ideal = 25 * (h / 100) ** 2;
  const adj = w > ideal ? ideal + 0.4 * (w - ideal) : w;
  const protein = Math.round(adj * (keep ? 1.6 : 1.4));
  const fat = Math.round(Math.max(adj * 0.8, (kcal * 0.25) / 9));
  const carbs = Math.max(80, Math.round((kcal - protein * 4 - fat * 9) / 4));
  return { kcal, protein, fat, carbs, salt: 5, fiber: 30, bmr: Math.round(bmr), tdee: Math.round(tdee), weight: w };
}

// ---- приёмы пищи ----
const sum = (items, k) => Math.round(items.reduce((a, x) => a + (Number(x[k]) || 0), 0) * 10) / 10;
export function mealTotals(items) {
  return { kcal: Math.round(sum(items, 'kcal')), protein: sum(items, 'protein'), fat: sum(items, 'fat'), carbs: sum(items, 'carbs'), salt: sum(items, 'salt') };
}
export const dayMeals = (date = dateStr()) => (peekDay(date)?.meals || []).filter((m) => !m.deleted);
export function dayTotals(date = dateStr()) {
  return mealTotals(dayMeals(date).flatMap((m) => m.items));
}
export function saveMeal(meal, date = dateStr()) {
  const d = day(date);
  d.meals = d.meals || [];
  const i = d.meals.findIndex((m) => m.id === meal.id);
  if (i >= 0) d.meals[i] = meal; else d.meals.push(meal);
  // Маленькие фото храним 14 дней: память браузера ограничена, а цифры остаются навсегда.
  const cut = addDays(dateStr(), -14);
  for (const [dt, dd] of Object.entries(state.days)) if (dt < cut) for (const m of dd.meals || []) if (m.thumb) delete m.thumb;
  save();
}
// Удаление — пометкой: при синхронизации с другим устройством запись не воскреснет.
export function deleteMeal(id, date = dateStr()) {
  const m = day(date).meals?.find((x) => x.id === id);
  if (m) { m.deleted = true; m.items = []; save(); }
}
// Изменили вес порции — пересчитываем блюдо пропорционально.
export function scaleItem(item, grams) {
  const g0 = Number(item.grams) || 0;
  const g = Math.max(0, Number(grams) || 0);
  if (!g0) return { ...item, grams: g };
  const k = g / g0;
  const r = (v) => Math.round((Number(v) || 0) * k * 10) / 10;
  return { ...item, grams: g, kcal: Math.round((Number(item.kcal) || 0) * k), protein: r(item.protein), fat: r(item.fat), carbs: r(item.carbs), salt: r(item.salt) };
}

// ---- нейросеть ----
const ITEM = {
  type: 'object', additionalProperties: false, required: ['name', 'grams', 'kcal', 'protein', 'fat', 'carbs', 'salt'],
  properties: { name: { type: 'string' }, grams: { type: 'number' }, kcal: { type: 'number' }, protein: { type: 'number' }, fat: { type: 'number' }, carbs: { type: 'number' }, salt: { type: 'number' } },
};
const STEP1 = {
  type: 'object', additionalProperties: false, required: ['title', 'items', 'questions'],
  properties: {
    title: { type: 'string' },
    items: { type: 'array', items: ITEM },
    questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'text', 'options'], properties: { id: { type: 'string' }, text: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } } } },
  },
};
const STEP2 = {
  type: 'object', additionalProperties: false, required: ['title', 'items', 'confidence', 'advice'],
  properties: { title: { type: 'string' }, items: { type: 'array', items: ITEM }, confidence: { type: 'string', enum: ['low', 'medium', 'high'] }, advice: { type: 'string' } },
};

function persona() {
  return meilinSystem();
}

function userContent(photo, text) {
  const parts = [];
  if (photo) parts.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo } });
  parts.push({ type: 'text', text });
  return parts;
}

// Шаг 1: что на тарелке и что уточнить.
export async function analyzeMeal({ photo, text }) {
  return callJSON({
    model: MODELS.expert, effort: 'low', schema: STEP1, maxTokens: 3000,
    system: persona(),
    messages: [{ role: 'user', content: userContent(photo, `${photo ? 'На фото — моя еда.' : 'Опишу, что я съел.'}${text ? ` Пояснение: ${text}` : ''}

Определи блюда и примерный вес порции каждого в граммах, по каждому — калории, белки, жиры, углеводы и соль (г). title — короткое название приёма пищи. Затем задай от одного до трёх самых важных уточняющих вопросов, которые сильнее всего меняют оценку (размер порции, масло и соус, жирность, напиток, хлеб, что не видно на фото). У каждого вопроса — 2–4 коротких варианта ответа. Если всё ясно, вопросов может не быть.`) }],
  });
}

// Шаг 2: окончательная оценка с учётом ответов и совет на остаток дня.
export async function finishMeal({ photo, text, first, answers }) {
  const qa = (first.questions || []).map((q) => `${q.text} — ${answers[q.id] || 'не знаю'}`).join('\n');
  return callJSON({
    model: MODELS.expert, effort: 'low', schema: STEP2, maxTokens: 3000,
    system: persona(),
    messages: [
      { role: 'user', content: userContent(photo, `${photo ? 'На фото — моя еда.' : 'Опишу, что я съел.'}${text ? ` Пояснение: ${text}` : ''}`) },
      { role: 'assistant', content: JSON.stringify({ title: first.title, items: first.items, questions: first.questions }) },
      { role: 'user', content: `Ответы на уточнения:\n${qa || '(без уточнений)'}\n\nДай окончательную оценку: блюда с весом, калориями, белками, жирами, углеводами и солью. confidence — насколько уверена оценка. advice — 1–2 фразы диетолога: как этот приём вписывается в норму дня и что добрать или ограничить до конца дня.` },
    ],
  });
}

// Разбор недели: тренд веса и питание → поправка нормы (не больше ±150 ккал за раз).
const WEEK = {
  type: 'object', additionalProperties: false, required: ['say', 'adjust'],
  properties: { say: { type: 'string' }, adjust: { type: 'integer', enum: [-150, -100, 0, 100, 150] } },
};
export function weekStats(today = dateStr()) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, -i);
    const m = dayMeals(d);
    if (m.length) days.push({ date: d, ...dayTotals(d) });
  }
  const avg = (k) => (days.length ? Math.round(days.reduce((a, x) => a + x[k], 0) / days.length) : null);
  const w1 = weightAvg(today);
  const w0 = weightAvg(addDays(today, -7));
  return { daysLogged: days.length, kcal: avg('kcal'), protein: avg('protein'), fat: avg('fat'), carbs: avg('carbs'), salt: avg('salt'), w1, w0, change: w1 && w0 ? Math.round((w1 - w0) * 10) / 10 : null };
}
export async function weekReview() {
  const s = weekStats();
  const T = targets();
  const out = await callJSON({
    model: MODELS.expert, effort: 'medium', schema: WEEK, maxTokens: 3000,
    system: persona(),
    messages: [{ role: 'user', content: `Разбор недели питания. Дней с записями: ${s.daysLogged} из 7. В среднем в день: ${s.kcal ?? '—'} ккал, белок ${s.protein ?? '—'} г, жиры ${s.fat ?? '—'} г, углеводы ${s.carbs ?? '—'} г, соль ${s.salt ?? '—'} г. Средний вес за неделю: ${s.w1 ? s.w1.toFixed(1) : 'нет данных'} кг, неделей раньше: ${s.w0 ? s.w0.toFixed(1) : 'нет данных'} кг. Норма сейчас: ${T.kcal} ккал, белок ${T.protein} г.

Цель — терять 0,5–0,8 кг в неделю (не больше 1 % веса), сохраняя мышцы. say — обращение к ученику, 3–5 фраз: что получается, главное, что поправить на следующей неделе (конкретно, по продуктам). adjust — поправка дневной нормы калорий: минус, если вес стоит две недели при честных записях; плюс, если вес уходит быстрее 1 % в неделю или ученик голоден и слаб; 0 — если всё идёт как надо или данных мало.` }],
  });
  const adjust = Math.max(-300, Math.min(300, (state.nutrition?.adjust || 0) + (Number(out.adjust) || 0)));
  state.nutrition = { ...(state.nutrition || {}), adjust, lastReview: dateStr(), lastSay: String(out.say || '') };
  save();
  return { ...out, stats: s, target: targets() };
}

// Уменьшаем фото перед отправкой: 1024 px по длинной стороне, JPEG.
export function shrinkPhoto(file, max = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const data = c.toDataURL('image/jpeg', 0.8);
      // Маленькая копия для дневника — 160 px.
      const s = Math.min(1, 160 / Math.max(c.width, c.height));
      const c2 = document.createElement('canvas');
      c2.width = Math.round(c.width * s);
      c2.height = Math.round(c.height * s);
      c2.getContext('2d').drawImage(c, 0, 0, c2.width, c2.height);
      resolve({ base64: data.split(',')[1], thumb: c2.toDataURL('image/jpeg', 0.6) });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}

export const newMealId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
