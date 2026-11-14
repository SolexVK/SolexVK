// Визуальный контроль: чистая логика без DOM, чтобы её можно было проверять тестами.
// Вход — 33 точки тела MediaPipe (нормированные и «мировые»), выход — повторы и подсказки.

export const LM = {
  nose: 0, earL: 7, earR: 8, shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16,
  hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28,
};

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
const len = (v) => Math.hypot(v.x, v.y, v.z || 0);
const deg = (r) => (r * 180) / Math.PI;

export function angle(a, b, c) {
  const u = sub(a, b);
  const v = sub(c, b);
  const d = (u.x * v.x + u.y * v.y + (u.z || 0) * (v.z || 0)) / (len(u) * len(v) || 1);
  return deg(Math.acos(Math.min(1, Math.max(-1, d))));
}

const vis = (lm, ids) => Math.min(...ids.map((i) => lm[i]?.visibility ?? 0));

// aspect = ширина/высота кадра: нормированные координаты переводим в общий масштаб.
export function metrics(lm, world, aspect = 0.75) {
  const p = (i) => ({ x: lm[i].x * aspect, y: lm[i].y, z: 0 });
  const w = world && world.length ? (i) => world[i] : p;
  const shM = mid(p(LM.shL), p(LM.shR));
  const hipM = mid(p(LM.hipL), p(LM.hipR));
  const anM = mid(p(LM.anL), p(LM.anR));
  const earM = mid(p(LM.earL), p(LM.earR));
  const torso = Math.max(1e-4, len(sub(shM, hipM)));
  const torsoY = Math.max(1e-4, hipM.y - shM.y);
  const wh = (i) => (hipM.y - p(i).y) / torsoY;
  const anSpan = Math.abs(p(LM.anL).x - p(LM.anR).x);
  const shSpan = Math.abs(p(LM.shL).x - p(LM.shR).x);
  const wShM = mid(w(LM.shL), w(LM.shR));
  const wHipM = mid(w(LM.hipL), w(LM.hipR));
  const tv = sub(wShM, wHipM);

  const leftSide = vis(lm, [LM.shL, LM.elL, LM.wrL, LM.hipL, LM.anL]) >= vis(lm, [LM.shR, LM.elR, LM.wrR, LM.hipR, LM.anR]);
  const S = leftSide
    ? { sh: LM.shL, el: LM.elL, wr: LM.wrL, hip: LM.hipL, kn: LM.knL, an: LM.anL }
    : { sh: LM.shR, el: LM.elR, wr: LM.wrR, hip: LM.hipR, kn: LM.knR, an: LM.anR };

  const kneeL = angle(w(LM.hipL), w(LM.knL), w(LM.anL));
  const kneeR = angle(w(LM.hipR), w(LM.knR), w(LM.anR));
  return {
    visCore: vis(lm, [LM.shL, LM.shR, LM.hipL, LM.hipR]),
    visLegs: vis(lm, [LM.knL, LM.knR, LM.anL, LM.anR]),
    visArms: vis(lm, [LM.wrL, LM.wrR, LM.elL, LM.elR]),
    visSide: vis(lm, [S.sh, S.el, S.wr, S.hip, S.an]),
    kneeL, kneeR, knee: (kneeL + kneeR) / 2,
    elbowL: angle(w(LM.shL), w(LM.elL), w(LM.wrL)),
    elbowR: angle(w(LM.shR), w(LM.elR), w(LM.wrR)),
    elbowSide: angle(p(S.sh), p(S.el), p(S.wr)),
    bodyLine: angle(p(S.sh), p(S.hip), p(S.an)),
    leanSide: Math.abs(deg(Math.atan2(shM.x - hipM.x, hipM.y - shM.y))),
    leanFB: deg(Math.atan2(-(tv.z || 0), -tv.y || 1e-6)), // + вперёд (к камере), − назад
    shTilt: Math.abs(deg(Math.atan2(p(LM.shL).y - p(LM.shR).y, Math.abs(p(LM.shL).x - p(LM.shR).x) || 1e-6))),
    wristHL: wh(LM.wrL), wristHR: wh(LM.wrR), wristH: (wh(LM.wrL) + wh(LM.wrR)) / 2,
    hipShift: (hipM.x - anM.x) / Math.max(anSpan, shSpan * 0.6, 1e-4),
    stance: anSpan / Math.max(shSpan, 1e-4),
    kneeSpan: Math.abs(p(LM.knL).x - p(LM.knR).x) / Math.max(anSpan, 1e-4),
    neck: (shM.y - earM.y) / torso,
  };
}

const lean = (limit, say) => ({ id: 'lean', bad: (m) => m.leanSide > limit, say });
const shrug = { id: 'shrug', bad: (m, c) => c.base && m.neck < c.base.neck * 0.8, say: 'Опустите плечи, шея свободна.' };

export const POSES = {
  sky: {
    need: ['core', 'arms'], signal: (m) => m.wristH, hi: 1.7, lo: 0.35, countAt: 'lo', minRepMs: 5000,
    slowSay: 'Медленнее. Подъём на весь вдох, опускание на весь выдох.',
    rules: [
      lean(9, 'Корпус ровно, не наклоняйтесь в сторону.'),
      { id: 'back', bad: (m, c) => c.phase === 'hi' && m.leanFB < -16, say: 'Не прогибайтесь назад. Тянитесь макушкой вверх, взгляд прямо.' },
      { id: 'asym', bad: (m, c) => c.phase === 'hi' && Math.abs(m.wristHL - m.wristHR) > 0.5, say: 'Поднимайте обе руки одинаково.' },
    ],
  },
  qishi: {
    need: ['core', 'arms'], signal: (m) => m.wristH, hi: 0.8, lo: 0.25, countAt: 'lo', minRepMs: 5000,
    slowSay: 'Медленнее. Руки всплывают сами, без усилия.',
    rules: [
      { id: 'high', bad: (m) => m.wristH > 1.25, say: 'Руки не выше плеч.' },
      shrug,
      lean(9, 'Корпус ровно.'),
      { id: 'knee-lock', bad: (m, c) => c.phase === 'lo' && c.reps >= 1 && m.visLegs > 0.5 && m.knee > 176, say: 'Внизу слегка согните колени.', holdMs: 2500, cooldownMs: 30000 },
    ],
  },
  shift: {
    need: ['core', 'legs'], signal: (m) => m.hipShift, hi: 0.2, lo: -0.2, countAt: 'both',
    rules: [
      lean(8, 'Корпус вертикально. Двигается таз, а не плечи.'),
      { id: 'lock', bad: (m) => m.knee > 177, say: 'Колени мягкие, не выпрямляйте до конца.' },
    ],
  },
  stolb: {
    need: ['core', 'legs', 'arms'], hold: true,
    rules: [
      { id: 'lock', bad: (m) => m.knee > 175, say: 'Чуть согните колени.' },
      { id: 'deep', bad: (m) => m.knee < 138, say: 'Встаньте выше. Глубоко не садимся.' },
      lean(7, 'Выровняйте корпус. Вес на обеих стопах поровну.'),
      { id: 'tilt', bad: (m) => m.shTilt > 7, say: 'Плечи на одном уровне.' },
      { id: 'arms', bad: (m) => m.wristH < 0.12 || m.wristH > 1.05, say: 'Руки перед животом, будто обнимаете большой шар.' },
      shrug,
    ],
  },
  chair: {
    need: ['core', 'legs'], signal: (m) => m.knee, hi: 158, lo: 120, countAt: 'hi', minDownMs: 1200,
    fastDownSay: 'Садитесь медленнее, не падайте на стул.',
    rules: [
      { id: 'valgus', bad: (m) => m.knee > 112 && m.knee < 150 && m.kneeSpan < 0.7, say: 'Колени не сводите внутрь, направляйте их на носки.', holdMs: 600 },
    ],
  },
  wallpush: {
    need: ['side'], signal: (m) => m.elbowSide, hi: 150, lo: 118, countAt: 'hi',
    rules: [
      { id: 'line', bad: (m) => m.bodyLine < 160, say: 'Тело прямой линией от пяток до макушки. Не прогибайтесь в пояснице.' },
    ],
  },
};

// Все замечания, которые может сделать мастер по камере (для озвучки).
export const COACH_LOST = {
  side: 'Я не вижу вас сбоку целиком. Встаньте боком к камере, чтобы были видны плечо, таз и стопа.',
  front: 'Я не вижу вас целиком. Отойдите на два-три шага, чтобы в кадре были голова и стопы.',
};
export const COACH_TEXTS = [...new Set([
  ...Object.values(POSES).flatMap((p) => [...p.rules.map((r) => r.say), p.slowSay, p.fastDownSay]),
  ...Object.values(COACH_LOST),
].filter(Boolean))];

const EMA_KEYS = ['knee', 'kneeL', 'kneeR', 'elbowSide', 'bodyLine', 'leanSide', 'leanFB', 'shTilt', 'wristH', 'wristHL', 'wristHR', 'hipShift', 'kneeSpan', 'neck'];

export class Coach {
  constructor(poseId, opts = {}) {
    this.def = POSES[poseId];
    this.id = poseId;
    this.reps = 0;
    this.phase = null;
    this.seen = { hi: false, lo: false };
    this.viol = {};
    this.cuedAt = {};
    this.lastCueAt = -1e9;
    this.frames = 0;
    this.badFrames = 0;
    this.visibleMs = 0;
    this.lostSince = null;
    this.lostTold = -1e9;
    this.m = null;
    this.base = null;
    this.baseAcc = [];
    this.phaseAt = 0;
    this.lastCountAt = null;
    this.lastT = null;
    this.gapMs = opts.gapMs ?? 5000;
    this.alpha = opts.alpha ?? 0.4;
  }

  visible(m) {
    const need = this.def.need;
    const T = 0.5;
    return (!need.includes('core') || m.visCore > T)
      && (!need.includes('legs') || m.visLegs > T)
      && (!need.includes('arms') || m.visArms > 0.35)
      && (!need.includes('side') || m.visSide > 0.45);
  }

  // t — миллисекунды. Возвращает события кадра.
  update(lm, world, t, aspect) {
    const ev = [];
    const dt = this.lastT == null ? 0 : Math.min(500, t - this.lastT);
    this.lastT = t;
    if (!lm) return this.lost(t, ev);
    const raw = metrics(lm, world, aspect);
    if (!this.visible(raw)) return this.lost(t, ev, raw);
    if (this.lostSince != null) { this.lostSince = null; ev.push({ type: 'found' }); }

    if (!this.m) this.m = { ...raw };
    else {
      for (const k of EMA_KEYS) this.m[k] += this.alpha * (raw[k] - this.m[k]);
      for (const k of ['visCore', 'visLegs', 'visArms', 'visSide', 'stance']) this.m[k] = raw[k];
    }
    const m = this.m;
    this.visibleMs += dt;
    this.frames++;

    if (!this.base) {
      this.baseAcc.push(raw.neck);
      if (this.baseAcc.length >= 12) {
        const s = [...this.baseAcc].sort((a, b) => a - b);
        this.base = { neck: s[Math.floor(s.length / 2)] };
      }
    }

    const d = this.def;
    if (!d.hold) {
      const v = d.signal(m);
      const next = v >= d.hi ? 'hi' : v <= d.lo ? 'lo' : null;
      if (next && next !== this.phase) {
        const prev = this.phase;
        const since = t - this.phaseAt;
        this.phase = next;
        this.phaseAt = t;
        this.seen[next] = true;
        const counts = d.countAt === 'both' ? prev != null : (next === d.countAt && this.seen.hi && this.seen.lo && prev != null);
        if (counts) {
          this.reps++;
          const repMs = this.lastCountAt == null ? null : t - this.lastCountAt;
          this.lastCountAt = t;
          ev.push({ type: 'rep', n: this.reps, ms: repMs });
          if (d.minRepMs && repMs != null && repMs < d.minRepMs) this.cue('slow', d.slowSay, t, ev, 20000);
        }
        if (d.minDownMs && prev === 'hi' && next === 'lo' && since < d.minDownMs) this.cue('fast-down', d.fastDownSay, t, ev, 15000);
      }
    }

    let anyBad = false;
    const ctx = { phase: this.phase, reps: this.reps, base: this.base };
    for (const r of d.rules) {
      const bad = !!r.bad(m, ctx);
      if (bad) {
        anyBad = true;
        this.viol[r.id] ??= t;
        if (t - this.viol[r.id] >= (r.holdMs ?? 1500)) this.cue(r.id, r.say, t, ev, r.cooldownMs ?? 12000);
      } else {
        delete this.viol[r.id];
      }
    }
    if (anyBad) this.badFrames++;
    return { ev, m, visible: true, bad: anyBad };
  }

  cue(id, say, t, ev, cooldown) {
    if (!say) return;
    if (t - this.lastCueAt < this.gapMs) return;
    if (this.cuedAt[id] != null && t - this.cuedAt[id] < cooldown) return;
    this.cuedAt[id] = t;
    this.lastCueAt = t;
    ev.push({ type: 'cue', id, say });
  }

  lost(t, ev, raw) {
    if (this.lostSince == null) this.lostSince = t;
    const ms = t - this.lostSince;
    if (ms > 3500 && t - this.lostTold > 25000) {
      this.lostTold = t;
      const side = this.def.need.includes('side');
      ev.push({ type: 'cue', id: 'lost', say: side ? COACH_LOST.side : COACH_LOST.front });
    }
    return { ev, m: raw || null, visible: false, lostMs: ms, bad: false };
  }

  // Доля времени без замечаний, 0–100. null, если камера почти не видела тело.
  quality() {
    if (this.frames < 20) return null;
    return Math.round(100 * (1 - this.badFrames / this.frames));
  }
}

// Короткая сводка углов для наставника (отправляется вместе с кадром).
export function describe(m) {
  if (!m) return '';
  const r = (v) => Math.round(v);
  return `колени ${r(m.knee)}° (180 — прямые), наклон корпуса в сторону ${r(m.leanSide)}°, вперёд-назад ${r(m.leanFB)}°, `
    + `перекос плеч ${r(m.shTilt)}°, высота кистей ${m.wristH.toFixed(2)} (0 — таз, 1 — плечи), ширина стойки ${m.stance.toFixed(2)} от ширины плеч`;
}
