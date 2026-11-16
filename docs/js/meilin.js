// Мэйлин — персональный агент по питанию.
// Устройство:
//   1. Досье (meilinDossier): всё, что нужно нутрициологу, собрано из общей базы приложения — тело и его тренды,
//      здоровье и лекарства (от доктора Шэна), нагрузка (Лао и Ли Ган), еда за сегодня и за недели,
//      меню, покупки, продукты дома, вкусы и память Мэйлин.
//   2. Методика (meilin-kb.js) — одинаковая во всех её обращениях: чат, фото еды, меню, замены, разбор недели.
//   3. Чат-агент (meilinChat): отвечает и предлагает действия — записать еду, заменить блюдо, поправить покупки,
//      составить новое меню. Действия выполняются по кнопке ученика. Новые факты о вкусах и привычках
//      Мэйлин запоминает сама (state.nutrition.facts), ученик видит и может удалить их во вкладке «Питание».
//   4. Сводка для команды (meilinBrief) — что другие мастера знают о питании.
import { state, save, dateStr, addDays, peekDay, daysBetween } from './store.js';
import { MODELS } from './ai-request.js';
import { callJSON } from './brain.js';
import { aiLanguage } from './i18n.js';
import { MEILIN_ROLE, MEILIN_METHOD } from './meilin-kb.js';
import { targets, dayMeals, dayTotals, weightAvg, latestWeight, saveMeal, newMealId } from './nutrition.js';
import { GROUPS, pantry, menu, menuDay, makeMenu, replaceMeal, phase } from './menu.js';

const r1 = (x) => Math.round(Number(x) * 10) / 10;
const SLOT = { breakfast: 'завтрак', lunch: 'обед', dinner: 'ужин', snack: 'перекус' };
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const dow = (ds) => new Date(`${ds}T12:00:00`).getDay();

export const facts = () => state.nutrition?.facts || [];
export function addFacts(list) {
  const n = state.nutrition || (state.nutrition = {});
  const cur = n.facts || [];
  for (const f of list || []) {
    const s = String(f || '').trim();
    if (s && s.length < 300 && !cur.some((x) => x.text.toLowerCase() === s.toLowerCase())) cur.push({ text: s, at: dateStr() });
  }
  n.facts = cur.slice(-40);
}
export function dropFact(i) {
  const n = state.nutrition;
  if (!n?.facts) return;
  n.facts.splice(i, 1);
  save();
}

// ---- досье ----
function bodyBlock() {
  const it = state.intake || {};
  const T = targets();
  const today = dateStr();
  const w = latestWeight();
  const w7 = weightAvg(today);
  const w14 = weightAvg(addDays(today, -7));
  const w28 = weightAvg(addDays(today, -21));
  const start = Number(state.profile.startWeight || it.body?.weight) || null;
  const h = Number(it.body?.height || state.profile.height) || null;
  const waist = [];
  for (let i = 0; i < 60; i++) { const d = peekDay(addDays(today, -i)); if (d?.waist) waist.push(`${addDays(today, -i)}: ${d.waist}`); if (waist.length >= 4) break; }
  return [
    `Пол ${it.sex === 'f' ? 'женский' : 'мужской'}, ${it.age || state.profile.age || '?'} лет, рост ${h || '?'} см.`,
    `Вес: последний ${w || '?'} кг; в начале ${start || '?'} кг; средний за 7 дней ${w7 ? r1(w7) : '—'}, неделей раньше ${w14 ? r1(w14) : '—'}, три недели назад ${w28 ? r1(w28) : '—'}.${h && w ? ` ИМТ ${r1(w / (h / 100) ** 2)}.` : ''}`,
    `Талия: ${waist.join('; ') || (it.waist ? `в анкете ${it.waist} см` : 'нет измерений')}.`,
    `Расчёт: основной обмен ${T.bmr} ккал, расход ${T.tdee} ккал. Норма сейчас: ${T.kcal} ккал (ручная поправка ${state.nutrition?.adjust || 0}), белок ${T.protein} г, жиры ${T.fat} г, углеводы ${T.carbs} г, соль до ${T.salt} г, клетчатка ${T.fiber} г.`,
    `Этап питания: ${phase() === 'maintain' ? 'поддержание веса и рост мышц' : 'похудение с сохранением мышц, уменьшение висцерального жира'}.`,
    `Цели ученика из анкеты: ${(it.goals || []).join(', ') || 'похудеть, убрать висцеральный жир, нарастить мышцы, здоровье и долголетие'}.`,
  ].join('\n');
}

function healthBlock() {
  const it = state.intake || {};
  const pr = state.program || {};
  const today = dateStr();
  const bp = [];
  for (let i = 0; i < 14; i++) { const b = peekDay(addDays(today, -i))?.bp; if (b?.sys) bp.push(b); }
  const avg = (k) => Math.round(bp.reduce((a, b) => a + Number(b[k]), 0) / bp.length);
  const h = state.health || {};
  const lines = [
    `Диагнозы из анкеты: ${(it.diagnoses || []).join(', ') || 'нет'}; обычное давление: ${it.bp || '?'}. Ограничения программы: ${(pr.flags || []).join(', ') || 'нет'}.`,
    bp.length ? `Давление за 14 дней: среднее ${avg('sys')}/${avg('dia')} по ${bp.length} измерениям, последнее ${bp[0].sys}/${bp[0].dia}.` : 'Давление за 14 дней не записывали.',
  ];
  if (h.meds?.length) lines.push(`Лекарства: ${h.meds.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''}${m.when ? ` (${m.when})` : ''}`).join('; ')}.`);
  else lines.push('Лекарства в приложение не внесены.');
  const labs = (h.labs || []).slice(-25);
  if (labs.length) lines.push(`Анализы: ${labs.map((l) => `${l.date} ${l.name} ${l.value}${l.unit ? ` ${l.unit}` : ''}${l.ref ? ` (норма ${l.ref})` : ''}`).join('; ')}.`);
  if (h.notes) lines.push(`Заметки доктора Шэна: ${h.notes}`);
  return lines.join('\n');
}

function activityBlock() {
  const today = dateStr();
  const rows = [];
  let steps = 0; let stepDays = 0;
  for (let i = 6; i >= 0; i--) {
    const ds = addDays(today, -i);
    const d = peekDay(ds);
    if (d?.steps) { steps += Number(d.steps); stepDays++; }
    const done = Object.entries(d?.sessions || {}).filter(([, v]) => v.done).map(([k, v]) => `${{ morning: 'утро', day: 'день', evening: 'вечер', strength: 'силовое' }[k] || k}${v.durSec ? ` ${Math.round(v.durSec / 60)} мин` : ''}`);
    rows.push(`${ds} (${WD[dow(ds)]}): ${done.join(', ') || 'занятий нет'}${d?.checkin?.decision ? `; решение Лао: ${d.checkin.decision.mode}` : ''}`);
  }
  const S = state.strength;
  const td = peekDay(today)?.checkin?.decision;
  return [
    `Тайцзи и цигун с Лао: уровень ${state.program?.level || '?'}, три коротких занятия в день. Сегодня: ${td ? `режим «${td.mode}»` : 'опрос самочувствия ещё не проходили'}.`,
    S ? `Силовые с Ли Ганом: дни ${S.days.map((x) => WD[x]).join(', ')}, этап ${S.phase}, врач разрешил силовые: ${S.doctorOk ? 'да' : 'пока нет'}. Сегодня силовое ${S.days.includes(dow(today)) ? 'по плану' : 'не по плану'}.` : 'Силовые пока не начинали.',
    `Шаги: ${stepDays ? `в среднем ${Math.round(steps / stepDays)} в день за ${stepDays} дн.` : 'не записывают'}.`,
    `Последние 7 дней:\n${rows.join('\n')}`,
  ].join('\n');
}

function foodBlock() {
  const today = dateStr();
  const T = targets();
  const meals = dayMeals(today);
  const e = dayTotals(today);
  const lines = [`Сейчас ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.`];
  lines.push(meals.length
    ? `Съедено сегодня: ${meals.map((m) => `${new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} «${m.title}» (${m.items.map((x) => `${x.name} ${x.grams || '?'} г`).join(', ')}) ${Math.round(m.items.reduce((a, x) => a + (Number(x.kcal) || 0), 0))} ккал`).join('; ')}. Итого ${e.kcal} ккал, белок ${r1(e.protein)}, жиры ${r1(e.fat)}, углеводы ${r1(e.carbs)}, соль ${r1(e.salt)} г. Осталось до нормы: ${T.kcal - e.kcal} ккал, белка ${Math.round(T.protein - e.protein)} г.`
    : 'Сегодня еду ещё не записывали.');
  const rows = [];
  let n = 0; const sum = { kcal: 0, protein: 0, salt: 0 };
  for (let i = 1; i <= 28; i++) {
    const ds = addDays(today, -i);
    const m = dayMeals(ds);
    if (!m.length) continue;
    const t = dayTotals(ds);
    n++; sum.kcal += t.kcal; sum.protein += t.protein; sum.salt += t.salt;
    if (i <= 14) rows.push(`${ds}: ${t.kcal} ккал, Б ${Math.round(t.protein)}, Ж ${Math.round(t.fat)}, У ${Math.round(t.carbs)}, соль ${r1(t.salt)} — ${m.map((x) => x.title).join(', ')}`);
  }
  lines.push(rows.length ? `Дневник еды за 14 дней:\n${rows.join('\n')}` : 'За прошлые 14 дней записей еды нет.');
  if (n) lines.push(`За 4 недели записей ${n} дней из 28; в среднем ${Math.round(sum.kcal / n)} ккал, белок ${Math.round(sum.protein / n)} г, соль ${r1(sum.salt / n)} г.`);
  if (state.nutrition?.lastSay) lines.push(`Твой последний разбор недели (${state.nutrition.lastReview}): ${state.nutrition.lastSay}`);
  return lines.join('\n');
}

function planBlock() {
  const m = menu();
  const P = pantry();
  const lines = [];
  if (m) {
    const di = menuDay();
    const age = daysBetween(m.start, dateStr());
    lines.push(`Меню на неделю составлено тобой ${m.start} (норма тогда ${m.kcal} ккал, белок ${m.protein} г)${age >= 7 ? ', неделя закончилась — пора составить новое' : `, сегодня день ${di + 1} из 7`}. Нумерация дней в действиях: 0 — первый день меню.`);
    m.days.forEach((d, i) => {
      const ds = addDays(m.start, i);
      const eaten = new Set(Object.values(state.days || {}).flatMap((x) => (x.meals || []).filter((y) => !y.deleted && y.fromMenu?.startsWith(`${m.start}:${i}:`)).map((y) => y.fromMenu.split(':')[2])));
      lines.push(`День ${i} (${ds}, ${WD[dow(ds)]})${i === di ? ' — СЕГОДНЯ' : ''}: ${d.meals.map((x, mi) => `${SLOT[x.slot] || x.slot} «${x.name}» ${Math.round(x.kcal)} ккал, Б ${Math.round(x.protein)}${i === di || i === di + 1 ? ` [${x.ingredients.map((g) => `${g.name} ${g.grams} г`).join(', ')}]` : ''}${eaten.has(String(mi)) ? ' (отмечено съеденным)' : ''}`).join('; ')}`);
    });
    const bought = m.bought || {};
    lines.push(`Список покупок: ${m.shopping.map((g) => `${g.group}: ${g.items.map((x) => `${x}${bought[x] ? ' (куплено)' : ''}`).join(', ')}`).join(' | ')}`);
    if (m.prep?.length) lines.push(`Заготовки: ${m.prep.join(' ')}`);
  } else {
    lines.push('Меню на неделю ещё не составлено.');
  }
  if (P) {
    lines.push(`Продукты, которые ученик ест и покупает (${P.updatedAt}): ${GROUPS.filter((g) => !g.negative && g.id !== 'kitchen').map((g) => `${g.title}: ${(P.groups?.[g.id] || []).join(', ') || '—'}`).join('; ')}.`);
    lines.push(`Не ест: ${[...(P.groups?.avoid || []), P.notes?.avoid || ''].filter(Boolean).join(', ') || 'нет ограничений'}. Кухня и время: ${(P.groups?.kitchen || []).join(', ') || 'не указано'}.`);
  } else lines.push('Список продуктов ученик ещё не составлял.');
  const n = state.nutrition || {};
  if (n.likes?.length) lines.push(`Понравились блюда: ${n.likes.slice(-15).join(', ')}.`);
  if (n.dislikes?.length) lines.push(`Не понравились: ${n.dislikes.slice(-15).join(', ')}.`);
  return lines.join('\n');
}

export function meilinDossier() {
  const f = facts();
  return `[Тело и цели]\n${bodyBlock()}

[Здоровье — от доктора Шэна и анкеты]\n${healthBlock()}

[Нагрузка — от Лао и Ли Гана]\n${activityBlock()}

[Питание]\n${foodBlock()}

[План: меню, покупки, продукты]\n${planBlock()}

[Что ты помнишь об ученике]\n${f.length ? f.map((x) => `- ${x.text}`).join('\n') : 'Пока ничего: узнавай привычки, режим дня, вкусы, бюджет, кто готовит, где ест — и запоминай.'}`;
}

// Полная системная подсказка Мэйлин: роль, методика, досье. extra — команда и безопасность из team.js.
export function meilinSystem(extra = '') {
  return `${MEILIN_ROLE}\n\n${MEILIN_METHOD}\n\nПиши на ${aiLanguage()} языке, обращайся на «вы».\n\n${extra}\n\n${meilinDossier()}`;
}

// ---- чат-агент ----
const ITEM = {
  type: 'object', additionalProperties: false, required: ['name', 'grams', 'kcal', 'protein', 'fat', 'carbs', 'salt'],
  properties: { name: { type: 'string' }, grams: { type: 'number' }, kcal: { type: 'number' }, protein: { type: 'number' }, fat: { type: 'number' }, carbs: { type: 'number' }, salt: { type: 'number' } },
};
const ACTION = {
  type: 'object', additionalProperties: false, required: ['type', 'label', 'day', 'slot', 'text', 'group', 'items'],
  properties: {
    type: { type: 'string', enum: ['log_meal', 'replace_meal', 'shop_add', 'shop_remove', 'make_menu'] },
    label: { type: 'string' },
    day: { type: 'integer' },
    slot: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack', 'none'] },
    text: { type: 'string' },
    group: { type: 'string' },
    items: { type: 'array', items: ITEM },
  },
};
const REPLY = {
  type: 'object', additionalProperties: false, required: ['say', 'actions', 'remember'],
  properties: { say: { type: 'string' }, actions: { type: 'array', items: ACTION }, remember: { type: 'array', items: { type: 'string' } } },
};

const AGENT_RULES = `Как ты отвечаешь в чате:
- Опирайся на досье: конкретные цифры ученика, его меню, покупки и съеденное. Не выдумывай данные, которых нет; если чего-то не хватает для ответа — спроси одним вопросом.
- say — ответ ученику: две–шесть простых фраз, он прозвучит вслух, поэтому без списков, скобок, эмодзи и разметки, числа удобные для произношения.
- actions — до трёх предложений действий, которые ученик выполнит одной кнопкой. Предлагай только когда это уместно:
  log_meal — ученик рассказал, что съел, а в дневнике этого нет: items с оценкой граммов, калорий, БЖУ и соли, text — название приёма пищи;
  replace_meal — заменить блюдо в меню: day — номер дня меню, slot — приём пищи, text — пожелание к новому блюду;
  shop_add — добавить в покупки: text — продукт с количеством, group — группа; shop_remove — убрать из покупок: text — точное название позиции;
  make_menu — составить новое меню на неделю, text — что учесть.
  label — короткая надпись на кнопке («Записать обед», «Заменить ужин в среду»). Неиспользуемые поля: day −1, slot none, пустые строки и массивы.
- remember — новые устойчивые факты об ученике для твоей памяти (режим дня, вкусы, непереносимость, бюджет, кто готовит, где обедает, реакция на блюда). Только новое, коротко; обычно пусто.
- Если приложено фото еды, этикетка, чек, меню ресторана, анализы или файл — разбери по своей части: еду оцени и предложи записать (log_meal), этикетку оцени по соли, сахару и белку, анализы свяжи с питанием (холестерин, глюкоза, мочевая кислота, ферритин, витамин D и т. п.), а медицинскую оценку оставь доктору Шэну.
- Если ученик хочет познакомиться поближе — задавай по одному вопросу за раз: режим дня и время приёмов пищи, завтракает ли, где обедает, кто готовит, бюджет, алкоголь, перекусы и сладкое, что любит и не любит, непереносимость, вода. Каждый ответ запоминай.`;

export async function meilinChat(text, { history = [], extra = '', signal, blocks = null } = {}) {
  const out = await callJSON({
    model: MODELS.expert, effort: 'low', schema: REPLY, maxTokens: 4000,
    system: `${meilinSystem(extra)}\n\n${AGENT_RULES}`,
    messages: [...history, { role: 'user', content: blocks?.length ? [...blocks, { type: 'text', text }] : text }],
  }, { signal });
  addFacts(out.remember);
  const actions = (out.actions || []).slice(0, 3).filter((a) => ACTION.properties.type.enum.includes(a.type));
  save();
  return { text: String(out.say || ''), actions, remembered: out.remember || [] };
}

// Выполнить предложенное действие (по кнопке ученика). Возвращает текст подтверждения.
export async function applyAction(a) {
  const m = menu();
  if (a.type === 'log_meal') {
    if (!a.items?.length) throw new Error('Нечего записать.');
    saveMeal({ id: newMealId(), at: Date.now(), title: a.text || 'Еда', source: 'chat', items: a.items.map((x) => ({ ...x })) });
    return 'Записано в дневник питания.';
  }
  if (a.type === 'shop_add') {
    if (!m) throw new Error('Сначала нужно меню на неделю.');
    const g = m.shopping.find((x) => x.group.toLowerCase() === String(a.group || '').toLowerCase()) || m.shopping.find((x) => x.group === 'Дополнительно');
    if (g) { if (!g.items.includes(a.text)) g.items.push(a.text); } else m.shopping.push({ group: a.group || 'Дополнительно', items: [a.text] });
    save();
    return 'Добавлено в список покупок.';
  }
  if (a.type === 'shop_remove') {
    if (!m) throw new Error('Списка покупок нет.');
    const q = String(a.text || '').toLowerCase();
    let hit = false;
    for (const g of m.shopping) { const n = g.items.length; g.items = g.items.filter((x) => !(x.toLowerCase() === q || x.toLowerCase().startsWith(q))); hit = hit || g.items.length < n; }
    m.shopping = m.shopping.filter((g) => g.items.length);
    save();
    if (!hit) throw new Error('Такой позиции в списке нет.');
    return 'Убрано из списка покупок.';
  }
  if (a.type === 'replace_meal') {
    if (!m) throw new Error('Меню на неделю ещё нет.');
    const d = m.days[a.day];
    const mi = d ? d.meals.findIndex((x) => x.slot === a.slot) : -1;
    if (mi < 0) throw new Error('Не нашла это блюдо в меню.');
    const meal = await replaceMeal(a.day, mi, a.text);
    return `Новое блюдо: «${meal.name}».`;
  }
  if (a.type === 'make_menu') {
    if (a.text) addFacts([`Пожелание к меню: ${a.text}`]);
    await makeMenu();
    return 'Новое меню на неделю готово — во вкладке «Питание».';
  }
  throw new Error('Неизвестное действие.');
}

// ---- для команды: что знают о питании Лао, Ли Ган и доктор Шэн ----
export function meilinBrief() {
  const today = dateStr();
  const T = targets();
  const e = dayTotals(today);
  let n = 0; const s = { kcal: 0, protein: 0, salt: 0 };
  for (let i = 1; i <= 7; i++) { const ds = addDays(today, -i); if (!dayMeals(ds).length) continue; const t = dayTotals(ds); n++; s.kcal += t.kcal; s.protein += t.protein; s.salt += t.salt; }
  const m = menu();
  const di = menuDay();
  return [
    `Питание (Мэйлин): норма ${T.kcal} ккал, белок ${T.protein} г, соль до ${T.salt} г; сегодня записано ${e.kcal} ккал, белок ${Math.round(e.protein)} г.`,
    n ? `За неделю записей ${n} дн., в среднем ${Math.round(s.kcal / n)} ккал, белок ${Math.round(s.protein / n)} г, соль ${r1(s.salt / n)} г.` : 'За неделю записей еды нет.',
    m && di >= 0 ? `По меню сегодня: ${m.days[di].meals.map((x) => x.name).join(', ')}.` : '',
    facts().length ? `Мэйлин знает: ${facts().slice(-6).map((x) => x.text).join('; ')}.` : '',
  ].filter(Boolean).join(' ');
}
