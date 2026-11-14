// Собирает все тексты интерфейса, которым нужен перевод: node tools/i18n/collect.mjs > tools/i18n/keys.json
import fs from 'node:fs';
import path from 'node:path';
globalThis.localStorage = { getItem: () => null };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru' }, configurable: true });
globalThis.document = { documentElement: {} };
const root = path.resolve('docs');
const keys = new Set();
const add = (s) => { if (s && /[А-Яа-яЁё]/.test(s)) keys.add(s); };
// 1. t(…) в коде
for (const f of fs.readdirSync(path.join(root, 'js'))) {
  if (!f.endsWith('.js')) continue;
  const src = fs.readFileSync(path.join(root, 'js', f), 'utf8');
  for (const m of src.matchAll(/(?<![A-Za-z_$.])t\('((?:[^'\\]|\\.)*)'/g)) add(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
}
// 2. данные, которые показываются через t(переменная)
const course = await import(path.join(root, 'js/course.js'));
const kb = await import(path.join(root, 'js/kb.js'));
const coach = await import(path.join(root, 'js/coach.js'));
const flowLines = await import(path.join(root, 'js/flow-lines.js'));
const program = await import(path.join(root, 'js/program.js'));
Object.values(course.SESSION_META).forEach((m) => { add(m.title); add(m.sub); });
Object.values(course.BP_TEXT).forEach(add);
course.SAFETY_RULES.forEach(([k, v]) => { add(k); add(v); });
course.RED_FLAGS.forEach(add);
kb.LEVELS.forEach((l) => { add(l.name); add(l.goal); });
for (const q of [...kb.INTAKE, ...kb.CHECKIN]) { add(q.say); (q.options || []).forEach(([, l]) => add(l)); (q.fields || []).forEach(([, l]) => add(l)); add(q.unit); }
Object.values(kb.CHECKIN_REPLIES).forEach(add);
Object.values(flowLines.FLOW_LINES).forEach(add);
coach.COACH_TEXTS.forEach(add);
for (const kind of ['morning', 'day', 'evening']) for (const pl of program.allPlans()) for (const m of ['full', 'light', 'rest']) {
  for (const s of course.buildSession(kind, pl, m).steps) {
    add(s.title); add(s.text); add(s.group);
    for (const it of s.items) { add(it.text); (it.cues || []).forEach((c) => add(c.text)); }
  }
}
// 3. index.html
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const m of html.matchAll(/<span>([^<]*[А-Яа-я][^<]*)<\/span>|aria-label="([^"]*[А-Яа-я][^"]*)"/g)) add(m[1] || m[2]);
add('Тай-Чи');
process.stdout.write(JSON.stringify([...keys].sort(), null, 1));
