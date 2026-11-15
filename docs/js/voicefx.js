// Подстройка записанного голоса мастера на телефоне: скорость речи и высота голоса меняются независимо.
// Скорость — растяжение по времени методом WSOLA (кусочки речи перекрываются с подбором лучшего стыка),
// высота — пересэмплирование. Записи не перезаписываются: каждая фраза обрабатывается один раз и хранится в памяти.

// Растянуть сигнал по времени в factor раз (>1 — длиннее), не меняя высоту.
function stretch(x, factor, sr) {
  if (Math.abs(factor - 1) < 1e-3) return x;
  const N = Math.round(sr * 0.04) & ~1; // кадр 40 мс
  const Hs = N / 2; // шаг записи
  const Ha = Hs / factor; // шаг чтения
  const tol = Math.round(sr * 0.012); // поиск лучшего стыка ±12 мс
  const len = x.length;
  const inp = new Float32Array(len + 2 * N + 2 * tol);
  inp.set(x, tol);
  const outLen = Math.ceil(len * factor) + N;
  const out = new Float32Array(outLen + N);
  const norm = new Float32Array(outLen + N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const step = Math.max(1, Math.round(sr / 12000)); // корреляция по прореженному сигналу — быстрее, точность достаточна
  let prev = tol; // откуда взят предыдущий кадр (в координатах inp)
  for (let k = 0; k * Hs < outLen; k++) {
    let pos = tol + Math.round(k * Ha);
    if (k > 0) {
      // Естественное продолжение предыдущего кадра — ищем похожий участок рядом с нужным местом.
      const nat = prev + Hs;
      let best = 0;
      let bestC = -Infinity;
      for (let d = -tol; d <= tol; d += step) {
        const p = pos + d;
        if (p < 0 || p + N > inp.length) continue;
        let c = 0;
        for (let i = 0; i < Hs; i += step) c += inp[p + i] * inp[nat + i];
        if (c > bestC) { bestC = c; best = d; }
      }
      pos += best;
    }
    if (pos + N > inp.length) break;
    const o = k * Hs;
    for (let i = 0; i < N; i++) { out[o + i] += win[i] * inp[pos + i]; norm[o + i] += win[i]; }
    prev = pos;
  }
  const res = new Float32Array(Math.ceil(len * factor));
  for (let i = 0; i < res.length; i++) res[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
  return res;
}

// Пересэмплировать: ratio > 1 — короче и выше. Кубическая интерполяция.
function resample(x, ratio) {
  if (Math.abs(ratio - 1) < 1e-4) return x;
  const n = Math.floor((x.length - 1) / ratio);
  const y = new Float32Array(n);
  const at = (i) => x[i < 0 ? 0 : i >= x.length ? x.length - 1 : i];
  for (let j = 0; j < n; j++) {
    const t = j * ratio;
    const i = Math.floor(t);
    const f = t - i;
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    y[j] = p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
  }
  return y;
}

// speed: 1 — как записано, 1.2 — на 20 % быстрее. semitones: сдвиг высоты в полутонах.
export function processSamples(x, sr, speed = 1, semitones = 0) {
  const p = 2 ** (semitones / 12);
  // Сначала растягиваем на p/speed, затем пересэмплирование на p возвращает длительность 1/speed и поднимает высоту в p раз.
  const y = resample(stretch(x, p / speed, sr), p);
  // Мягкие края, чтобы не было щелчков.
  const fade = Math.min(y.length >> 1, Math.round(sr * 0.004));
  for (let i = 0; i < fade; i++) { const g = i / fade; y[i] *= g; y[y.length - 1 - i] *= g; }
  return y;
}

export function processBuffer(ctx, buf, speed = 1, semitones = 0) {
  if (Math.abs(speed - 1) < 1e-3 && Math.abs(semitones) < 1e-3) return buf;
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(processSamples(buf.getChannelData(c), buf.sampleRate, speed, semitones));
  const out = ctx.createBuffer(buf.numberOfChannels, chans[0].length, buf.sampleRate);
  chans.forEach((d, c) => out.getChannelData(c).set(d));
  return out;
}
