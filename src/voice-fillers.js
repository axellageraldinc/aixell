import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Short phrases the voice chat speaks while the agent is still working, so the silence does not feel like a hang: one right
// away (`start`), then one at each mark of `waits`, longer and more apologetic as the wait grows. The defaults are English;
// put your own sets in data/voice-fillers.json (same shape) to change the words or the language.
export const DEFAULT_FILLERS = {
  start: ['One moment.', 'Let me check.', 'Give me a second.', 'Hmm, let me think.', 'Okay, working on it.', 'Sure, one sec.'],
  waits: [
    { at: [10, 15, 20], phrases: ['Still on it.', 'Almost there.', 'Still thinking.', 'Hang on a little longer.'] },
    { at: [30, 60], phrases: ['Still looking into it, hang on.', 'This is taking a bit longer.', 'Still working on it, just a moment.'] },
    { at: [120, 150, 180], phrases: ['Sorry, this is taking a while. Still on it.', 'Still running, thanks for waiting.', "That's a tricky one, still working on it."] },
    { at: [240, 300, 360], phrases: ['Really sorry, this is taking very long. Still working.', "Not done yet, but I'm still on it.", 'Thanks for waiting, just a bit more.'] },
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
    const at = tier?.at;
    if (!list || !Array.isArray(at) || !at.length || at.length > MAX_LIST) return null;
    if (!at.every((s) => Number.isInteger(s) && s >= 1 && s <= MAX_SECONDS)) return null;
    waits.push({ at: [...at], phrases: list });
  }
  return { start, waits };
}

export function loadFillers(file = path.join(config.dataDir, 'voice-fillers.json')) {
  try {
    return validateFillers(JSON.parse(fs.readFileSync(file, 'utf8'))) ?? DEFAULT_FILLERS;
  } catch {
    return DEFAULT_FILLERS;
  }
}
