import crypto from 'node:crypto';
import { CATEGORIES, HALF_LIFE_H } from './profile.js';
import { content } from './content.js';
import * as store from './store.js';

// "For you": the timeline is ranked like a social feed. Every ready card has a score
//     relevance (System One's taste reading + what the reader taught: topics, sources)  x  freshness (half-life per category)
//     x  corroboration (outlets that ran it)  + a little for stack security and popularity,
// then a mixer shapes the order so it does not read like a list sorted by one number: no more than two cards in a row from
// the same category or source, no category over 5 of any 12, about one card in ten from outside the top (exploration), and
// whatever the reader has already seen after everything unseen.
//
// The ranked order is frozen into a snapshot (kept 6 hours) the moment the first page is asked for; later pages are slices of
// it, so cards arriving or re-ranking while the reader scrolls never duplicate or skip anything.
const WINDOW_MS = 6 * 86_400_000;
const POOL_MAX = 600;
const PAGE = 12;
const QUOTA = 5;
const EXPLORE = 0.1;
export const LANG_BOOST = 0.08; // a card from a language-restricted source that passed the filters

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function scoreRow(row, { feedback, weights, now = Date.now() }) {
  const topics = row.topics ? JSON.parse(row.topics) : [];
  let taste = 0;
  for (const t of topics) taste += feedback.get(t) ?? 0;
  const relevance = clamp((row.rel ?? 0.4) + clamp(taste, -3, 3) * 0.12 + (weights.get(row.source) ?? 0) * 0.2, 0, 1.6);
  const ageH = Math.max(0, (now - row.published) / 3_600_000);
  const fresh = 0.5 ** (ageH / (HALF_LIFE_H[row.cat] ?? 18));
  const corroboration = 1 + 0.25 * Math.min(3, (row.outlets ?? 1) - 1);
  let bonus = row.flag === 'stack' ? 0.25 : 0;
  if (row.kind === 'steam-sale') bonus += 0.2;
  if (row.meta) {
    const meta = JSON.parse(row.meta);
    if (meta.points) bonus += 0.05 * Math.min(1, Math.log10(1 + meta.points) / 3);
    if (meta.gh?.d24) bonus += 0.08 * Math.min(1, Math.log10(1 + meta.gh.d24) / 3.5);
    if (meta.likes) bonus += 0.04 * Math.min(1, Math.log10(1 + meta.likes) / 3);
    if (meta.lang && meta.lang === content().languageCode) bonus += LANG_BOOST; // a share in the content language: a light nudge, never a quota
  }
  // A small floor keeps zero-relevance items ordered by age instead of tied.
  return relevance * fresh * corroboration + bonus * fresh + 0.01 * fresh;
}

const rngOf = (seed) => { let a = parseInt(crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 8), 16); return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

// items: [{ id, cat, source, score, rel }] sorted best first -> same items in shown order. `cat` set = one category, so the
// category rules are off. Rules loosen step by step if the items left cannot satisfy them.
export function mix(items, { cat = '', seed = 'x' } = {}) {
  const rng = rngOf(seed);
  const left = items.slice();
  const out = [];
  const ok = (it, level) => {
    const a = out.at(-1);
    const b = out.at(-2);
    if (level < 3 && a && b && a.source === it.source && b.source === it.source) return false;
    if (it.thread && level < 3 && out.slice(-PAGE + 1).some((x) => x.thread === it.thread)) return false; // one card per ongoing story on a page
    if (cat) return true;
    if (level < 2 && a && b && a.cat === it.cat && b.cat === it.cat) return false;
    if (level < 1 && out.slice(-PAGE + 1).filter((x) => x.cat === it.cat).length >= QUOTA) return false;
    return true;
  };
  while (left.length) {
    let pick = -1;
    // Exploration: now and then something from further down, from a category the last page showed little of.
    if (out.length >= 3 && left.length > 30 && rng() < EXPLORE) {
      const recent = out.slice(-PAGE);
      const count = (c) => recent.filter((x) => x.cat === c).length;
      const from = Math.max(20, Math.floor(left.length / 3));
      const tail = left.map((it, i) => ({ it, i })).filter(({ it, i }) => i >= from && (it.rel ?? 0) >= 0.3 && ok(it, 0));
      tail.sort((a, b) => count(a.it.cat) - count(b.it.cat) || a.i - b.i);
      if (tail.length) { pick = tail[Math.floor(rng() * Math.min(5, tail.length))].i; left[pick].explored = true; }
    }
    for (let level = 0; pick < 0 && level < 4; level += 1) pick = left.findIndex((it, i) => i < (level ? left.length : 14) && ok(it, level));
    out.push(left.splice(Math.max(0, pick), 1)[0]);
  }
  return out;
}

export function rankIds({ cat = '', now = Date.now(), seed = 'x' } = {}) {
  const feedback = store.feedbackTopics();
  const weights = store.feedbackSources();
  const pool = store.rankPool(now - WINDOW_MS, CATEGORIES[cat] ? cat : '');
  const scored = pool.map((row) => ({ id: row.id, cat: row.cat, source: row.source, thread: row.thread || '', rel: row.rel ?? 0.4, seen: Boolean(row.seen_at || row.read_at), score: scoreRow(row, { feedback, weights, now }) }))
    .sort((a, b) => b.score - a.score).slice(0, POOL_MAX);
  const opts = { cat: CATEGORIES[cat] ? cat : '', seed };
  return [...mix(scored.filter((s) => !s.seen), opts), ...mix(scored.filter((s) => s.seen), opts)].map((s) => s.id);
}

// -> { ids, snapshot }. Frozen until it expires.
export function newSnapshot(cat = '') {
  const id = crypto.randomBytes(5).toString('hex');
  const ids = rankIds({ cat, seed: id });
  store.saveSnapshot(id, cat, ids);
  return { id, ids };
}
export const snapshotCursor = (id, offset) => `s${id}.${offset}`;
export function parseCursor(cursor) {
  const m = /^s([0-9a-f]{10})\.(\d{1,5})$/.exec(cursor ?? '');
  return m ? { id: m[1], offset: Number(m[2]) } : null;
}

// One page of a snapshot. An expired snapshot (or a cursor from before) is rebuilt and continues at the same offset.
export function forYouPage({ cat = '', cursor = '', limit = PAGE } = {}) {
  let snap = null;
  let offset = 0;
  const c = parseCursor(cursor);
  if (c) {
    const ids = store.loadSnapshot(c.id);
    if (ids) { snap = { id: c.id, ids }; offset = c.offset; }
    else { snap = newSnapshot(cat); offset = c.offset; }
  } else snap = newSnapshot(cat);
  const slice = snap.ids.slice(offset, offset + limit);
  const rows = store.rowsByIds(slice);
  const end = offset + limit;
  return { rows, next: end < snap.ids.length ? snapshotCursor(snap.id, end) : '', snapshot: snap.id, total: snap.ids.length };
}
