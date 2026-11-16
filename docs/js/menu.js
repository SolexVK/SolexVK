// Продукты ученика и меню на неделю от мастера-диетолога.
// Сначала пошаговый разговор о продуктах (по группам, с замечаниями мастера), затем меню на 7 дней из этих продуктов:
// простые блюда, быстрая готовка, сходится с нормой. Каждую неделю — новое меню с учётом веса, вкусов и этапа.
import { state, save, dateStr, addDays, daysBetween } from './store.js';
import { MODELS } from './ai-request.js';
import { callJSON } from './brain.js';
import { aiLanguage } from './i18n.js';
import { targets, weekStats } from './nutrition.js';
import { meilinSystem } from './meilin.js';

// Группы продуктов: простые и доступные варианты для выбора одним касанием.
export const GROUPS = [
  { id: 'meat', title: 'Мясо и птица', items: ['Куриное филе', 'Куриные бёдра', 'Индейка', 'Говядина', 'Фарш говяжий', 'Свинина нежирная', 'Куриная печень', 'Куриные сердечки'] },
  { id: 'fish', title: 'Рыба и морепродукты', items: ['Минтай', 'Хек', 'Треска', 'Скумбрия', 'Сельдь', 'Горбуша', 'Тунец консервированный', 'Сардины консервированные', 'Креветки', 'Кальмары'] },
  { id: 'dairy', title: 'Яйца и молочное', items: ['Яйца', 'Творог 2–5 %', 'Кефир 1 %', 'Йогурт натуральный', 'Сыр твёрдый', 'Сыр адыгейский', 'Сметана 10 %', 'Молоко', 'Ряженка'] },
  { id: 'grains', title: 'Крупы, хлеб, картофель', items: ['Гречка', 'Овсяные хлопья', 'Рис', 'Бурый рис', 'Булгур', 'Перловка', 'Пшено', 'Макароны из твёрдых сортов', 'Хлеб цельнозерновой', 'Картофель'] },
  { id: 'legumes', title: 'Бобовые', items: ['Чечевица красная', 'Фасоль консервированная', 'Нут', 'Горох', 'Зелёный горошек', 'Тофу'] },
  { id: 'veg', title: 'Овощи и грибы', items: ['Капуста белокочанная', 'Брокколи', 'Цветная капуста', 'Морковь', 'Свёкла', 'Огурцы', 'Помидоры', 'Перец болгарский', 'Кабачки', 'Тыква', 'Баклажаны', 'Лук', 'Чеснок', 'Шпинат', 'Шампиньоны', 'Замороженные овощные смеси', 'Квашеная капуста'] },
  { id: 'greens', title: 'Зелень и салаты', items: ['Укроп', 'Петрушка', 'Листовой салат', 'Зелёный лук', 'Кинза', 'Руккола'] },
  { id: 'fruit', title: 'Фрукты и ягоды', items: ['Яблоки', 'Груши', 'Бананы', 'Апельсины', 'Мандарины', 'Киви', 'Лимон', 'Ягоды замороженные', 'Чернослив'] },
  { id: 'fats', title: 'Орехи, семена, масла', items: ['Масло оливковое', 'Масло подсолнечное', 'Грецкие орехи', 'Миндаль', 'Семена льна', 'Тыквенные семечки', 'Арахисовая паста'] },
  { id: 'extras', title: 'Приправы и напитки', items: ['Специи и травы', 'Томатная паста', 'Горчица', 'Соевый соус', 'Мёд', 'Какао', 'Кофе', 'Чай зелёный', 'Минеральная вода'] },
  { id: 'avoid', title: 'Чего не ешь', items: ['Не ем свинину', 'Не люблю рыбу', 'Плохо переношу молоко', 'Аллергия на орехи', 'Не люблю бобовые', 'Не ем субпродукты'], negative: true },
  { id: 'kitchen', title: 'Кухня и время', items: ['Плита', 'Духовка', 'Микроволновка', 'Мультиварка', 'Аэрогриль', 'Блендер', 'Кухонные весы', 'Готовлю 10–15 минут', 'Готовлю до 30 минут', 'Могу готовить на 2 дня', 'Обед беру с собой'] },
];

export const pantry = () => state.nutrition?.pantry || null;
export function savePantry(p) {
  state.nutrition = { ...(state.nutrition || {}), pantry: { ...p, updatedAt: dateStr() } };
  save();
}

// Замечания мастера по одной группе: пробелы, замены, уточнение.
const REVIEW = {
  type: 'object', additionalProperties: false, required: ['comment', 'suggest', 'question'],
  properties: { comment: { type: 'string' }, suggest: { type: 'array', items: { type: 'string' } }, question: { type: 'string' } },
};
export async function reviewGroup(group, chosen, all) {
  const so = Object.entries(all).filter(([k, v]) => k !== group.id && v?.length).map(([k, v]) => `${GROUPS.find((g) => g.id === k)?.title}: ${v.join(', ')}`).join('\n');
  return callJSON({
    model: MODELS.daily, effort: 'low', schema: REVIEW, maxTokens: 1500,
    system: `Ты — Мэйлин, наставница по питанию в приложении ученика (тайцзи, похудение, висцеральный жир, мышцы, повышенное давление). Пиши на ${aiLanguage()} языке, на «вы», коротко и тепло. Сейчас ты помогаешь составить список доступных ученику продуктов, по группам.`,
    messages: [{ role: 'user', content: `Группа «${group.title}». Ученик выбрал: ${chosen.length ? chosen.join(', ') : 'ничего'}.\nУже выбрано в других группах:\n${so || '—'}\n\n${group.negative ? 'Это ограничения: что ученик не ест. Учти их.' : group.id === 'kitchen' ? 'Это кухонная техника и время на готовку.' : 'Оцени выбор для целей ученика.'} comment — 1–2 фразы: что хорошо и чего не хватает (например, источника омега-3, клетчатки, нежирного белка, кальция). suggest — до 4 простых недорогих продуктов этой группы, которые стоит добавить или которыми заменить то, чего нет (не повторяй выбранное и не предлагай противоречащее ограничениям). question — один короткий уточняющий вопрос или пустая строка.` }],
  });
}

// ---- меню ----
const ING = { type: 'object', additionalProperties: false, required: ['name', 'grams'], properties: { name: { type: 'string' }, grams: { type: 'number' } } };
const MEAL = {
  type: 'object', additionalProperties: false, required: ['slot', 'name', 'minutes', 'ingredients', 'steps', 'kcal', 'protein', 'fat', 'carbs'],
  properties: {
    slot: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] }, name: { type: 'string' }, minutes: { type: 'integer' },
    ingredients: { type: 'array', items: ING }, steps: { type: 'array', items: { type: 'string' } },
    kcal: { type: 'number' }, protein: { type: 'number' }, fat: { type: 'number' }, carbs: { type: 'number' },
  },
};
const MENU = {
  type: 'object', additionalProperties: false, required: ['note', 'days', 'shopping', 'prep'],
  properties: {
    note: { type: 'string' },
    days: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['meals'], properties: { meals: { type: 'array', items: MEAL } } } },
    shopping: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['group', 'items'], properties: { group: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } } } },
    prep: { type: 'array', items: { type: 'string' } },
  },
};

export const menu = () => state.nutrition?.menu || null;
export const menuStale = () => { const m = menu(); return !m || daysBetween(m.start, dateStr()) >= 7; };
export const phase = () => state.nutrition?.phase || 'loss';
// Номер дня меню для даты (0–6) или -1.
export function menuDay(date = dateStr()) {
  const m = menu();
  if (!m) return -1;
  const i = daysBetween(m.start, date);
  return i >= 0 && i < (m.days?.length || 0) ? i : -1;
}

export async function makeMenu() {
  const P = pantry();
  const T = targets();
  const s = weekStats();
  const likes = state.nutrition?.likes || [];
  const dislikes = state.nutrition?.dislikes || [];
  const list = GROUPS.filter((g) => !g.negative && g.id !== 'kitchen').map((g) => `${g.title}: ${(P?.groups?.[g.id] || []).join(', ') || '—'}`).join('\n');
  const avoid = [...(P?.groups?.avoid || []), P?.notes?.avoid || ''].filter(Boolean).join(', ');
  const kitchen = (P?.groups?.kitchen || []).join(', ');
  const ph = phase();
  const out = await callJSON({
    model: MODELS.expert, effort: 'medium', schema: MENU, maxTokens: 16000,
    system: `${meilinSystem()}

Сейчас ты составляешь меню как практичный домашний повар: простые доступные продукты, быстрая готовка, без экзотики. Белок в каждом приёме пищи, половина тарелки — овощи, цельные крупы, жирная рыба 2 раза в неделю, бобовые, соль до 5 г в день, без сахара в напитках, последний приём пищи за 3 часа до сна. Можно готовить сразу на 2 дня и использовать остатки. Учитывай всё, что знаешь об ученике: вкусы, режим дня, что не понравилось, и силовые дни.`,
    messages: [{ role: 'user', content: `Составь меню на 7 дней, начиная с сегодняшнего (${new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}).
Этап: ${ph === 'maintain' ? 'поддержание веса и рост мышц' : 'похудение с сохранением мышц, уменьшение висцерального жира'}.
Норма на день: ${T.kcal} ккал (допуск ±5 %), белок не меньше ${T.protein} г, жиры около ${T.fat} г, углеводы около ${T.carbs} г, соль до ${T.salt} г.
Доступные продукты (используй только их и базовые: соль, перец, вода, специи):
${list}
Не ест / ограничения: ${avoid || 'нет'}.
Кухня и время: ${kitchen || 'плита, до 30 минут'}.
Дни меню: ${Array.from({ length: 7 }, (_, i) => { const ds = addDays(dateStr(), i); const w = new Date(`${ds}T12:00:00`).getDay(); return `${i + 1}) ${ds}${state.strength?.days?.includes(w) ? ' — силовое с Ли Ганом: белковый приём пищи после тренировки, чуть больше углеводов' : ''}`; }).join('; ')}.
${likes.length ? `Понравилось раньше: ${likes.slice(-15).join(', ')}.` : ''}${dislikes.length ? ` Не понравилось, не повторять: ${dislikes.slice(-15).join(', ')}.` : ''}
${s.change != null ? `За прошлую неделю средний вес изменился на ${s.change} кг.` : ''}

В каждом дне: breakfast, lunch, dinner и один snack. У блюда: название, минуты готовки (не больше 30, лучше 10–20), ингредиенты в граммах, 1–3 коротких шага, калории и БЖУ на порцию. Блюда разнообразные, но одно блюдо можно повторить через день как заготовку. shopping — список покупок на неделю по группам с количеством («Куриное филе — 1,5 кг»). prep — 2–4 совета по заготовкам на неделю. note — 2 фразы ученику о том, на чём построено меню.` }],
  });
  const m = { start: dateStr(), days: (out.days || []).slice(0, 7), shopping: out.shopping || [], prep: out.prep || [], note: String(out.note || ''), kcal: T.kcal, protein: T.protein, bought: {} };
  state.nutrition = { ...(state.nutrition || {}), menu: m };
  save();
  return m;
}

// Заменить одно блюдо на похожее по калориям и белку.
export async function replaceMeal(di, mi, wish = '') {
  const m = menu();
  const old = m.days[di].meals[mi];
  const P = pantry();
  const list = Object.entries(P?.groups || {}).filter(([k]) => k !== 'avoid' && k !== 'kitchen').flatMap(([, v]) => v).join(', ');
  const out = await callJSON({
    model: MODELS.daily, effort: 'low', schema: MEAL, maxTokens: 2000,
    system: `${meilinSystem()}\n\nСейчас ты заменяешь одно блюдо в меню. Простые продукты, быстрая готовка, мало соли.`,
    messages: [{ role: 'user', content: `${wish ? `Пожелание ученика: ${wish}. ` : ''}Замени блюдо «${old.name}» (${old.slot}) на другое: примерно ${Math.round(old.kcal)} ккал и не меньше ${Math.round(old.protein)} г белка, до 20 минут готовки, только из продуктов: ${list}. Не повторяй: ${m.days.flatMap((d) => d.meals.map((x) => x.name)).join(', ')}. Ограничения: ${(P?.groups?.avoid || []).join(', ') || 'нет'}.` }],
  });
  m.days[di].meals[mi] = { ...out, slot: old.slot };
  save();
  return m.days[di].meals[mi];
}

export function rateMeal(name, good) {
  const n = state.nutrition || (state.nutrition = {});
  const add = (k) => { n[k] = [...(n[k] || []).filter((x) => x !== name), name].slice(-40); };
  const del = (k) => { n[k] = (n[k] || []).filter((x) => x !== name); };
  if (good) { add('likes'); del('dislikes'); } else { add('dislikes'); del('likes'); }
  save();
}
