// The term glossary of the cards: which English tech words stay English ("keep") and which have a
// rendering in the content language that people really use ("<code>:<rendering>").
//
// Rows come from four places: a seed file, System One (asked once per unknown term, the answer is
// cached) and the owner (the sources dialog; an owner row is never overwritten by anything else).
// Everything here is deterministic and cheap; the models are called from llm.js, which owns the
// transport.
//
// Seed files, in this order:
//   src/fresh/glossary/en.json           shipped: the English terms that stay English, and candidates
//   <dataDir>/glossary.<code>.json       a deployment's own seed (the export script writes it)
//
// A seed file is { id, lang, keep: [{term, bad}], translate: [{term, form, bad}], candidates: [...],
// typos: { wrong: right } }. "bad" lists renderings that must not appear in a card whose source
// uses the term; for English cards that list is normally empty.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { content } from './content.js';
import * as store from './store.js';

export const SEED_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'glossary');

const readSeed = (file) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

// -> { keep, translate, candidates, typos }
export function loadSeed({ dataDir = config.dataDir, languageCode = content().languageCode } = {}) {
  const shipped = readSeed(path.join(SEED_DIR, 'en.json')) ?? {};
  const own = languageCode && languageCode !== 'en' ? readSeed(path.join(dataDir, `glossary.${languageCode}.json`)) : null;
  const pick = (list) => (Array.isArray(list) ? list.filter((entry) => entry && typeof entry.term === 'string') : []);
  return {
    keep: [...pick(shipped.keep), ...pick(own?.keep)],
    translate: [...pick(shipped.translate), ...pick(own?.translate)],
    candidates: [...(Array.isArray(shipped.candidates) ? shipped.candidates : []), ...(Array.isArray(own?.candidates) ? own.candidates : [])],
    typos: { ...(shipped.typos ?? {}), ...(own?.typos ?? {}) },
  };
}

const SEED = loadSeed();

// term -> renderings that must not appear in a card whose source uses the term ("bad"; matched whole words only)
const SEED_KEEP = SEED.keep.map((entry) => [entry.term, Array.isArray(entry.bad) ? entry.bad : []]);
// Where the content language has its own usual word: decided here, not asked.
const SEED_OWN = SEED.translate.map((entry) => [entry.term, String(entry.form ?? '')]);

// Phrases worth asking System One about when they are not decided yet (curated; extend freely).
export const CANDIDATES = SEED.candidates;

// A common rendering of some of them, so a "translate" answer can be used without asking a writer.
const FORMS = Object.fromEntries(SEED.translate.filter((entry) => entry.form).map((entry) => [entry.term, String(entry.form)]));
export const knownForm = (term) => FORMS[term] ?? '';

const TYPOS = SEED.typos;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const spaced = (term) => esc(term).replace(/(?:\\?[ -])+/g, '[ -]');
const B = '(?<![A-Za-z0-9])';
const E = '(?![A-Za-z0-9])';
// Affix patterns of the content language's word building, used to spot a rendering hidden inside a
// derived word (a prefix or suffix the swap cannot remove safely). The shipped list is the general
// set of South-East Asian affixes; a language with other word building simply never matches.
const PREFIX = '(?:meng|meny|mem|men|me|di|ter|ber|pem|pen|peng|pe|per|ke|se)';
const SUFFIX = '(?:kan|an|i|nya|lah|kah|pun)';

export const normTerm = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
export const validTerm = (t) => /^[a-z0-9][a-z0-9 .+#/-]{0,46}[a-z0-9+#]?$/.test(t) && t.length >= 2;

export function seedGlossary() {
  for (const [term, bad] of SEED_KEEP) store.glossaryPut({ term, decision: 'keep', source: 'seed', bad: bad.length ? bad : null }, false);
  for (const [term, form] of SEED_OWN) if (form) store.glossaryPut({ term, decision: `${content().languageCode}:${form}`, source: 'seed', form }, false);
}
seedGlossary();

const prefixOf = () => `${content().languageCode}:`;
const parse = (r) => ({ term: r.term, keep: r.decision === 'keep', form: r.decision.includes(':') ? r.decision.slice(r.decision.indexOf(':') + 1) : r.form ?? '', decision: r.decision, source: r.source, bad: r.bad ? JSON.parse(r.bad) : [], hits: r.hits, updatedAt: r.updated_at });
export const entries = () => store.glossaryAll().map(parse);
export const entryOf = (term) => { const r = store.glossaryGet(normTerm(term)); return r ? parse(r) : null; };

// How the source can mention a term: plural, -ed, -ing ("fine-tuning", "flashing", "patches").
const termRe = new Map();
function reOf(term) {
  let re = termRe.get(term);
  if (!re) {
    const base = spaced(term);
    const stem = term.endsWith('e') ? `|${spaced(term.slice(0, -1))}ing` : '';
    re = new RegExp(`${B}(?:${base}(?:s|es|d|ed|ing|ings)?${stem})${E}`, 'i');
    termRe.set(term, re);
  }
  return re;
}

// CamelCase and acronyms are names: always kept as they are.
export function namesIn(text) {
  const out = new Set();
  if (!/[a-z]/.test(text)) return [];
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{1,5}\b|\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*/g)) out.add(m[0]);
  return [...out].slice(0, 10);
}

// text: the source (title + snippet/text). -> { entries: decided terms it uses, unknown: candidate terms not decided yet, names }
export function extract(text, all = entries()) {
  const t = String(text ?? '');
  const decided = new Set(all.map((e) => e.term));
  const used = all.filter((e) => reOf(e.term).test(t));
  // "coding agent" already says it all: the shorter "agent" stays in the list too (its renderings are checked separately).
  const unknown = CANDIDATES.filter((c) => !decided.has(c) && reOf(c).test(t));
  return { entries: used, unknown, names: namesIn(t) };
}

// Context sentence for an unknown term (what System One reads next to the term).
export function contextOf(term, text) {
  const m = reOf(term).exec(text);
  if (!m) return '';
  const from = Math.max(0, m.index - 90);
  return text.slice(from, m.index + term.length + 110).replace(/\s+/g, ' ').trim();
}

// The hard rules for one card, as text for the writer ('' when there is nothing to say).
export function rulesText(used, names = []) {
  const keep = used.filter((e) => e.keep).map((e) => e.term);
  const tr = used.filter((e) => !e.keep && e.form).map((e) => `${e.term} → ${e.form}`);
  const parts = [];
  if (keep.length) parts.push(`write exactly in English (do not translate): ${keep.join(', ')}`);
  if (tr.length) parts.push(`translate: ${tr.join('; ')}`);
  if (names.length) parts.push(`keep names exactly: ${names.join(', ')}`);
  return parts.join('. ');
}

const keepCase = (from, to) => (from.length > 1 && from === from.toUpperCase() ? to.toUpperCase() : from[0] === from[0].toUpperCase() && from[0] !== from[0].toLowerCase() ? to[0].toUpperCase() + to.slice(1) : to);

// Deterministic post-check of one written field. Replaces a forbidden rendering of a kept term (whole word only: "agenda" is never
// touched; "agennya" -> "agent-nya"; "agen-agen" -> "agent"). `unsafe`: the rendering is still there inside a derived word
// (dikuantisasi, keagenan) that cannot be swapped without rewriting the sentence.
export function fixText(text, used) {
  let out = String(text ?? '');
  const fixes = [];
  const pairs = [];
  for (const e of used) if (e.keep) for (const bad of e.bad) pairs.push([bad, e.term]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  for (const [bad, term] of pairs) {
    const p = spaced(bad);
    out = out.replace(new RegExp(`${B}${p}[ -]${p}${E}`, 'gi'), (m) => { fixes.push(`${bad}→${term}`); return keepCase(m, term); });
    out = out.replace(new RegExp(`${B}${p}(nya|lah|kah|pun)?${E}`, 'gi'), (m, suf) => { fixes.push(`${bad}→${term}`); return keepCase(m, term) + (suf ? `-${suf.toLowerCase()}` : ''); });
  }
  for (const [typo, right] of Object.entries(TYPOS)) {
    out = out.replace(new RegExp(`${B}${typo}${E}`, 'gi'), (m) => { fixes.push(`${typo}→${right}`); return keepCase(m, right); });
  }
  const unsafe = pairs.some(([bad]) => new RegExp(`${B}${PREFIX}?${spaced(bad)}${SUFFIX}?${E}`, 'i').test(out));
  return { text: out, fixes, unsafe };
}

// card: { title_local, summary, why } -> { card, fixes, unsafe }
export function fixCard(card, used) {
  const out = { ...card };
  const fixes = [];
  let unsafe = false;
  for (const f of ['title_local', 'summary', 'why']) {
    if (typeof card[f] !== 'string') continue;
    const r = fixText(card[f], used);
    out[f] = r.text; fixes.push(...r.fixes); unsafe ||= r.unsafe;
  }
  return { card: out, fixes, unsafe };
}

// ---------- owner / system writes ----------
// decision: 'keep' | 'translate' (uses `form`, the remembered one or the known one) | '<code>:<form>'
export function setDecision(term, decision, { source = 'owner', form = '', bad } = {}) {
  const t = normTerm(term);
  if (!validTerm(t)) throw new Error('That term is not valid.');
  const old = store.glossaryGet(t);
  const prefix = prefixOf();
  let d = String(decision ?? '');
  if (d === 'translate') {
    const f = String(form || (old?.decision.startsWith(prefix) ? old.decision.slice(prefix.length) : '') || old?.form || knownForm(t)).trim().toLowerCase();
    if (!f) throw new Error(`A rendering in ${content().language} is required.`);
    d = `${prefix}${f}`;
  }
  if (d.startsWith(prefix)) {
    const f = d.slice(prefix.length).trim().toLowerCase();
    if (!/^[\p{L}0-9][\p{L}0-9 -]{0,38}$/u.test(f) || f === t) throw new Error(`That ${content().language} rendering is not valid.`);
    d = `${prefix}${f}`;
  } else if (d !== 'keep') throw new Error('The decision must be keep or translate.');
  const badList = Array.isArray(bad) ? bad.map((b) => normTerm(b)).filter((b) => b && b.length < 48).slice(0, 12) : null;
  store.glossaryPut({ term: t, decision: d, source, bad: badList?.length ? badList : null, form: d.startsWith(prefix) ? d.slice(prefix.length) : old?.form ?? null });
  return entryOf(t);
}
// A System One decision never replaces anything already there.
export const cacheDecision = (term, decision, source = 'jev') => store.glossaryPut({ term: normTerm(term), decision, source, form: decision.startsWith(prefixOf()) ? decision.slice(prefixOf().length) : null }, false);

// A compact block for another prompt (the chat system message): the keep-terms used most, then the translations.
export function glossaryForPrompt(n = 40) {
  const all = entries().sort((a, b) => (b.source === 'owner') - (a.source === 'owner') || b.hits - a.hits || a.term.localeCompare(b.term));
  const keep = all.filter((e) => e.keep).slice(0, n).map((e) => e.term);
  const tr = all.filter((e) => !e.keep && e.form).slice(0, Math.max(5, Math.floor(n / 4))).map((e) => `${e.term} → ${e.form}`);
  const lines = [];
  if (keep.length) lines.push(`These technical terms stay in English, do not translate them: ${keep.join(', ')}.`);
  if (tr.length) lines.push(`These terms are translated: ${tr.join('; ')}.`);
  return lines.join('\n');
}
