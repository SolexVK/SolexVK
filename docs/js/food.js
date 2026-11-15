// Экран «Питание»: итог дня, добавление еды (фото → уточнения → оценка, словами или вручную), чек-лист, разбор недели.
import { state, save, dateStr, day, peekDay } from './store.js';
import { t, locale } from './i18n.js';
import { aiAvailable } from './brain.js';
import {
  targets, dayMeals, dayTotals, mealTotals, saveMeal, deleteMeal, scaleItem,
  analyzeMeal, finishMeal, weekReview, weekStats, shrinkPhoto, newMealId,
} from './nutrition.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = (v) => (Math.round((Number(v) || 0) * 10) / 10).toString().replace('.', ',');
const CHECK = [
  ['veg', 'Овощи в двух приёмах пищи и больше'],
  ['protein', 'Белок в каждом приёме пищи'],
  ['water', 'Вода 1,5–2 литра'],
  ['nosugar', 'Без сладких напитков и соков'],
  ['noalcohol', 'Без алкоголя'],
  ['early', 'Последняя еда за 3 часа до сна'],
];

function bar(label, have, need, unit, over = false) {
  const p = need ? Math.min(100, Math.round((have / need) * 100)) : 0;
  const cls = over && have > need * 1.05 ? 'over' : have >= need * 0.9 ? 'ok' : '';
  return `<div class="nbar ${cls}"><div class="nbar-top"><span>${label}</span><span><b>${n1(have)}</b> / ${need} ${unit}</span></div><div class="nbar-line"><i style="width:${p}%"></i></div></div>`;
}

// Подсказка на остаток дня — по правилам, без нейросети.
function tip(T, s) {
  const h = new Date().getHours();
  const leftP = T.protein - s.protein;
  const leftK = T.kcal - s.kcal;
  if (s.kcal > T.kcal * 1.05) return t('Норма калорий на сегодня уже набрана. Если голодно — овощи, кефир или чай без сахара.');
  if (h >= 15 && leftP > 30) return t('До нормы белка не хватает {n} г. На ужин подойдут курица, рыба, творог или яйца.', { n: Math.round(leftP) });
  if (s.salt > T.salt) return t('Соли сегодня уже больше 5 г. Остаток дня — без солений, колбас и соусов.');
  if (leftK > 0 && h >= 20) return t('До сна осталось немного: если голодно — белковое и лёгкое, за 3 часа до сна.');
  return t('Белок в каждом приёме пищи, половина тарелки — овощи.');
}

export function renderFood(main, ui) {
  const today = dateStr();
  const T = targets();
  const s = dayTotals(today);
  const meals = dayMeals(today);
  const d = peekDay(today) || {};
  const food = d.food || {};
  const ai = aiAvailable();
  const ws = weekStats();
  main.innerHTML = `
    <section class="food-head card">
      <p class="eyebrow">${t('Питание сегодня')}</p>
      ${bar(t('Калории'), s.kcal, T.kcal, t('ккал'), true)}
      ${bar(t('Белок'), s.protein, T.protein, t('г'))}
      ${bar(t('Жиры'), s.fat, T.fat, t('г'), true)}
      ${bar(t('Углеводы'), s.carbs, T.carbs, t('г'), true)}
      ${s.salt ? `<p class="note">${t('Соль')}: ${n1(s.salt)} / ${T.salt} ${t('г')}</p>` : ''}
      <p class="food-tip">${esc(tip(T, s))}</p>
    </section>
    <section class="food-actions">
      <label class="btn wide" for="food-photo">📷 ${t('Сфотографировать еду')}</label>
      <input type="file" id="food-photo" accept="image/*" capture="environment" hidden>
      <div class="row-btns"><button class="btn ghost" id="food-text">${t('Описать словами')}</button><button class="btn ghost" id="food-manual">${t('Записать вручную')}</button></div>
      ${ai ? '' : `<p class="note">${t('Фото и описание разбирает нейросеть — подключите сервер или ключ API в настройках. Вручную можно записывать и без неё.')}</p>`}
    </section>
    <section class="food-list">
      <h3>${t('Приёмы пищи')}</h3>
      ${meals.length ? meals.map((m) => {
        const tt = mealTotals(m.items);
        return `<article class="meal" data-meal="${esc(m.id)}">
          ${m.thumb ? `<img class="meal-ph" src="${esc(m.thumb)}" alt="">` : '<div class="meal-ph empty">🍽</div>'}
          <div class="meal-b"><h4>${esc(m.title || t('Еда'))} <small>${esc(new Date(m.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }))}</small></h4>
            <p class="meal-n">${tt.kcal} ${t('ккал')} · ${t('Б')} ${n1(tt.protein)} · ${t('Ж')} ${n1(tt.fat)} · ${t('У')} ${n1(tt.carbs)}</p>
            <p class="note">${esc(m.items.map((x) => `${x.name} ${Math.round(x.grams)} ${t('г')}`).join(', '))}</p>
            ${m.advice ? `<p class="meal-adv">${esc(m.advice)}</p>` : ''}
          </div>
          <button class="s-icon meal-del" data-del-meal="${esc(m.id)}" aria-label="${t('Удалить')}">✕</button>
        </article>`;
      }).join('') : `<p class="note">${t('Пока пусто. Сфотографируйте тарелку перед едой — мастер оценит калории и белок.')}</p>`}
    </section>
    <section class="food-check card">
      <h3>${t('Чек-лист дня')}</h3>
      ${CHECK.map(([k, l]) => `<label class="switch"><input type="checkbox" data-fcheck="${k}" ${food[k] ? 'checked' : ''}><span>${t(l)}</span></label>`).join('')}
    </section>
    <section class="food-week card">
      <h3>${t('Неделя')}</h3>
      <p class="note">${ws.daysLogged ? t('Дней с записями: {n} из 7. В среднем {k} ккал и {p} г белка в день.', { n: ws.daysLogged, k: ws.kcal, p: ws.protein }) : t('Записей за неделю пока нет.')}
      ${ws.change != null ? ` ${t('Средний вес за неделю изменился на {c} кг.', { c: n1(ws.change) })}` : ''}</p>
      ${state.nutrition?.lastSay ? `<p class="meal-adv">${esc(state.nutrition.lastSay)}</p>` : ''}
      ${ai ? `<button class="btn ghost" id="food-week">${t('Разбор недели с диетологом')}</button>` : ''}
    </section>
    <details class="food-norm"><summary>${t('Как считается норма')}</summary>
      <p class="note">${t('Расход в покое — около {b} ккал, за день с ходьбой и занятиями — около {d} ккал (вес {w} кг). Для похудения норма меньше расхода примерно на 20 %: {k} ккал. Белок — {p} г, чтобы сохранять и растить мышцы. Соль — до 5 г из-за давления. Норма пересчитывается по мере похудения и после разбора недели. Это ориентир, а не назначение врача.', { b: T.bmr, d: T.tdee, w: n1(T.weight), k: T.kcal, p: T.protein })}</p>
    </details>`;

  main.querySelector('#food-photo').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!ai) { ui.toast(t('Нейросеть не подключена.')); return; }
    try { mealFlow(ui, { photo: await shrinkPhoto(f) }); } catch { ui.toast(t('Не получилось прочитать фото.')); }
  });
  main.querySelector('#food-text').addEventListener('click', () => (ai ? mealFlow(ui, {}) : ui.toast(t('Нейросеть не подключена.'))));
  main.querySelector('#food-manual').addEventListener('click', () => manualFlow(ui));
  main.querySelector('#food-week')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = t('Диетолог смотрит неделю…');
    try { await weekReview(); ui.render(); } catch (err) { ui.toast(err.message || t('Не получилось получить ответ.')); b.disabled = false; b.textContent = t('Разбор недели с диетологом'); }
  });
  main.querySelectorAll('[data-fcheck]').forEach((c) => c.addEventListener('change', () => {
    const dd = day(today);
    dd.food = { ...(dd.food || {}), [c.dataset.fcheck]: c.checked };
    save();
  }));
  main.querySelectorAll('[data-del-meal]').forEach((b) => b.addEventListener('click', () => {
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = '?'; ui.toast(t('Нажмите ещё раз, чтобы удалить')); return; }
    deleteMeal(b.dataset.delMeal, today);
    ui.render();
  }));
}

// ---- добавление еды с нейросетью ----
function mealFlow(ui, { photo }) {
  const pv = photo ? `<img class="food-prev" src="data:image/jpeg;base64,${photo.base64}" alt="">` : '';
  ui.openSheet(`<h3>${t('Мастер-диетолог')}</h3>${pv}
    <label for="mf-text">${photo ? t('Пояснение (необязательно)') : t('Что вы съели? Опишите блюда и примерный размер порций')}</label>
    <textarea id="mf-text" rows="${photo ? 2 : 4}" placeholder="${photo ? t('Например: жарено на оливковом масле, хлеб не ел') : t('Например: тарелка гречки, две котлеты, салат из огурцов со сметаной, чай без сахара')}"></textarea>
    <button class="btn wide" id="mf-go">${t('Отправить мастеру')}</button>
    <button class="btn ghost wide" data-close>${t('Отмена')}</button>`);
  const body = document.querySelector('#sheet-body');
  body.querySelector('#mf-go').addEventListener('click', async () => {
    const text = body.querySelector('#mf-text').value.trim();
    if (!photo && !text) { ui.toast(t('Опишите, что вы съели.')); return; }
    body.querySelector('#mf-go').disabled = true;
    body.querySelector('#mf-go').textContent = t('Мастер смотрит…');
    try {
      const first = await analyzeMeal({ photo: photo?.base64, text });
      askStep(ui, { photo, text, first });
    } catch (err) {
      ui.toast(err.message || t('Не получилось получить ответ.'));
      body.querySelector('#mf-go').disabled = false;
      body.querySelector('#mf-go').textContent = t('Отправить мастеру');
    }
  });
}

function askStep(ui, ctx) {
  const { first } = ctx;
  const qs = first.questions || [];
  if (!qs.length) { resultStep(ui, ctx, {}); return; }
  ui.openSheet(`<h3>${esc(first.title || t('Еда'))}</h3>
    <p class="note">${t('Вижу')}: ${esc(first.items.map((x) => `${x.name} ~${Math.round(x.grams)} ${t('г')}`).join(', '))}</p>
    ${qs.map((q) => `<fieldset class="mf-q" data-q="${esc(q.id)}"><legend>${esc(q.text)}</legend>
      <div class="chips">${q.options.map((o) => `<button type="button" class="chip" data-a="${esc(o)}">${esc(o)}</button>`).join('')}</div>
      <input class="mf-other" placeholder="${t('Или свой ответ')}"></fieldset>`).join('')}
    <button class="btn wide" id="mf-calc">${t('Посчитать')}</button>
    <button class="btn ghost wide" data-close>${t('Отмена')}</button>`);
  const body = document.querySelector('#sheet-body');
  const answers = {};
  body.querySelectorAll('.mf-q').forEach((fs) => {
    fs.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
      fs.querySelectorAll('[data-a]').forEach((x) => x.classList.toggle('on', x === b));
      answers[fs.dataset.q] = b.dataset.a;
    }));
    fs.querySelector('.mf-other').addEventListener('input', (e) => { if (e.target.value.trim()) answers[fs.dataset.q] = e.target.value.trim(); });
  });
  body.querySelector('#mf-calc').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = t('Считаю…');
    resultStep(ui, ctx, answers);
  });
}

async function resultStep(ui, ctx, answers) {
  let res;
  try {
    res = await finishMeal({ photo: ctx.photo?.base64, text: ctx.text, first: ctx.first, answers });
  } catch (err) {
    ui.toast(err.message || t('Не получилось получить ответ.'));
    res = { title: ctx.first.title, items: ctx.first.items, confidence: 'low', advice: '' };
  }
  editStep(ui, { id: newMealId(), at: Date.now(), title: res.title, items: res.items, advice: res.advice, confidence: res.confidence, thumb: ctx.photo?.thumb || '', source: ctx.photo ? 'photo' : 'text' });
}

// Итог: можно поправить вес каждой порции — калории и БЖУ пересчитаются.
function editStep(ui, meal) {
  const conf = { low: t('приблизительно'), medium: t('довольно точно'), high: t('точно') }[meal.confidence] || '';
  const draw = () => {
    const tt = mealTotals(meal.items);
    ui.openSheet(`<h3>${esc(meal.title || t('Еда'))}</h3>
      ${conf ? `<p class="note">${t('Оценка')}: ${conf}. ${t('Если взвешивали — поправьте граммы.')}</p>` : ''}
      <div class="mf-items">${meal.items.map((x, i) => `<div class="mf-item"><span class="mf-name">${esc(x.name)}</span>
        <label class="mf-g"><input type="number" inputmode="decimal" min="0" step="5" value="${Math.round(x.grams)}" data-gi="${i}"> ${t('г')}</label>
        <span class="mf-k">${Math.round(x.kcal)} ${t('ккал')} · ${t('Б')} ${n1(x.protein)} · ${t('Ж')} ${n1(x.fat)} · ${t('У')} ${n1(x.carbs)}</span></div>`).join('')}</div>
      <p class="meal-n"><b>${t('Итого')}: ${tt.kcal} ${t('ккал')}</b> · ${t('Б')} ${n1(tt.protein)} · ${t('Ж')} ${n1(tt.fat)} · ${t('У')} ${n1(tt.carbs)}${tt.salt ? ` · ${t('соль')} ${n1(tt.salt)} ${t('г')}` : ''}</p>
      ${meal.advice ? `<p class="meal-adv">${esc(meal.advice)}</p>` : ''}
      <button class="btn wide" id="mf-save">${t('Сохранить')}</button>
      <button class="btn ghost wide" data-close>${t('Отмена')}</button>`);
    const body = document.querySelector('#sheet-body');
    body.querySelectorAll('[data-gi]').forEach((inp) => inp.addEventListener('change', () => {
      const i = Number(inp.dataset.gi);
      meal.items[i] = scaleItem(meal.items[i], inp.value);
      draw();
    }));
    body.querySelector('#mf-save').addEventListener('click', () => {
      saveMeal(meal);
      ui.closeSheet();
      ui.render();
      ui.toast(t('Сохранено'));
    });
  };
  draw();
}

// ---- вручную, без нейросети ----
function manualFlow(ui) {
  ui.openSheet(`<h3>${t('Записать вручную')}</h3>
    <label for="mm-name">${t('Что съели')}</label><input id="mm-name" placeholder="${t('Например: творог 5 %, 200 г')}">
    <div class="mm-grid">
      <label>${t('Калории')}<input id="mm-k" type="number" inputmode="decimal" min="0"></label>
      <label>${t('Белок, г')}<input id="mm-p" type="number" inputmode="decimal" min="0"></label>
      <label>${t('Жиры, г')}<input id="mm-f" type="number" inputmode="decimal" min="0"></label>
      <label>${t('Углеводы, г')}<input id="mm-c" type="number" inputmode="decimal" min="0"></label>
    </div>
    <button class="btn wide" id="mm-save">${t('Сохранить')}</button>
    <button class="btn ghost wide" data-close>${t('Отмена')}</button>`);
  const body = document.querySelector('#sheet-body');
  body.querySelector('#mm-save').addEventListener('click', () => {
    const v = (id) => Number(body.querySelector(id).value.replace(',', '.')) || 0;
    const name = body.querySelector('#mm-name').value.trim();
    if (!name || !v('#mm-k')) { ui.toast(t('Укажите, что съели, и калории.')); return; }
    saveMeal({ id: newMealId(), at: Date.now(), title: name, source: 'manual', items: [{ name, grams: 0, kcal: v('#mm-k'), protein: v('#mm-p'), fat: v('#mm-f'), carbs: v('#mm-c'), salt: 0 }] });
    ui.closeSheet();
    ui.render();
    ui.toast(t('Сохранено'));
  });
}
