// Search by meaning: the openai-compatible embed call, vector storage, ranking, and the word fallback. No real embedding server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import '../helpers/env.js';
const store = await import('../../src/fresh/store.js');
const vectors = await import('../../src/fresh/vectors.js');
const compat = await import('../../src/providers/compat.js');
const { idOf } = await import('../../src/fresh/rank.js');

// A tiny fake /embeddings server: a text maps to an axis by keyword, so "meaning" is predictable.
const AXES = [/gpu|graphics|nvidia/i, /game|steam|console/i, /security|exploit|cve/i];
const vecOf = (text) => AXES.map((re) => (re.test(text) ? 1 : 0)).concat([0.05]);
let calls = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls += 1;
    const { input } = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vecOf(t) })).reverse() }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
server.unref();
const base = `http://127.0.0.1:${server.address().port}/v1`;
const agent = { name: 'vec-test', home: '/nonexistent', provider: 'x', model: 'm', baseUrl: null };

function card(i, title, { cat = 'ai', summary = '' } = {}) {
  const id = idOf(`https://example.com/v/${i}`);
  store.insertCandidate({ id, url: `https://example.com/v/${i}`, title, source: 's', cat, published: Date.now() - i, first_seen: Date.now(), score: 3, outlets: 1, also: '[]', meta: '{}', sig: `v${i}`, status: 'new' });
  store.markReady({ id, title_local: title, summary, why: '', topics: JSON.stringify(['t']), image: 0, llm: 1 });
  return id;
}
const gpu = card(1, 'New Nvidia GPU announced', { cat: 'pcbuild' });
const game = card(2, 'Steam game of the year', { cat: 'pcgaming' });
const cve = card(3, 'Critical exploit found, CVE-2026-1', { cat: 'security' });

test('without an embeddings capability nothing is embedded and search says so', async () => {
  compat.setProviderConfig({ providers: {}, capabilities: {} });
  assert.equal(await vectors.embedPending(agent), 0);
  assert.equal(await vectors.search(agent, 'gpu'), null);
  assert.deepEqual(store.searchWords('nvidia').map((h) => h.id), [gpu]);
  assert.deepEqual(store.searchWords('nvidia exploit'), []);
});

test('embedPending stores a unit vector per story (keyless server, out-of-order reply) and is idempotent', async () => {
  compat.setProviderConfig({ providers: { e: { type: 'openai-compatible', baseUrl: base } }, capabilities: { embeddings: { provider: 'e', model: 'fake' } } });
  assert.equal(await vectors.embedPending(agent), 3);
  assert.equal(await vectors.embedPending(agent), 0);
  const v = store.vectorGet(gpu, 'fake');
  assert.equal(v.length, 4);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-5);
  assert.deepEqual(vectors.coverage(agent), { model: 'fake', embedded: 3, ready: 3 });
});

test('search ranks by meaning, filters by category and drops weak matches', async () => {
  const hits = await vectors.search(agent, 'which graphics card is best');
  assert.equal(hits[0].id, gpu);
  assert.ok(hits[0].score > 0.9);
  assert.ok(!hits.some((h) => h.id === cve), 'unrelated story is below the cut-off');
  assert.deepEqual((await vectors.search(agent, 'graphics card', { cat: 'pcgaming' })), []);
  assert.deepEqual((await vectors.search(agent, '   ')), null);
});

test('similar finds neighbours of a story, never the story itself; hidden stories are not searched', async () => {
  const twin = card(4, 'Another Nvidia GPU review');
  await vectors.embedPending(agent);
  assert.deepEqual(vectors.similar(agent, gpu).map((h) => h.id), [twin]);
  store.setFlag('hidden', twin, true);
  assert.deepEqual(vectors.similar(agent, gpu), []);
});

test('a server error stops the run without throwing and leaves the story for the next round', async () => {
  const late = card(5, 'Late GPU story');
  compat.setProviderConfig({ providers: { e: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' } }, capabilities: { embeddings: { provider: 'e', model: 'fake' } } });
  assert.equal(await vectors.embedPending(agent), 0);
  assert.equal(store.vectorGet(late, 'fake'), null);
  compat.setProviderConfig(null);
});

test('diversify spreads a cluster of near-identical stories instead of listing them in a row', async () => {
  const { diversify } = await import('../../src/fresh/timeline.js');
  const unit = (...v) => { const n = Math.hypot(...v); return Float32Array.from(v.map((x) => x / n)); };
  const vecs = new Map([['a1', unit(1, 0.05)], ['a2', unit(1, 0.1)], ['a3', unit(1, 0.15)], ['b', unit(0.05, 1)], ['c', unit(-1, 0.3)]]);
  const items = [{ id: 'a1', score: 1 }, { id: 'a2', score: 0.95 }, { id: 'a3', score: 0.9 }, { id: 'b', score: 0.7 }, { id: 'c', score: 0.5 }];
  assert.deepEqual(diversify(items, vecs).map((i) => i.id), ['a1', 'b', 'a2', 'c', 'a3']);
  assert.deepEqual(diversify(items, new Map()).map((i) => i.id), items.map((i) => i.id), 'no vectors, no change');
});
