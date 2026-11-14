// Собирает все фразы мастера и их ключи: node tools/voice/dump.mjs > tools/voice/phrases.json
import { allSessionTexts } from '../../docs/js/course.js';
import { COACH_TEXTS } from '../../docs/js/coach.js';
import { clipKey, normText } from '../../docs/js/voice.js';

const texts = [...new Set([...allSessionTexts(), ...COACH_TEXTS].map(normText))].sort();
process.stdout.write(JSON.stringify(texts.map((text) => ({ key: clipKey(text), text })), null, 1));
