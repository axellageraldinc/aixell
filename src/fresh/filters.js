// The filter packs of the feed: small JSON lists of regular expressions that decide what is
// dropped before (and after) a model has looked at a story.
//
//   src/fresh/filters/en.json      the shipped English pack (affiliate, course, giveaway, deals, ...)
//   <dataDir>/filters/<id>.json    extra packs, e.g. the owner's own list for another language
//
// A pack is { id, lang, rules: [{ name, test, action }] } where `test` is a regular expression
// as a string (compiled with the `i` flag) and `action` is one of:
//
//   drop      the story is not shown at all
//   soft      the story is dropped unless it is on topic (an `allow` rule matches)
//   allow     the story is on topic, so `soft` rules do not apply to it
//   category  only applies when the story is in one of the listed `cats` (console business news)
//
// `unless` on a rule names another rule that cancels it (the shipped `homelab` rule does not
// apply to a self-hosted AI tool). A pack that cannot be read is a warning, never a crash.
//
// Which packs are active: config.json `fresh.filters.packs` (a list of ids), else the shipped
// `en` pack. Packs that are listed but missing are skipped with a warning.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const SHIPPED_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'filters');
export const SHIPPED_PACKS = ['en'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// One pack, checked and compiled. -> { pack, errors }
export function compilePack(raw, { where = 'pack' } = {}) {
  const errors = [];
  if (!isPlainObject(raw)) return { pack: null, errors: [`${where}: must be an object`] };
  if (typeof raw.id !== 'string' || !raw.id) errors.push(`${where}.id: must be a non-empty string`);
  const rules = [];
  for (const [index, rule] of (Array.isArray(raw.rules) ? raw.rules : []).entries()) {
    const at = `${where}.rules[${index}]`;
    if (!isPlainObject(rule)) { errors.push(`${at}: must be an object`); continue; }
    if (typeof rule.name !== 'string' || !rule.name) { errors.push(`${at}.name: must be a non-empty string`); continue; }
    if (!['drop', 'soft', 'allow', 'category'].includes(rule.action)) { errors.push(`${at}.action: must be drop, soft, allow or category`); continue; }
    if (typeof rule.test !== 'string' || !rule.test) { errors.push(`${at}.test: must be a non-empty regular expression`); continue; }
    let re;
    try {
      re = new RegExp(rule.test, 'i');
    } catch {
      errors.push(`${at}.test: not a valid regular expression`);
      continue;
    }
    const cats = rule.action === 'category' ? (Array.isArray(rule.cats) ? rule.cats.filter((cat) => typeof cat === 'string' && cat) : []) : [];
    if (rule.action === 'category' && !cats.length) { errors.push(`${at}.cats: a category rule needs a list of category ids`); continue; }
    rules.push({ name: rule.name, action: rule.action, test: rule.test, unless: typeof rule.unless === 'string' ? rule.unless : null, cats, re });
  }
  if (errors.length) return { pack: null, errors };
  return { pack: { id: raw.id, lang: typeof raw.lang === 'string' ? raw.lang : '', rules }, errors };
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// Every pack the configuration asks for, in order. A pack id found in the data dir replaces the
// shipped pack of the same id, so a deployment can adjust the English list without touching code.
export function loadPacks({ settings = config.fresh ?? {}, dataDir = config.dataDir } = {}) {
  const ids = Array.isArray(settings.filters?.packs) && settings.filters.packs.length ? settings.filters.packs : SHIPPED_PACKS;
  const packs = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const custom = path.join(dataDir, 'filters', `${id}.json`);
    const file = fs.existsSync(custom) ? custom : path.join(SHIPPED_DIR, `${id}.json`);
    if (!fs.existsSync(file)) {
      console.warn(`[fresh] filter pack "${id}" not found, skipped`);
      continue;
    }
    const { pack, errors } = compilePack(readJson(file), { where: `filter pack "${id}"` });
    if (errors.length) {
      console.warn(`[fresh] ${errors.join('; ')}; the pack was skipped`);
      continue;
    }
    packs.push(pack);
  }
  return packs;
}

// The rules of every active pack, flattened, with the pack id kept for debugging.
export const loadRules = (opts = {}) => loadPacks(opts).flatMap((pack) => pack.rules.map((rule) => ({ ...rule, pack: pack.id, lang: pack.lang })));

// One pack by language code, whether or not it is listed in `fresh.filters.packs`. A language
// connector (X search) uses this for its own slots: a deployment drops its language's junk words
// in `data/filters/<lang>.json`, and no pack means no extra filter (the English pack is never
// applied to posts in another language).
export function loadLangPack(code, { dataDir = config.dataDir } = {}) {
  const lang = String(code ?? '').slice(0, 2).toLowerCase();
  if (!lang) return null;
  const custom = path.join(dataDir, 'filters', `${lang}.json`);
  const file = fs.existsSync(custom) ? custom : path.join(SHIPPED_DIR, `${lang}.json`);
  if (!fs.existsSync(file)) return null;
  const { pack, errors } = compilePack(readJson(file), { where: `filter pack "${lang}"` });
  if (errors.length) {
    console.warn(`[fresh] ${errors.join('; ')}; the pack was skipped`);
    return null;
  }
  return pack;
}
