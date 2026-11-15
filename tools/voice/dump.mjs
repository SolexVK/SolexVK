// Собирает все фразы мастера и их ключи: node tools/voice/dump.mjs > tools/voice/phrases.json
import { allSessionTexts } from '../../docs/js/course.js';
import { COACH_TEXTS } from '../../docs/js/coach.js';
import { INTAKE, INTAKE_DONE, CHECKIN, CHECKIN_REPLIES } from '../../docs/js/kb.js';
import { FLOW_LINES } from '../../docs/js/flow-lines.js';
import { clipKey, normText, voiceKey } from '../../docs/js/voice.js';
import { liganTexts } from '../../docs/js/strength.js';
import { guideTexts } from '../../docs/js/guides.js';

const texts = [...new Set([...allSessionTexts(), ...COACH_TEXTS, ...INTAKE.map((q) => q.say), INTAKE_DONE, ...CHECKIN.map((q) => q.say), ...Object.values(CHECKIN_REPLIES), ...Object.values(FLOW_LINES), ...guideTexts()].map(normText))].sort();
// Фразы Ли Гана — его голосом, в своём пространстве ключей.
const ligan = [...new Set(liganTexts().map(normText))].sort();
const out = [...texts.map((text) => ({ key: clipKey(text), text })), ...ligan.map((text) => ({ key: voiceKey(text, 'ligan'), text, who: 'ligan' }))];
process.stdout.write(JSON.stringify(out, null, 1));
