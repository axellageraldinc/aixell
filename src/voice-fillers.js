import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Short phrases the voice chat speaks while the agent is still working, so the silence does not feel like a hang: one right
// away (`start`), then more, each after waiting a while since the previous one ended: `after` is that wait in seconds, and
// the phrases get longer and more apologetic as the waits grow. When the waits run out the last one repeats. The defaults are English;
// put your own sets in data/voice-fillers.json (same shape) to change the words or the language. `speed` is how fast they
// are spoken, from 0.5 to 2 (a speech provider's default pace can be too fast for short phrases).
export const DEFAULT_FILLERS = {
  speed: 1,
  start: ['One moment.', 'Let me check.', 'Give me a second.', 'Hmm, let me think.', 'Okay, working on it.', 'Sure, one sec.'],
  waits: [
    { after: [10, 15, 20], phrases: ['Still on it.', 'Almost there.', 'Still thinking.', 'Hang on a little longer.'] },
    { after: [30, 60], phrases: ['Still looking into it, hang on.', 'This is taking a bit longer.', 'Still working on it, just a moment.'] },
    { after: [120, 150, 180], phrases: ['Sorry, this is taking a while. Still on it.', 'Still running, thanks for waiting.', "That's a tricky one, still working on it."] },
    { after: [240, 300, 360], phrases: ['Really sorry, this is taking very long. Still working.', "Not done yet, but I'm still on it.", 'Thanks for waiting, just a bit more.'] },
  ],
};

const MAX_PHRASE = 200;
const MAX_LIST = 20;
const MAX_SECONDS = 3600;

function phrases(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_LIST) return null;
  const clean = list.map((p) => (typeof p === 'string' ? p.trim() : ''));
  return clean.every((p) => p && p.length <= MAX_PHRASE) ? clean : null;
}

// Returns the cleaned set, or null when the shape is wrong (the caller then uses the defaults).
export function validateFillers(raw) {
  const start = phrases(raw?.start);
  if (!start || !Array.isArray(raw.waits) || !raw.waits.length || raw.waits.length > MAX_LIST) return null;
  const waits = [];
  for (const tier of raw.waits) {
    const list = phrases(tier?.phrases);
    const after = tier?.after;
    if (!list || !Array.isArray(after) || !after.length || after.length > MAX_LIST) return null;
    if (!after.every((s) => Number.isInteger(s) && s >= 1 && s <= MAX_SECONDS)) return null;
    waits.push({ after: [...after], phrases: list });
  }
  const speed = raw.speed === undefined ? DEFAULT_FILLERS.speed : raw.speed;
  if (typeof speed !== 'number' || !(speed >= 0.5 && speed <= 2)) return null;
  return { speed, start, waits };
}

export function loadFillers(file = path.join(config.dataDir, 'voice-fillers.json')) {
  try {
    return validateFillers(JSON.parse(fs.readFileSync(file, 'utf8'))) ?? DEFAULT_FILLERS;
  } catch {
    return DEFAULT_FILLERS;
  }
}
