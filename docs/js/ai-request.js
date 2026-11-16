// Общая часть запросов к Claude: используется и в приложении, и на сервере.
// Ежедневные беседы — Claude Haiku 5.5; программа и пересмотр уровня — Claude Sonnet 5.5.
export const MODELS = { daily: 'claude-haiku-5-5', expert: 'claude-sonnet-5-5' };
export const ALLOWED_MODELS = new Set(Object.values(MODELS));

// Готовит запрос. Для Sonnet включаем серверный запасной вариант на случай отказа модели;
// у Haiku такой возможности нет.
export function prepareRequest({ model, system, messages, maxTokens = 16000, effort, schema }) {
  if (!ALLOWED_MODELS.has(model)) throw new Error('model_not_allowed');
  const body = {
    model,
    max_tokens: Math.min(maxTokens, 16000),
    system,
    messages,
    output_config: { effort: effort || (model === MODELS.expert ? 'medium' : 'low') },
  };
  if (schema) body.output_config.format = { type: 'json_schema', schema };
  if (model === MODELS.expert) {
    body.betas = ['server-side-fallback-2026-07-01'];
    body.fallbacks = 'default';
    return { beta: true, body };
  }
  return { beta: false, body };
}

// Выполняет запрос через SDK-клиент (в браузере или на сервере).
export async function runRequest(client, req, opts = {}) {
  const msg = req.beta
    ? await client.beta.messages.create(req.body, opts)
    : await client.messages.create(req.body, opts);
  return { content: msg.content, stop_reason: msg.stop_reason, model: msg.model, usage: msg.usage || null };
}

// Достаёт текст ответа; при отказе модели возвращает null.
export function responseText(res) {
  if (!res || res.stop_reason === 'refusal') return null;
  return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
