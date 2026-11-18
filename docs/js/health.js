// Медицинская карта ученика (state.health) и указания доктора Шэна команде.
// Здесь только данные и тексты для подсказок других мастеров — без обращений к нейросети,
// чтобы любой модуль (brain, meilin, team, course, program) мог это импортировать без циклов.
import { state } from './store.js';

const LISTS = ['diagnoses', 'meds', 'allergies', 'labs', 'studies', 'rules', 'exclude', 'docs', 'medHistory'];
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

// Динамика анализов: по каждому показателю все значения по датам (крупные анализы мочи и крови — тоже).
function labTrends() {
  const by = new Map();
  for (const l of state.health?.labs || []) { const k = String(l.name); if (!by.has(k)) by.set(k, []); by.get(k).push(l); }
  const rows = [...by.entries()].map(([name, arr]) => {
    arr.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const last = arr.at(-1);
    return { name, last: String(last.date), line: `${name}${last.unit ? ` (${last.unit})` : ''}: ${arr.slice(-8).map((l) => `${l.value}${l.flag === 'high' ? '↑' : l.flag === 'low' ? '↓' : ''} [${l.date}]`).join(', ')}${last.ref ? `; норма ${String(last.ref).slice(0, 60)}` : ''}` };
  });
  rows.sort((a, b) => b.last.localeCompare(a.last));
  return rows.slice(0, 140).map((r) => r.line).join('\n');
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
  if (h.timeline?.length) out.push(`История болезни по годам (по документам архива):\n${h.timeline.map((x) => `${x.date}: ${x.text}`).join('\n')}`);
  if (h.labs.length) out.push(`Анализы — динамика по показателям (значения по датам, старые → новые; ↑↓ — вне нормы лаборатории):\n${labTrends()}`);
  else out.push('Анализы: в карту не внесены.');
  if (h.medHistory.length) out.push(`История лекарств из архива (что принимается сейчас — уточнить у ученика):\n${h.medHistory.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''}${m.how ? `, ${m.how}` : ''} (${m.first || '?'} — ${m.last || '?'}${m.status === 'likely_current' ? ', возможно, принимает сейчас' : ', в прошлом'})`).join('\n')}`);
  if (h.studies.length) out.push(`Обследования и заключения (по датам):\n${h.studies.slice(-60).map((s) => `${s.date || '?'}: ${String(s.text).slice(0, 260)}`).join('\n')}`);
  if (h.docs.length) out.push(`Документы в карте: ${h.docs.length}, с ${h.docs[0].date || '?'} по ${h.docs.at(-1).date || '?'}. Последние:\n${h.docs.slice(-15).map((d) => `${d.date || '?'} — ${d.kind}: ${d.title}. ${d.summary}`).join('\n')}`);
  const P = h.plan;
  if (P) {
    if (P.questions?.length) out.push(`Твой план после разбора архива — вопросы ученику (задавай по одному, ответы вноси в карту; отмечай, что уже выяснено):\n${P.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`);
    if (P.exams?.length) out.push(`Твой план — обследования, которые нужно обсудить с врачом:\n${P.exams.map((e) => `- ${e.what} — ${e.why} [${e.when}]`).join('\n')}`);
    if (P.team?.length) out.push(`Твой план — предложения мастерам (предлагай ученику кнопками set_rule, когда обсудите; уже действующие указания — ниже):\n${P.team.map((x) => `- ${WHO_NAME[x.who] || x.who}: ${x.text}`).join('\n')}`);
  }
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
  const maybe = h.medHistory.filter((m) => m.status === 'likely_current' && !meds.some((x) => x.name.toLowerCase() === m.name.toLowerCase()));
  if (maybe.length) out.push(`Возможно, принимает (по архиву, не подтверждено): ${maybe.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''}`).join('; ')}.`);
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
