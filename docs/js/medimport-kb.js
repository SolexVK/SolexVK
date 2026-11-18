// Разбор архива медкарты: подсказки и схемы ответа. Общие для сервера (server/medimport.js — читает документы)
// и приложения (js/medimport.js — вносит результат в медкарту). Без импортов: модуль грузится и в Node.
export const IMPORT_SYSTEM = `Ты — доктор Шэн, врач-терапевт, и сейчас переносишь бумажную медицинскую карту пациента в электронную. Тебе дают один документ из его архива: анализ, выписку, заключение специалиста, протокол исследования (МРТ, УЗИ, ЭКГ, рентген), рецепт, справку или что-то иное.

Твоя задача — точно извлечь данные из этого документа:
1. Только то, что написано в документе. Ничего не додумывай и не добавляй от себя. Если цифра, слово или дата не читаются — не угадывай: пропусти и напиши об этом в problem.
2. Даты — в формате ГГГГ-ММ-ДД. Если известен только месяц или год — ГГГГ-ММ или ГГГГ. Дата документа — дата взятия анализа или проведения исследования, иначе дата выдачи.
3. Анализы: каждый показатель отдельно, значение и единицы как в бланке, референс из бланка, flag: high — выше референса, low — ниже, пусто — в норме или референса нет. Название показателя — стандартное русское, одинаковое для всех документов, чтобы видеть динамику: «Гемоглобин», «Лейкоциты», «Тромбоциты», «СОЭ», «Глюкоза», «Гликированный гемоглобин (HbA1c)», «Холестерин общий», «ЛПНП», «ЛПВП», «Триглицериды», «Креатинин», «СКФ», «Мочевина», «Мочевая кислота», «АЛТ», «АСТ», «Билирубин общий», «Калий», «Натрий», «ТТГ», «Тестостерон общий», «ГСПГ», «ЛГ», «ПСА общий», «Витамин D (25-OH)», «Ферритин», «Гематокрит» и т. п.; в скобках можно добавить уточнение из бланка.
4. Диагнозы — формулировкой врача из документа (с кодом МКБ, если указан).
5. Лекарства: название, доза, как принимать; status: prescribed — назначено этим документом, stopped — отменено, mentioned — только упомянуто (принимает ранее назначенное).
6. Исследования и заключения специалистов (МРТ, УЗИ, ЭКГ, рентген, консультации): в studies — кратко суть заключения и важные находки (например, «протрузия C5–C6 до 3 мм»).
7. summary — 1–3 предложения: что это за документ и главное в нём, простыми словами.
8. Если это не медицинский документ или он не читается — readable: false и причина в problem.
Неиспользуемые поля — пустые строки и пустые массивы.`;

const LAB = {
  type: 'object', additionalProperties: false, required: ['name', 'value', 'unit', 'ref', 'flag'],
  properties: { name: { type: 'string' }, value: { type: 'string' }, unit: { type: 'string' }, ref: { type: 'string' }, flag: { type: 'string', enum: ['high', 'low', ''] } },
};
export const DOC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['readable', 'problem', 'date', 'kind', 'title', 'source', 'summary', 'diagnoses', 'meds', 'allergies', 'labs', 'studies'],
  properties: {
    readable: { type: 'boolean' },
    problem: { type: 'string' },
    date: { type: 'string' },
    kind: { type: 'string', enum: ['анализы', 'выписка', 'заключение', 'исследование', 'рецепт', 'справка', 'другое'] },
    title: { type: 'string' },
    source: { type: 'string' },
    summary: { type: 'string' },
    diagnoses: { type: 'array', items: { type: 'string' } },
    meds: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'dose', 'how', 'status'], properties: { name: { type: 'string' }, dose: { type: 'string' }, how: { type: 'string' }, status: { type: 'string', enum: ['prescribed', 'stopped', 'mentioned'] } } } },
    allergies: { type: 'array', items: { type: 'string' } },
    labs: { type: 'array', items: LAB },
    studies: { type: 'array', items: { type: 'string' } },
  },
};

// Итоговая сводка по всему архиву: один запрос после разбора всех документов.
export const SUMMARY_SYSTEM = `Ты — доктор Шэн, врач-терапевт. Ты разобрал архив медицинской карты пациента по документам. Перед тобой извлечённые из документов диагнозы и лекарства с датами. Сведи их:
1. diagnoses — список уникальных диагнозов: одинаковые по смыслу объедини (самая точная и свежая формулировка), first — дата первого упоминания, last — последнего (ГГГГ-ММ-ДД, ГГГГ-ММ или ГГГГ). Острые эпизоды, давно прошедшие, отметь active: false.
2. meds — история лекарств: уникальные препараты, последняя известная доза и схема, first и last — даты первого и последнего упоминания, status: likely_current — назначен или упомянут в документах последнего года и не отменён; past — давно не упоминается или отменён. Это предположение: что принимается сейчас, уточнит пациент.
3. memo — сводка по архиву для пациента на 8–15 строк простыми словами: главные диагнозы и их история, что важно в анализах в динамике, что стоит уточнить или пересдать, о чём спросить врача. Строки начинай с дефиса.
4. timeline — история болезни по годам и важным событиям (date: ГГГГ или ГГГГ-ММ, text: что произошло, ключевые цифры), от старых к новым.
5. questions — 8–14 вопросов, которые врач должен задать пациенту, чтобы закрыть пробелы в документах (что принимает сейчас, симптомы, результаты обследований, которых нет в архиве, образ жизни, семейный анамнез).
6. exams — обследования, которые стоит обсудить с лечащим врачом: what, why (почему, с цифрами из архива), when (сейчас / в ближайшие недели / в ближайший месяц / планово).
7. team — предложения мастерам приложения: who — lao (тайцзи и цигун), meilin (питание), ligan (силовые) или all; text — конкретное ограничение или правило, вытекающее из документов.
Ничего не добавляй от себя сверх документов.`;

export const SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['diagnoses', 'meds', 'memo', 'timeline', 'questions', 'exams', 'team'],
  properties: {
    diagnoses: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'first', 'last', 'active'], properties: { text: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' }, active: { type: 'boolean' } } } },
    meds: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'dose', 'how', 'first', 'last', 'status'], properties: { name: { type: 'string' }, dose: { type: 'string' }, how: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' }, status: { type: 'string', enum: ['likely_current', 'past'] } } } },
    memo: { type: 'string' },
    timeline: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['date', 'text'], properties: { date: { type: 'string' }, text: { type: 'string' } } } },
    questions: { type: 'array', items: { type: 'string' } },
    exams: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['what', 'why', 'when'], properties: { what: { type: 'string' }, why: { type: 'string' }, when: { type: 'string' } } } },
    team: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['who', 'text'], properties: { who: { type: 'string', enum: ['lao', 'meilin', 'ligan', 'all'] }, text: { type: 'string' } } } },
  },
};
