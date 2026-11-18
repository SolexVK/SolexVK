// Медицинская карта ученика (state.health) и указания доктора Шэна команде.
// Здесь только данные и тексты для подсказок других мастеров — без обращений к нейросети,
// чтобы любой модуль (brain, meilin, team, course, program) мог это импортировать без циклов.
import { state } from './store.js';

const LISTS = ['diagnoses', 'meds', 'allergies', 'labs', 'studies', 'rules', 'exclude'];
export function health() {
  const h = state.health && typeof state.health === 'object' ? state.health : (state.health = {});
  for (const k of LISTS) if (!Array.isArray(h[k])) h[k] = [];
  for (const k of LISTS) if (k !== 'exclude') for (const x of h[k]) if (x && !x.id) x.id = newId();
  if (typeof h.notes !== 'string') h.notes = h.notes ? String(h.notes) : '';
  return h;
}
export const newId = () => `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const WHO_NAME = { lao: 'мастер Лао', meilin: 'Мэйлин', ligan: 'Ли Ган', all: 'все мастера' };

// Общие пороги давления перед занятием; личные (от врача через доктора Шэна) могут быть только строже.
export const BP_DEFAULT = { light: { sys: 150, dia: 95 }, stop: { sys: 171, dia: 106 } };
export function bpLimits() {
  const L = state.health?.bp || {};
  const pick = (k, f) => Math.min(BP_DEFAULT[k][f], Number(L[k]?.[f]) || 999);
  return { light: { sys: pick('light', 'sys'), dia: pick('light', 'dia') }, stop: { sys: pick('stop', 'sys'), dia: pick('stop', 'dia') }, custom: !!state.health?.bp };
}

// Упражнения, которые доктор Шэн исключил (id из kb.EXERCISES и strength.LIGAN_EX).
export const healthExclude = () => (state.health?.exclude || []).map((x) => x.id);

export function rulesFor(who) {
  return (state.health?.rules || []).filter((r) => r.who === who || r.who === 'all' || who === 'shen');
}

const fmtLab = (l) => `${l.name} ${l.value}${l.unit ? ` ${l.unit}` : ''}${l.ref ? ` (норма ${l.ref})` : ''}${l.flag === 'high' ? ' ↑' : l.flag === 'low' ? ' ↓' : ''}`;

// Последние значения каждого показателя (для коротких сводок).
export function latestLabs(n = 25) {
  const by = new Map();
  for (const l of (state.health?.labs || [])) {
    const k = String(l.name).toLowerCase();
    const prev = by.get(k);
    if (!prev || String(l.date) >= String(prev.date)) by.set(k, l);
  }
  return [...by.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, n);
}

// Полная карта — для самого доктора Шэна.
export function cardText() {
  const h = health();
  const src = (x) => [x.date && `с ${x.date}`, x.source].filter(Boolean).join(', ');
  const out = [];
  out.push(`Диагнозы: ${h.diagnoses.length ? h.diagnoses.map((d) => `${d.text}${src(d) ? ` (${src(d)})` : ''}`).join('; ') : 'в карту не внесены'}.`);
  const meds = h.meds.filter((m) => !m.stopped);
  out.push(`Лекарства сейчас: ${meds.length ? meds.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''}${m.when ? `, ${m.when}` : ''}${src(m) ? ` (${src(m)})` : ''}`).join('; ') : 'не внесены'}.`);
  const stopped = h.meds.filter((m) => m.stopped);
  if (stopped.length) out.push(`Отменены: ${stopped.map((m) => `${m.name} (${m.stopped})`).join('; ')}.`);
  out.push(`Аллергии и непереносимость: ${h.allergies.length ? h.allergies.map((a) => a.text).join('; ') : 'не внесены'}.`);
  if (h.labs.length) {
    const dates = [...new Set(h.labs.map((l) => l.date))].sort().reverse().slice(0, 8);
    out.push(`Анализы:\n${dates.map((d) => `${d}: ${h.labs.filter((l) => l.date === d).map(fmtLab).join('; ')}`).join('\n')}`);
  } else out.push('Анализы: в карту не внесены.');
  if (h.studies.length) out.push(`Обследования и заключения:\n${h.studies.slice(-12).map((s) => `${s.date || '?'}: ${s.text}${s.source ? ` (${s.source})` : ''}`).join('\n')}`);
  if (h.notes) out.push(`Заметки: ${h.notes}`);
  out.push(...teamFrame());
  return out.join('\n');
}

// Рамки для команды: разрешение на силовые, пороги давления, исключения, указания.
function teamFrame() {
  const h = health();
  const out = [];
  const S = state.strength;
  out.push(`Силовые: врач ${S?.doctorOk ? `разрешил${h.strengthOk?.date ? ` (${h.strengthOk.date}${h.strengthOk.source ? `, ${h.strengthOk.source}` : ''})` : ''}` : 'ещё не разрешил — только умеренная нагрузка'}.`);
  const L = bpLimits();
  out.push(`Пороги давления перед занятием${L.custom ? ' (личные, от врача)' : ' (общие)'}: облегчённое занятие с ${L.light.sys}/${L.light.dia}, отмена с ${L.stop.sys}/${L.stop.dia}.`);
  if (h.exclude.length) out.push(`Исключённые упражнения: ${h.exclude.map((x) => `${x.title || x.id}${x.why ? ` — ${x.why}` : ''}`).join('; ')}.`);
  out.push(h.rules.length ? `Указания доктора Шэна мастерам:\n${h.rules.map((r) => `- ${WHO_NAME[r.who] || r.who}: ${r.text}`).join('\n')}` : 'Указаний мастерам пока нет.');
  return out;
}

// Что должен знать и выполнять конкретный мастер (lao, meilin, ligan).
export function doctorFrame(who) {
  const h = health();
  const out = [];
  if (h.diagnoses.length) out.push(`Диагнозы: ${h.diagnoses.map((d) => d.text).join('; ')}.`);
  const meds = h.meds.filter((m) => !m.stopped);
  if (meds.length) out.push(`Лекарства: ${meds.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''}${m.when ? ` (${m.when})` : ''}`).join('; ')}.`);
  if (h.allergies.length) out.push(`Аллергии и непереносимость: ${h.allergies.map((a) => a.text).join('; ')}.`);
  const labs = latestLabs(who === 'meilin' ? 25 : 10).filter((l) => who === 'meilin' || l.flag);
  if (labs.length) out.push(`${who === 'meilin' ? 'Последние анализы' : 'Анализы с отклонениями'}: ${labs.map((l) => `${l.date} ${fmtLab(l)}`).join('; ')}.`);
  const S = state.strength;
  out.push(`Силовые: врач ${S?.doctorOk ? 'разрешил' : 'ещё не разрешил — только умеренная нагрузка'}.`);
  if (who !== 'meilin') {
    const L = bpLimits();
    out.push(`Давление перед занятием: облегчённое с ${L.light.sys}/${L.light.dia}, отмена с ${L.stop.sys}/${L.stop.dia}${L.custom ? ' (личные пороги от врача)' : ''}.`);
    if (h.exclude.length) out.push(`Исключены доктором: ${h.exclude.map((x) => x.title || x.id).join(', ')}.`);
  }
  const r = rulesFor(who);
  out.push(r.length ? `Указания доктора Шэна тебе (обязательны):\n${r.map((x) => `- ${x.text}`).join('\n')}` : 'Особых указаний доктора Шэна тебе нет.');
  if (h.notes) out.push(`Заметки доктора: ${h.notes}`);
  return `[Медицинские рамки от доктора Шэна — соблюдай их во всех советах и планах]\n${out.join('\n')}`;
}
