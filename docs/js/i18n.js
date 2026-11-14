// Язык интерфейса. Ключ перевода — сам русский текст: t('Сегодня') → 'Today' в английском словаре.
// Новый язык = новый словарь в папке lang/ и строка в LANGS. Голос мастера пока всегда русский.
import EN from './lang/en.js';

export const LANGS = [
  { id: 'ru', name: 'Русский', locale: 'ru-RU', speech: 'ru-RU' },
  { id: 'en', name: 'English', locale: 'en-GB', speech: 'en-US' },
];
const DICTS = { en: EN };

function savedLang() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const s = JSON.parse(localStorage.getItem('taichi.state.v1') || '{}');
    return s.settings?.lang || null;
  } catch { return null; }
}
function systemLang() {
  if (typeof navigator === 'undefined') return 'ru';
  const l = (navigator.language || 'ru').slice(0, 2).toLowerCase();
  return LANGS.some((x) => x.id === l) ? l : 'ru';
}

// Язык выбирается один раз при загрузке; при смене приложение перезагружается.
// По умолчанию русский; язык телефона не навязываем.
export const lang = savedLang() || 'ru';
export const suggestedLang = systemLang;
const dict = DICTS[lang] || null;
if (typeof document !== 'undefined') document.documentElement.lang = lang;

export function t(key, vars) {
  let s = (dict && dict[key]) || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
  return s;
}

export const locale = () => (LANGS.find((x) => x.id === lang) || LANGS[0]).locale;
export const speechLang = () => (LANGS.find((x) => x.id === lang) || LANGS[0]).speech;
// Название языка для подсказки нейросети.
export const aiLanguage = () => ({ ru: 'русском', en: 'английском (English)' }[lang] || 'русском');
