// Who Fresh is for, and what that means for every story: the categories, the reader profile and
// the filter rules. All three come from configuration and data files (see categories.js,
// taste.js and filters.js); this module keeps the names the rest of Fresh already imports, so
// the pipeline did not have to change shape.
//
// The neutral defaults ship in code: three broad categories and a general technology reader.
// A deployment overrides them in config.json or in its data directory.
import { loadCategories } from './categories.js';
import { loadTaste } from './taste.js';
import { loadRules } from './filters.js';

const categories = loadCategories();

// id -> label, in the configured order.
export const CATEGORIES = Object.fromEntries(categories.map((category) => [category.id, category.label]));
export const CAT_IDS = categories.map((category) => category.id);
export const CATEGORY_DEFS = categories;

// The category to fall back to when a story names one that this deployment does not have (the
// source list still ships the categories of the example deployment).
export const PRIMARY_CAT = CAT_IDS[0] ?? 'tech';
// The category that means "security", when the deployment has one.
export const SECURITY_CAT = CAT_IDS.includes('security') ? 'security' : null;

// How long a story stays interesting (hours until its freshness halves).
export const HALF_LIFE_H = Object.fromEntries(categories.map((category) => [category.id, category.halfLifeHours]));

// Handed to System One as the reader's "state" on every scoring call.
export const PROFILE = loadTaste();

// Per category: words that raise (pos) or lower (neg) a story before a model has looked at it, and as a fallback when no model
// answers. Matched on title + snippet.
export const KEYWORDS = Object.fromEntries(categories.map((category) => [category.id, { pos: category.posRe, neg: category.negRe }]));

// The active filter rules, flattened from the packs. `drop` rules hide a story outright; `soft`
// rules hide it unless the rule's `unless` names another rule that matches; `allow` rules only
// exist to be named by `unless`; `category` rules apply to the categories they list.
const RULES = loadRules();
const rulesOf = (...names) => RULES.filter((rule) => names.includes(rule.name));
const regexOf = (rules, fallback = /(?!)/) => {
  const source = rules.map((rule) => rule.test).filter(Boolean).join('|');
  try {
    return new RegExp(source || fallback.source, 'i');
  } catch {
    return fallback;
  }
};

// A rule that is not in the active packs answers "never matches", so a missing pack disables that check instead of crashing.
export const STACK = regexOf(rulesOf('stack'));
export const CRYPTO = regexOf(rulesOf('crypto'));
export const LISTICLE = regexOf(rulesOf('listicle'));
export const CONSOLE_BAN = regexOf(rulesOf('console-business'));
export const LAPTOP = regexOf(rulesOf('laptop'));
// Home-server news, without the laptop part ("notebooks" are Jupyter repositories in the GitHub connector).
export const NOT_WANTED = regexOf(rulesOf('homelab'));

const matches = (rule, text) => rule.re.test(text);
const allowNames = (text) => new Set(RULES.filter((rule) => rule.action === 'allow' && matches(rule, text)).map((rule) => rule.name));

export const hardBan = (text) => RULES.some((rule) => rule.action === 'drop' && matches(rule, text));

// A story in one of a rule's categories that matches it is out (console business news).
export const bannedIn = (cat, text) => RULES.some((rule) => rule.action === 'category' && rule.cats.includes(cat) && matches(rule, text));

// `lang`: the language of the post, when the source knows it. Only packs of that language (and the
// language-neutral ones) apply then; without it every pack applies.
export function unwanted(text, lang = '') {
  const rules = lang ? RULES.filter((rule) => !rule.lang || rule.lang === lang) : RULES;
  const allowed = allowNames(text);
  return rules.some((rule) => rule.action === 'soft' && matches(rule, text) && !(rule.unless && allowed.has(rule.unless)));
}

// -> 'tech' | ... | null: a guess from words alone, used when the source's own category is too broad (HN, Techmeme ...).
export function guessCat(text, fallback = null) {
  const hits = (cat) => (text.match(new RegExp(KEYWORDS[cat].pos.source, 'gi')) ?? []).length - (text.match(new RegExp(KEYWORDS[cat].neg.source, 'gi')) ?? []).length;
  if (SECURITY_CAT && STACK.test(text) && /\b(vulnerab|cve|exploit|malicious|leak|compromis|advisory)/i.test(text)) return SECURITY_CAT;
  let best = fallback;
  let top = fallback && KEYWORDS[fallback] ? hits(fallback) : 0; // the source's own category holds unless another clearly beats it
  for (const cat of CAT_IDS) {
    const n = hits(cat);
    if (n > top) { top = n; best = cat; }
  }
  return best;
}

// A rough 0..1 reading of how well a story fits, from words alone (a model refines it; this stands in when none answers).
export function keywordRelevance(cat, text) {
  const k = KEYWORDS[cat];
  if (!k) return 0.2;
  let v = 0.3;
  if (k.pos.test(text)) v += 0.3;
  if (k.neg.test(text)) v -= 0.3;
  if (cat === SECURITY_CAT && STACK.test(text)) v += 0.3;
  return Math.max(0, Math.min(1, v));
}


// The reader's rough interests, per category: words that raise or lower a story before a model has
// looked at it. Everything specific to one deployment (a taste profile, another language's words)
// lives in the data directory, not here.

