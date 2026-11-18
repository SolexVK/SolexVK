// Загрузка архива медкарты в разделе доктора Шэна.
// Приложение отправляет zip на сервер (POST /api/med/import), сервер распаковывает и разбирает документы
// (server/medimport.js), приложение следит за ходом и по кнопке ученика вносит итог в медкарту (state.health).
import { serverConfig } from './sync.js';
import { save, dateStr } from './store.js';
import { health, newId } from './health.js';
import { t } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s) => String(s || '').trim();
const RUNNING = ['uploaded', 'unpacking', 'reading', 'summary'];

let last = null;      // последний ответ сервера о разборе
let uploading = null; // { pct } — пока архив отправляется
let timer = null;
let local = null;     // готовый разбор из файла .json (подготовлен заранее, без разбора на сервере)

async function getStatus() {
  const cfg = serverConfig();
  const r = await fetch(`${cfg.url}/api/med/import`, { cache: 'no-store', headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  last = (await r.json()).job;
  return last;
}

function upload(file, onPct) {
  const cfg = serverConfig();
  return new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open('POST', `${cfg.url}/api/med/import`);
    x.setRequestHeader('Authorization', `Bearer ${cfg.token}`);
    x.setRequestHeader('Content-Type', 'application/zip');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100)); };
    x.onload = () => {
      let body = {};
      try { body = JSON.parse(x.responseText); } catch { /* пусто */ }
      if (x.status === 200) ok(body.job);
      else bad(new Error(body.message || (x.status === 401 ? t('Сервер не принял ключ доступа.') : t('Сервер ответил ошибкой {n}.', { n: x.status }))));
    };
    x.onerror = () => bad(new Error(t('Нет связи. Проверьте интернет.')));
    x.send(file);
  });
}

// Цена разбора — по токенам (Sonnet: $2 / $10 за миллион).
const cost = (u) => (u ? (u.input * 2 + u.output * 10) / 1e6 : 0);

function boxHTML() {
  if (!serverConfig()) return `<p class="note">${t('Загрузка архива медкарты работает, когда приложение подключено к вашему серверу.')}</p>`;
  const pick = `<label class="btn wide mi-pick" for="mi-file">${t('Загрузить архив медкарты (zip)')}</label><input type="file" id="mi-file" accept=".zip,application/zip,application/x-zip-compressed,.json,application/json" hidden>`;
  if (uploading) return `<p><b>${t('Отправляю архив на сервер: {p} %', { p: uploading.pct })}</b></p><progress max="100" value="${uploading.pct}"></progress><p class="note">${t('Не закрывайте приложение, пока архив не отправится.')}</p>`;
  const j = local || last;
  if (!j) return `${pick}<p class="note">${t('Соберите все документы — анализы, выписки, заключения, МРТ, фото и сканы — в один zip-архив. Сервер распакует его, доктор Шэн прочитает каждый документ, а вы одной кнопкой внесёте всё в медкарту.')}</p>`;
  if (RUNNING.includes(j.state)) {
    const what = j.state === 'reading' ? t('Доктор Шэн читает документы: {d} из {n}', { d: j.done, n: j.total }) : j.state === 'summary' ? t('Документы прочитаны, доктор Шэн составляет сводку…') : t('Распаковываю архив…');
    return `<p><b>${what}</b></p>${j.total ? `<progress max="${j.total}" value="${j.done}"></progress>` : '<progress></progress>'}
      <p class="note">${t('Разбор идёт на сервере — приложение можно закрыть и вернуться позже.')}${j.skipped || j.failed ? ` ${t('Пропущено: {s}, не прочитано: {f}.', { s: j.skipped, f: j.failed })}` : ''}</p>`;
  }
  if (j.state === 'error') return `<p class="srv-status err">${t('Разбор архива не удался: {e}', { e: esc(j.error) })}</p>${pick}`;
  const probs = j.files.filter((f) => f.status !== 'ok');
  const docs = j.files.filter((f) => f.status === 'ok');
  const R = docs.map((f) => f.result);
  const labs = R.reduce((a, r) => a + (r.labs?.length || 0), 0);
  const studies = R.reduce((a, r) => a + (r.studies?.length || 0), 0);
  const S = j.summary || {};
  const report = `<details class="mi-files"><summary>${t('Файлы: прочитано {o} из {n}', { o: j.ok, n: j.total })}</summary><ul>${j.files.map((f) => `<li class="mi-${f.status}">${f.status === 'ok' ? '✓' : f.status === 'skip' ? '–' : '✕'} ${esc(f.name)}${f.status === 'ok' ? ` <small>${esc(f.result.date)} · ${esc(f.result.title)}</small>` : ` <small>${esc(f.reason)}</small>`}</li>`).join('')}</ul></details>`;
  const retry = j.failed ? `<button type="button" class="btn ghost wide" id="mi-retry">${t('Повторить непрочитанные: {n}', { n: j.failed })}</button>` : '';
  if (j.applied) return `<p>${t('Архив от {d} внесён в медкарту: документов {n}.', { d: new Date(j.created).toLocaleDateString(), n: j.ok })}</p>${report}${retry}${pick}`;
  return `<p><b>${t('Архив разобран: документов {o} из {n}.', { o: j.ok, n: j.total })}</b></p>
    <ul class="mi-sum">
      <li>${t('Диагнозов: {n}', { n: S.diagnoses?.length || 0 })}</li>
      <li>${t('Лекарств в истории: {n}', { n: S.meds?.length || 0 })}</li>
      <li>${t('Показателей анализов: {n}', { n: labs })}</li>
      <li>${t('Исследований и заключений: {n}', { n: studies })}</li>
    </ul>
    ${probs.length ? `<p class="note">${t('Не прочитаны или пропущены: {n} — список ниже. Их можно исправить и загрузить вторым архивом.', { n: probs.length })}</p>` : ''}
    ${S.memo ? `<div class="msg-memo"><p>${esc(S.memo)}</p></div>` : ''}
    ${report}
    ${j.usage ? `<p class="note">${t('Разбор стоил около {c} $.', { c: cost(j.usage).toFixed(2) })}</p>` : ''}
    ${retry}
    <button type="button" class="btn wide" id="mi-apply">${t('Внести всё в медкарту')}</button>`;
}

// Готовый разбор из файла: { format: 'taichi-medarchive', version: 1, id, created, files: [{ n, name, status, reason, result }], summary }.
function readPrepared(d) {
  if (d?.format !== 'taichi-medarchive' || !Array.isArray(d.files)) throw new Error(t('Файл не похож на разбор медкарты.'));
  const files = d.files.map((f, i) => ({ n: f.n ?? i + 1, name: String(f.name || ''), status: f.result && f.status !== 'skip' && f.status !== 'fail' ? 'ok' : (f.status === 'fail' ? 'fail' : 'skip'), reason: String(f.reason || ''), result: f.result || null }));
  const count = (st) => files.filter((f) => f.status === st).length;
  const done = health().imports?.some((x) => x.id === d.id);
  return { id: String(d.id || `file-${Date.now()}`), created: d.created || new Date().toISOString(), state: 'done', total: files.length, done: files.length, ok: count('ok'), skipped: count('skip'), failed: 0, usage: null, applied: done ? new Date().toISOString() : null, files, summary: d.summary || null };
}

// Внести результат разбора в медкарту.
export function applyImport(j) {
  const h = health();
  const docs = j.files.filter((f) => f.status === 'ok' && f.result);
  const has = new Set(h.docs.map((d) => d.ref));
  const seen = new Set(h.docs.map((d) => `${d.file}|${d.date}|${d.title}`)); // тот же документ из другого разбора
  let labs = 0;
  for (const f of docs) {
    const r = f.result;
    const ref = `${j.id}:${f.n}`;
    if (has.has(ref) || seen.has(`${f.name}|${clean(r.date)}|${clean(r.title)}`)) continue;
    const src = [r.title, r.source].filter(Boolean).join(', ');
    h.docs.push({ id: newId(), ref, date: clean(r.date), kind: r.kind, title: clean(r.title), source: clean(r.source), summary: clean(r.summary), file: f.name });
    for (const l of r.labs || []) {
      if (!clean(l.name) || !clean(l.value)) continue;
      const rec = { date: clean(r.date), name: clean(l.name), value: clean(l.value), unit: clean(l.unit), ref: clean(l.ref), flag: l.flag || '', source: src };
      const dup = h.labs.find((x) => x.date === rec.date && x.name.toLowerCase() === rec.name.toLowerCase());
      if (dup) Object.assign(dup, rec); else { h.labs.push({ id: newId(), ...rec }); labs++; }
    }
    for (const s of r.studies || []) if (clean(s) && !h.studies.some((x) => x.date === clean(r.date) && x.text === clean(s))) h.studies.push({ id: newId(), date: clean(r.date), text: clean(s), source: src });
    for (const a of r.allergies || []) if (clean(a) && !h.allergies.some((x) => x.text.toLowerCase() === clean(a).toLowerCase())) h.allergies.push({ id: newId(), text: clean(a), source: src });
  }
  const S = j.summary || {};
  let dg = S.diagnoses || [];
  if (!dg.length) dg = [...new Set(docs.flatMap((f) => f.result.diagnoses || []).map(clean).filter(Boolean))].map((text) => ({ text, first: '', active: true }));
  for (const d of dg) {
    const text = d.active === false ? `${clean(d.text)} (в прошлом)` : clean(d.text);
    if (text && !h.diagnoses.some((x) => x.text.toLowerCase() === text.toLowerCase())) h.diagnoses.push({ id: newId(), text, date: clean(d.first), source: 'архив медкарты', at: Date.now() });
  }
  for (const m of S.meds || []) {
    const name = clean(m.name);
    if (!name) continue;
    const cur = h.medHistory.find((x) => x.name.toLowerCase() === name.toLowerCase());
    const rec = { name, dose: clean(m.dose), how: clean(m.how), first: clean(m.first), last: clean(m.last), status: m.status };
    if (cur) Object.assign(cur, rec); else h.medHistory.push({ id: newId(), ...rec });
  }
  h.labs.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  h.studies.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  h.docs.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  // История по годам и план доктора (вопросы, обследования, предложения мастерам) — из сводки разбора.
  if (S.timeline?.length) h.timeline = S.timeline.map((x) => ({ date: clean(x.date), text: clean(x.text) })).sort((a, b) => a.date.localeCompare(b.date));
  if (S.questions?.length || S.exams?.length || S.team?.length) h.plan = { at: dateStr(), questions: (S.questions || []).map(clean), exams: (S.exams || []).map((e) => ({ what: clean(e.what), why: clean(e.why), when: clean(e.when) })), team: (S.team || []).map((x) => ({ who: x.who, text: clean(x.text) })) };
  h.imports = [...(h.imports || []), { id: j.id, at: dateStr(), docs: docs.length }];
  save();
  return { docs: docs.length, labs };
}

export function importBoxHTML() { return `<div class="mi-box" id="mi-box">${boxHTML()}</div>`; }

// ui: { toast, onApplied(memo) } — onApplied перерисовывает медкарту и предлагает разговор с доктором.
export function bindImport(ui) {
  const draw = () => {
    const box = document.getElementById('mi-box');
    if (!box) { clearInterval(timer); timer = null; return; }
    box.innerHTML = boxHTML();
    wire(box);
  };
  const poll = () => {
    clearInterval(timer);
    timer = setInterval(async () => {
      if (!document.getElementById('mi-box')) { clearInterval(timer); timer = null; return; }
      try { await getStatus(); draw(); if (!last || !RUNNING.includes(last.state)) { clearInterval(timer); timer = null; } } catch { /* следующая попытка */ }
    }, 5000);
  };
  const wire = (box) => {
    box.querySelector('#mi-file')?.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (/\.json$/i.test(f.name)) {
        // Готовый разбор архива (файл taichi-medarchive): показываем итог, вносится той же кнопкой.
        try { local = readPrepared(JSON.parse(await f.text())); } catch (err) { ui.toast(err.message || t('Файл не похож на разбор медкарты.')); return; }
        draw();
        return;
      }
      if (!/\.zip$/i.test(f.name) && !/zip/.test(f.type)) { ui.toast(t('Нужен архив .zip.')); return; }
      local = null;
      uploading = { pct: 0 };
      draw();
      try {
        last = await upload(f, (p) => { if (p !== uploading.pct) { uploading.pct = p; draw(); } });
        uploading = null;
        draw();
        poll();
      } catch (err) {
        uploading = null;
        draw();
        ui.toast(err.message);
      }
    });
    box.querySelector('#mi-retry')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const cfg = serverConfig();
        const r = await fetch(`${cfg.url}/api/med/import/${encodeURIComponent(last.id)}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.token}` } });
        if (!r.ok) throw new Error(t('Сервер ответил ошибкой {n}.', { n: r.status }));
        last = (await r.json()).job;
        draw();
        poll();
      } catch (err) { ui.toast(err.message); draw(); }
    });
    box.querySelector('#mi-apply')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      const j = local || last;
      const res = applyImport(j);
      if (local) local.applied = new Date().toISOString();
      else {
        try {
          const cfg = serverConfig();
          await fetch(`${cfg.url}/api/med/import/${encodeURIComponent(last.id)}/applied`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.token}` } });
          last.applied = new Date().toISOString();
        } catch { /* отметка на сервере не обязательна */ }
      }
      ui.toast(t('В медкарту внесено документов: {d}, показателей анализов: {l}.', { d: res.docs, l: res.labs }));
      draw();
      ui.onApplied(j.summary?.memo || '');
    });
  };
  draw();
  if (!serverConfig()) return;
  getStatus().then(() => { draw(); if (last && RUNNING.includes(last.state)) poll(); }).catch(() => {});
}
