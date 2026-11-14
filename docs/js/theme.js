// Цветовые темы в восточном стиле. auto — бумага днём и тушь ночью, по настройке айфона.
import { state } from './store.js';

export const PALETTES = [
  { id: 'paper', name: 'Рисовая бумага', bg: '#f2ebdd', accent: '#2e5b4e', seal: '#b0362a', ink: '#1f1a14', dark: false },
  { id: 'ink', name: 'Ночная тушь', bg: '#121110', accent: '#cfa95e', seal: '#d4553f', ink: '#ede6d9', dark: true },
  { id: 'jade', name: 'Нефрит', bg: '#e4ede7', accent: '#1d6b58', seal: '#b23a2b', ink: '#11241c', dark: false },
  { id: 'celadon', name: 'Селадон', bg: '#e2eaec', accent: '#2b6880', seal: '#b23a2b', ink: '#13232a', dark: false },
  { id: 'lacquer', name: 'Красный лак', bg: '#22100e', accent: '#dcb05e', seal: '#e8603f', ink: '#f4e7d6', dark: true },
  { id: 'bamboo', name: 'Бамбук', bg: '#ebe8d7', accent: '#4f6e27', seal: '#a8402c', ink: '#252914', dark: false },
];

export function applyPalette(id = state.settings.palette || 'auto') {
  const root = document.documentElement;
  if (id === 'auto' || !PALETTES.some((p) => p.id === id)) delete root.dataset.palette;
  else root.dataset.palette = id;
  const p = PALETTES.find((x) => x.id === id);
  // Цвет строки состояния айфона под фон темы.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    if (p) { m.setAttribute('content', p.bg); m.removeAttribute('media'); }
  });
}

// Символ тайцзи для экранов ожидания.
export const TAIJI = `<svg class="taiji" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="48" class="yin"/><path class="yang" d="M50 2a48 48 0 0 1 0 96a24 24 0 0 1 0-48a24 24 0 0 0 0-48z"/><circle cx="50" cy="26" r="7" class="yin"/><circle cx="50" cy="74" r="7" class="yang"/><circle cx="50" cy="50" r="48" fill="none" stroke="currentColor" stroke-width="2" opacity="0.4"/></svg>`;

// Облачный разделитель.
export const CLOUD_RULE = `<svg class="cloud-rule" viewBox="0 0 360 18" preserveAspectRatio="none" aria-hidden="true"><path d="M0 9H140M220 9H360" stroke="currentColor" stroke-width="1"/><path d="M150 9c0-4 4-7 8-5c1-3 6-4 8-1c2-3 7-2 8 1c4-2 8 1 8 5c0 3-3 5-6 5h-20c-3 0-6-2-6-5z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
