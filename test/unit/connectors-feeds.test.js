// The free feed connectors against the fixtures, with a ctx.fetch stub (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../helpers/env.js';
const rssModule = await import('../../src/connectors/rss.js');
const { youtube } = await import('../../src/connectors/youtube.js');
const { githubReleases, isPrerelease } = await import('../../src/connectors/github-releases.js');
const { ghsa } = await import('../../src/connectors/ghsa.js');
const { hn } = await import('../../src/connectors/hn.js');

const fixture = (name) => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 9, 22, 12, 0);

// A stub of the guarded fetch: a map from url (or a predicate) to { status, body, url }.
function stubFetch(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const route = typeof routes === 'function' ? routes(url) : routes[url];
    if (route === undefined) throw new Error(`unexpected url ${url}`);
    if (typeof route === 'function') return route(url, options);
    if (typeof route === 'object' && !Buffer.isBuffer(route)) return { status: 200, url, type: '', ...route };
    return { status: 200, url, type: '', body: Buffer.from(route) };
  };
  return { fetch, calls };
}

const ctx = (config, fetch) => ({ config, fetch, secret: () => null, state: null, providers: null, budget: null, log: console, signal: AbortSignal.timeout(5000), now: () => NOW, timezone: 'UTC' });

test('rss: parses a feed through ctx.fetch and returns candidates', async () => {
  const { fetch, calls } = stubFetch({ 'https://example.com/rss.xml': fixture('rss.xml') });
  const out = await rssModule.rss.fetch(ctx({ id: 'example', cat: 'ai', limit: 2, url: 'https://example.com/rss.xml' }, fetch));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/rss.xml');
  assert.equal(out.length, 2, 'the limit is applied after sorting by date');
  assert.deepEqual(Object.keys(out[0]).sort(), ['cat', 'image', 'snippet', 'title', 'ts', 'url']);
  assert.equal(out[0].title, 'New GPU driver fixes stutter & crashes');
  assert.equal(out[0].url, 'https://example.com/news/gpu-driver');
  assert.equal(out[0].ts, Date.UTC(2026, 9, 20, 8, 30));
  assert.equal(out[0].cat, 'ai');
  assert.equal(out[1].ts, Date.UTC(2026, 9, 19, 12, 0));
});

test('rss: a non-200 answer and a body that is not a feed are errors', async () => {
  const notFound = stubFetch({ 'https://example.com/x': { status: 404, body: Buffer.from('no') } });
  await assert.rejects(rssModule.rss.fetch(ctx({ url: 'https://example.com/x' }, notFound.fetch)), /http 404/);
  const notFeed = stubFetch({ 'https://example.com/x': '<html><body>hi</body></html>' });
  await assert.rejects(rssModule.rss.fetch(ctx({ url: 'https://example.com/x' }, notFeed.fetch)), /not a feed/);
});

test('youtube: the same Atom reader, with its own type', async () => {
  const { fetch } = stubFetch({ 'https://www.youtube.com/feeds/videos.xml?channel_id=X': fixture('atom.xml') });
  const out = await youtube.fetch(ctx({ id: 'yt', cat: 'pcgaming', limit: 5, url: 'https://www.youtube.com/feeds/videos.xml?channel_id=X' }, fetch));
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'v2.4.0');
  assert.equal(youtube.type, 'youtube');
});

test('github-releases: stable releases only, the product name in front, and the substantial flag', async () => {
  const feed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>v2.1.0</title><link rel="alternate" href="https://github.com/example/app/releases/tag/v2.1.0"/><published>2026-10-21T00:00:00Z</published><summary>Big notes</summary></entry>
    <entry><title>v2.0.3</title><link rel="alternate" href="https://github.com/example/app/releases/tag/v2.0.3"/><published>2026-10-20T00:00:00Z</published><summary>patch</summary></entry>
    <entry><title>v2.0.2</title><link rel="alternate" href="https://github.com/example/app/releases/tag/v2.0.2"/><published>2026-10-19T00:00:00Z</published><summary>patch</summary></entry>
    <entry><title>v2.0.0-rc1</title><link rel="alternate" href="https://github.com/example/app/releases/tag/v2.0.0-rc1"/><published>2026-10-18T00:00:00Z</published><summary>pre</summary></entry>
    <entry><title>v1.9.0</title><link rel="alternate" href="https://github.com/example/app/releases/tag/v1.9.0"/><published>2026-10-17T00:00:00Z</published><summary>old</summary></entry>
  </feed>`;
  const { fetch } = stubFetch({ 'https://github.com/example/app/releases.atom': feed });
  const out = await githubReleases.fetch(ctx({ id: 'gh', cat: 'ai', limit: 3, url: 'https://github.com/example/app/releases.atom', label: 'Example App' }, fetch));
  assert.deepEqual(out.map((i) => i.title), ['Example App v2.1.0 released', 'Example App v2.0.3 released', 'Example App v2.0.2 released']);
  assert.equal(out[0].meta.release, true);
  assert.equal(out[0].meta.repo, true);
  assert.equal(out[0].meta.substantial, true, 'a minor step is substantial');
  assert.equal(out[1].meta.substantial, false, 'a plain patch is not');
  assert.ok(out.every((i) => i.meta.bodyLen === undefined), 'the internal bodyLen does not leak into meta');
});

test('github-releases: isPrerelease is still the same rule', () => {
  assert.equal(isPrerelease('v1.2.3'), false);
  assert.equal(isPrerelease('v1.2.3-rc1'), true);
  assert.equal(isPrerelease('Nightly build'), true);
  assert.equal(isPrerelease('v1.2.3', 'https://github.com/a/b/releases/tag/v1.2.3-beta'), true);
});

test('ghsa: advisories become candidates with packages and severity', async () => {
  const { fetch } = stubFetch({ 'https://api.github.com/advisories?ecosystem=npm': fixture('ghsa.json') });
  const out = await ghsa.fetch(ctx({ id: 'ghsa-npm', cat: 'security', limit: 1, url: 'https://api.github.com/advisories?ecosystem=npm' }, fetch));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Prototype pollution in example-package (example-package, example-cli)');
  assert.equal(out[0].url, 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc');
  assert.equal(out[0].ts, Date.parse('2026-10-20T10:00:00Z'));
  assert.equal(out[0].cat, 'security');
  assert.deepEqual(out[0].meta, { cve: 'CVE-2026-0001', severity: 'critical', packages: ['example-package', 'example-cli'] });
  assert.ok(!/[#*`>\[\]]/.test(out[0].snippet), 'markdown markers are stripped');
});

test('hn: jobs are dropped, a story without a url points at its HN page', async () => {
  const items = JSON.parse(fixture('hn-items.json'));
  const { fetch, calls } = stubFetch((url) => {
    if (url.endsWith('/topstories.json')) return fixture('hn-topstories.json');
    const id = url.match(/item\/(\d+)\.json/)?.[1];
    return items[id] ? JSON.stringify(items[id]) : { status: 404, body: Buffer.from('') };
  });
  const out = await hn.fetch(ctx({ id: 'hn', cat: 'ai', limit: 4, url: 'https://hacker-news.firebaseio.com/v0/topstories.json' }, fetch));
  assert.equal(calls.length, 5, 'the list and four items');
  assert.deepEqual(out.map((i) => i.title), ['A tiny local model beats the big one', 'Ask HN: what is your editor setup?', 'A story with no url uses the HN page']);
  assert.equal(out[0].meta.points, 412);
  assert.equal(out[0].meta.comments, 88);
  assert.equal(out[2].url, 'https://news.ycombinator.com/item?id=104');
  assert.equal(out[0].ts, 1793000000 * 1000);
});

test('rss: the parser and helpers are still exported from fresh/feeds.js', async () => {
  const feeds = await import('../../src/fresh/feeds.js');
  assert.equal(typeof feeds.parseFeed, 'function');
  assert.equal(typeof feeds.stripTags, 'function');
  assert.equal(typeof feeds.discoverFeed, 'function');
  assert.equal(typeof feeds.isPrerelease, 'function');
  assert.equal(feeds.parseFeed(fixture('rss.xml'), { id: 'example', cat: 'ai' }).length, 3);
});
