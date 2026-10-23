// The "meta-sentence" check of a written card: sentences about the text itself ("the text only
// contains a title", "this article explains ...") are a sign of a lazy rewrite, so the card is
// rejected and the paid writer is asked instead.
//
// The patterns are language-specific, so they live in data:
//
//   src/fresh/filters/meta.<code>.json   shipped lists (en)
//   <dataDir>/filters/meta.<code>.json   a deployment's own list, which replaces the shipped one
//
// A file is { id, lang, patterns: ["regex", ...] }. A language with no list is not checked at
// all: a wrong guess about another language is worse than no check. An invalid pattern is a
// warning and the rest of the list still applies.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const SHIPPED_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'filters');

const cache = new Map();

const compile = (list, where) => {
  const out = [];
  for (const [index, pattern] of (Array.isArray(list) ? list : []).entries()) {
    if (typeof pattern !== 'string' || !pattern) {
      console.warn(`[fresh] ${where}[${index}]: not a string, skipped`);
      continue;
    }
    try {
      out.push(new RegExp(pattern, 'i'));
    } catch {
      console.warn(`[fresh] ${where}[${index}]: not a valid regular expression, skipped`);
    }
  }
  return out;
};

// -> [RegExp], empty when the language has no list.
export function metaPatterns(lang, { dataDir = config.dataDir } = {}) {
  const code = String(lang || '').toLowerCase().slice(0, 8);
  if (!code) return [];
  const key = `${dataDir}|${code}`;
  if (cache.has(key)) return cache.get(key);
  const name = `meta.${code}.json`;
  const custom = path.join(dataDir, 'filters', name);
  const file = fs.existsSync(custom) ? custom : path.join(SHIPPED_DIR, name);
  let patterns = [];
  if (fs.existsSync(file)) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      console.warn(`[fresh] ${name}: not valid JSON, the check is skipped`);
    }
    if (parsed) patterns = compile(parsed.patterns, `${name}.patterns`);
  }
  cache.set(key, patterns);
  return patterns;
}

// -> true when the text reads like a sentence about the text itself.
export const isMeta = (text, lang, opts = {}) => metaPatterns(lang, opts).some((re) => re.test(String(text ?? '')));

// Tests and a config reload: forget what was read.
export const resetMetaCache = () => cache.clear();
