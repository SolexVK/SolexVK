// Собирает все фразы мастера и их ключи: node tools/voice/dump.mjs > tools/voice/phrases.json
import { allSessionTexts } from '../../docs/js/course.js';
import { COACH_TEXTS } from '../../docs/js/coach.js';
import { INTAKE, INTAKE_DONE, CHECKIN, CHECKIN_REPLIES } from '../../docs/js/kb.js';
import { FLOW_LINES } from '../../docs/js/flow-lines.js';
import { clipKey, normText } from '../../docs/js/voice.js';
import { guideTexts } from '../../docs/js/guides.js';

const texts = [...new Set([...allSessionTexts(), ...COACH_TEXTS, ...INTAKE.map((q) => q.say), INTAKE_DONE, ...CHECKIN.map((q) => q.say), ...Object.values(CHECKIN_REPLIES), ...Object.values(FLOW_LINES), ...guideTexts()].map(normText))].sort();
process.stdout.write(JSON.stringify(texts.map((text) => ({ key: clipKey(text), text })), null, 1));
