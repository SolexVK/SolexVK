// Сервер приложения «Тай-Чи».
// Хранит данные ученика (дневник, анкету, программу, беседы, память мастера) и передаёт запросы
// мастера к Claude API, чтобы ключ API жил на сервере, а не в телефоне.
//
// Переменные окружения:
//   APP_TOKEN          — ключ доступа приложения к серверу (обязателен, длинная случайная строка)
//   ANTHROPIC_API_KEY  — ключ Claude API (без него сервер только хранит данные)
//   PORT               — порт, по умолчанию 8787
//   DATA_DIR           — папка данных, по умолчанию ./data
//   ALLOW_ORIGIN       — откуда разрешены запросы, по умолчанию https://solexvk.github.io
//   SERVE_APP=1        — раздавать само приложение из ../docs (тогда сайт и сервер на одном адресе)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { ALLOWED_MODELS, runRequest } from '../docs/js/ai-request.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.APP_TOKEN || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, 'data'));
const ORIGINS = (process.env.ALLOW_ORIGIN || 'https://solexvk.github.io').split(',').map((s) => s.trim());
const SERVE_APP = process.env.SERVE_APP === '1';
const APP_DIR = path.resolve(here, '..', 'docs');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_BODY = 8 * 1024 * 1024;

if (TOKEN.length < 16) {
  console.error('Задайте APP_TOKEN длиной не меньше 16 символов.');
  process.exit(1);
}
await fs.mkdir(path.join(DATA_DIR, 'backups'), { recursive: true });
const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic({ maxRetries: 2 }) : null;

// ---- хранилище: один файл, запись через временный файл ----
async function readState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); } catch { return { rev: 0, state: null, updatedAt: null }; }
}
let writing = Promise.resolve();
function writeState(doc) {
  writing = writing.then(async () => {
    const tmp = `${STATE_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc));
    await fs.rename(tmp, STATE_FILE);
    // Копия раз в день: можно откатиться, если что-то пошло не так.
    const day = new Date().toISOString().slice(0, 10);
    const bak = path.join(DATA_DIR, 'backups', `state-${day}.json`);
    await fs.copyFile(STATE_FILE, bak).catch(() => {});
  });
  return writing;
}

// ---- ограничение частоты запросов к нейросети ----
const hits = [];
function rateLimited() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60000) hits.shift();
  if (hits.length >= 30) return true;
  hits.push(now);
  return false;
}

// ---- помощники ----
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ORIGINS.includes(origin) || ORIGINS.includes('*'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}
function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function authorized(req) {
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('too_large'), { code: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.task': 'application/octet-stream' };
async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let file = path.normalize(path.join(APP_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(APP_DIR)) return send(res, 403, { error: 'forbidden' });
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    return res.end(data);
  } catch {
    return send(res, 404, { error: 'not_found' });
  }
}

// ---- маршруты ----
const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    if (SERVE_APP && req.method === 'GET') return serveStatic(req, res);
    return send(res, 404, { error: 'not_found' });
  }
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, ai: !!claude });
  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

  try {
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, await readState());
    }
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!body.state || typeof body.state !== 'object') return send(res, 400, { error: 'bad_state' });
      const cur = await readState();
      // Кто-то записал раньше нас — отдаём серверную копию, приложение объединит и повторит.
      if (cur.state && Number(body.rev) !== cur.rev) return send(res, 409, cur);
      const doc = { rev: cur.rev + 1, state: body.state, updatedAt: new Date().toISOString() };
      await writeState(doc);
      return send(res, 200, { rev: doc.rev, updatedAt: doc.updatedAt });
    }
    if (url.pathname === '/api/messages' && req.method === 'POST') {
      if (!claude) return send(res, 503, { error: 'ai_not_configured' });
      if (rateLimited()) return send(res, 429, { error: 'rate_limited' });
      const reqBody = await readBody(req);
      const body = reqBody.body || {};
      // Пропускаем только разрешённые модели и разумный размер ответа.
      if (!ALLOWED_MODELS.has(body.model)) return send(res, 400, { error: 'model_not_allowed' });
      body.max_tokens = Math.min(Number(body.max_tokens) || 4000, 16000);
      const out = await runRequest(claude, { beta: !!reqBody.beta, body });
      return send(res, 200, out);
    }
    return send(res, 404, { error: 'not_found' });
  } catch (err) {
    if (err.code === 413) return send(res, 413, { error: 'too_large' });
    if (err instanceof SyntaxError) return send(res, 400, { error: 'bad_json' });
    if (err instanceof Anthropic.RateLimitError) return send(res, 429, { error: 'rate_limited' });
    if (err instanceof Anthropic.APIError) return send(res, 502, { error: 'ai_error', status: err.status });
    console.error(err);
    return send(res, 500, { error: 'server_error' });
  }
});

server.listen(PORT, () => console.log(`Тай-Чи сервер слушает порт ${PORT}${claude ? ', нейросеть подключена' : ', без нейросети'}${SERVE_APP ? ', раздаёт приложение' : ''}`));
