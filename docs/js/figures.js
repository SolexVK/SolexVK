// Схемы упражнений: фигура-манекен в одном стиле, рисуется по углам суставов.
// Сплошная фигура — начальная поза, полупрозрачная — конечная; красные стрелки — траектория движения,
// она рассчитывается сама по промежуточным позам. Цвета берутся из темы.
import { t } from './i18n.js';

// ---- размеры тела (рост около 360 единиц) ----
const LEN = { torso: 118, neck: 13, headR: 19, upper: 64, fore: 58, hand: 19, thigh: 94, shin: 90, foot: 30, heel: 9 };
const W = { upper: [17, 14], fore: [14, 11], hand: [11, 8], thigh: [27, 19], shin: [19, 13], foot: [12, 8], neck: 13 };
const GROUND = 400;

const rad = (a) => (a * Math.PI) / 180;
const add = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k];
const lerp = (a, b, k) => a + (b - a) * k;
const f1 = (n) => Math.round(n * 10) / 10;
// Вид сбоку: 0 — вниз, 90 — вперёд (вправо), 180 — вверх, -90 — назад.
const dirS = (a) => [Math.sin(rad(a)), Math.cos(rad(a))];
// Вид спереди: 0 — вниз, 90 — в свою сторону, 180 — вверх, отрицательные — к середине тела. s = −1 правая сторона (слева на экране).
const dirF = (a, s) => [s * Math.sin(rad(a)), Math.cos(rad(a))];

// ---- прямая кинематика ----
function solveSide(P) {
  const J = {};
  J.hip = [0, 0];
  const dT = dirS(P.torso);
  J.sh = add(J.hip, dT, LEN.torso);
  const dH = dirS(P.head ?? P.torso);
  J.neck = add(J.sh, dH, LEN.neck);
  J.headC = add(J.neck, dH, LEN.headR);
  J.dT = dT;
  J.dH = dH;
  for (const s of ['N', 'F']) {
    const a = P['arm' + s];
    const l = P['leg' + s];
    J['el' + s] = add(J.sh, dirS(a[0]), LEN.upper);
    J['wr' + s] = add(J['el' + s], dirS(a[1]), LEN.fore);
    J['ha' + s] = add(J['wr' + s], dirS(a[2] ?? a[1]), LEN.hand);
    J['kn' + s] = add(J.hip, dirS(l[0]), LEN.thigh * (l[3] ?? 1));
    J['an' + s] = add(J['kn' + s], dirS(l[1]), LEN.shin);
    const dF = dirS(l[2] ?? 90);
    J['toe' + s] = add(J['an' + s], dF, LEN.foot);
    J['heel' + s] = add(J['an' + s], dF, -LEN.heel);
  }
  return J;
}

function solveFront(P) {
  const J = {};
  J.hip = [P.shiftX || 0, 0];
  const dT = dirF(P.torso ?? 180, 1);
  J.sh = add(J.hip, dT, LEN.torso * (P.torsoFs ?? 1));
  const dH = dirF(P.head ?? P.torso ?? 180, 1);
  J.neck = add(J.sh, dH, LEN.neck);
  J.headC = add(J.neck, dH, LEN.headR);
  J.dT = dT;
  J.dH = dH;
  const side = { R: -1, L: 1 };
  for (const s of ['R', 'L']) {
    const k = side[s];
    const shJ = add(J.sh, [k * 37, 4]);
    const hipJ = add(J.hip, [k * 17, 0]);
    J['shj' + s] = shJ;
    J['hipj' + s] = hipJ;
    const a = P['arm' + s];
    J['el' + s] = add(shJ, dirF(a[0], k), LEN.upper * (a[3] ?? 1));
    J['wr' + s] = add(J['el' + s], dirF(a[1], k), LEN.fore * (a[4] ?? 1));
    J['ha' + s] = add(J['wr' + s], dirF(a[2] ?? a[1], k), LEN.hand);
    const l = P['leg' + s];
    J['kn' + s] = add(hipJ, dirF(l[0], k), LEN.thigh * (l[2] ?? 1));
    J['an' + s] = add(J['kn' + s], dirF(l[1], k), LEN.shin * (l[3] ?? 1));
  }
  return J;
}

const solve = (view, P) => (view === 'front' ? solveFront(P) : solveSide(P));

// Промежуточная поза: линейно по всем углам.
function mix(A, B, k) {
  if (k <= 0) return A;
  if (k >= 1) return B;
  const out = {};
  for (const key of Object.keys(A)) {
    const a = A[key];
    const b = B[key] ?? a;
    out[key] = Array.isArray(a) ? a.map((v, i) => lerp(v, b[i] ?? v, k)) : typeof a === 'number' ? lerp(a, b, k) : a;
  }
  return out;
}

function shift(J, dx, dy) {
  const out = {};
  for (const [k, v] of Object.entries(J)) out[k] = k === 'dT' || k === 'dH' ? v : [v[0] + dx, v[1] + dy];
  return out;
}

// ---- рисование ----
// Капсула от a до b с толщиной wa и wb: конечности, шея, стопы.
function capsule(a, b, wa, wb) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const n = [-dy / len, dx / len];
  const ra = wa / 2;
  const rb = wb / 2;
  const p1 = add(a, n, ra);
  const p2 = add(b, n, rb);
  const p3 = add(b, n, -rb);
  const p4 = add(a, n, -ra);
  return `M${f1(p1[0])} ${f1(p1[1])}L${f1(p2[0])} ${f1(p2[1])}A${f1(rb)} ${f1(rb)} 0 0 1 ${f1(p3[0])} ${f1(p3[1])}L${f1(p4[0])} ${f1(p4[1])}A${f1(ra)} ${f1(ra)} 0 0 1 ${f1(p1[0])} ${f1(p1[1])}Z`;
}

// Замкнутая сглаженная кривая через точки (Catmull-Rom → кубические Безье).
function smooth(pts) {
  const n = pts.length;
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f1(c1[0])} ${f1(c1[1])} ${f1(c2[0])} ${f1(c2[1])} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return `${d}Z`;
}

function torsoSide(J) {
  const d = J.dT;
  const nf = [-d[1], d[0]]; // вперёд (грудь)
  // доля длины туловища, отступ вперёд (живот, грудь), отступ назад (ягодицы, спина)
  const prof = [[-0.08, 16, 20], [0.12, 22, 24], [0.42, 24, 16], [0.72, 23, 20], [0.94, 17, 17], [1.02, 9, 11]];
  const front = prof.map(([k, f]) => add(add(J.hip, d, LEN.torso * k), nf, f));
  const back = prof.map(([k, , b]) => add(add(J.hip, d, LEN.torso * k), nf, -b)).reverse();
  return smooth([...front, ...back]);
}

function torsoFront(J, P) {
  const d = J.dT;
  const nr = [d[1], -d[0]]; // вправо на экране
  const L = LEN.torso * (P.torsoFs ?? 1);
  const prof = [[-0.1, 33], [0.08, 35], [0.42, 29], [0.72, 35], [0.93, 41], [1.04, 20]];
  const right = prof.map(([k, w]) => add(add(J.hip, d, L * k), nr, w));
  const left = prof.map(([k, w]) => add(add(J.hip, d, L * k), nr, -w)).reverse();
  return smooth([...right, ...left]);
}

function headSide(J) {
  const a = Math.atan2(J.dH[0], J.dH[1]) * 180 / Math.PI;
  const nf = [-J.dH[1], J.dH[0]];
  const nose = add(add(J.headC, nf, 15), J.dH, -2);
  const bun = add(add(J.headC, J.dH, 19), nf, -6);
  return `<circle cx="${f1(bun[0])}" cy="${f1(bun[1])}" r="6.5" class="fg-hair"/>`
    + `<ellipse cx="${f1(J.headC[0])}" cy="${f1(J.headC[1])}" rx="15.5" ry="${LEN.headR}" transform="rotate(${f1(-a)} ${f1(J.headC[0])} ${f1(J.headC[1])})"/>`
    + `<circle cx="${f1(nose[0])}" cy="${f1(nose[1])}" r="3.4"/>`;
}

function headFront(J) {
  const a = Math.atan2(J.dH[0], J.dH[1]) * 180 / Math.PI;
  const bun = add(J.headC, J.dH, 21);
  return `<circle cx="${f1(bun[0])}" cy="${f1(bun[1])}" r="6.5" class="fg-hair"/>`
    + `<ellipse cx="${f1(J.headC[0])}" cy="${f1(J.headC[1])}" rx="16" ry="${LEN.headR + 1}" transform="rotate(${f1(-a)} ${f1(J.headC[0])} ${f1(J.headC[1])})"/>`;
}

const limbS = (J, s, far) => {
  const c = far ? 'fg-far' : '';
  return `<g class="${c}">`
    + `<path d="${capsule(J['heel' + s], J['toe' + s], W.foot[0], W.foot[1])}"/>`
    + `<path d="${capsule(J['kn' + s], J['an' + s], W.shin[0], W.shin[1])}"/>`
    + `<path d="${capsule(J.hip, J['kn' + s], W.thigh[0], W.thigh[1])}"/></g>`;
};
const armS = (J, s, far) => `<g class="${far ? 'fg-far' : ''}">`
  + `<path d="${capsule(J.sh, J['el' + s], W.upper[0], W.upper[1])}"/>`
  + `<path d="${capsule(J['el' + s], J['wr' + s], W.fore[0], W.fore[1])}"/>`
  + `<path d="${capsule(J['wr' + s], J['ha' + s], W.hand[0], W.hand[1])}"/></g>`;

function drawSide(J, P) {
  const nearFirst = P.farFront; // иногда дальняя рука должна быть перед телом
  return [
    armS(J, 'F', true), limbS(J, 'F', true),
    `<path d="${torsoSide(J)}"/>`,
    `<path d="${capsule(J.sh, J.neck, W.neck, W.neck)}"/>`,
    limbS(J, 'N', false),
    headSide(J),
    nearFirst ? '' : armS(J, 'N', false),
  ].join('');
}

function drawFront(J, P) {
  const foot = (s, k) => {
    const a = J['an' + s];
    const c = add(a, [k * 6, 7]);
    return `<ellipse cx="${f1(c[0])}" cy="${f1(c[1])}" rx="12" ry="7"/>`;
  };
  const leg = (s, k) => `<path d="${capsule(J['hipj' + s], J['kn' + s], W.thigh[0] + 2, W.thigh[1])}"/><path d="${capsule(J['kn' + s], J['an' + s], W.shin[0], W.shin[1])}"/>${foot(s, k)}`;
  const arm = (s) => `<path d="${capsule(J['shj' + s], J['el' + s], W.upper[0], W.upper[1])}"/><path d="${capsule(J['el' + s], J['wr' + s], W.fore[0], W.fore[1])}"/><path d="${capsule(J['wr' + s], J['ha' + s], W.hand[0] + 1, W.hand[1] + 1)}"/>`;
  const armsBehind = P.armsBehind;
  return [
    armsBehind ? arm('R') + arm('L') : '',
    leg('R', -1), leg('L', 1),
    `<path d="${capsule(J.sh, J.neck, W.neck + 1, W.neck + 1)}"/>`,
    `<path d="${torsoFront(J, P)}"/>`,
    headFront(J),
    armsBehind ? '' : arm('R') + arm('L'),
  ].join('');
}

// Точки, по которым ищем низ фигуры (чтобы поставить её на пол) и рамку рисунка.
function extentPts(J, view) {
  const pts = [];
  for (const [k, v] of Object.entries(J)) if (k !== 'dT' && k !== 'dH') pts.push(v);
  const d = J.dT;
  const n = [-d[1], d[0]];
  for (const k of [-0.08, 0.12, 0.42, 0.72, 0.94]) {
    const c = add(J.hip, d, LEN.torso * k);
    pts.push(add(c, n, view === 'front' ? 36 : 24), add(c, n, view === 'front' ? -36 : -24));
  }
  pts.push(add(J.headC, J.dH, LEN.headR + 8));
  return pts;
}
const lowest = (J, view, pad = 0) => {
  let m = -Infinity;
  for (const p of extentPts(J, view)) m = Math.max(m, p[1]);
  // толщина конечностей: стопы и колени
  return m + pad;
};

// ---- реквизит ----
const PROPS = {
  floor: (J0, box) => `<path class="fg-floor" d="M${f1(box[0] - 10)} ${GROUND + 1}H${f1(box[2] + 10)}"/>`,
  chair: (J0) => { // стул сбоку под тазом
    const top = J0.hip[1] + 16;
    const x0 = J0.hip[0] - 34;
    const x1 = J0.hip[0] + 46;
    return `<g class="fg-prop"><path d="M${f1(x0)} ${f1(top)}H${f1(x1)}M${f1(x0 + 4)} ${f1(top)}V${GROUND}M${f1(x1 - 4)} ${f1(top)}V${GROUND}M${f1(x0)} ${f1(top)}V${f1(top - 100)}"/></g>`;
  },
  chairShins: (J0) => { // стул под голенями (разгрузка поясницы)
    const top = Math.max(J0.anN[1], J0.knN[1]) + 12;
    const x0 = J0.knN[0] - 6;
    const x1 = J0.anN[0] + 30;
    return `<g class="fg-prop"><path d="M${f1(x0)} ${f1(top)}H${f1(x1)}M${f1(x0 + 4)} ${f1(top)}V${GROUND}M${f1(x1 - 4)} ${f1(top)}V${GROUND}M${f1(x1)} ${f1(top)}V${f1(top - 95)}"/></g>`;
  },
  chairBack: (J0) => { // спинка стула впереди, за неё держатся рукой
    const x = J0.haN[0] + 4;
    const top = J0.haN[1] + 4;
    return `<g class="fg-prop"><path d="M${f1(x)} ${f1(top)}V${GROUND}M${f1(x)} ${f1(top + 70)}H${f1(x + 60)}V${GROUND}"/></g>`;
  },
  wall: (J0) => {
    const x = J0.haN[0] + 6;
    return `<g class="fg-prop"><path d="M${f1(x)} ${GROUND}V${GROUND - 330}"/>${Array.from({ length: 11 }, (_, i) => `<path class="fg-hatch" d="M${f1(x)} ${GROUND - 20 - i * 30}l12 -12"/>`).join('')}</g>`;
  },
  ball: (J0) => {
    const wx = (J0.wrN[0] + J0.sh[0]) / 2 + 6;
    const wy = (J0.wrN[1] + J0.elN[1]) / 2 + 6;
    return `<ellipse class="fg-guide" cx="${f1(wx)}" cy="${f1(wy)}" rx="34" ry="44"/>`;
  },
  mat: (J0, box) => `<rect class="fg-mat" x="${f1(box[0] + 6)}" y="${GROUND - 1}" width="${f1(box[2] - box[0] - 12)}" height="7" rx="3.5"/>`,
};

// ---- стрелки ----
function trajectory(def, frames, joint, from, to) {
  const pts = [];
  const N = 28;
  for (let i = 0; i <= N; i++) {
    const g = from + ((to - from) * i) / N; // позиция вдоль цепочки кадров
    const k = Math.min(frames.length - 2, Math.floor(g));
    const P = mix(frames[k].P, frames[k + 1].P, g - k);
    const J = place(def, P, frames[0].J);
    pts.push(J[joint]);
  }
  return pts;
}

function arrowPath(pts, off, centre, trim = 0.08) {
  const n = pts.length;
  const mid = pts[Math.floor(n / 2)];
  const tg = [pts[Math.min(n - 1, Math.floor(n / 2) + 1)][0] - pts[Math.max(0, Math.floor(n / 2) - 1)][0], pts[Math.min(n - 1, Math.floor(n / 2) + 1)][1] - pts[Math.max(0, Math.floor(n / 2) - 1)][1]];
  let nn = [-tg[1], tg[0]];
  const l = Math.hypot(...nn) || 1;
  nn = [nn[0] / l, nn[1] / l];
  const sgn = (mid[0] - centre[0]) * nn[0] + (mid[1] - centre[1]) * nn[1] >= 0 ? 1 : -1;
  const out = [];
  const a = Math.floor(n * trim);
  const b = n - 1 - Math.floor(n * trim);
  for (let i = a; i <= b; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[Math.min(n - 1, i + 1)];
    let m = [-(p1[1] - p0[1]), p1[0] - p0[0]];
    const ml = Math.hypot(...m) || 1;
    m = [m[0] / ml, m[1] / ml];
    if (m[0] * nn[0] + m[1] * nn[1] < 0) m = [-m[0], -m[1]];
    out.push(add(pts[i], m, off * sgn));
  }
  return `M${out.map((p) => `${f1(p[0])} ${f1(p[1])}`).join('L')}`;
}

// Ставим позу на место: кадр 0 — на пол, остальные — так, чтобы опорная точка не сдвигалась.
function place(def, P, J0) {
  let J = solve(def.view, P);
  if (!J0) {
    const dy = GROUND - lowest(J, def.view, def.groundPad ?? 7);
    return shift(J, 0, dy);
  }
  const a = def.anchor || (def.view === 'front' ? 'hip' : 'anN');
  J = shift(J, J0[a][0] - J[a][0], J0[a][1] - J[a][1]);
  if (def.free) {
    const dy = GROUND - lowest(J, def.view, def.groundPad ?? 7);
    J = shift(J, 0, Math.min(0, dy));
  }
  return J;
}

// ---- библиотека поз ----
// Вид сбоку: torso, head; armN/armF = [плечо, предплечье, кисть]; legN/legF = [бедро, голень, стопа, укорочение бедра].
// Вид спереди: armR/armL = [плечо, предплечье, кисть, укор. плеча, укор. предплечья]; legR/legL = [бедро, голень, укор. бедра, укор. голени].
const STAND_S = { torso: 180, head: 180, armN: [2, 0, 0], armF: [-2, 0, 0], legN: [3, -4, 90], legF: [-3, 2, 90] };
const SOFT_S = { ...STAND_S, torso: 182, legN: [12, -10, 90], legF: [10, -9, 90] };
const STAND_F = { torso: 180, head: 180, armR: [8, 4, 2], armL: [8, 4, 2], legR: [4, -1, 1, 1], legL: [4, -1, 1, 1] };
const SOFT_F = { ...STAND_F, legR: [6, -3, 0.97, 1], legL: [6, -3, 0.97, 1] };
const SUPINE = { torso: -90, head: -94, armN: [96, 92, 90], armF: [98, 94, 92] };

const FIG = {
  breath: { view: 'side', frames: [{ ...SOFT_S, armN: [10, 120, 150], armF: [14, 124, 152] }],
    marks: (J) => dblArrow(add(J.hip, [48, -44]), [1, 0], 12) + label(t('вдох 4 · выдох 6'), add(J.headC, [0, -44]), 'middle') },
  neck: { view: 'front', frames: [SOFT_F],
    marks: (J) => arcArrow(J.headC, 34, -150, -30, true, -1) + label('½', add(J.headC, [0, -62]), 'middle') },
  shoulders: { view: 'side', frames: [SOFT_S],
    marks: (J) => circleArrow(J.sh, 26) },
  wrists: { view: 'side', frames: [{ ...SOFT_S, armN: [8, 92, 92], armF: [10, 94, 94] }],
    marks: (J) => circleArrow(J.haN, 15) },
  blades: { view: 'front', frames: [
    { ...SOFT_F, armR: [92, 178, 180], armL: [92, 178, 180] },
    { ...SOFT_F, armR: [-150, 178, 180, 0.62], armL: [-150, 178, 180, 0.62] }],
    arrows: [{ j: 'elR', off: 0 }, { j: 'elL', off: 0 }], both: true },
  pelvis: { view: 'front', frames: [{ ...SOFT_F, armR: [28, -40, -40], armL: [28, -40, -40] }],
    marks: (J) => ellipseArrow(add(J.hip, [0, 6]), 58, 16) },
  knees: { view: 'side', anchor: 'anN', frames: [
    { ...SOFT_S, armN: [16, 22, 22], armF: [18, 24, 24] },
    { ...SOFT_S, torso: 192, legN: [36, -18, 90], legF: [34, -17, 90], armN: [34, 34, 30], armF: [36, 36, 32] }],
    arrows: [{ j: 'hip', off: -30 }], both: true },
  feet: { view: 'side', anchor: 'toeN', frames: [
    { ...STAND_S, armN: [40, 70, 80] },
    { ...STAND_S, legN: [3, -4, 52], legF: [-3, 2, 52], armN: [36, 64, 76] }],
    props: ['chairBack'], arrows: [{ j: 'heelN', off: -10 }], both: true },
  sky: { view: 'front', frames: [
    { ...SOFT_F, armR: [12, -62, -80], armL: [12, -62, -80] },
    { ...SOFT_F, armR: [96, 150, 190], armL: [96, 150, 190] },
    { ...SOFT_F, armR: [170, 192, 205], armL: [170, 192, 205] }],
    marks: (J) => vArrow([J.hip[0] + 62, J.hip[1] - 40], [J.hip[0] + 62, J.headC[1] - 64]) + label(t('вдох'), [J.hip[0] + 72, J.sh[1] - 20], 'start')
      + `<path class="fg-guide" d="M${f1(J.hip[0] - 50)} ${f1(J.headC[1] - 70)}Q${f1(J.hip[0] - 150)} ${f1(J.sh[1] - 10)} ${f1(J.hip[0] - 60)} ${f1(J.hip[1] - 10)}"/>`
      + label(t('выдох'), [J.hip[0] - 104, J.hip[1] - 14], 'end') },
  qishi: { view: 'side', frames: [
    { ...SOFT_S },
    { ...SOFT_S, armN: [88, 92, 98], armF: [86, 90, 96] },
    { ...SOFT_S, torso: 186, legN: [28, -14, 90], legF: [26, -13, 90], armN: [40, 80, 70], armF: [38, 78, 68] }],
    arrows: [{ j: 'wrN', off: 16, from: 0, to: 1 }, { j: 'wrN', off: 16, from: 1, to: 2 }],
    labels: [{ text: () => t('вдох'), j: 'sh', dx: 62, dy: -40 }, { text: () => t('выдох'), j: 'hip', dx: 92, dy: 0 }] },
  shift: { view: 'front', frames: [
    { ...SOFT_F, shiftX: -16, legR: [-2, -1, 0.95, 1], legL: [14, -4, 1.02, 1], armR: [28, -40, -40], armL: [28, -40, -40], legsWide: true },
    { ...SOFT_F, shiftX: 16, legR: [14, -4, 1.02, 1], legL: [-2, -1, 0.95, 1], armR: [28, -40, -40], armL: [28, -40, -40] }],
    marks: (J) => dblArrow(add(J.hip, [16, 46]), [1, 0], 34) },
  stolb: { view: 'side', frames: [{ ...SOFT_S, torso: 182, legN: [22, -12, 90], legF: [20, -11, 90], armN: [42, 108, 128], armF: [44, 110, 130] }],
    props: ['ball'], marks: (J) => upArrow(add(J.headC, [0, -32]), 30) },
  close: { view: 'front', frames: [{ ...SOFT_F, armR: [14, -58, -78], armL: [14, -58, -78] }],
    marks: (J) => ringMark(add(J.hip, [0, -14]), 12) },
  walk: { view: 'side', anchor: 'anF', frames: [{ ...STAND_S, torso: 182, legN: [24, 4, 70], legF: [-20, -30, 112], armN: [-22, -12, -10], armF: [24, 40, 40] }],
    marks: (J) => horArrow(add(J.headC, [22, -8]), 60) },
  chair: { view: 'side', anchor: 'anN', frames: [
    { ...STAND_S, torso: 196, head: 188, legN: [88, 2, 90], legF: [86, 2, 90], armN: [22, 172, 150], armF: [24, 174, 152] },
    { ...STAND_S, armN: [16, 170, 150], armF: [18, 172, 152] }],
    props: ['chair'], arrows: [{ j: 'hip', off: 16 }],
    labels: [{ text: () => t('выдох'), j: 'sh', dx: 70, dy: -10 }] },
  wall: { view: 'side', anchor: 'anN', frames: [
    { ...STAND_S, torso: 160, head: 160, armN: [100, 100, 170], armF: [98, 98, 168], legN: [-14, -14, 90], legF: [-15, -15, 90] },
    { ...STAND_S, torso: 150, head: 150, armN: [140, 40, 170], armF: [138, 38, 168], legN: [-24, -24, 90], legF: [-25, -25, 90] }],
    props: ['wall'], arrows: [{ j: 'sh', off: 26 }], both: true },
  bridge: { view: 'side', anchor: 'sh', groundPad: 4, frames: [
    { ...SUPINE, legN: [150, 30, 90], legF: [146, 28, 92] },
    { ...SUPINE, torso: -70, head: -92, legN: [130, 18, 90], legF: [126, 16, 92] }],
    props: ['mat'], arrows: [{ j: 'hip', off: 18 }] },
  bird: { view: 'side', anchor: 'knN', groundPad: 6, frames: [
    { torso: 90, head: 102, armN: [0, 0, 90], armF: [2, 2, 92], legN: [0, -90, -90], legF: [2, -88, -88] },
    { torso: 90, head: 104, armN: [92, 92, 92], armF: [2, 2, 92], legN: [0, -90, -90], legF: [-90, -90, -94] }],
    farFront: false, props: ['mat'], arrows: [{ j: 'haN', off: 14 }, { j: 'toeF', off: 14 }] },
  bug: { view: 'side', anchor: 'sh', groundPad: 4, frames: [
    { ...SUPINE, armN: [176, 176, 176], armF: [172, 172, 172], legN: [180, 90, 150], legF: [178, 88, 150] },
    { ...SUPINE, armN: [176, 176, 176], armF: [172, 172, 172], legN: [120, 30, 100], legF: [178, 88, 150] }],
    props: ['mat'], arrows: [{ j: 'heelN', off: 12 }] },
  march: { view: 'side', anchor: 'hip', frames: [
    { ...STAND_S, legN: [88, 2, 90], legF: [86, 2, 90], armN: [-20, 30, 30], armF: [20, 60, 60] },
    { ...STAND_S, legN: [118, 20, 100], legF: [86, 2, 90], armN: [-20, 30, 30], armF: [20, 60, 60] }],
    props: ['chair'], arrows: [{ j: 'knN', off: 14 }], both: true, free: true },
  tilt: { view: 'side', anchor: 'hip', frames: [
    { ...STAND_S, legN: [88, 2, 90], legF: [86, 2, 90], armN: [40, 80, 80], armF: [42, 82, 82] },
    { ...STAND_S, torso: 168, head: 176, legN: [88, 2, 90], legF: [86, 2, 90], armN: [40, 84, 84], armF: [42, 86, 86] }],
    props: ['chair'], arrows: [{ j: 'sh', off: 18 }], both: true },
  unload: { view: 'side', anchor: 'sh', groundPad: 4, frames: [
    { ...SUPINE, legN: [180, 90, 140], legF: [178, 88, 140] }],
    props: ['mat', 'chairShins'],
    marks: (J) => label(t('вдох 4 · выдох 6'), add(J.hip, [0, -150]), 'middle') },
};
FIG.close.marks = FIG.close.marks;

// ---- значки ----
const ARW = 'marker-end="url(#fg-ah)"';
function label(text, p, anchor = 'middle') { return `<text class="fg-label" x="${f1(p[0])}" y="${f1(p[1])}" text-anchor="${anchor}">${text}</text>`; }
function dblArrow(c, d, h) {
  const a = add(c, d, -h);
  const b = add(c, d, h);
  return `<path class="fg-arrow" d="M${f1(a[0])} ${f1(a[1])}L${f1(b[0])} ${f1(b[1])}" ${ARW} marker-start="url(#fg-ah)"/>`;
}
function vArrow(a, b) { return `<path class="fg-arrow" d="M${f1(a[0])} ${f1(a[1])}L${f1(b[0])} ${f1(b[1])}" ${ARW}/>`; }
function upArrow(p, h) { return `<path class="fg-arrow" d="M${f1(p[0])} ${f1(p[1])}V${f1(p[1] - h)}" ${ARW}/>`; }
function horArrow(p, w) { return `<path class="fg-arrow" d="M${f1(p[0])} ${f1(p[1])}H${f1(p[0] + w)}" ${ARW}/>`; }
function arcArrow(c, r, a0, a1, both, sy = 1) {
  const pt = (a) => [c[0] + r * Math.cos(rad(a)), c[1] + sy * 0.45 * r * Math.sin(rad(a)) - 0];
  const p0 = pt(a0);
  const p1 = pt(a1);
  return `<path class="fg-arrow" d="M${f1(p0[0])} ${f1(p0[1])}A${r} ${f1(r * 0.45)} 0 0 ${sy > 0 ? 1 : 0} ${f1(p1[0])} ${f1(p1[1])}" ${ARW} ${both ? 'marker-start="url(#fg-ah)"' : ''}/>`;
}
function circleArrow(c, r) {
  const p0 = [c[0] + r * Math.cos(rad(200)), c[1] + r * Math.sin(rad(200))];
  const p1 = [c[0] + r * Math.cos(rad(150)), c[1] + r * Math.sin(rad(150))];
  return `<path class="fg-arrow" d="M${f1(p0[0])} ${f1(p0[1])}A${r} ${r} 0 1 1 ${f1(p1[0])} ${f1(p1[1])}" ${ARW}/>`;
}
function ellipseArrow(c, rx, ry) {
  const p0 = [c[0] - rx * 0.94, c[1] + ry * 0.34];
  const p1 = [c[0] - rx * 0.7, c[1] + ry * 0.72];
  return `<path class="fg-arrow" d="M${f1(p0[0])} ${f1(p0[1])}A${rx} ${ry} 0 1 1 ${f1(p1[0])} ${f1(p1[1])}" ${ARW}/>`;
}
function ringMark(c, r) { return `<circle class="fg-guide" cx="${f1(c[0])}" cy="${f1(c[1])}" r="${r}"/><circle class="fg-guide" cx="${f1(c[0])}" cy="${f1(c[1])}" r="${r * 2}"/>`; }

export const hasFigure = (id) => !!FIG[id];
export const figureIds = () => Object.keys(FIG);

// Рисунок упражнения. opts.frame — показать конкретную позу (для анимации), opts.bare — без стрелок.
export function figureSvg(id, opts = {}) {
  const def = FIG[id];
  if (!def) return '';
  const frames = [];
  for (const P of def.frames) {
    const J = place(def, P, frames[0]?.J);
    frames.push({ P, J });
  }
  const J0 = frames[0].J;
  const body = [];
  const draw = (J, P) => (def.view === 'front' ? drawFront(J, P) : drawSide(J, P));
  // Конечные позы — бледной тенью позади.
  if (!opts.bare) for (let i = frames.length - 1; i >= 1; i--) body.push(`<g class="fg-ghost">${draw(frames[i].J, frames[i].P)}</g>`);
  body.push(`<g class="fg-body">${draw(J0, frames[0].P)}</g>`);
  if (def.farFront === false && def.view === 'side') body.push(`<g class="fg-body">${armS(J0, 'N', false)}</g>`);
  // Рамка: все позы, все точки.
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of frames) for (const p of extentPts(f.J, def.view)) box = [Math.min(box[0], p[0]), Math.min(box[1], p[1]), Math.max(box[2], p[0]), Math.max(box[3], p[1])];
  const centre = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  const marks = [];
  if (!opts.bare && frames.length > 1) {
    for (const ar of def.arrows || []) {
      const pts = trajectory(def, frames, ar.j, ar.from ?? 0, ar.to ?? frames.length - 1);
      marks.push(`<path class="fg-arrow" d="${arrowPath(pts, ar.off ?? 14, centre)}" ${ARW} ${def.both ? 'marker-start="url(#fg-ah)"' : ''}/>`);
    }
  }
  if (!opts.bare && def.marks) marks.push(def.marks(J0));
  if (!opts.bare) for (const lb of def.labels || []) marks.push(label(lb.text(), add(J0[lb.j], [lb.dx || 0, lb.dy || 0]), lb.anchor || 'start'));
  const props = ['floor', ...(def.props || [])].map((p) => PROPS[p](J0, box)).join('');
  // Рамка с запасом под стрелки и реквизит.
  const pad = 34;
  const x0 = box[0] - pad - (def.props?.includes('wall') ? 0 : 0);
  const x1 = box[2] + pad + (def.props?.includes('wall') || def.props?.includes('chairBack') ? 70 : 0);
  const y0 = Math.min(box[1], ...(def.marks ? [box[1] - 40] : [box[1]])) - pad;
  const y1 = GROUND + 12;
  return `<svg class="fig" viewBox="${f1(x0)} ${f1(y0)} ${f1(x1 - x0)} ${f1(y1 - y0)}" role="img" aria-label="${t('Схема упражнения')}">
    <defs><marker id="fg-ah" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4.2" markerHeight="4.2" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="fg-ahead"/></marker></defs>
    ${props}${body.join('')}${marks.join('')}</svg>`;
}
