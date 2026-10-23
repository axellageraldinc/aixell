// Fresh store, "latest" pagination, and the "for you" ranking with frozen snapshots (src/fresh/store.js, timeline.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataDir } from '../helpers/env.js';
const store = await import('../../src/fresh/store.js');
const timeline = await import('../../src/fresh/timeline.js');
const { idOf } = await import('../../src/fresh/rank.js');

const CATS = ['ai', 'pcbuild', 'pcgaming', 'security', 'console'];
const NOW = Date.now();
const idFor = (i) => idOf(`https://example.com/story/${i}`);

function card(i, { cat = CATS[i % CATS.length], source = `source-${i % 7}`, published = NOW - i * 60_000, rel = 0.5 } = {}) {
  const id = idFor(i);
  store.insertCandidate({ id, url: `https://example.com/story/${i}`, title: `Title ${i}`, source, cat, published, first_seen: published, score: 3, outlets: 1, also: '[]', meta: '{}', sig: `s${i}`, status: 'new' });
  store.markReady({ id, title_local: `Card ${i}`, summary: 'Summary.', why: '', topics: JSON.stringify(['topic']), image: 0, llm: 1 });
  store.setRel(id, rel);
  return id;
}
const N = 50;
for (let i = 0; i < N; i += 1) card(i);

test('the store lives in the temp data directory', () => {
  assert.equal(store.stats().ready, N);
  assert.ok(store.IMAGE_DIR.startsWith(dataDir));
});

test('latest: pages walk the whole timeline newest first, with no gaps or repeats', () => {
  const seen = [];
  let cursor = '';
  let pages = 0;
  do {
    const out = store.page({ cursor, limit: 12 });
    seen.push(...out.rows.map((r) => r.id));
    const last = out.rows.at(-1);
    cursor = out.more ? `${last.published}:${last.id}` : '';
    pages += 1;
  } while (cursor && pages < 20);
  assert.equal(pages, 5);
  assert.equal(seen.length, N);
  assert.equal(new Set(seen).size, N);
  assert.equal(seen[0], idFor(0), 'newest first');
  assert.equal(seen.at(-1), idFor(N - 1));
});

test('latest: a category filter only returns that category', () => {
  const out = store.page({ cat: 'security', limit: 100 });
  assert.equal(out.rows.length, N / CATS.length);
  assert.ok(out.rows.every((r) => r.cat === 'security'));
  assert.equal(out.more, false);
});

test('latest: hidden cards are not listed; saved cards come back in the saved view, newest save first', () => {
  const hide = idFor(1);
  store.setFlag('hidden', hide, true);
  assert.ok(!store.page({ limit: 100 }).rows.some((r) => r.id === hide));
  assert.equal(store.page({ limit: 100 }).rows.length, N - 1);
  store.setFlag('saved', idFor(5), true);
  store.setFlag('saved', idFor(6), true);
  const saved = store.page({ saved: true, limit: 10 });
  assert.deepEqual(saved.rows.map((r) => r.id).sort(), [idFor(5), idFor(6)].sort());
  store.setFlag('saved', idFor(5), false);
  store.setFlag('saved', idFor(6), false);
  store.setFlag('hidden', hide, false);
});

test('for you: the pages of one snapshot cover the pool exactly once', () => {
  const first = timeline.forYouPage({ limit: 12 });
  assert.equal(first.total, N);
  assert.match(first.next, /^s[0-9a-f]{10}\.12$/);
  const ids = first.rows.map((r) => r.id);
  let next = first.next;
  while (next) {
    const page = timeline.forYouPage({ cursor: next, limit: 12 });
    assert.equal(page.snapshot, first.snapshot, 'every page belongs to the same snapshot');
    ids.push(...page.rows.map((r) => r.id));
    next = page.next;
  }
  assert.equal(ids.length, N);
  assert.equal(new Set(ids).size, N);
});

test('for you: the order is frozen while the reader scrolls, even when new cards arrive', () => {
  const first = timeline.forYouPage({ limit: 10 });
  const fresh = card(1000, { published: NOW + 1000, rel: 1.5 });
  const second = timeline.forYouPage({ cursor: first.next, limit: 10 });
  assert.ok(!second.rows.some((r) => r.id === fresh), 'a card that arrived mid-scroll does not slip into later pages');
  assert.ok(!first.rows.some((r) => r.id === fresh));
  const reopened = timeline.forYouPage({ limit: 10 });
  assert.notEqual(reopened.snapshot, first.snapshot, 'a new first page takes a new snapshot');
  assert.equal(reopened.total, N + 1);
});

test('for you: an unknown or expired snapshot is rebuilt and continues at the same offset', () => {
  const page = timeline.forYouPage({ cursor: 's0123456789.20', limit: 10 });
  assert.equal(page.rows.length, 10);
  assert.match(page.next, /\.30$/);
  assert.deepEqual(timeline.parseCursor('s0123456789.20'), { id: '0123456789', offset: 20 });
  assert.equal(timeline.parseCursor('garbage'), null);
  assert.equal(timeline.parseCursor('latest:123'), null);
});

test('for you: a category view only contains that category', () => {
  const page = timeline.forYouPage({ cat: 'ai', limit: 100 });
  assert.ok(page.rows.length > 0 && page.rows.every((r) => r.cat === 'ai'));
});

test('mix: no source appears three times in a row when other sources are available', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, cat: CATS[i % 5], source: i < 15 ? 'loud' : `quiet-${i}`, rel: 0.5, score: 30 - i }));
  const out = timeline.mix(items, { seed: 'fixed' });
  assert.equal(out.length, 30);
  assert.equal(new Set(out.map((x) => x.id)).size, 30);
  for (let i = 2; i < 12; i += 1) {
    assert.ok(!(out[i].source === 'loud' && out[i - 1].source === 'loud' && out[i - 2].source === 'loud'), `three in a row at ${i}`);
  }
});

test('mix is deterministic for a given seed', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `${i}`, cat: CATS[i % 5], source: `s${i % 9}`, rel: 0.6, score: 60 - i }));
  const a = timeline.mix(items, { seed: 'one' }).map((x) => x.id).join();
  assert.equal(timeline.mix(items, { seed: 'one' }).map((x) => x.id).join(), a);
});

test('scoreRow: newer beats older, relevance and corroboration raise the score', () => {
  const ctx = { now: NOW };
  const base = { published: NOW - 3_600_000, cat: 'ai', source: 'a', rel: 0.5, outlets: 1, topics: JSON.stringify(['llm']), meta: null };
  const fresh = timeline.scoreRow(base, ctx);
  assert.ok(fresh > timeline.scoreRow({ ...base, published: NOW - 48 * 3_600_000 }, ctx));
  assert.ok(timeline.scoreRow({ ...base, rel: 0.9 }, ctx) > fresh);
  assert.ok(timeline.scoreRow({ ...base, rel: 0.1 }, ctx) < fresh);
  assert.ok(timeline.scoreRow({ ...base, outlets: 3 }, ctx) > fresh);
});

test('snapshots are stored and read back', () => {
  store.saveSnapshot('abcdef0123', 'ai', ['x', 'y']);
  assert.deepEqual(store.loadSnapshot('abcdef0123'), ['x', 'y']);
  assert.equal(store.loadSnapshot('ffffffffff'), null);
});
