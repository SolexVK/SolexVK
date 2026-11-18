// Загрузка архива медкарты: приложение присылает zip, сервер распаковывает его и по одному разбирает документы
// нейросетью (доктор Шэн извлекает диагнозы, лекарства, анализы, заключения), затем сводит итог.
// Всё идёт на сервере: приложение можно закрыть, после перезапуска службы разбор продолжится.
// Данные: DATA_DIR/med/<id>/job.json (ход и результаты), files/ (распакованные оригиналы).
// Вносит результат в медкарту само приложение — по кнопке ученика (js/medimport.js).
import fs from 'node:fs/promises';
import fsc from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import jpeg from 'jpeg-js';
import { MODELS, prepareRequest, runRequest, responseText } from '../docs/js/ai-request.js';
import { IMPORT_SYSTEM, DOC_SCHEMA, SUMMARY_SYSTEM, SUMMARY_SCHEMA } from '../docs/js/medimport-kb.js';

const MAX_ZIP = 800 * 1024 * 1024;
const MAX_ENTRY = 60 * 1024 * 1024;
const MAX_FILES = 1500;
const MAX_TOTAL = 3 * 1024 * 1024 * 1024;
const CONCURRENCY = 3;
const IMG = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const SHEET = new Set(['.xlsx', '.xls', '.xlsm', '.ods', '.csv']);
const TEXT = new Set(['.txt', '.rtf', '.html', '.htm', '.xml', '.json', '.md']);
const IMG_LIMIT = 3.6 * 1024 * 1024; // после base64 — меньше 5 МБ, предела Claude API

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Имена в zip: UTF-8 (флаг или просто корректная последовательность), иначе — кодировка DOS (Windows, кириллица cp866).
function entryName(e) {
  const raw = Buffer.isBuffer(e.fileName) ? e.fileName : Buffer.from(String(e.fileName));
  if (e.generalPurposeBitFlag & 0x800) return raw.toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { /* не UTF-8 */ }
  try { return new TextDecoder('ibm866').decode(raw); } catch { return raw.toString('latin1'); }
}

function openZip(file) {
  return new Promise((ok, bad) => yauzl.open(file, { lazyEntries: true, decodeStrings: false, validateEntrySizes: true }, (err, z) => (err ? bad(err) : ok(z))));
}
function zipFromBuffer(buf) {
  return new Promise((ok, bad) => yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: false }, (err, z) => (err ? bad(err) : ok(z))));
}
function readStream(z, e) {
  return new Promise((ok, bad) => z.openReadStream(e, (err, s) => (err ? bad(err) : ok(s))));
}
// Перебор записей zip.
async function eachEntry(z, fn) {
  await new Promise((ok, bad) => {
    z.on('entry', (e) => { Promise.resolve(fn(e)).then(() => z.readEntry(), (err) => { z.close(); bad(err); }); });
    z.on('end', ok);
    z.on('error', bad);
    z.readEntry();
  });
}

// ---- извлечение текста ----
let XLSX = null;
async function sheetLib(appDir) {
  if (XLSX) return XLSX;
  const code = await fs.readFile(path.join(appDir, 'vendor/sheetjs/xlsx.core.min.js'), 'utf8');
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  XLSX = ctx.XLSX;
  return XLSX;
}
async function sheetText(appDir, buf) {
  const X = await sheetLib(appDir);
  const wb = X.read(buf, { type: 'buffer', cellDates: true, dense: true });
  return wb.SheetNames.map((n) => `Лист «${n}»:\n${X.utils.sheet_to_csv(wb.Sheets[n], { FS: ';', blankrows: false })}`).join('\n\n');
}
async function docxText(buf) {
  const z = await zipFromBuffer(buf);
  let xml = '';
  await eachEntry(z, async (e) => {
    if (entryName(e) !== 'word/document.xml') return;
    const chunks = [];
    for await (const c of await readStream(z, e)) chunks.push(c);
    xml = Buffer.concat(chunks).toString('utf8');
  });
  return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}
// Крупное фото документа уменьшаем (только JPEG; без внешних программ).
function shrinkJpeg(buf) {
  const img = jpeg.decode(buf, { maxMemoryUsageInMB: 1024, formatAsRGBA: true });
  const k = Math.min(1, 2400 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const out = Buffer.alloc(w * h * 4);
  // усреднение по квадрату исходных точек — текст остаётся читаемым
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y / k); const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) / k)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / k); const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) / k)));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * img.width + xx) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
      const o = (y * w + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  let q = 85;
  let enc = jpeg.encode({ data: out, width: w, height: h }, q).data;
  while (enc.length > IMG_LIMIT && q > 50) { q -= 10; enc = jpeg.encode({ data: out, width: w, height: h }, q).data; }
  return enc;
}

// Что делать с файлом по расширению: kind или причина пропуска.
function classify(name) {
  const base = path.basename(name);
  if (name.startsWith('__MACOSX/') || base.startsWith('._') || base.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(base)) return { ignore: true };
  const ext = path.extname(base).toLowerCase();
  if (ext === '.pdf') return { kind: 'pdf' };
  if (IMG[ext]) return { kind: 'image' };
  if (SHEET.has(ext)) return { kind: 'sheet' };
  if (ext === '.docx') return { kind: 'docx' };
  if (TEXT.has(ext)) return { kind: 'text' };
  if (ext === '.heic' || ext === '.heif') return { skip: 'фото в формате HEIC — сохраните как JPG' };
  if (ext === '.doc') return { skip: 'старый формат Word (.doc) — сохраните как .docx или PDF' };
  if (['.zip', '.rar', '.7z'].includes(ext)) return { skip: 'архив внутри архива — распакуйте его в общий архив' };
  return { skip: `формат ${ext || 'без расширения'} не поддерживается` };
}

export function createMedImport({ dataDir, appDir, claude }) {
  const root = path.join(dataDir, 'med');
  const jobs = new Map(); // id → job (в памяти, пишется в job.json)
  let active = null;
  const saving = new Map();

  const dir = (id) => path.join(root, id);
  async function save(job) {
    const prev = saving.get(job.id) || Promise.resolve();
    const next = prev.then(async () => {
      const f = path.join(dir(job.id), 'job.json');
      await fs.writeFile(`${f}.tmp`, JSON.stringify(job));
      await fs.rename(`${f}.tmp`, f);
    }).catch((err) => console.error('medimport save', err));
    saving.set(job.id, next);
    return next;
  }

  async function unpack(job) {
    job.state = 'unpacking';
    await save(job);
    const zipFile = path.join(dir(job.id), 'archive.zip');
    const z = await openZip(zipFile);
    const files = [];
    let total = 0;
    await fs.mkdir(path.join(dir(job.id), 'files'), { recursive: true });
    await eachEntry(z, async (e) => {
      const name = entryName(e);
      if (/\/$/.test(name)) return;
      const c = classify(name);
      if (c.ignore) return;
      if (files.length >= MAX_FILES) throw new Error(`в архиве больше ${MAX_FILES} файлов`);
      const n = files.length + 1;
      const rec = { n, name, kind: c.kind || '', size: e.uncompressedSize, status: 'wait', reason: '' };
      files.push(rec);
      if (c.skip) { rec.status = 'skip'; rec.reason = c.skip; return; }
      if (e.uncompressedSize > MAX_ENTRY) { rec.status = 'skip'; rec.reason = 'файл больше 60 МБ'; return; }
      total += e.uncompressedSize;
      if (total > MAX_TOTAL) throw new Error('распакованный архив больше 3 ГБ');
      rec.file = `${n}${path.extname(name).toLowerCase()}`;
      await pipeline(await readStream(z, e), fsc.createWriteStream(path.join(dir(job.id), 'files', rec.file)));
    });
    job.files = files;
    job.total = files.length;
    job.state = 'reading';
    await save(job);
    await fs.unlink(zipFile).catch(() => {});
  }

  // Блоки сообщения для одного документа.
  async function blocks(job, f) {
    const buf = await fs.readFile(path.join(dir(job.id), 'files', f.file));
    const label = { type: 'text', text: `Документ из архива: «${f.name}». Извлеки данные по правилам.` };
    if (f.kind === 'pdf') {
      if (buf.length > 30 * 1024 * 1024) throw Object.assign(new Error('PDF больше 30 МБ'), { skip: true });
      return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }, label];
    }
    if (f.kind === 'image') {
      const ext = path.extname(f.file);
      let data = buf; let type = IMG[ext];
      if (data.length > IMG_LIMIT) {
        if (type !== 'image/jpeg') throw Object.assign(new Error('изображение больше 3,5 МБ — сохраните как JPG'), { skip: true });
        data = shrinkJpeg(data);
        type = 'image/jpeg';
      }
      return [{ type: 'image', source: { type: 'base64', media_type: type, data: data.toString('base64') } }, label];
    }
    let text = '';
    if (f.kind === 'sheet') text = await sheetText(appDir, buf);
    else if (f.kind === 'docx') text = await docxText(buf);
    else text = buf.toString('utf8');
    if (/\.html?$/i.test(f.file)) text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw Object.assign(new Error('в файле нет текста'), { skip: true });
    return [{ type: 'text', text: `${label.text}\n\n<документ>\n${text.slice(0, 150000)}\n</документ>` }];
  }

  async function ask(system, content, schema, maxTokens) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await runRequest(claude, prepareRequest({ model: MODELS.expert, system, messages: [{ role: 'user', content }], maxTokens, effort: 'low', schema }));
        const txt = responseText(res);
        if (txt == null) throw Object.assign(new Error('нейросеть отказалась читать документ'), { final: true });
        return { out: JSON.parse(txt), usage: res.usage };
      } catch (err) {
        const st = err.status;
        // Перегрузка или лимит токенов в минуту — ждём и повторяем; ошибка в самом документе — сразу дальше.
        if (err.final || (st && st < 500 && st !== 429 && st !== 408) || attempt >= 8) throw err;
        await sleep(Math.min(120000, 20000 * attempt));
      }
    }
  }

  async function readOne(job, f) {
    f.status = 'work';
    try {
      const content = await blocks(job, f);
      const { out, usage } = await ask(IMPORT_SYSTEM, content, DOC_SCHEMA, 8000);
      f.result = out;
      f.status = out.readable === false ? 'skip' : 'ok';
      if (out.readable === false) f.reason = out.problem || 'не удалось прочитать';
      if (usage) { job.usage.input += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0); job.usage.output += usage.output_tokens || 0; }
    } catch (err) {
      f.status = err.skip ? 'skip' : 'fail';
      f.reason = String(err.error?.error?.message || err.message || 'ошибка').slice(0, 200);
      if (!err.skip) console.error(`medimport ${job.id} #${f.n}:`, f.reason);
    }
    job.done = job.files.filter((x) => !['wait', 'work'].includes(x.status)).length;
    await save(job);
  }

  async function summarize(job) {
    job.state = 'summary';
    await save(job);
    const ok = job.files.filter((f) => f.status === 'ok' && f.result);
    const diag = []; const meds = []; const labs = new Map();
    for (const f of ok) {
      const r = f.result;
      for (const d of r.diagnoses || []) diag.push(`${r.date || '?'}: ${d}`);
      for (const m of r.meds || []) meds.push(`${r.date || '?'}: ${m.name} ${m.dose} ${m.how} [${m.status}]`);
      for (const l of r.labs || []) { const k = l.name.toLowerCase(); const p = labs.get(k); if (!p || String(r.date) >= String(p.date)) labs.set(k, { ...l, date: r.date }); }
    }
    if (!ok.length) { job.summary = { diagnoses: [], meds: [], memo: '', timeline: [], questions: [], exams: [], team: [] }; return; }
    const labLines = [...labs.values()].map((l) => `${l.date}: ${l.name} ${l.value} ${l.unit} (норма ${l.ref || '?'})${l.flag ? ` ${l.flag}` : ''}`);
    const docs = ok.map((f) => `${f.result.date || '?'} — ${f.result.kind}: ${f.result.title}. ${f.result.summary}`);
    const text = `Документов разобрано: ${ok.length}.\n\nДиагнозы по документам:\n${diag.join('\n') || 'нет'}\n\nЛекарства по документам:\n${meds.join('\n') || 'нет'}\n\nПоследние значения анализов:\n${labLines.join('\n') || 'нет'}\n\nДокументы:\n${docs.join('\n')}`.slice(0, 300000);
    try {
      const { out } = await ask(SUMMARY_SYSTEM, [{ type: 'text', text }], SUMMARY_SCHEMA, 16000);
      job.summary = out;
    } catch (err) {
      job.summary = { diagnoses: [], meds: [], memo: '', timeline: [], questions: [], exams: [], team: [], error: String(err.message || err).slice(0, 200) };
    }
  }

  async function run(job) {
    active = job;
    try {
      if (job.state === 'uploaded' || job.state === 'unpacking') await unpack(job);
      if (job.state === 'reading') {
        for (const f of job.files) if (f.status === 'work') f.status = 'wait';
        const queue = job.files.filter((f) => f.status === 'wait');
        await Promise.all(Array.from({ length: CONCURRENCY }, async () => { for (let f; (f = queue.shift());) await readOne(job, f); }));
        job.state = 'summary';
      }
      if (job.state === 'summary') await summarize(job);
      job.state = 'done';
      job.finished = new Date().toISOString();
    } catch (err) {
      console.error(`medimport ${job.id}:`, err);
      job.state = 'error';
      job.error = String(err.message || err).slice(0, 300);
    }
    await save(job);
    active = null;
  }

  // После перезапуска службы — продолжить незаконченный разбор.
  async function resume() {
    await fs.mkdir(root, { recursive: true });
    for (const id of await fs.readdir(root).catch(() => [])) {
      try {
        const job = JSON.parse(await fs.readFile(path.join(dir(id), 'job.json'), 'utf8'));
        jobs.set(id, job);
        if (!['done', 'error'].includes(job.state) && claude && !active) run(job);
      } catch { /* не задание */ }
    }
  }

  function latest() {
    return [...jobs.values()].sort((a, b) => String(b.created).localeCompare(String(a.created)))[0] || null;
  }

  // Ответ приложению: ход разбора; результаты — когда всё готово.
  function view(job) {
    if (!job) return { job: null };
    const files = (job.files || []).map((f) => ({ n: f.n, name: f.name, status: f.status, reason: f.reason, ...(job.state === 'done' && f.result ? { result: f.result } : {}) }));
    const count = (s) => files.filter((f) => f.status === s).length;
    return { job: { id: job.id, created: job.created, finished: job.finished || null, state: job.state, error: job.error || '', total: job.total || 0, done: job.done || 0, ok: count('ok'), skipped: count('skip'), failed: count('fail'), applied: job.applied || null, usage: job.usage, files, summary: job.state === 'done' ? job.summary || null : null } };
  }

  // POST /api/med/import — тело запроса: zip.
  async function upload(req) {
    if (!claude) return [503, { error: 'ai_not_configured' }];
    if (active) return [409, { error: 'busy', message: 'Предыдущий архив ещё разбирается.' }];
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_ZIP) return [413, { error: 'too_large', message: 'Архив больше 800 МБ.' }];
    const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
    await fs.mkdir(dir(id), { recursive: true });
    const zipFile = path.join(dir(id), 'archive.zip');
    let size = 0;
    const out = fsc.createWriteStream(zipFile);
    try {
      for await (const c of req) {
        size += c.length;
        if (size > MAX_ZIP) throw Object.assign(new Error('too_large'), { code: 413 });
        if (!out.write(c)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((ok, bad) => out.end((err) => (err ? bad(err) : ok())));
      // Проверка, что это zip: подпись PK.
      const fh = await fs.open(zipFile);
      const sig = Buffer.alloc(4);
      await fh.read(sig, 0, 4, 0);
      await fh.close();
      if (sig.readUInt32LE(0) !== 0x04034b50) throw Object.assign(new Error('not_zip'), { code: 400 });
    } catch (err) {
      out.destroy();
      await fs.rm(dir(id), { recursive: true, force: true });
      if (err.code === 413) return [413, { error: 'too_large', message: 'Архив больше 800 МБ.' }];
      if (err.code === 400) return [400, { error: 'not_zip', message: 'Это не zip-архив.' }];
      throw err;
    }
    const job = { id, created: new Date().toISOString(), state: 'uploaded', size, total: 0, done: 0, files: [], usage: { input: 0, output: 0 } };
    jobs.set(id, job);
    await save(job);
    run(job);
    return [200, view(job)];
  }

  async function applied(id) {
    const job = jobs.get(id);
    if (!job) return [404, { error: 'not_found' }];
    job.applied = new Date().toISOString();
    await save(job);
    return [200, { ok: true }];
  }

  // Повторить документы, которые не удалось прочитать (сбой связи, лимит нейросети).
  async function retry(id) {
    const job = jobs.get(id);
    if (!job) return [404, { error: 'not_found' }];
    if (active) return [409, { error: 'busy' }];
    let n = 0;
    for (const f of job.files || []) if (f.status === 'fail') { f.status = 'wait'; f.reason = ''; n++; }
    if (!n) return [200, view(job)];
    job.state = 'reading';
    job.summary = null;
    job.applied = null;
    await save(job);
    run(job);
    return [200, view(job)];
  }

  return { upload, status: () => view(latest()), applied, retry, resume };
}
