// Команда мастеров: Лао (тайцзи и цигун), Мэйлин (питание), Ли Ган (силовые), доктор Шэн (здоровье).
// У каждого свой чат и своя специализация. Все видят общую сводку об ученике и знают решения друг друга:
// решение Лао о сегодняшнем дне, этап Ли Гана, норму Мэйлин и ограничения доктора Шэна.
import { state, dateStr, addDays, peekDay } from './store.js';
import { chatReply, aiAvailable, studentContext } from './brain.js';
import { offlineAnswer, MasterError } from './master.js';
import { targets, dayTotals } from './nutrition.js';
import { meilinChat, meilinBrief } from './meilin.js';
import { st as strength, phaseDef, strengthToday, LIGAN_EX, BAND_NAME } from './strength.js';
import { bpMode } from './course.js';
import { t, aiLanguage } from './i18n.js';
import { blocksFor, cachedBlocks, filesNote } from './attach.js';

export const MASTERS = {
  lao: { name: 'Лао', full: 'Мастер Лао', role: 'тайцзи и цигун', seal: '道',
    hello: 'Я рядом. Спросите о любом упражнении, расскажите, как прошло занятие или что болит.',
    chips: ['Что у меня сегодня?', 'Как стоять столбом?', 'Болит поясница, что делать?', 'Давление 160 на 100, заниматься?'] },
  meilin: { name: 'Мэйлин', full: 'Мэйлин', role: 'питание', seal: '食',
    hello: 'Здравствуйте, я Мэйлин, ваш нутрициолог. Я вижу ваш вес, давление, нагрузку, всё, что вы едите, меню и список покупок. Спросите о питании, расскажите, что съели, — я запишу, поправлю меню и покупки.',
    chips: ['Давайте познакомимся поближе', 'Сколько мне ещё можно съесть сегодня?', 'Что мне купить на эту неделю?', 'Чем заменить ужин сегодня?', 'Как идёт моё питание за неделю?'] },
  ligan: { name: 'Ли Ган', full: 'Ли Ган', role: 'силовые', seal: '力',
    hello: 'Ли Ган на связи. Спросите про силовые, резинки, технику или как прошло занятие.',
    chips: ['Когда следующее силовое?', 'Какую резинку брать?', 'После силовой болят мышцы — это нормально?', 'Как дышать при усилии?'] },
  shen: { name: 'Доктор Шэн', full: 'Доктор Шэн', role: 'здоровье', seal: '医',
    hello: 'Здравствуйте, я доктор Шэн. Слежу за давлением, весом, болью и анализами и согласую работу всех мастеров. Расскажите, что беспокоит, или спросите про анализы.',
    chips: ['Как у меня с давлением за неделю?', 'Что спросить у врача?', 'Объясните мои анализы', 'Можно ли мне силовые?'] },
};
export const MASTER_IDS = Object.keys(MASTERS);

// История чатов: Лао — state.chat (как раньше), остальные — state.chats[id].
export function chatOf(who) {
  if (who === 'lao') return state.chat;
  state.chats = state.chats || {};
  return (state.chats[who] = state.chats[who] || []);
}
export function pushChat(who, ...msgs) {
  const arr = chatOf(who);
  arr.push(...msgs);
  if (who === 'lao') state.chat = arr.slice(-40);
  else state.chats[who] = arr.slice(-40);
}

// ---- общие сведения для всей команды ----
const TEAM = `Команда наставников в приложении: мастер Лао — тайцзи и цигун, решает, какой сегодня день (полное занятие, облегчённое, отдых); Мэйлин — питание; Ли Ган — силовые тренировки с резинками и весом тела; доктор Шэн — здоровье: давление, вес, боль, анализы, лекарства и разрешения врача, он согласует работу остальных. Отвечай только в своей области. Если вопрос к коллеге, кратко скажи, что думаешь, и предложи спросить его во вкладке «Мастера». Не противоречь решениям коллег: облегчённый день от Лао и ограничения доктора Шэна обязательны для всех.`;

const SAFETY = `Безопасность важнее прогресса. Ты не ставишь диагнозов, не назначаешь и не отменяешь лекарства. При боли или давлении в груди, внезапной слабости или онемении, нарушении речи, проблемах с мочеиспусканием, давлении выше ста восьмидесяти на сто десять — прекратить нагрузку и звонить 103 или 112.`;

const FILES = 'Ученик может прикладывать к сообщению фото, PDF, таблицы Excel (приходят текстом, по листам, через «;») и текстовые файлы: анализы, выписки, заключения врачей, фото еды и этикеток, фото упражнения. Разбирай их по своей специализации, называй конкретные значения из файла. Если вложение не по твоей части — скажи главное и к кому из коллег с ним обратиться: анализы и выписки подробно разбирает доктор Шэн. Если текст на фото не читается — попроси переснять.';

const VOICE = () => `Пиши на ${aiLanguage()} языке. Ответ прозвучит вслух: простые фразы, без списков, скобок, эмодзи и разметки. Коротко: две–пять фраз, один главный совет. Обращайся на «вы». Ты ИИ-наставник; если спросят — так и скажи.`;

// Что решили другие мастера сегодня и о чём недавно говорили с ними.
export function teamState({ forMeilin = false } = {}) {
  const today = dateStr();
  const d = peekDay(today) || {};
  const lines = [];
  const dec = d.checkin?.decision;
  lines.push(dec ? `Решение Лао на сегодня: режим «${dec.mode}»${dec.skip?.length ? `, пропустить: ${dec.skip.join(', ')}` : ''}.` : 'Опрос самочувствия сегодня ещё не проходили.');
  if (d.bp?.sys) lines.push(`Давление сегодня ${d.bp.sys}/${d.bp.dia} (правило: ${bpMode(d.bp.sys, d.bp.dia)}).`);
  const S = state.strength;
  if (S) lines.push(`Силовые (Ли Ган): этап «${phaseDef().name}», дни ${S.days.join(',')} (0 — вс), врач разрешил силовые: ${S.doctorOk ? 'да' : 'нет, пока только умеренно'}.`);
  if (!forMeilin) { try { lines.push(meilinBrief()); } catch { /* нет данных */ } }
  const h = state.health;
  if (h?.meds?.length) lines.push(`Лекарства: ${h.meds.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''}`).join('; ')}.`);
  if (h?.notes) lines.push(`Заметки доктора Шэна: ${h.notes}`);
  return lines.join('\n');
}
function recentWithOthers(who) {
  const out = [];
  for (const id of MASTER_IDS) {
    if (id === who) continue;
    const c = chatOf(id).filter((m) => m.at && Date.now() - m.at < 7 * 864e5).slice(-4);
    if (c.length) out.push(`С ${MASTERS[id].full}: ${c.map((m) => `${m.role === 'user' ? 'ученик' : 'наставник'}: ${String(m.text).slice(0, 200)}`).join(' / ')}`);
  }
  return out.length ? `Недавние разговоры ученика с коллегами:\n${out.join('\n')}` : '';
}

function healthContext(days = 14) {
  const today = dateStr();
  const rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const ds = addDays(today, -i);
    const d = peekDay(ds);
    if (!d) continue;
    const p = [];
    if (d.bp?.sys) p.push(`АД ${d.bp.sys}/${d.bp.dia}${d.bp.pulse ? `, пульс ${d.bp.pulse}` : ''}`);
    if (d.weight) p.push(`вес ${d.weight}`);
    if (d.waist) p.push(`талия ${d.waist}`);
    if (d.pain?.back != null) p.push(`боль ${d.pain.back}`);
    if (d.checkin?.answers) p.push(`самочувствие ${JSON.stringify(d.checkin.answers)}`);
    if (p.length) rows.push(`${ds}: ${p.join('; ')}`);
  }
  const labs = (state.health?.labs || []).slice(-30).map((l) => `${l.date}: ${l.name} ${l.value}${l.unit ? ` ${l.unit}` : ''}${l.ref ? ` (норма ${l.ref})` : ''}`);
  return `Показатели за ${days} дней:\n${rows.join('\n') || 'нет записей'}${labs.length ? `\nАнализы:\n${labs.join('\n')}` : '\nАнализов в приложении пока нет.'}`;
}

function strengthContext() {
  const S = strength();
  const ex = LIGAN_EX.map((e) => { const x = S.ex[e.id]; return `${e.title}: ${x ? `${x.reps} повт., резинка ${BAND_NAME[x.band]}${x.hist?.length ? `, последние оценки ${x.hist.slice(-3).map((h) => h.r).join(',')}` : ''}` : 'по умолчанию'}`; });
  const td = strengthToday();
  return `Этап «${phaseDef().name}»: подходов ${phaseDef().sets}, отдых ${phaseDef().rest} с, повторы ${phaseDef().minReps}–${phaseDef().maxReps}. Сегодня силовое ${td.planned ? 'по плану' : 'не по плану'}${td.done ? ', уже сделано' : ''}. Резинки у ученика: ${S.bands.map((b) => BAND_NAME[b]).join(', ')}. Занятий на этапе: ${(S.log || []).filter((l) => l.date >= S.since).length}.
Упражнения: ${ex.join('; ')}.`;
}

function systemFor(who) {
  const common = `${TEAM}\n\n${SAFETY}\n\n${FILES}\n\n${VOICE()} Если приложено фото с камеры во время занятия, оцени положение тела в текущем упражнении: одно, что получается, и одно-два исправления; внешность и обстановку не обсуждай.\n\n[Решения команды]\n${teamState()}\n\n${recentWithOthers(who)}`;
  if (who === 'ligan') {
    return `Ты — Ли Ган, наставник по силовым тренировкам в личном приложении ученика. Тренируешь людей зрелого возраста с больной спиной и повышенным давлением: резинки-эспандеры, стул и вес тела, два раза в неделю до часа. Цель ученика — сохранить и нарастить мышцы, сжечь висцеральный жир, укрепить спину. Говоришь бодро, коротко и уверенно, но бережно.
Твои правила: пока врач не разрешил силовые — только умеренная интенсивность, когда можно говорить фразами; выдох на усилии, без задержки дыхания и натуживания; никакой осевой нагрузки на позвоночник, скручиваний с весом, наклонов с круглой спиной и резких рывков; шея нейтрально (протрузия C5–C6); боль, отдающая в ногу или руку, — стоп. Прогрессия медленная: сначала повторы, потом резинка туже. Мышечная усталость на следующий день — нормально, острая боль в суставе или спине — нет.
[Силовые ученика]\n${strengthContext()}\n\n${common}\n\n${studentContext({ days: 7 })}`;
  }
  if (who === 'shen') {
    return `Ты — доктор Шэн, мастер здоровья в личном приложении ученика. Ты сочетаешь знания современной медицины и восточного подхода к здоровью и долголетию. Твоя задача — следить за давлением, пульсом, весом, талией, болью, анализами и лекарствами, объяснять результаты простыми словами, замечать тревожные тенденции, помогать подготовить вопросы к врачу и согласовывать работу мастеров Лао, Мэйлин и Ли Гана. Говоришь спокойно, точно и по-доброму.
Ты не заменяешь лечащего врача: не ставишь диагнозов, не назначаешь, не меняешь и не отменяешь лекарства и дозы. Назначения врача главнее твоих советов. Если показатели вне нормы, объясни, что это может значить, насколько срочно и к какому врачу идти.
[Здоровье ученика]\n${healthContext()}\n\n${common}\n\n${studentContext({ days: 7 })}`;
  }
  return null; // Лао — его собственная системная подсказка в brain.js
}

// ---- базовый режим без нейросети ----
function offlineFor(who, text) {
  const q = String(text || '');
  if (who === 'lao') return offlineAnswer(q);
  if (/груд|одышк|речь|перекос|слабост|онемен|chest|speech|numb/i.test(q)) return offlineAnswer(q);
  if (who === 'meilin') {
    const T = targets();
    const e = dayTotals();
    if (/сколько|ещё|норм|калор|left|how much|calor/i.test(q)) return t('Норма на сегодня {k} ккал и {p} г белка. Уже съедено {ek} ккал и {ep} г белка. Остаток лучше добрать белком и овощами.', { k: T.kcal, p: T.protein, ek: e.kcal, ep: Math.round(e.protein) });
    if (/сол|salt/i.test(q)) return t('Соль — до пяти граммов в день. Меньше колбас, сыров, солений и полуфабрикатов, готовую еду не досаливайте, добавляйте лимон, травы и специи.');
    if (/перекус|вечер|snack|evening/i.test(q)) return t('Перекус — белок плюс овощ или фрукт: творог, кефир, яйцо, горсть орехов с яблоком. Последняя еда за три часа до сна.');
    return offlineAnswer(/питан|еда|food/i.test(q) ? q : `питание ${q}`);
  }
  if (who === 'ligan') {
    const td = strengthToday();
    if (/когда|следующ|next|when/i.test(q)) { const W = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу']; return td.planned ? t('Силовое по плану сегодня. Начните с карточки «Сила с Ли Ганом» на главном экране.') : t('Силовые по плану: {d}. Между ними отдых — мышцы растут именно в это время.', { d: strength().days.map((x) => t(W[x])).join(', ') }); }
    if (/резин|band/i.test(q)) return t('Берите резинку, с которой последние два повтора даются с трудом, но техника не ломается. После занятия отметьте «легко» или «тяжело» — я сам подберу нагрузку дальше.');
    if (/дыш|breath/i.test(q)) return t('Выдох на усилии, вдох на возврате. Дыхание не задерживаем и не натуживаемся — при давлении это особенно важно.');
    if (/болят мышцы|крепатур|sore/i.test(q)) return t('Тянущая усталость в мышцах на следующий день — нормально, она проходит за два–три дня. Острая боль в суставе или спине — не нормально: отметьте «было больно», и я облегчу упражнение.');
    return offlineAnswer(q);
  }
  if (who === 'shen') {
    if (/давлен|pressure/i.test(q)) {
      const v = [];
      for (let i = 0; i < 7; i++) { const b = peekDay(addDays(dateStr(), -i))?.bp; if (b?.sys) v.push(b); }
      if (!v.length) return t('За неделю нет записей давления. Измеряйте утром и вечером сидя, после пяти минут покоя, и записывайте перед занятием.');
      const s = Math.round(v.reduce((a, b) => a + Number(b.sys), 0) / v.length);
      const dd = Math.round(v.reduce((a, b) => a + Number(b.dia), 0) / v.length);
      return t('Среднее давление за неделю {s} на {d}, измерений {n}. Цель обычно ниже ста тридцати пяти на восемьдесят пять дома. Покажите эти записи врачу.', { s, d: dd, n: v.length });
    }
    return offlineAnswer(q);
  }
  return offlineAnswer(q);
}

// Вопрос мастеру. Возвращает { text, offline }.
export async function askTeam(who, { text, image, extra, onDelta, signal, files = [] }) {
  if (!aiAvailable()) {
    const ans = files.length ? t('Чтобы мастер посмотрел фото или файл, подключите сервер или ключ API в настройках. Без нейросети я отвечаю только на вопросы по курсу.') : offlineFor(who, text);
    onDelta?.(ans);
    return { text: ans, offline: true };
  }
  try {
    // История: тексты; к недавним сообщениям с вложениями — сами файлы, пока приложение открыто.
    const blocks = files.length ? blocksFor(files) : null;
    // Запрос к серверу — до 8 МБ: старые вложения добавляем, только пока хватает места.
    let room = 6e6 - (blocks ? JSON.stringify(blocks).length : 0);
    const history = chatOf(who).slice(-12).reverse().map((m) => {
      const txt = `${m.text}${filesNote(m.files)}`;
      let cb = m.role === 'user' ? cachedBlocks(m.at) : null;
      if (cb) { const sz = JSON.stringify(cb).length; if (sz > room) cb = null; else room -= sz; }
      return { role: m.role, content: cb ? [...cb, { type: 'text', text: txt }] : txt };
    }).reverse();
    while (history.length && history[0].role !== 'user') history.shift();
    if (files.length) text = `${text}${filesNote(files)}`;
    if (who === 'meilin') {
      // Мэйлин — агент: видит полное досье и может предлагать действия (записать еду, заменить блюдо, покупки).
      const extra2 = `${TEAM}\n\n${SAFETY}\n\n${FILES}\n\n[Решения команды]\n${teamState({ forMeilin: true })}\n\n${recentWithOthers(who)}${extra ? `\n\n[Сейчас]\n${extra}` : ''}`;
      const r = await meilinChat(text, { history, extra: extra2, signal, blocks });
      onDelta?.(r.text);
      return { text: r.text, actions: r.actions, remembered: r.remembered, offline: false };
    }
    const out = await chatReply(text, { extra: who === 'lao' && blocks ? `${extra || ''}${extra ? '\n' : ''}${FILES}` : extra, image, signal, system: systemFor(who), history, blocks });
    onDelta?.(out);
    return { text: out, offline: false };
  } catch (err) {
    throw new MasterError(err.kind || 'unknown', err.message || t('Не получилось получить ответ.'));
  }
}
