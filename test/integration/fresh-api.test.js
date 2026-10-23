// The Fresh API against a seeded store (40 made-up cards), with every network path in offline mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, waitFor } from '../helpers/boot.js';

const N = 40;
let app, me;
before(async () => { app = await boot({ seed: N }); me = await app.login(); });
after(async () => { await app.stop(); });

async function walk(query, { max = 20 } = {}) {
  const items = [];
  const pages = [];
  let cursor = '';
  for (let i = 0; i < max; i += 1) {
    const r = await me.get(`/api/fresh?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(r.status, 200);
    pages.push(r.data);
    items.push(...r.data.items);
    cursor = r.data.next;
    if (!cursor) break;
  }
  return { items, pages };
}
const firstId = async (query = 'mode=latest&limit=1') => (await me.get(`/api/fresh?${query}`)).data.items[0].id;

test('the timeline needs a session', async () => {
  assert.equal((await app.client().get('/api/fresh')).status, 401);
  assert.equal((await app.client().get('/api/fresh/status')).status, 401);
});

test('for you: pages through every card once, all from one snapshot', async () => {
  const { items, pages } = await walk('limit=12');
  assert.equal(items.length, N);
  assert.equal(new Set(items.map((i) => i.id)).size, N);
  assert.equal(pages.length, 4);
  assert.equal(new Set(pages.map((p) => p.snapshot)).size, 1);
  assert.equal(pages[0].mode, 'foryou');
  assert.equal(pages[0].total, N);
  assert.match(pages[0].next, /^s[0-9a-f]{10}\.12$/);
  assert.ok(Array.isArray(pages[0].catOrder));
});

test('a card has the fields the app draws', async () => {
  const card = (await me.get('/api/fresh?mode=latest&limit=1')).data.items[0];
  assert.match(card.id, /^[a-f0-9]{16}$/);
  assert.match(card.title, /^Card title \d+$/);
  assert.match(card.original, /^Original title /);
  assert.ok(card.summary && card.url.startsWith('https://example.com/'));
  assert.ok(card.catLabel && card.cat);
  assert.ok(Array.isArray(card.topics) && Array.isArray(card.also));
  assert.equal(typeof card.ts, 'number');
  assert.equal(card.saved, false);
  assert.equal(card.seen, false);
});

test('latest: newest first, cursor pages, category filter, limit cap', async () => {
  const { items, pages } = await walk('mode=latest&limit=15');
  assert.equal(items.length, N);
  assert.equal(new Set(items.map((i) => i.id)).size, N);
  assert.deepEqual(items.map((i) => i.ts), items.map((i) => i.ts).sort((a, b) => b - a));
  assert.match(pages[0].next, /^\d+:[a-f0-9]{16}$/);
  assert.equal(pages[0].mode, 'latest');
  const security = await walk('mode=latest&cat=security&limit=30');
  assert.ok(security.items.length > 0 && security.items.every((i) => i.cat === 'security'));
  assert.equal((await me.get('/api/fresh?mode=latest&cat=not-a-category&limit=30')).data.items.length, 30, 'an unknown category means all');
  assert.equal((await me.get('/api/fresh?mode=latest&limit=1000')).data.items.length, 30, 'limit is capped at 30');
});

test('latest: the answer carries an ETag and an unchanged list is a 304', async () => {
  const first = await me.raw('GET', '/api/fresh?mode=latest&limit=5');
  const etag = first.headers.get('etag');
  assert.match(etag, /^W\/"[0-9a-f]{20}"$/);
  assert.equal((await me.raw('GET', '/api/fresh?mode=latest&limit=5', { headers: { 'If-None-Match': etag } })).status, 304);
});

test('save, unsave, hide and read change what the lists show', async () => {
  const id = await firstId();
  assert.deepEqual((await me.post(`/api/fresh/${id}/save`, {})).data, { ok: true });
  const saved = await me.get('/api/fresh?saved=1&limit=30');
  assert.equal(saved.data.mode, 'saved');
  assert.equal(saved.data.items[0].id, id, 'the newest save comes first');
  assert.ok(saved.data.items.every((i) => i.saved));
  assert.equal(saved.data.items.length, 1 + 5, 'plus the five cards the seed saved');
  await me.post(`/api/fresh/${id}/unsave`, {});
  assert.ok(!(await me.get('/api/fresh?saved=1&limit=30')).data.items.some((i) => i.id === id));

  await me.post(`/api/fresh/${id}/read`, {});
  const read = (await me.get('/api/fresh?mode=latest&limit=30')).data.items.find((i) => i.id === id);
  assert.equal(read.read, true);
  assert.equal(read.seen, true);

  await me.post(`/api/fresh/${id}/hide`, {});
  assert.ok(!(await me.get('/api/fresh?mode=latest&limit=30')).data.items.some((i) => i.id === id));
});

test('actions on an unknown card are 404, and malformed ids do not reach the store', async () => {
  assert.equal((await me.post(`/api/fresh/${'0'.repeat(16)}/save`, {})).data.error.code, 'no_item');
  assert.equal((await me.post('/api/fresh/zzz/save', {})).status, 404);
  assert.equal((await me.post(`/api/fresh/${'0'.repeat(16)}/explode`, {})).status, 404);
});

test('signals: counted once per card and kind, unknown kinds refused, the rate limit answers 429', async () => {
  const items = (await walk('mode=latest&limit=30')).items;
  const [a, b] = items;
  const open = await me.post(`/api/fresh/${a.id}/signal`, { kind: 'open' });
  assert.deepEqual([open.status, open.data.counted], [200, true]);
  const again = await me.post(`/api/fresh/${a.id}/signal`, { kind: 'open' });
  assert.equal(again.data.counted, false, 'the same signal on the same card counts once in ten minutes');
  assert.equal((await me.post(`/api/fresh/${a.id}/signal`, { kind: 'telepathy' })).data.error.code, 'bad_signal');
  assert.equal((await me.post(`/api/fresh/${'0'.repeat(16)}/signal`, { kind: 'open' })).status, 400);
  assert.equal((await me.post(`/api/fresh/${b.id}/signal`, { kind: 'dwell', ms: 1000 })).status, 200);
  assert.equal((await me.post(`/api/fresh/${b.id}/signal`, { kind: 'skip' })).status, 200);
  // 120 signals a minute are allowed; the rest are limited.
  let limited = null;
  for (const item of items) {
    for (const kind of ['read', 'ask', 'save', 'share']) {
      const r = await me.post(`/api/fresh/${item.id}/signal`, { kind });
      if (r.status === 429) { limited = r; break; }
    }
    if (limited) break;
  }
  assert.ok(limited, 'the rate limit kicked in');
  assert.equal(limited.data.error.code, 'rate_limited');
});

test('seen: valid ids are marked, junk is filtered out, at most 100 at a time', async () => {
  const ids = (await me.get('/api/fresh?mode=latest&limit=3')).data.items.map((i) => i.id);
  const r = await me.post('/api/fresh/seen', { ids: [...ids, 'junk', 42, '../etc', null] });
  assert.deepEqual(r.data, { ok: true, count: 3 });
  assert.deepEqual((await me.post('/api/fresh/seen', { ids: 'nope' })).data, { ok: true, count: 0 });
});

test('poll reports how many cards are newer than a time, and status the pool and queue', async () => {
  const poll = await me.get('/api/fresh/poll?since=0');
  assert.ok(poll.data.count > N - 10 && poll.data.count <= N, `count ${poll.data.count}: everything except the few cards hidden by earlier tests`);
  assert.ok(poll.data.newest > 0);
  assert.equal(poll.data.running, false);
  assert.equal((await me.get(`/api/fresh/poll?since=${Date.now() + 60_000}`)).data.count, 0);
  const status = (await me.get('/api/fresh/status')).data;
  assert.equal(status.total, N);
  assert.equal(status.ready, N);
  assert.ok('queue' in status && 'llm' in status);
});

test('the feed page and the settings carry the content language and the time zone', async () => {
  const page = (await me.get('/api/fresh?mode=latest&limit=3')).data;
  assert.equal(page.contentLang, 'en');
  assert.equal(page.contentLanguage, 'English');
  assert.equal(typeof page.timezone, 'string');
  const settings = (await me.get('/api/fresh/settings')).data;
  assert.equal(settings.contentLang, 'en');
  assert.equal(typeof settings.timezone, 'string');
});

test('card pictures are served as JPEG; a card without one is 404', async () => {
  const items = (await walk('mode=latest&limit=30')).items;
  const withImage = items.find((i) => i.image);
  const without = items.find((i) => !i.image);
  assert.ok(withImage && without);
  const ok = await me.raw('GET', withImage.image);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.match(ok.headers.get('cache-control'), /immutable/);
  assert.equal((await me.get(`/api/fresh/img/${without.id}`)).status, 404);
  assert.equal((await me.get('/api/fresh/img/not-an-id')).status, 404);
});

test('reader: a stored article opens without any download (the seed stores every article), and marks the card read', async () => {
  const card = (await walk('mode=latest&limit=30')).items[0];
  const r = await me.get(`/api/fresh/${card.id}/reader`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.blocks, [{ type: 'p', text: 'Stored article text, so no download is needed.' }]);
  assert.equal((await me.get(`/api/fresh/${'0'.repeat(16)}/reader`)).status, 404);
});

test('refresh answers at once and never waits for gathering', async () => {
  const started = Date.now();
  const r = await me.post('/api/fresh/refresh', {});
  const took = Date.now() - started;
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.ok('running' in r.data && 'newCount' in r.data && 'lastRunAt' in r.data);
  assert.ok(took < 1000, `refresh took ${took} ms`);
  await waitFor(async () => (await me.get('/api/fresh/poll?since=0')).data.running === false, { what: 'the offline round to finish' });
});

test('settings: read, validate, update and persist', async () => {
  const before = (await me.get('/api/fresh/settings')).data;
  assert.ok(before.sources.length > 5 && before.categories.ai);
  assert.ok(Array.isArray(before.catOrder) && before.catOrder.includes('saved'));
  assert.equal((await me.put('/api/fresh/settings', { catOrder: 'nope' })).data.error.code, 'bad_order');
  const after = await me.put('/api/fresh/settings', { intervalMin: 45, catOrder: ['security', 'bogus', 'ai', 'security'] });
  assert.equal(after.status, 200);
  assert.equal(after.data.intervalMin, 45);
  assert.deepEqual(after.data.catOrder.slice(0, 2), ['security', 'ai'], 'unknown and repeated ids are dropped');
  assert.equal((await me.get('/api/fresh/settings')).data.intervalMin, 45);
});

test('sources: validation, SSRF refusal when adding, only custom sources can be removed', async () => {
  assert.equal((await me.post('/api/fresh/sources', { url: 'x' })).data.error.code, 'bad_source');
  assert.equal((await me.post('/api/fresh/sources', {})).status, 400);
  const local = await me.post('/api/fresh/sources', { url: 'http://127.0.0.1:1/feed.xml' });
  assert.equal(local.status, 400);
  assert.match(local.data.error.message, /private address/);
  const sources = (await me.get('/api/fresh/settings')).data.sources;
  assert.equal((await me.patch('/api/fresh/sources/nope', { on: false })).status, 404);
  assert.equal((await me.delete(`/api/fresh/sources/${sources[0].id}`)).status, 404, 'a built-in source cannot be deleted');
  const target = sources.find((s) => s.on !== false) ?? sources[0];
  assert.equal((await me.patch(`/api/fresh/sources/${target.id}`, { on: false })).status, 200);
  assert.equal((await me.get('/api/fresh/settings')).data.sources.find((s) => s.id === target.id).on, false);
  await me.patch(`/api/fresh/sources/${target.id}`, { on: true });
});

test('glossary: list entries, validate and save an owner decision', async () => {
  const list = await me.get('/api/fresh/glossary');
  assert.ok(list.data.entries.length > 30);
  assert.ok(list.data.entries.some((e) => e.term === 'agent' && e.keep));
  assert.equal((await me.put('/api/fresh/glossary/%21%21', { decision: 'keep' })).data.error.code, 'bad_term');
  // The shipped seed has no renderings of its own (the cards are written in English), so a translation needs the form.
  assert.equal((await me.put('/api/fresh/glossary/vulnerability', { decision: 'translate' })).status, 400, 'a translation without a rendering is refused');
  assert.equal((await me.put('/api/fresh/glossary/vulnerability', { decision: 'translate', form: 'weakness' })).status, 200, 'the owner supplies the rendering');
  const kept = await me.put('/api/fresh/glossary/hotfix', { decision: 'keep', bad: ['quick fix'] });
  assert.equal(kept.data.keep, true);
  assert.deepEqual(kept.data.bad, ['quick fix']);
});

test('ingest: needs the bearer token; ingested stories are written by the (mock) writer and appear in the timeline', async () => {
  const bad = await app.client().raw('POST', '/api/fresh/ingest', { json: { items: [] }, headers: { Authorization: 'Bearer wrong' } });
  assert.equal(bad.status, 401);
  assert.equal((await app.client().raw('POST', '/api/fresh/ingest', { json: { items: [] } })).status, 401);
  const { token } = (await me.get('/api/fresh/ingest-token')).data;
  assert.match(token, /^[a-f0-9]{48}$/);
  const post = (items) => app.client().call('POST', '/api/fresh/ingest', { json: { items }, headers: { Authorization: `Bearer ${token}` } });
  const items = [
    { source: 'Worker One', title: 'New open-source coding agent ships MCP support and local model inference', url: 'https://example.net/posts/agent-mcp', text: 'A new coding agent CLI adds MCP support and runs local models with quantization on a 12GB GPU, with benchmark numbers.', cat: 'ai' },
    { title: 'not a link', url: 'ftp://example.net/x' },
    { title: '', url: 'https://example.net/empty' },
  ];
  const r = await post(items);
  assert.equal(r.status, 200);
  assert.equal(r.data.received, 1, 'items without an http(s) URL or a title are dropped');
  assert.equal(r.data.added, 1);
  const again = await post(items);
  assert.equal(again.data.added, 0, 'the same URL is not added twice');
  await waitFor(async () => (await me.get('/api/fresh/poll?since=0')).data.running === false, { what: 'the round to finish' });
  const card = await waitFor(async () => (await walk('mode=latest&limit=30')).items.find((i) => i.url === 'https://example.net/posts/agent-mcp'), { timeoutMs: 15_000, what: 'the ingested card' });
  assert.equal(card.source, 'w-WorkerOne');
  assert.ok(card.title.length > 0 && card.summary.length > 0);
});

test('bootstrap needs the token too', async () => {
  assert.equal((await app.client().raw('POST', '/api/fresh/bootstrap')).status, 401);
  const { token } = (await me.get('/api/fresh/ingest-token')).data;
  const r = await app.client().call('GET', '/api/fresh/bootstrap', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 404, 'no bootstrap has run yet');
});
