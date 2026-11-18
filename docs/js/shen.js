// Доктор Шэн — личный врач ученика и координатор команды по здоровью.
// Устройство:
//   1. Медицинская карта (health.js, state.health): диагнозы, лекарства, аллергии, анализы, обследования, заметки,
//      разрешение на силовые, личные пороги давления, исключённые упражнения и указания мастерам.
//   2. Профессиональная база (shen-kb.js) — согласованный с учеником образ врача.
//   3. Чат-агент (shenChat): отвечает голосом (say), пишет письменные тексты (memo: сводка для врача, разбор анализов)
//      и предлагает изменения карты и указания мастерам (actions). Всё вносится только по кнопке ученика.
//   4. Остальные мастера читают рамки доктора (health.doctorFrame) в каждом своём запросе: чат Лао, опрос перед
//      занятием, пересмотр программы, досье Мэйлин (чат, меню, замены, фото еды), чат Ли Гана. Пороги давления
//      меняют решение о занятии (course.bpMode), исключённые упражнения убираются из занятий (program.resolvePlan).
import { save, dateStr } from './store.js';
import { MODELS } from './ai-request.js';
import { callJSON } from './brain.js';
import { aiLanguage } from './i18n.js';
import { SHEN_ROLE, SHEN_METHOD, SHEN_AGENT } from './shen-kb.js';
import { health, cardText, newId, WHO_NAME, BP_DEFAULT } from './health.js';
import { EXERCISES } from './kb.js';
import { LIGAN_EX, st as strength } from './strength.js';

// Упражнения, которые доктор может исключить: цигун и тайцзи (Лао) и силовые (Ли Ган).
export function exerciseList() {
  return [
    ...Object.entries(EXERCISES).map(([id, e]) => ({ id, title: e.name, who: 'lao' })),
    ...LIGAN_EX.map((e) => ({ id: e.id, title: e.title, who: 'ligan' })),
  ];
}
const EX_IDS = () => exerciseList().map((e) => e.id);

export function shenSystem(task = '') {
  const ex = exerciseList().map((e) => `${e.id} — ${e.title} (${e.who === 'lao' ? 'Лао' : 'Ли Ган'})`).join('; ');
  const stable = `${SHEN_ROLE}\n\n${SHEN_METHOD}\n\nПиши на ${aiLanguage()} языке, обращайся на «вы».\n\n[Медицинская карта ученика]\n${cardText()}\n\n[Упражнения программы — id для exclude_exercise]\n${ex}`;
  const now = `Сейчас ${new Date().toLocaleString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}.`;
  return [stable, `${now}${task ? `\n\n${task}` : ''}`];
}

const LAB = {
  type: 'object', additionalProperties: false, required: ['name', 'value', 'unit', 'ref', 'flag'],
  properties: { name: { type: 'string' }, value: { type: 'string' }, unit: { type: 'string' }, ref: { type: 'string' }, flag: { type: 'string', enum: ['high', 'low', ''] } },
};
const TYPES = ['add_diagnosis', 'add_med', 'stop_med', 'add_allergy', 'add_labs', 'add_study', 'note', 'set_rule', 'remove_rule', 'exclude_exercise', 'allow_exercise', 'bp_limits', 'strength_clearance'];
const ACTION = () => ({
  type: 'object', additionalProperties: false,
  required: ['type', 'label', 'text', 'name', 'dose', 'date', 'source', 'who', 'ex', 'labs', 'light_sys', 'light_dia', 'stop_sys', 'stop_dia', 'ok'],
  properties: {
    type: { type: 'string', enum: TYPES },
    label: { type: 'string' }, text: { type: 'string' }, name: { type: 'string' }, dose: { type: 'string' },
    date: { type: 'string' }, source: { type: 'string' },
    who: { type: 'string', enum: ['lao', 'meilin', 'ligan', 'all', 'none'] },
    ex: { type: 'string', enum: [...EX_IDS(), 'none'] },
    labs: { type: 'array', items: LAB },
    light_sys: { type: 'integer' }, light_dia: { type: 'integer' }, stop_sys: { type: 'integer' }, stop_dia: { type: 'integer' },
    ok: { type: 'boolean' },
  },
});
const REPLY = () => ({
  type: 'object', additionalProperties: false, required: ['say', 'memo', 'actions'],
  properties: { say: { type: 'string' }, memo: { type: 'string' }, actions: { type: 'array', items: ACTION() } },
});

export async function shenChat(text, { history = [], extra = '', signal, blocks = null } = {}) {
  const out = await callJSON({
    model: MODELS.expert, effort: blocks?.length ? 'medium' : 'low', schema: REPLY(), maxTokens: 8000,
    system: shenSystem(`${extra}\n\n${SHEN_AGENT}`),
    messages: [...history, { role: 'user', content: blocks?.length ? [...blocks, { type: 'text', text }] : text }],
  }, { signal });
  const actions = (out.actions || []).filter((a) => TYPES.includes(a.type)).slice(0, 8).map((a) => ({ ...a, agent: 'shen' }));
  return { text: String(out.say || ''), memo: String(out.memo || '').trim(), actions };
}

const clean = (s) => String(s || '').trim();
const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();

// Выполнить предложение доктора (по кнопке ученика). Возвращает текст подтверждения.
export function applyShenAction(a) {
  const h = health();
  const date = clean(a.date);
  const source = clean(a.source);
  const at = Date.now();
  switch (a.type) {
    case 'add_diagnosis': {
      if (!clean(a.text)) throw new Error('Нечего записать.');
      if (!h.diagnoses.some((d) => same(d.text, a.text))) h.diagnoses.push({ id: newId(), text: clean(a.text), date, source, at });
      save(); return 'Диагноз внесён в медкарту.';
    }
    case 'add_med': {
      const name = clean(a.name);
      if (!name) throw new Error('Нечего записать.');
      const cur = h.meds.find((m) => !m.stopped && same(m.name, name));
      const rec = { name, dose: clean(a.dose), when: clean(a.text), date, source, at };
      if (cur) Object.assign(cur, rec); else h.meds.push({ id: newId(), ...rec });
      save(); return 'Лекарство внесено в медкарту. Мастера будут его учитывать.';
    }
    case 'stop_med': {
      const m = h.meds.find((x) => !x.stopped && same(x.name, a.name));
      if (!m) throw new Error('Такого лекарства в карте нет.');
      m.stopped = date || dateStr();
      save(); return 'Отмечено: лекарство отменено врачом.';
    }
    case 'add_allergy': {
      if (!clean(a.text)) throw new Error('Нечего записать.');
      if (!h.allergies.some((x) => same(x.text, a.text))) h.allergies.push({ id: newId(), text: clean(a.text), source, at });
      save(); return 'Внесено в медкарту.';
    }
    case 'add_labs': {
      const labs = (a.labs || []).filter((l) => clean(l.name) && clean(l.value));
      if (!labs.length) throw new Error('Нечего записать.');
      const d = date || dateStr();
      let n = 0;
      for (const l of labs) {
        const rec = { date: d, name: clean(l.name), value: clean(l.value), unit: clean(l.unit), ref: clean(l.ref), flag: l.flag || '', source };
        const dup = h.labs.find((x) => x.date === d && same(x.name, rec.name));
        if (dup) Object.assign(dup, rec); else { h.labs.push({ id: newId(), ...rec }); n++; }
      }
      h.labs.sort((x, y) => String(x.date).localeCompare(String(y.date)));
      if (h.labs.length > 400) h.labs = h.labs.slice(-400);
      save(); return `Анализы внесены в медкарту: ${labs.length}.`;
    }
    case 'add_study': {
      if (!clean(a.text)) throw new Error('Нечего записать.');
      h.studies.push({ id: newId(), date, text: clean(a.text), source, at });
      save(); return 'Обследование внесено в медкарту.';
    }
    case 'note': {
      if (!clean(a.text)) throw new Error('Нечего записать.');
      h.notes = [h.notes, `${dateStr()}: ${clean(a.text)}`].filter(Boolean).join('\n').slice(-3000);
      save(); return 'Заметка внесена в медкарту.';
    }
    case 'set_rule': {
      const who = WHO_NAME[a.who] ? a.who : 'all';
      if (!clean(a.text)) throw new Error('Нечего записать.');
      if (!h.rules.some((r) => r.who === who && same(r.text, a.text))) h.rules.push({ id: newId(), who, text: clean(a.text), source, date: dateStr(), at });
      save(); return who === 'meilin' ? 'Указание передано Мэйлин. Она учтёт его в советах и в следующем меню.' : `Указание передано: ${WHO_NAME[who]}.`;
    }
    case 'remove_rule': {
      const n = h.rules.length;
      h.rules = h.rules.filter((r) => !same(r.text, a.text));
      if (h.rules.length === n) throw new Error('Такого указания нет.');
      save(); return 'Указание снято.';
    }
    case 'exclude_exercise': {
      const e = exerciseList().find((x) => x.id === a.ex);
      if (!e) throw new Error('Не нашёл такое упражнение.');
      if (!h.exclude.some((x) => x.id === e.id)) h.exclude.push({ id: e.id, title: e.title, why: clean(a.text), date: dateStr() });
      save(); return `Упражнение «${e.title}» убрано из занятий.`;
    }
    case 'allow_exercise': {
      const n = h.exclude.length;
      h.exclude = h.exclude.filter((x) => x.id !== a.ex);
      if (h.exclude.length === n) throw new Error('Это упражнение не было исключено.');
      save(); return 'Упражнение возвращено в занятия.';
    }
    case 'bp_limits': {
      const v = (x, max) => { const n = Number(x); return n >= 80 && n <= max ? Math.round(n) : max; };
      const light = { sys: v(a.light_sys, BP_DEFAULT.light.sys), dia: v(a.light_dia, BP_DEFAULT.light.dia) };
      const stop = { sys: v(a.stop_sys, BP_DEFAULT.stop.sys), dia: v(a.stop_dia, BP_DEFAULT.stop.dia) };
      stop.sys = Math.max(stop.sys, light.sys); stop.dia = Math.max(stop.dia, light.dia);
      h.bp = { light, stop, source, date: dateStr() };
      save(); return `Пороги давления: облегчённое занятие с ${light.sys}/${light.dia}, отмена с ${stop.sys}/${stop.dia}.`;
    }
    case 'strength_clearance': {
      strength().doctorOk = !!a.ok;
      h.strengthOk = { ok: !!a.ok, date: date || dateStr(), source };
      save(); return a.ok ? 'Отмечено: врач разрешил силовые. Ли Ган может постепенно повышать нагрузку.' : 'Отмечено: силовые пока только умеренно.';
    }
    default: throw new Error('Неизвестное действие.');
  }
}

// Удаление записи из карты (кнопка ✕ в медкарте).
export function dropRecord(list, id) {
  const h = health();
  if (list === 'bp') { delete h.bp; save(); return; }
  if (!Array.isArray(h[list])) return;
  h[list] = h[list].filter((x) => x.id !== id);
  save();
}
