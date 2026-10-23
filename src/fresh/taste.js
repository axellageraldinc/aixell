// Who the feed is for, as text that goes into the prompts. Three sources, in this order:
//
//   1. config.json  `fresh.taste.profile`  (the text, or a `file:` reference inside the data dir)
//   2. <dataDir>/taste.md
//   3. the neutral profile below
//
// The text is handed to the classifier as the reader's state and to the writer as the
// {{profile}} slot, so it is read once, at import, like the rest of the configuration.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { readTextRef } from '../config/secrets.js';

// A neutral reader: no hardware, no country, no personal dislikes. It describes a general
// technology reader so a fresh install still writes sensible cards.
export const DEFAULT_PROFILE = `Reader: a technology enthusiast who follows software releases, developer tools, AI and security.
Wants concrete facts (versions, numbers, prices, benchmarks) over opinions, and distrusts rumours without a source.
Prefers short, neutral writing; dislikes hype, listicles, deals and advertising.`;

const readDataFile = (dataDir) => {
  const file = path.join(dataDir, 'taste.md');
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

// -> { text, from: 'config' | 'data' | 'defaults' }
export function tasteSource({ settings = config.fresh ?? {}, dataDir = config.dataDir } = {}) {
  const ref = settings.taste?.profile;
  if (typeof ref === 'string' && ref.trim()) {
    let text = null;
    try {
      text = readTextRef(ref.trim(), { dataDir });
    } catch (error) {
      // A path that escapes the data dir is a configuration mistake, not a reason to refuse to start.
      console.warn(`[fresh] taste.profile: ${error.message}; the defaults apply`);
    }
    if (text) return { text, from: 'config' };
  }
  const fromFile = readDataFile(dataDir);
  if (fromFile) return { text: fromFile, from: 'data' };
  return { text: DEFAULT_PROFILE, from: 'defaults' };
}

export const loadTaste = (opts = {}) => tasteSource(opts).text;
