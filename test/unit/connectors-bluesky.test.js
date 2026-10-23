// The Bluesky connector: candidateOf with the configured languages, no queries means unavailable and
// no login, the login is mocked, and the legacy `since` key still works.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const bluesky = await import('../../src/connectors/bluesky.js');
const { stateFor } = await import('../../src/connectors/state.js');

const post = (text, { langs = ['en'], likes = 40, reposts = 3, handle = 'person.bsky.social', link, createdAt = new Date().toISOString() } = {}) => ({
  uri: 'at://did:plc:abc/app.bsky.feed.post/3abc',
  author: { handle },
  likeCount: likes,
  repostCount: reposts,
  record: { text, langs, createdAt },
  ...(link ? { embed: { external: { uri: link, title: 'An article', description: 'x', thumb: '' } } } : {}),
});

let n = 0;
const ctxOf = (config = {}, { secret = { handle: 'someone', appPassword: 'secret' }, fetch = null } = {}) => {
  const id = `bluesky-test-${process.pid}-${n += 1}`;
  return {
    config: { id, ...config },
    secret: (key) => (secret ? secret[key] ?? null : null),
    state: stateFor(id),
    fetch: fetch ?? (async () => { throw new Error('no network'); }),
    providers: { get: () => null },
    budget: null,
    now: () => Date.now(),
    timezone: 'UTC',
    enabled: true,
    log: { warn: () => {} },
  };
};

test('candidateOf: a linked post in an accepted language becomes a card', () => {
  const candidate = bluesky.candidateOf(post('A useful write-up on local models', { link: 'https://example.com/a' }), { minEngagement: 8, cat: 'ai' });
  assert.equal(candidate.url, 'https://example.com/a');
  assert.equal(candidate.title, 'An article');
  assert.equal(candidate.meta.via, 'bluesky');
  assert.equal(candidate.meta.likes, 43);
  assert.equal(candidate.cat, 'ai');
});

test('candidateOf: the configured languages decide, not a fixed pair', () => {
  const german = post('Ein nützlicher Bericht über lokale Modelle und ihre Geschwindigkeit', { langs: ['de'], link: 'https://example.com/de' });
  assert.equal(bluesky.candidateOf(german, { languages: ['en'] }), null, 'German is not accepted by default');
  assert.ok(bluesky.candidateOf(german, { languages: ['de'] }), 'German is accepted when configured');
  const english = post('A useful write-up on local models', { langs: ['en'], link: 'https://example.com/en' });
  assert.equal(bluesky.candidateOf(english, { languages: ['de'] }), null);
  assert.ok(bluesky.candidateOf(english, { languages: ['en', 'de'] }));
});

test('candidateOf: engagement, bots, banned words and bare posts are filtered as before', () => {
  const base = { languages: ['en'], minEngagement: 8 };
  assert.equal(bluesky.candidateOf(post('short', { likes: 1, reposts: 0, link: 'https://example.com/a' }), base), null, 'too little engagement');
  assert.equal(bluesky.candidateOf(post('A good write-up about tools', { handle: 'deals-bot.bsky.social', link: 'https://example.com/a' }), base), null, 'a bot handle');
  assert.equal(bluesky.candidateOf(post('A good write-up about tools', { link: 'https://amzn.to/x' }), base), null, 'an affiliate link is no card');
  assert.equal(bluesky.candidateOf(post('A short note', { likes: 10, reposts: 0 }), base), null, 'a bare short post');
  const bare = bluesky.candidateOf(post('A long enough note about a local model and its context window, with real numbers from a hands-on test on a small GPU', { likes: 40, reposts: 5 }), base);
  assert.ok(bare, 'a bare post with many reactions and enough text is a card');
  assert.match(bare.url, /^https:\/\/bsky\.app\/profile\//);
});

test('no queries configured: status says so and fetch never logs in', async () => {
  let calls = 0;
  const ctx = ctxOf({ queries: [] }, { fetch: async () => { calls += 1; throw new Error('must not be called'); } });
  assert.deepEqual(await bluesky.fetch(ctx), []);
  assert.equal(calls, 0, 'no login attempt and no search');
  assert.equal(bluesky.statusOf(ctx).unavailable, 'no queries configured');
  assert.equal(bluesky.statusOf(ctx).queries, 0);
});

test('no credentials: status says so and fetch returns nothing', async () => {
  // The offline switch supplies mock credentials on purpose (so a test run answers all four
  // connectors); outside it, a missing login means no fetch at all.
  const before = process.env.HERMES_WEB_FRESH_OFFLINE;
  process.env.HERMES_WEB_FRESH_OFFLINE = '0';
  try {
    let calls = 0;
    const ctx = ctxOf({ queries: [{ q: 'llm', cat: 'ai' }] }, { secret: null, fetch: async () => { calls += 1; throw new Error('must not be called'); } });
    assert.deepEqual(await bluesky.fetch(ctx), []);
    assert.equal(calls, 0);
    assert.equal(bluesky.statusOf(ctx).unavailable, 'no credentials');
  } finally { process.env.HERMES_WEB_FRESH_OFFLINE = before; }
});

test('fetch: a mocked login and one search answer become candidates', async () => {
  const seen = [];
  const ctx = ctxOf({ queries: [{ q: 'llm', cat: 'ai', minEngagement: 8 }] }, {
    fetch: async (url, options) => {
      seen.push(String(url));
      if (String(url).includes('createSession')) {
        return { status: 200, body: Buffer.from(JSON.stringify({ accessJwt: 'access', refreshJwt: 'refresh', didDoc: {} })) };
      }
      if (String(url).includes('searchPosts')) {
        assert.equal(options.headers.Authorization, 'Bearer access');
        return { status: 200, body: Buffer.from(JSON.stringify({ posts: [post('A useful write-up on local models', { link: 'https://example.com/a' })] })) };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const items = await bluesky.fetch(ctx);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.com/a');
  assert.ok(seen[0].includes('createSession'), 'the login happened first');
  assert.match(seen[1], /searchPosts\?.*q=llm/);
  assert.equal(bluesky.statusOf(ctx).loggedIn, true);
  assert.equal(bluesky.statusOf(ctx).queries, 1);
  assert.ok(ctx.state.get('bluesky-since') > 0, 'the cursor is written under the instance prefix');
});

test('fetch: the legacy unprefixed since key is used when the prefixed one is missing', async () => {
  const ctx = ctxOf({ queries: [{ q: 'llm', cat: 'ai' }] }, {
    fetch: async (url) => {
      if (String(url).includes('createSession')) return { status: 200, body: Buffer.from(JSON.stringify({ accessJwt: 'a', refreshJwt: 'r', didDoc: {} })) };
      return { status: 200, body: Buffer.from(JSON.stringify({ posts: [] })) };
    },
  });
  const legacySince = Date.now() - 3_600_000;
  ctx.state.set('bluesky-since', null); // the prefixed key holds an explicit value
  const { kvSet } = await import('../../src/fresh/store.js');
  kvSet('bluesky-since', legacySince);
  // Remove the prefixed value by writing a new instance id: the fallback is the unprefixed key.
  const fresh = ctxOf({ queries: [{ q: 'llm', cat: 'ai' }] }, {
    fetch: async (url) => {
      if (String(url).includes('createSession')) return { status: 200, body: Buffer.from(JSON.stringify({ accessJwt: 'a', refreshJwt: 'r', didDoc: {} })) };
      assert.match(String(url), /since=/);
      const since = new URL(String(url)).searchParams.get('since');
      assert.equal(Date.parse(since), legacySince, 'the search starts from the legacy cursor');
      return { status: 200, body: Buffer.from(JSON.stringify({ posts: [] })) };
    },
  });
  await bluesky.fetch(fresh);
});

test('test(): logs in and reports ok without a secret in the detail', async () => {
  const ctx = ctxOf({}, {
    fetch: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ accessJwt: 'a', refreshJwt: 'r', didDoc: {} })) }),
  });
  assert.deepEqual(await bluesky.test(ctx), { ok: true });
  const bad = ctxOf({}, { fetch: async () => ({ status: 401, body: Buffer.from('{}') }) });
  const out = await bluesky.test(bad);
  assert.equal(out.ok, false);
  assert.equal(JSON.stringify(out).includes('secret'), false);
});

test('the connector declares its contract fields', () => {
  assert.equal(bluesky.default.type, 'bluesky');
  assert.deepEqual(bluesky.default.defaultSchedule, { every: '60m' });
  assert.deepEqual(bluesky.default.cost, { kind: 'free' });
  assert.deepEqual(bluesky.default.credentials.map((c) => c.key), ['handle', 'appPassword']);
  assert.equal(typeof bluesky.default.status, 'function');
  assert.equal(typeof bluesky.default.test, 'function');
});

test('the shipped default has no queries and no owner strings', () => {
  assert.deepEqual(bluesky.QUERIES, []);
  assert.deepEqual(bluesky.LANGS, ['en']);
});
