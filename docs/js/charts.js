// Графики на чистом SVG: тонкие линии, одна ось, подписи только на концах, подсказка по касанию.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(Number(v.toFixed(6)));
  return { lo, hi, ticks };
}
const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ','));
const shortDate = (s) => { const [, m, d] = s.split('-'); return `${Number(d)}.${m}`; };

// series: [{ name, color: 'var(--series-1)', points: [{date, value}] }]
export function lineChart(host, { series, unit = '', empty = 'Появится после двух записей в дневнике.' }) {
  host.textContent = '';
  const all = series.flatMap((s) => s.points);
  const dates = [...new Set(all.map((p) => p.date))].sort();
  if (dates.length < 2) {
    const box = h('p', 'chart-empty');
    box.textContent = all.length ? `Пока одна запись: ${fmt(all[all.length - 1].value)}${unit ? ' ' + unit : ''}. ${empty}` : empty;
    host.append(box);
    return;
  }
  if (series.length > 1) {
    const lg = h('div', 'chart-legend');
    for (const s of series) {
      const it = h('span', 'chart-key');
      const sw = h('i');
      sw.style.background = s.color;
      it.append(sw, document.createTextNode(s.name));
      lg.append(it);
    }
    host.append(lg);
  }
  const W = 340;
  const H = 170;
  const pad = { l: 34, r: 40, t: 10, b: 22 };
  const { lo, hi, ticks } = niceTicks(Math.min(...all.map((p) => p.value)), Math.max(...all.map((p) => p.value)));
  const x = (d) => pad.l + (dates.indexOf(d) / (dates.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', tabindex: '0' });
  svg.setAttribute('aria-label', series.map((s) => `${s.name}: ${s.points.map((p) => `${shortDate(p.date)} — ${fmt(p.value)}`).join(', ')}`).join('. '));
  for (const t of ticks) {
    svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: 'chart-grid' }));
    svg.append(el('text', { x: pad.l - 6, y: y(t) + 3.5, class: 'chart-tick', 'text-anchor': 'end' }, fmt(t)));
  }
  svg.append(el('text', { x: pad.l, y: H - 5, class: 'chart-tick' }, shortDate(dates[0])));
  svg.append(el('text', { x: W - pad.r, y: H - 5, class: 'chart-tick', 'text-anchor': 'end' }, shortDate(dates[dates.length - 1])));

  const ends = [];
  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
    svg.append(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = s.points[s.points.length - 1];
    svg.append(el('circle', { cx: x(last.date), cy: y(last.value), r: 4, fill: s.color, class: 'chart-dot' }));
    ends.push({ y: y(last.value), x: x(last.date), text: fmt(last.value) });
  }
  // Подписи на концах линий: если сходятся ближе 12px, оставляем только верхнюю — остальное в подсказке.
  ends.sort((a, b) => a.y - b.y);
  let prevY = -99;
  for (const e of ends) {
    if (e.y - prevY < 12) continue;
    prevY = e.y;
    svg.append(el('text', { x: e.x + 8, y: e.y + 4, class: 'chart-end' }, e.text));
  }

  const cross = el('line', { y1: pad.t, y2: H - pad.b, class: 'chart-cross', visibility: 'hidden' });
  svg.append(cross);
  const tip = h('div', 'chart-tip');
  tip.hidden = true;
  const wrap = h('div', 'chart-wrap');
  wrap.append(svg, tip);
  host.append(wrap);

  let idx = dates.length - 1;
  const show = (i) => {
    idx = Math.max(0, Math.min(dates.length - 1, i));
    const d = dates[idx];
    cross.setAttribute('x1', x(d));
    cross.setAttribute('x2', x(d));
    cross.setAttribute('visibility', 'visible');
    tip.textContent = '';
    tip.append(h('div', 'chart-tip-date', shortDate(d)));
    for (const s of series) {
      const p = s.points.find((q) => q.date === d);
      if (!p) continue;
      const row = h('div', 'chart-tip-row');
      const key = h('i');
      key.style.background = s.color;
      row.append(key, h('b', '', `${fmt(p.value)}${unit ? ' ' + unit : ''}`), h('span', '', series.length > 1 ? s.name : ''));
      tip.append(row);
    }
    tip.hidden = false;
    const frac = x(d) / W;
    tip.style.left = `${Math.min(72, Math.max(2, frac * 100 - 14))}%`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
  const fromEvent = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const f = (px - pad.l) / (W - pad.l - pad.r);
    show(Math.round(f * (dates.length - 1)));
  };
  svg.addEventListener('pointermove', fromEvent);
  svg.addEventListener('pointerdown', fromEvent);
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(idx));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { show(idx - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { show(idx + 1); e.preventDefault(); }
  });
}

// Столбики по неделям: значение на шапке, подсказка на каждом столбике.
export function weekBars(host, { weeks, max = 14, color = 'var(--series-1)' }) {
  host.textContent = '';
  if (!weeks.length) { host.append(h('p', 'chart-empty', 'Появится после первого занятия.')); return; }
  const W = 340;
  const H = 150;
  const pad = { l: 10, r: 10, t: 20, b: 22 };
  const band = (W - pad.l - pad.r) / Math.max(weeks.length, 4);
  const bw = Math.min(24, band - 8);
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img' });
  svg.setAttribute('aria-label', weeks.map((w) => `${w.label}: ${w.value} из ${max}`).join(', '));
  const yGoal = y(10);
  svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: yGoal, y2: yGoal, class: 'chart-grid' }));
  svg.append(el('text', { x: W - pad.r, y: yGoal - 4, class: 'chart-tick', 'text-anchor': 'end' }, 'цель 10'));
  svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: H - pad.b, y2: H - pad.b, class: 'chart-axis' }));
  const tip = h('div', 'chart-tip');
  tip.hidden = true;
  weeks.forEach((w, i) => {
    const cx = pad.l + band * i + band / 2;
    const top = y(w.value);
    const base = H - pad.b;
    const hgt = base - top;
    const g = el('g', { class: 'chart-bar', tabindex: '0' });
    if (hgt > 0.5) {
      const r = Math.min(4, hgt);
      const x0 = cx - bw / 2;
      g.append(el('path', { d: `M${x0} ${base} V${top + r} Q${x0} ${top} ${x0 + r} ${top} H${x0 + bw - r} Q${x0 + bw} ${top} ${x0 + bw} ${top + r} V${base} Z`, fill: color }));
    }
    g.append(el('rect', { x: cx - band / 2, y: pad.t, width: band, height: H - pad.t - pad.b, fill: 'transparent' }));
    svg.append(g);
    svg.append(el('text', { x: cx, y: top - 5, class: 'chart-end', 'text-anchor': 'middle' }, String(w.value)));
    svg.append(el('text', { x: cx, y: H - 6, class: 'chart-tick', 'text-anchor': 'middle' }, w.label));
    const show = () => {
      tip.textContent = '';
      const row = h('div', 'chart-tip-row');
      row.append(h('b', '', `${w.value} из ${max}`), h('span', '', `неделя ${w.label}`));
      tip.append(row);
      tip.hidden = false;
      tip.style.left = `${Math.min(64, Math.max(2, (cx / W) * 100 - 16))}%`;
    };
    g.addEventListener('pointerenter', show);
    g.addEventListener('pointerdown', show);
    g.addEventListener('focus', show);
    g.addEventListener('pointerleave', () => { tip.hidden = true; });
    g.addEventListener('blur', () => { tip.hidden = true; });
  });
  const wrap = h('div', 'chart-wrap');
  wrap.append(svg, tip);
  host.append(wrap);
}
