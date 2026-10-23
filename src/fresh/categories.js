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
