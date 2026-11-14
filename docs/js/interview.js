// Голосовая беседа мастера: задаёт вопросы по одному, ученик отвечает кнопками, числами или голосом.
import * as voice from './voice.js';
import { FLOW_LINES } from './flow-lines.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NUM_WORDS = { ноль: 0, один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10 };

function parseNumber(t) {
  const m = String(t).match(/\d+([.,]\d+)?/);
  if (m) return Number(m[0].replace(',', '.'));
  const w = String(t).toLowerCase().split(/\s+/).find((x) => x in NUM_WORDS);
  return w != null ? NUM_WORDS[w] : null;
}
function matchOption(t, options) {
  const s = String(t).toLowerCase().replace(/ё/g, 'е');
  let best = null;
  for (const [val, label] of options) {
    const words = label.toLowerCase().replace(/ё/g, 'е').split(/[\s,]+/).filter((w) => w.length > 2);
    const hit = words.filter((w) => s.includes(w.slice(0, Math.max(4, w.length - 2)))).length;
    if (hit && (!best || hit > best.hit)) best = { val, hit };
  }
  return best?.val ?? null;
}

// questions: из kb.js. answers — объект, который заполняется. Возвращает промис с ответами (или null при отмене).
export function runInterview(root, { title, questions, answers = {}, onClose }) {
  return new Promise((resolve) => {
    const list = () => questions.filter((q) => (!q.onlyIf || q.onlyIf(answers)) && (!q.skipIf || !q.skipIf(answers)));
    let idx = 0;
    let multi = new Set();

    const finish = (val) => { voice.cancel(); voice.stopListening(); onClose?.(); resolve(val); };

    function render() {
      const qs = list();
      if (idx >= qs.length) return finish(answers);
      const q = qs[idx];
      const cur = answers[q.id];
      multi = new Set(Array.isArray(cur) ? cur : []);
      let input = '';
      if (q.kind === 'choice') {
        input = `<div class="iv-options">${q.options.map(([v, l]) => `<button class="iv-opt ${cur === v ? 'on' : ''}" data-val="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
      } else if (q.kind === 'multi') {
        input = `<div class="iv-options multi">${q.options.map(([v, l]) => `<button class="iv-opt ${multi.has(v) ? 'on' : ''}" data-multi="${esc(v)}" aria-pressed="${multi.has(v)}">${esc(l)}</button>`).join('')}</div>
          <button class="btn wide" data-next>Дальше</button>`;
      } else if (q.kind === 'scale') {
        input = `<div class="iv-scale">${Array.from({ length: 11 }, (_, n) => `<button class="iv-num ${Number(cur) === n ? 'on' : ''}" data-val="${n}">${n}</button>`).join('')}</div>
          <div class="iv-scale-legend"><span>0 — нет</span><span>10 — очень сильно</span></div>`;
      } else if (q.kind === 'number') {
        input = `<div class="iv-fields"><label class="iv-field"><input id="iv-n" inputmode="decimal" value="${esc(cur ?? '')}" aria-label="${esc(q.unit || 'Число')}"><span>${esc(q.unit || '')}</span></label></div>
          <button class="btn wide" data-next>Дальше</button>`;
      } else if (q.kind === 'numbers') {
        input = `<div class="iv-fields">${q.fields.map(([k, l]) => `<label class="iv-field"><span>${esc(l)}</span><input data-field="${k}" inputmode="decimal" value="${esc(cur?.[k] ?? '')}"></label>`).join('')}</div>
          <button class="btn wide" data-next>Дальше</button>`;
      } else {
        input = `<textarea id="iv-t" rows="2" class="iv-text">${esc(cur ?? '')}</textarea><button class="btn wide" data-next>Дальше</button>`;
      }
      root.innerHTML = `
        <section class="iv">
          <div class="iv-top">
            <button class="icon-btn" data-back aria-label="Назад">‹</button>
            <div class="iv-dots" aria-label="Вопрос ${idx + 1} из ${qs.length}">${qs.map((_, i) => `<i class="${i < idx ? 'done' : i === idx ? 'cur' : ''}"></i>`).join('')}</div>
            <button class="icon-btn" data-cancel aria-label="Закрыть">✕</button>
          </div>
          <p class="eyebrow">${esc(title)} · ${idx + 1} из ${qs.length}</p>
          <h2 class="iv-q">${esc(q.say)}</h2>
          <div class="iv-input">${input}</div>
          <div class="iv-row">
            ${voice.sttSupported && q.kind !== 'multi' ? '<button class="btn ghost" data-voice>Ответить голосом</button>' : ''}
            <button class="btn ghost" data-repeat>Повторить вопрос</button>
            ${q.optional ? '<button class="btn ghost" data-skip>Пропустить</button>' : ''}
          </div>
          <p class="iv-heard" aria-live="polite"></p>
        </section>`;
      voice.speak(q.say, { interrupt: true });
    }

    function readInput(q) {
      if (q.kind === 'number') {
        const v = parseNumber(root.querySelector('#iv-n').value);
        if (v == null) return q.optional ? undefined : false;
        if ((q.min != null && v < q.min) || (q.max != null && v > q.max)) return false;
        return v;
      }
      if (q.kind === 'numbers') {
        const out = {};
        for (const [k, , min, max] of q.fields) {
          const v = parseNumber(root.querySelector(`[data-field="${k}"]`).value);
          if (v == null || v < min || v > max) return q.optional ? undefined : false;
          out[k] = v;
        }
        return out;
      }
      if (q.kind === 'multi') return [...multi];
      if (q.kind === 'text') return root.querySelector('#iv-t').value.trim() || undefined;
      return answers[q.id];
    }

    function next(value) {
      const q = list()[idx];
      if (value !== undefined) answers[q.id] = value; else delete answers[q.id];
      idx++;
      render();
    }

    root.onclick = async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const q = list()[idx];
      if (t.dataset.val != null) {
        next(q.kind === 'scale' ? Number(t.dataset.val) : t.dataset.val);
      } else if (t.dataset.multi != null) {
        const v = t.dataset.multi;
        if (v === 'none') multi = new Set(multi.has('none') ? [] : ['none']);
        else { multi.delete('none'); if (multi.has(v)) multi.delete(v); else multi.add(v); }
        root.querySelectorAll('[data-multi]').forEach((b) => { const on = multi.has(b.dataset.multi); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
      } else if (t.hasAttribute('data-next')) {
        const v = readInput(q);
        if (v === false) { root.querySelector('.iv-heard').textContent = 'Проверьте ответ: число вне разумных пределов.'; return; }
        if (q.kind === 'multi' && !v.length && !q.optional) { root.querySelector('.iv-heard').textContent = 'Отметьте хотя бы один вариант.'; return; }
        next(v);
      } else if (t.hasAttribute('data-skip')) {
        next(undefined);
      } else if (t.hasAttribute('data-back')) {
        if (idx > 0) { idx--; render(); }
      } else if (t.hasAttribute('data-cancel')) {
        finish(null);
      } else if (t.hasAttribute('data-repeat')) {
        voice.speak(q.say, { interrupt: true });
      } else if (t.hasAttribute('data-voice')) {
        voice.cancel();
        const heard = root.querySelector('.iv-heard');
        heard.textContent = 'Слушаю…';
        let text = '';
        try { text = await voice.listenOnce({ onInterim: (x) => { heard.textContent = x || 'Слушаю…'; } }); } catch { text = ''; }
        if (list()[idx] !== q) return;
        heard.textContent = text ? `Услышал: «${text}»` : '';
        if (!text) { voice.speak(FLOW_LINES.noAnswer); return; }
        if (q.kind === 'choice') { const v = matchOption(text, q.options); if (v) next(v); else voice.speak(FLOW_LINES.noAnswer); }
        else if (q.kind === 'scale') { const v = parseNumber(text); if (v != null && v >= 0 && v <= 10) next(v); else voice.speak(FLOW_LINES.noAnswer); }
        else if (q.kind === 'number') { const v = parseNumber(text); if (v != null) root.querySelector('#iv-n').value = v; }
        else if (q.kind === 'numbers') {
          const nums = (text.match(/\d+/g) || []).map(Number);
          q.fields.forEach(([k], i) => { if (nums[i] != null) root.querySelector(`[data-field="${k}"]`).value = nums[i]; });
        } else if (q.kind === 'text') root.querySelector('#iv-t').value = text;
      }
    };
    render();
  });
}
