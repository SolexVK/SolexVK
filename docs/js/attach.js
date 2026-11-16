// Вложения в чате с мастерами: фото, PDF и текстовые файлы (анализы, выписки, фото еды, этикетки, меню).
// Файл целиком уходит нейросети только с тем сообщением, к которому приложен (и пока приложение открыто —
// ещё в двух следующих вопросах, чтобы можно было переспросить). В истории чата хранится только миниатюра и имя.
import { shrinkPhoto } from './nutrition.js';
import { t } from './i18n.js';

export const MAX_FILES = 4;
const MAX_PDF = 5 * 1024 * 1024; // сервер принимает до 8 МБ, base64 добавляет треть
const MAX_TEXT = 60000;
export const ACCEPT = 'image/*,application/pdf,.pdf,.txt,.csv,.md,.json,text/plain,text/csv,.xlsx,.xlsm,.xls,.ods,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.oasis.opendocument.spreadsheet';
const MAX_SHEET_FILE = 10 * 1024 * 1024;

// Библиотека SheetJS (Apache 2.0) — грузится только когда приложили таблицу.
let xlsxLib = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxLib) {
    xlsxLib = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = new URL('../vendor/sheetjs/xlsx.core.min.js', import.meta.url).href;
      sc.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('xlsx')));
      sc.onerror = () => { xlsxLib = null; reject(new Error('xlsx')); };
      document.head.append(sc);
    });
  }
  return xlsxLib;
}

// Таблица Excel → текст: каждый лист в CSV (через «;»), пустые строки убраны.
export async function sheetToText(buf) {
  const X = await loadXLSX();
  const wb = X.read(buf, { type: 'array', cellDates: true, dense: true });
  const parts = [];
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    if (!ws) continue;
    const csv = X.utils.sheet_to_csv(ws, { FS: ';', blankrows: false, dateNF: 'yyyy-mm-dd', strip: true }).trim();
    if (csv) parts.push(`Лист «${sn}»:\n${csv}`);
  }
  return parts.join('\n\n');
}

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
  if (/\.(xlsx|xlsm|xls|ods)$/i.test(name) || /spreadsheet|ms-excel/.test(type)) {
    if (file.size > MAX_SHEET_FILE) throw new Error(t('Таблица «{n}» больше 10 МБ. Оставьте в ней только нужные листы.', { n: name }));
    let text;
    try { text = await sheetToText(await file.arrayBuffer()); } catch (err) {
      throw new Error(err.message === 'xlsx' ? t('Не загрузилась программа для чтения Excel. Проверьте интернет и попробуйте ещё раз.') : t('Не получилось прочитать таблицу «{n}». Сохраните её как .xlsx или CSV.', { n: name }));
    }
    if (!text) throw new Error(t('Таблица «{n}» пустая.', { n: name }));
    const cut = text.length > MAX_TEXT;
    return { kind: 'sheet', name, text: cut ? `${text.slice(0, MAX_TEXT)}\n[…таблица обрезана: слишком большая]` : text };
  }
  if (type.startsWith('text/') || /\.(txt|csv|md|json)$/i.test(name)) {
    const text = (await file.text()).slice(0, MAX_TEXT);
    return { kind: 'text', name, text };
  }
  throw new Error(t('Файл «{n}» пока не поддерживается. Пришлите фото, PDF, таблицу Excel или текстовый файл.', { n: name }));
}

// Вложения → блоки сообщения для Claude.
export function blocksFor(files = []) {
  return files.map((f) => {
    if (f.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.data } };
    if (f.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: f.name };
    return { type: 'text', text: `${f.kind === 'sheet' ? 'Таблица Excel' : 'Файл'} «${f.name}»:\n${f.text}` };
  });
}

// Что сохраняем в истории чата: без самих данных.
export const fileMeta = (files = []) => files.map((f) => ({ kind: f.kind, name: f.name, ...(f.thumb ? { thumb: f.thumb } : {}) }));
export const filesNote = (files = []) => (files.length ? `\n[Приложено: ${files.map((f) => `${f.kind === 'image' ? 'фото' : f.kind === 'pdf' ? 'PDF' : f.kind === 'sheet' ? 'таблица' : 'файл'} «${f.name}»`).join(', ')}]` : '');

// Кэш содержимого вложений на время работы приложения: ключ — время сообщения.
const cache = new Map();
export function rememberFiles(at, files) {
  if (!files?.length) return;
  cache.set(at, blocksFor(files));
  while (cache.size > 2) cache.delete(cache.keys().next().value);
}
export const cachedBlocks = (at) => cache.get(at) || null;
