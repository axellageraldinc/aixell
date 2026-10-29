// The x-api search provider against a fake transport: query building, handle filters, the rendered answer, cost and errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const { XApi, buildXQuery } = await import('../../src/providers/x-api.js');
const { ProviderError } = await import('../../src/providers/errors.js');
const { parseAnswer } = await import('../../src/connectors/x-search.js');

const NOW = Date.parse('2026-10-23T12:00:00Z');
const PAYLOAD = {
  data: [
    { id: '11', author_id: 'u1', text: 'Big release with a longer context window https://t.co/aaa', entities: { urls: [{ url: 'https://t.co/aaa', expanded_url: 'https://example.com/release', unwound_url: 'https://example.com/release-notes' }] } },
    { id: '12', author_id: 'u2', text: 'Thread on local models https://t.co/bbb', entities: { urls: [{ url: 'https://t.co/bbb', expanded_url: 'https://x.com/b/status/12' }] } },
    { id: '13', author_id: 'missing', text: 'orphan', entities: {} },
  ],
  includes: { users: [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }] },
  meta: { result_count: 3 },
};
const fakeFetch = (reply = { status: 200, body: JSON.stringify(PAYLOAD) }) => {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url: new URL(url), opts }); if (reply instanceof Error) throw reply; return reply; };
  fn.calls = calls;
  return fn;
};
const make = (over = {}) => new XApi({ id: 'x', bearer: () => 'test-token', costMicro: 5000, currency: 'USD', now: () => NOW, fetch: fakeFetch(), ...over });

test('buildXQuery: topic words, link and retweet operators, language, handle allowlist or exclusion', () => {
  assert.equal(buildXQuery({ topic: 'New AI model releases' }), '(new OR ai OR model OR releases) -is:retweet has:links');
  assert.equal(buildXQuery({ topic: 'llama', lang: 'EN' }), 'llama -is:retweet has:links lang:en');
  assert.equal(buildXQuery({ topic: 'agents', filter: { allowedHandles: ['a', 'b_c'] } }), 'agents -is:retweet has:links (from:a OR from:b_c)');
  assert.equal(buildXQuery({ topic: 'agents', filter: { allowedHandles: ['solo'] } }), 'agents -is:retweet has:links from:solo');
  assert.equal(buildXQuery({ topic: 'agents', filter: { excludedHandles: ['spam1', 'spam2'] } }), 'agents -is:retweet has:links -from:spam1 -from:spam2');
  assert.equal(buildXQuery({ topic: 'agents', filter: { allowedHandles: ['bad handle!', 'ok'], excludedHandles: ['z'] } }), 'agents -is:retweet has:links from:ok', 'invalid handles are dropped; an allowlist wins over exclusions');
  assert.equal(buildXQuery({ query: 'fallback query text' }).startsWith('(fallback OR query OR text)'), true);
  assert.ok(buildXQuery({ topic: 'x'.repeat(900) }).length <= 512);
});

test('search: sends the bearer token, the operators and a clamped start time; renders the answer; reports the configured cost', async () => {
  const fetch = fakeFetch();
  const p = make({ fetch, lang: 'en', maxResults: 25 });
  assert.deepEqual(p.search.pricing, { perCallMicro: 5000, currency: 'USD' });
  const out = await p.search.search({ query: 'prose prompt that is ignored', topic: 'open models', filter: { from: '2026-10-01', allowedHandles: ['alice', 'bob'] } });
  const { url, opts } = fetch.calls[0];
  assert.equal(url.origin + url.pathname, 'https://api.x.com/2/tweets/search/recent');
  assert.equal(opts.headers.Authorization, 'Bearer test-token');
  assert.equal(url.searchParams.get('query'), '(open OR models) -is:retweet has:links lang:en (from:alice OR from:bob)');
  assert.equal(url.searchParams.get('max_results'), '25');
  assert.equal(url.searchParams.get('expansions'), 'author_id');
  assert.equal(url.searchParams.get('start_time'), '2026-10-16T12:02:00.000Z', 'older than seven days is clamped to the API window');
  assert.equal(out.costMicro, 5000);
  assert.equal(out.answer, '- @alice: Big release with a longer context window https://x.com/alice/status/11\n- @bob: Thread on local models https://x.com/bob/status/12');
  assert.deepEqual(out.citations.map((c) => c.url), ['https://x.com/alice/status/11', 'https://x.com/bob/status/12']);
  const items = parseAnswer({ answer: out.answer, citations: out.citations }, { cats: ['ai'] });
  assert.ok(items.length >= 1 && items[0].url === 'https://x.com/alice/status/11' && items[0].meta.handle === 'alice');
  // a request language beats the configured one; a recent start date is kept as given
  await p.search.search({ topic: 'x', lang: 'de', filter: { from: '2026-10-22' } });
  assert.match(fetch.calls[1].url.searchParams.get('query'), /lang:de/);
  assert.equal(fetch.calls[1].url.searchParams.get('start_time'), '2026-10-22T00:00:00.000Z');
});

test('search: errors become ProviderError (no token, HTTP status, bad JSON, transport failure)', async () => {
  await assert.rejects(make({ bearer: () => null }).search.search({ topic: 'x' }), (e) => e instanceof ProviderError && e.kind === 'nokey');
  for (const status of [401, 402, 429, 503]) {
    await assert.rejects(make({ fetch: fakeFetch({ status, body: '{"title":"nope"}' }) }).search.search({ topic: 'x' }), (e) => e instanceof ProviderError && e.status === status && e.message === String(status));
  }
  await assert.rejects(make({ fetch: fakeFetch({ status: 200, body: '<html>' }) }).search.search({ topic: 'x' }), (e) => e instanceof ProviderError && e.kind === 'empty');
  await assert.rejects(make({ fetch: fakeFetch(new Error('socket hang up')) }).search.search({ topic: 'x' }), (e) => e instanceof ProviderError && e.kind === 'timeout');
  const empty = await make({ fetch: fakeFetch({ status: 200, body: '{"meta":{"result_count":0}}' }) }).search.search({ topic: 'x' });
  assert.deepEqual([empty.answer, empty.citations, empty.costMicro], ['', [], 5000]);
});

test('registered as type x-api: the bearer token comes from a secret reference', async () => {
  process.env.HW_TEST_X_BEARER = 'from-env';
  try {
    const compat = await import('../../src/providers/compat.js');
    compat.setProviderConfig({ providers: { x: { type: 'x-api', bearerToken: 'env:HW_TEST_X_BEARER', costMicro: 1234, currency: 'EUR' } }, capabilities: { socialSearch: { provider: 'x' } } });
    const reg = compat.providersFor({ name: 'a', home: '/nonexistent' });
    const search = reg.get('socialSearch');
    assert.deepEqual(search.pricing, { perCallMicro: 1234, currency: 'EUR' });
    assert.equal(reg.provider('socialSearch').bearer(), 'from-env');
    assert.equal(reg.flags().socialSearch, true);
    assert.equal(reg.flags().writer, false);
    compat.setProviderConfig(null);
  } finally { delete process.env.HW_TEST_X_BEARER; }
});
