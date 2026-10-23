// The categories of the feed: which ones exist, what they are called, how fast they go stale and
// which words point at them. Three sources, in this order:
//
//   1. config.json  `fresh.categories`  (the whole list replaces the defaults)
//   2. <dataDir>/categories.json        (the same shape, for a deployment that keeps data in files)
//   3. the neutral defaults below       (technology, AI, security: no owner-specific taste)
//
// A category is { id, label, halfLifeHours, keywords: { pos, neg } }. Keywords are regular
// expressions as source strings; they are compiled once, with the `i` flag. An unreadable data
// file is a warning, never a crash: the defaults then apply.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// Neutral defaults: a general technology feed that anyone can start from. They are deliberately
// broad, not tuned to one reader.
export const DEFAULT_CATEGORIES = [
  {
    id: 'tech',
    label: 'Technology',
    halfLifeHours: 24,
    keywords: {
      pos: '\\b(release|launch|update|version|platform|software|hardware|chip|device|open source|standard|protocol|browser|runtime|compiler|database|cloud|server|network)\\b',
      neg: '\\b(celebrity|gossip|horoscope|recipe|travel deal|fashion)\\b',
    },
  },
  {
    id: 'ai',
    label: 'AI',
    halfLifeHours: 18,
    keywords: {
      pos: '\\b(model|llm|agent|agentic|inference|training|fine-?tun\\w*|quantiz\\w*|embedding|transformer|prompt|token|context window|benchmark|eval|open-?weights?|mcp|rag)\\b',
      neg: '\\b(agi|superintelligen\\w*|sentient|funding round|valuation|ai girlfriend|will replace)\\b',
    },
  },
  {
    id: 'security',
    label: 'Security',
    halfLifeHours: 36,
    keywords: {
      pos: '\\b(cve-\\d{4}-\\d+|vulnerabilit\\w*|zero[- ]day|rce|supply chain|malicious package|typosquat|prompt injection|leak(?:ed|s)?|exfiltrat\\w*|sandbox escape|phishing|advisory|exploit\\w*|backdoor|compromis\\w*|ransomware|malware)\\b',
      neg: '\\b(webinar|whitepaper|sponsored|top \\d+|how to choose)\\b',
    },
  },
];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// One entry, checked and compiled. Returns null and reports why when it cannot be used.
export function compileCategory(entry, { onError = (message) => console.warn(`[fresh] ${message}`) } = {}) {
  if (!isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id) {
    onError('categories: an entry without an id was ignored');
    return null;
  }
  const label = typeof entry.label === 'string' && entry.label ? entry.label : entry.id;
  const halfLifeHours = Number.isFinite(entry.halfLifeHours) && entry.halfLifeHours > 0 ? entry.halfLifeHours : 24;
  const source = isPlainObject(entry.keywords) ? entry.keywords : {};
  const pos = typeof source.pos === 'string' ? source.pos : '';
  const neg = typeof source.neg === 'string' ? source.neg : '';
  let posRe;
  let negRe;
  try {
    posRe = new RegExp(pos || '(?!)', 'i');
    negRe = new RegExp(neg || '(?!)', 'i');
  } catch {
    onError(`categories: the keywords of "${entry.id}" are not valid regular expressions, so it was ignored`);
    return null;
  }
  return { id: entry.id, label, halfLifeHours, keywords: { pos, neg }, posRe, negRe };
}

const readDataFile = (dataDir) => {
  const file = path.join(dataDir, 'categories.json');
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed?.categories;
    if (!Array.isArray(list)) {
      console.warn('[fresh] categories.json: expected a list, the defaults apply');
      return null;
    }
    return list;
  } catch {
    console.warn('[fresh] categories.json: not valid JSON, the defaults apply');
    return null;
  }
};

// Which entries to use: config, else the data file, else the defaults. Exported so the export
// script and the tests can ask without importing the whole Fresh pipeline.
export function categorySource({ settings = config.fresh ?? {}, dataDir = config.dataDir } = {}) {
  if (Array.isArray(settings.categories) && settings.categories.length) return { list: settings.categories, from: 'config' };
  const fromFile = readDataFile(dataDir);
  if (fromFile) return { list: fromFile, from: 'data' };
  return { list: DEFAULT_CATEGORIES, from: 'defaults' };
}

export function loadCategories(opts = {}) {
  const { list } = categorySource(opts);
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const category = compileCategory(entry);
    if (!category || seen.has(category.id)) continue;
    seen.add(category.id);
    out.push(category);
  }
  if (!out.length) return DEFAULT_CATEGORIES.map((entry) => compileCategory(entry)).filter(Boolean);
  return out;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const RESERVED = new Set(['all', 'saved']);
export const MAX_CATEGORIES = 12;

// What the editor in Settings shows: the raw entries, and whether it may change them (not when config.json owns the list).
export function categoryEditorView(opts = {}) {
  const { list, from } = categorySource(opts);
  const entries = list.filter(isPlainObject).map((entry) => ({
    id: String(entry.id ?? ''),
    label: typeof entry.label === 'string' && entry.label ? entry.label : String(entry.id ?? ''),
    halfLifeHours: Number.isFinite(entry.halfLifeHours) && entry.halfLifeHours > 0 ? entry.halfLifeHours : 24,
    keywords: { pos: typeof entry.keywords?.pos === 'string' ? entry.keywords.pos : '', neg: typeof entry.keywords?.neg === 'string' ? entry.keywords.neg : '' },
  }));
  return { categories: entries, from, editable: from !== 'config' };
}

// Checks an edited list and writes it to <dataDir>/categories.json. Throws an Error with a reader-facing message.
export function saveCategories(list, { dataDir = config.dataDir, settings = config.fresh ?? {} } = {}) {
  if (Array.isArray(settings.categories) && settings.categories.length) throw new Error('The categories are set in config.json; edit them there.');
  if (!Array.isArray(list) || !list.length) throw new Error('Keep at least one category.');
  if (list.length > MAX_CATEGORIES) throw new Error(`At most ${MAX_CATEGORIES} categories.`);
  const seen = new Set();
  const clean = list.map((entry) => {
    const id = String(entry?.id ?? '').trim();
    if (!ID_RE.test(id) || RESERVED.has(id)) throw new Error(`"${id}" is not a usable id (lowercase letters, digits and dashes, up to 24).`);
    if (seen.has(id)) throw new Error(`The id "${id}" is used twice.`);
    seen.add(id);
    const label = String(entry?.label ?? '').trim().slice(0, 40);
    if (!label) throw new Error(`Category "${id}" needs a name.`);
    const halfLifeHours = Math.max(1, Math.min(240, Math.round(Number(entry?.halfLifeHours)) || 24));
    const pos = String(entry?.keywords?.pos ?? '').slice(0, 2000);
    const neg = String(entry?.keywords?.neg ?? '').slice(0, 2000);
    const out = { id, label, halfLifeHours, keywords: { pos, neg } };
    if (!compileCategory(out, { onError: () => {} })) throw new Error(`The keywords of "${label}" are not a valid regular expression.`);
    return out;
  });
  const file = path.join(dataDir, 'categories.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ categories: clean }, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return clean;
}
