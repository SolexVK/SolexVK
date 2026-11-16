// Вложения в чате с мастерами: фото, PDF и текстовые файлы (анализы, выписки, фото еды, этикетки, меню).
// Файл целиком уходит нейросети только с тем сообщением, к которому приложен (и пока приложение открыто —
// ещё в двух следующих вопросах, чтобы можно было переспросить). В истории чата хранится только миниатюра и имя.
import { shrinkPhoto } from './nutrition.js';
import { t } from './i18n.js';

export const MAX_FILES = 4;
const MAX_PDF = 5 * 1024 * 1024; // сервер принимает до 8 МБ, base64 добавляет треть
const MAX_TEXT = 60000;
export const ACCEPT = 'image/*,application/pdf,.pdf,.txt,.csv,.md,.json,text/plain,text/csv';

const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error('read'));
  r.readAsDataURL(file);
});

// Файл → вложение { kind, name, ... } или ошибка с понятным текстом.
export async function readAttachment(file) {
  const name = file.name || t('файл');
  const type = file.type || '';
  if (type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(name)) {
    try {
      // 1600 px — чтобы мелкий текст анализов и этикеток оставался читаемым.
      const ph = await shrinkPhoto(file, 1600);
      return { kind: 'image', name, data: ph.base64, thumb: ph.thumb };
    } catch {
      throw new Error(t('Не получилось открыть изображение «{n}». Попробуйте сохранить его как JPEG.', { n: name }));
    }
  }
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
    if (file.size > MAX_PDF) throw new Error(t('Файл «{n}» больше 5 МБ. Сфотографируйте нужные страницы или сожмите PDF.', { n: name }));
    return { kind: 'pdf', name, data: await toBase64(file) };
  }
  if (type.startsWith('text/') || /\.(txt|csv|md|json)$/i.test(name)) {
    const text = (await file.text()).slice(0, MAX_TEXT);
    return { kind: 'text', name, text };
  }
  throw new Error(t('Файл «{n}» пока не поддерживается. Пришлите фото, PDF или текстовый файл.', { n: name }));
}

// Вложения → блоки сообщения для Claude.
export function blocksFor(files = []) {
  return files.map((f) => {
    if (f.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.data } };
    if (f.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: f.name };
    return { type: 'text', text: `Файл «${f.name}»:\n${f.text}` };
  });
}

// Что сохраняем в истории чата: без самих данных.
export const fileMeta = (files = []) => files.map((f) => ({ kind: f.kind, name: f.name, ...(f.thumb ? { thumb: f.thumb } : {}) }));
export const filesNote = (files = []) => (files.length ? `\n[Приложено: ${files.map((f) => `${f.kind === 'image' ? 'фото' : f.kind === 'pdf' ? 'PDF' : 'файл'} «${f.name}»`).join(', ')}]` : '');

// Кэш содержимого вложений на время работы приложения: ключ — время сообщения.
const cache = new Map();
export function rememberFiles(at, files) {
  if (!files?.length) return;
  cache.set(at, blocksFor(files));
  while (cache.size > 2) cache.delete(cache.keys().next().value);
}
export const cachedBlocks = (at) => cache.get(at) || null;
