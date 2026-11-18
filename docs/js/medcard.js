// Медицинская карта на экране доктора Шэна: что внесено и какие указания получили мастера.
import { health, bpLimits, WHO_NAME } from './health.js';
import { dropRecord } from './shen.js';
import { state } from './store.js';
import { t } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const del = (list, id) => `<button type="button" class="mc-del" data-mc-del="${list}" data-id="${esc(id)}" aria-label="${t('Удалить')}">✕</button>`;
const sub = (x) => [x.date, x.source].filter(Boolean).map(esc).join(' · ');

function labsTable(labs) {
  // Показатель → значения по датам (последние три), чтобы видеть динамику.
  const by = new Map();
  for (const l of labs) { const k = l.name.toLowerCase(); if (!by.has(k)) by.set(k, []); by.get(k).push(l); }
  const rows = [...by.values()].map((arr) => arr.sort((a, b) => String(a.date).localeCompare(String(b.date))));
  rows.sort((a, b) => String(b.at(-1).date).localeCompare(String(a.at(-1).date)));
  return `<table class="mc-labs"><thead><tr><th>${t('Показатель')}</th><th>${t('Значение')}</th><th>${t('Норма')}</th><th></th></tr></thead><tbody>${rows.map((arr) => {
    const l = arr.at(-1);
    const prev = arr.slice(-3, -1).map((p) => `${esc(p.value)} <small>${esc(p.date)}</small>`).join(' → ');
    return `<tr class="${l.flag ? `mc-${l.flag}` : ''}"><td>${esc(l.name)}</td><td><b>${esc(l.value)}</b> ${esc(l.unit)}${l.flag === 'high' ? ' ↑' : l.flag === 'low' ? ' ↓' : ''} <small class="mc-d">${esc(l.date)}</small>${prev ? `<small class="mc-d">${t('раньше')}: ${prev}</small>` : ''}</td><td><small>${esc(l.ref)}</small></td><td>${del('labs', l.id)}</td></tr>`;
  }).join('')}</tbody></table>`;
}

export function medcardHTML() {
  const h = health();
  const meds = h.meds.filter((m) => !m.stopped);
  const empty = !h.diagnoses.length && !meds.length && !h.labs.length && !h.studies.length && !h.allergies.length && !h.rules.length && !h.exclude.length && !h.bp && !h.docs.length;
  const L = bpLimits();
  const S = state.strength;
  const li = (list, x, body) => `<li><span>${body}${sub(x) ? `<small>${sub(x)}</small>` : ''}</span>${del(list, x.id)}</li>`;
  const sec = (title, items) => (items.length ? `<h4>${t(title)}</h4><ul class="mc-list">${items.join('')}</ul>` : '');
  const rulesBy = ['all', 'lao', 'meilin', 'ligan'].map((w) => [w, h.rules.filter((r) => r.who === w)]).filter(([, r]) => r.length);
  return `<details class="memory medcard" ${empty ? '' : 'open'}><summary>${t('Медицинская карта')}${empty ? '' : ` · ${t('указаний мастерам')}: ${h.rules.length}`}</summary>
    ${empty ? `<p>${t('Карта пока пустая. Пришлите доктору выписки, анализы или заключения (фото, PDF, Excel) или расскажите о себе — он предложит, что внести, а вы подтвердите кнопкой.')}</p>` : ''}
    ${h.timeline?.length ? `<details class="mc-sub"><summary>${t('История болезни по годам')}</summary><ul class="mc-list mc-tl">${h.timeline.map((x) => `<li><span><b>${esc(x.date)}</b> — ${esc(x.text)}</span></li>`).join('')}</ul></details>` : ''}
    ${h.plan?.exams?.length ? `<details class="mc-sub"><summary>${t('Что обследовать: {n}', { n: h.plan.exams.length })}</summary><ul class="mc-list">${h.plan.exams.map((e) => `<li><span><b>${esc(e.what)}</b> — ${esc(e.why)}<small>${esc(e.when)}</small></span></li>`).join('')}</ul></details>` : ''}
    ${sec('Диагнозы', h.diagnoses.map((d) => li('diagnoses', d, esc(d.text))))}
    ${sec('Лекарства', meds.map((m) => li('meds', m, `<b>${esc(m.name)}</b> ${esc(m.dose)}${m.when ? ` — ${esc(m.when)}` : ''}`)))}
    ${h.medHistory.length ? `<details class="mc-sub"><summary>${t('История лекарств из архива: {n}', { n: h.medHistory.length })}</summary><ul class="mc-list">${h.medHistory.map((m) => li('medHistory', { ...m, date: [m.first, m.last].filter(Boolean).join(' — '), source: m.status === 'likely_current' ? t('возможно, принимаете сейчас — уточните у доктора') : t('в прошлом') }, `<b>${esc(m.name)}</b> ${esc(m.dose)}${m.how ? ` — ${esc(m.how)}` : ''}`)).join('')}</ul></details>` : ''}
    ${sec('Аллергии и непереносимость', h.allergies.map((a) => li('allergies', a, esc(a.text))))}
    ${h.labs.length ? `<details class="mc-sub" ${h.labs.length < 40 ? 'open' : ''}><summary>${t('Анализы')}: ${new Set(h.labs.map((l) => l.name.toLowerCase())).size}</summary>${labsTable(h.labs)}</details>` : ''}
    ${h.studies.length ? `<details class="mc-sub" ${h.studies.length < 8 ? 'open' : ''}><summary>${t('Обследования и заключения')}: ${h.studies.length}</summary><ul class="mc-list">${h.studies.slice().reverse().map((s) => li('studies', s, esc(s.text))).join('')}</ul></details>` : ''}
    ${h.docs.length ? `<details class="mc-sub"><summary>${t('Документы архива')}: ${h.docs.length}</summary><ul class="mc-list">${h.docs.slice().reverse().map((d) => li('docs', d, `<b>${esc(d.title || d.kind)}</b> — ${esc(d.summary)}`)).join('')}</ul></details>` : ''}
    <h4>${t('Указания мастерам')}</h4>
    <ul class="mc-list">
      <li><span>${t('Силовые')}: ${S?.doctorOk ? t('врач разрешил') : t('врач ещё не разрешил — только умеренно')}</span></li>
      <li><span>${t('Давление перед занятием: облегчённое с {a}, отмена с {b}', { a: `${L.light.sys}/${L.light.dia}`, b: `${L.stop.sys}/${L.stop.dia}` })}${L.custom ? `<small>${t('личные пороги от врача')}${h.bp?.source ? ` · ${esc(h.bp.source)}` : ''}</small>` : ''}</span>${L.custom ? del('bp', 'bp') : ''}</li>
      ${h.exclude.map((x) => li('exclude', x, `${t('Исключено')}: ${esc(x.title || x.id)}${x.why ? ` — ${esc(x.why)}` : ''}`)).join('')}
      ${rulesBy.map(([w, list]) => list.map((r) => li('rules', r, `<b>${esc(t(WHO_NAME[w]))}:</b> ${esc(r.text)}`)).join('')).join('')}
    </ul>
    ${h.notes ? `<h4>${t('Заметки')}</h4><p class="mc-notes">${esc(h.notes)}</p>` : ''}
  </details>`;
}

export function bindMedcard(root, rerender) {
  root.querySelectorAll('[data-mc-del]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm(t('Удалить эту запись из медкарты?'))) return;
    dropRecord(b.dataset.mcDel, b.dataset.id);
    rerender();
  }));
}
