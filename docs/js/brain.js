// «Разум» мастера: обращения к нейросети, память об ученике, составление программы, ответы на опрос.
// Нейросеть работает поверх правил: правила задают границы безопасности, нейросеть может сделать мягче, но не жёстче.
import Anthropic from '../vendor/anthropic-sdk.mjs';
import { MODELS, prepareRequest, runRequest, responseText } from './ai-request.js';
import { state, getApiKey, dateStr, addDays, peekDay, save, logEntry } from './store.js';
import { PRINCIPLES, LEVELS, EXERCISES, INTAKE, CHECKIN, CHECKIN_REPLIES } from './kb.js';
import { FLOW_LINES } from './flow-lines.js';
import { serverConfig, api } from './sync.js';
import { t, aiLanguage } from './i18n.js';

export class BrainError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// Есть ли доступ к нейросети: через свой сервер или по ключу на телефоне.
export const aiAvailable = () => !!(serverConfig() || getApiKey());

export async function call(params, { signal } = {}) {
  const req = prepareRequest(params);
  const cfg = serverConfig();
  try {
    if (cfg) {
      const r = await api('/api/messages', { method: 'POST', body: JSON.stringify(req), signal });
      if (r.status === 429) throw new BrainError('rate', t('Слишком много запросов. Подождите минуту.'));
      if (!r.ok) {
        const info = await r.json().catch(() => ({}));
        if (info.error === 'ai_not_configured') throw new BrainError('api', t('На сервере не задан ключ Claude API.'));
        throw new BrainError('api', info.message ? `Claude ${info.status ?? ''}: ${info.message}` : t('Сервер ответил ошибкой {n}.', { n: r.status }));
      }
      return await r.json();
    }
    const key = getApiKey();
    if (!key) throw new BrainError('nokey', t('Нейросеть не подключена.'));
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1 });
    return await runRequest(client, req, { signal });
  } catch (err) {
    if (err instanceof BrainError) throw err;
    if (err?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError) throw new BrainError('aborted', t('Остановлено.'));
    if (err?.kind === 'auth' || err instanceof Anthropic.AuthenticationError) throw new BrainError('auth', t('Ключ доступа не принят. Проверьте настройки.'));
    if (err instanceof Anthropic.RateLimitError) throw new BrainError('rate', t('Слишком много запросов. Подождите минуту.'));
    if (err instanceof Anthropic.APIConnectionError || err instanceof TypeError) throw new BrainError('network', t('Нет связи. Проверьте интернет.'));
    if (err instanceof Anthropic.APIError) throw new BrainError('api', t('Ошибка сервиса {n}.', { n: err.status ?? '' }));
    throw new BrainError('unknown', t('Не получилось получить ответ.'));
  }
}

export async function callJSON(params, opts) {
  const res = await call(params, opts);
  const text = responseText(res);
  if (text == null) throw new BrainError('refusal', t('Нейросеть не смогла ответить на этот запрос.'));
  try { return JSON.parse(text); } catch { throw new BrainError('format', t('Нейросеть ответила в неверном формате.')); }
}

// ---- образ мастера ----
const PERSONA = `Ты — мастер Лао, наставник тайцзи и цигун в личном приложении одного ученика. Рядом с тобой работают другие наставники: Мэйлин (питание), Ли Ган (силовые тренировки) и доктор Шэн (здоровье, анализы). Много лет учишь людей зрелого возраста, знаешь традицию стиля Ян и оздоровительного цигун «Ба Дуань Цзинь», понимаешь основы восточной медицины и современной реабилитации. Всё, что ученик видит и слышит, пиши на ${aiLanguage()} языке. Обращайся на «вы» (в английском — вежливо и тепло), спокойно, тепло и внимательно, как наставник, а не как врач и не как продавец. Ты ИИ-наставник; если спросят — так и скажи.

Принципы, которым ты следуешь:
${PRINCIPLES.map((p) => `- ${p}`).join('\n')}

Уровни учеников:
${LEVELS.map((l) => `- Уровень ${l.n} «${l.name}»: ${l.who} Цель: ${l.goal}`).join('\n')}

Безопасность важнее прогресса. Ты не ставишь диагнозов, не назначаешь лекарств. При боли или давлении в груди, внезапной слабости или онемении, нарушении речи, проблемах с мочеиспусканием — прекратить занятие и звонить 103 или 112. Шее не нужны круги и запрокидывание, пояснице — наклоны с круглой спиной и глубокие скручивания, при давлении — задержки дыхания и положение головой вниз.`;

const VOICE_RULES = `Пиши на ${aiLanguage()} языке. Твой ответ прозвучит вслух через синтез речи. Пиши простыми фразами, без списков, скобок, эмодзи и разметки. Числа пиши словами, если их удобнее произнести.`;

// Сводка об ученике для нейросети: анкета, программа, память, последние дни.
export function studentContext({ days = 7 } = {}) {
  const today = dateStr();
  const lines = [`Сегодня ${today}.`];
  const p = state.profile;
  if (p.name) lines.push(`Ученика зовут ${p.name}.`);
  if (state.intake) lines.push(`Анкета: ${JSON.stringify(state.intake)}`);
  const pr = state.program;
  if (pr) lines.push(`Программа: уровень ${pr.level}, ступень ${pr.stage}, с ${pr.levelSince}. Ограничения: ${(pr.flags || []).join(', ') || 'нет'}. Исключено: ${(pr.exclude || []).join(', ') || 'ничего'}. Множитель нагрузки ${pr.doseScale}. Предостережения: ${(pr.cautions || []).join('; ') || 'нет'}.`);
  if (state.memory?.summary) lines.push(`Память мастера об ученике: ${state.memory.summary}`);
  const rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const ds = addDays(today, -i);
    const d = peekDay(ds);
    if (!d) continue;
    const parts = [];
    if (d.bp?.sys) parts.push(`АД ${d.bp.sys}/${d.bp.dia}`);
    if (d.checkin) parts.push(`опрос: ${JSON.stringify(d.checkin.answers)}, решение ${d.checkin.decision?.mode}`);
    if (d.pain?.back != null) parts.push(`боль в пояснице ${d.pain.back}`);
    const s = Object.entries(d.sessions || {}).filter(([, v]) => v.done).map(([k, v]) => `${k}${v.partial ? ' частично' : ''}${v.stolbSec ? `, столб ${v.stolbSec}с` : ''}${v.chairReps ? `, стул ${v.chairReps}` : ''}${v.quality != null ? `, без замечаний ${v.quality}%` : ''}`);
    if (s.length) parts.push(`занятия: ${s.join('; ')}`);
    if (d.steps) parts.push(`шаги ${d.steps}`);
    if (d.weight) parts.push(`вес ${d.weight}`);
    if (d.waist) parts.push(`талия ${d.waist}`);
    if (d.note) parts.push(`заметка: ${d.note}`);
    if (parts.length) rows.push(`${ds}: ${parts.join('; ')}`);
  }
  if (rows.length) lines.push(`Дневник:\n${rows.join('\n')}`);
  return lines.join('\n');
}

// ---- 1. Программа по анкете (Sonnet) ----
const EX_IDS = Object.keys(EXERCISES);
const PROGRAM_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['level', 'doseScale', 'exclude', 'focus', 'cautions', 'rationale'],
  properties: {
    level: { type: 'integer', enum: [1, 2, 3] },
    doseScale: { type: 'number', enum: [0.6, 0.7, 0.8, 0.9, 1] },
    exclude: { type: 'array', items: { type: 'string', enum: EX_IDS } },
    focus: { type: 'array', items: { type: 'string' } },
    cautions: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
};

export async function designProgram(intake, base) {
  const catalog = Object.entries(EXERCISES).map(([id, e]) => `${id}: ${e.name}${e.floor ? ' (на полу)' : ''}${e.min > 1 ? ` (с уровня ${e.min})` : ''}`).join('\n');
  const out = await callJSON({
    model: MODELS.expert, effort: 'medium', schema: PROGRAM_SCHEMA,
    system: `${PERSONA}\n\nСейчас ты составляешь начальную программу по анкете ученика. Правила приложения уже предложили базовый вариант; ты можешь сделать его бережнее (понизить уровень, уменьшить множитель нагрузки, исключить упражнения), но не интенсивнее.`,
    messages: [{ role: 'user', content: `Анкета ученика:\n${JSON.stringify(intake, null, 1)}\n\nБазовый вариант по правилам: уровень ${base.level}, ограничения ${base.flags.join(', ') || 'нет'}, баллы слабости ${base.weakness}, причины: ${base.reasons.join('; ') || 'нет'}. Рекомендации к врачу: ${base.doctor.join('; ') || 'нет'}.\n\nКаталог упражнений (id: название):\n${catalog}\n\nВерни программу. level — от 1 до 3, не выше базового. doseScale — множитель повторов и времени. exclude — id упражнений, которые этому ученику пока нельзя. focus — 2–4 главных направления работы. cautions — 2–5 коротких предостережений для этого ученика. rationale — обращение мастера к ученику вслух, 5–7 фраз: что вы увидели в ответах, с какого уровня начинаете и почему, на чём сосредоточитесь, что важно соблюдать. ${VOICE_RULES}` }],
  });
  const level = Math.min(base.level, Math.max(1, out.level | 0));
  return {
    level,
    // Если нейросеть назвала уровень выше разрешённого, её текст мог бы его объявить — тогда текст по правилам.
    clampedLevel: (out.level | 0) > base.level,
    doseScale: Math.min(1, Math.max(0.6, Number(out.doseScale) || 1)),
    exclude: (out.exclude || []).filter((id) => EX_IDS.includes(id) && !['breath', 'close', 'unload'].includes(id)),
    focus: (out.focus || []).slice(0, 5).map(String),
    cautions: (out.cautions || []).slice(0, 6).map(String),
    rationale: (out.level | 0) > base.level ? '' : String(out.rationale || ''),
  };
}

// ---- 2. Ответ на опрос перед занятием (Haiku) ----
const CHECKIN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['say', 'mode', 'skip'],
  properties: {
    say: { type: 'string' },
    mode: { type: 'string', enum: ['full', 'light', 'rest', 'none'] },
    skip: { type: 'array', items: { type: 'string', enum: EX_IDS } },
  },
};
const ORDER = { full: 0, light: 1, rest: 2, none: 3 };

export async function checkinReply(answers, rule, kind) {
  const q = CHECKIN.map((c) => `${c.id}: ${c.say}`).join('\n');
  const out = await callJSON({
    model: MODELS.daily, effort: 'low', schema: CHECKIN_SCHEMA, maxTokens: 4000,
    system: `${PERSONA}\n\n${studentContext()}`,
    messages: [{ role: 'user', content: `Перед занятием (${kind === 'morning' ? 'утро' : kind === 'day' ? 'день' : 'вечер'}) ты задал вопросы:\n${q}\n\nОтветы ученика: ${JSON.stringify(answers)}\nРешение по правилам безопасности: режим ${rule.mode}${rule.reasons.length ? `, причины: ${rule.reasons.join('; ')}` : ''}.\n\nВерни: say — что ты скажешь ученику вслух, 2–4 фразы: отклик на его состояние, что сегодня делаем и одно наставление на занятие, учитывая его историю; mode — режим занятия: full, light, rest или none (не легче, чем решение по правилам); skip — id упражнений, которые сегодня лучше пропустить (обычно пусто). ${VOICE_RULES}` }],
  });
  const mode = ORDER[out.mode] >= ORDER[rule.mode] ? out.mode : rule.mode;
  // Режим урезан правилами — слова нейросети («в полную силу») могли бы ему противоречить.
  const say = mode !== out.mode ? (CHECKIN_REPLIES[rule.key] || CHECKIN_REPLIES[mode] || '') : String(out.say || '');
  return { say, mode, skip: (out.skip || []).filter((id) => EX_IDS.includes(id)) };
}

// ---- 3. Память мастера (Haiku) ----
export async function updateMemory(event) {
  const out = await callJSON({
    model: MODELS.daily, effort: 'low', maxTokens: 4000,
    schema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } },
    system: 'Ты ведёшь краткие заметки мастера Лао (тайцзи) об ученике. Пиши по-русски, сжато, по делу.', // заметки внутренние, всегда по-русски
    messages: [{ role: 'user', content: `Прежние заметки:\n${state.memory?.summary || '(пусто)'}\n\nНовое событие:\n${event}\n\nСвежие данные:\n${studentContext({ days: 3 })}\n\nОбнови заметки: состояние здоровья и его динамика, что получается и что трудно, реакция на нагрузку, особенности характера и мотивации, договорённости. Не больше 1500 знаков. Сохраняй важное из прежних заметок.` }],
  });
  state.memory = { summary: String(out.summary || '').slice(0, 2000), updatedAt: Date.now() };
  save();
  return state.memory;
}

// ---- 4. Пересмотр уровня (Sonnet) ----
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['decision', 'say', 'reasons'],
  properties: {
    decision: { type: 'string', enum: ['stay', 'stage_up', 'level_up', 'step_back'] },
    say: { type: 'string' },
    reasons: { type: 'array', items: { type: 'string' } },
  },
};

export async function reviewProgress(ready) {
  const out = await callJSON({
    model: MODELS.expert, effort: 'medium', schema: REVIEW_SCHEMA,
    system: `${PERSONA}\n\n${studentContext({ days: 14 })}`,
    messages: [{ role: 'user', content: `Еженедельный пересмотр программы. Оценка готовности по правилам: ${ready.score} из 100. Условия перехода на следующий уровень: ${ready.crit.map((c) => `${c.text} — ${c.ok ? 'выполнено' : 'не выполнено'} (${c.have})`).join('; ')}. Повышение ступени нагрузки по правилам ${ready.stageUp ? 'возможно' : 'пока рано'}. Признаки ухудшения: ${ready.regress ? 'есть' : 'нет'}. Следующий уровень ${ready.nextScripted ? 'готов в приложении' : 'ещё не расписан в приложении'}.\n\nПрими решение как мастер, без спешки: stay — оставить как есть; stage_up — следующая ступень нагрузки (только если правила разрешают); level_up — следующий уровень (только если все условия выполнены и уровень готов в приложении); step_back — сделать мягче. say — обращение к ученику вслух, 3–5 фраз: как прошли две недели, решение и почему, на чём сосредоточиться. reasons — 2–4 коротких причины. ${VOICE_RULES}` }],
  });
  let decision = out.decision;
  if (decision === 'level_up' && !(ready.ready && ready.nextScripted)) decision = ready.stageUp ? 'stage_up' : 'stay';
  if (decision === 'stage_up' && !ready.stageUp) decision = 'stay';
  const lines = { step_back: FLOW_LINES.stepBack, level_up: FLOW_LINES.levelUp, stage_up: FLOW_LINES.stageUp, stay: FLOW_LINES.stay };
  const say = decision !== out.decision ? lines[decision] : String(out.say || '');
  return { decision, say, reasons: (out.reasons || []).map(String) };
}

// ---- 5. Свободная беседа (Haiku) ----
export async function chatReply(text, { extra = '', image = null, signal } = {}) {
  const history = state.chat.slice(-10).map((m) => ({ role: m.role, content: m.text }));
  while (history.length && history[0].role !== 'user') history.shift();
  const preface = `${extra ? `[Сейчас]\n${extra}\n\n` : ''}[Слова ученика]\n${text}`;
  const content = image
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }, { type: 'text', text: preface }]
    : preface;
  const res = await call({
    model: MODELS.daily, effort: 'low', maxTokens: 4000,
    system: `${PERSONA}\n\nОтвечай коротко: две–четыре фразы, один совет за раз. Если приложено фото с камеры, оцени положение тела в текущем упражнении: одно, что получается, и одно-два исправления. Внешность и обстановку не обсуждай. ${VOICE_RULES}\n\n${studentContext()}`,
    messages: [...history, { role: 'user', content }],
  }, { signal });
  const out = responseText(res);
  if (out == null) throw new BrainError('refusal', t('На это мастер ответить не может. Спросите иначе или обратитесь к врачу.'));
  return out;
}

// Запись события в журнал и, если есть нейросеть, обновление памяти в фоне.
export function remember(kind, text) {
  logEntry(kind, 'event', text);
  save();
  if (aiAvailable()) updateMemory(text).catch(() => { /* память обновится в следующий раз */ });
}

export { INTAKE };
