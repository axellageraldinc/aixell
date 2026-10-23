// With no `connectors` in the config, the Settings sources list must be identical to before apart
// from the added `type` (same ids, order, names, cats, urls), and the four account-bound sources
// must still be listed as virtual with their legacy ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';

const fresh = await import('../../src/fresh/index.js');
const { DEFAULT_SOURCES } = await import('../../src/fresh/feeds.js');

const ACCOUNT = ['bluesky', 'x', 'github', 'steam'];

test('sourcesView: the presets are used when no connectors are configured', () => {
  const view = fresh.sourcesView();
  assert.equal(view.length, DEFAULT_SOURCES.length + ACCOUNT.length);
  DEFAULT_SOURCES.forEach((old, i) => {
    const now = view[i];
    assert.equal(now.id, old.id);
    assert.equal(now.name, old.name);
    assert.equal(now.kind, old.kind);
    assert.equal(now.cat, old.cat);
    assert.equal(now.url, old.url);
    assert.equal(now.virtual, false);
    assert.equal(now.custom, false);
  });
  const types = Object.fromEntries(view.slice(0, DEFAULT_SOURCES.length).map((s) => [s.id, s.type]));
  assert.equal(types.pcgamer, 'rss');
  assert.equal(types.dfoundry, 'youtube');
  assert.equal(types.hn, 'hn');
  assert.equal(types['gh-claudecode'], 'github-releases');
  assert.equal(types['ghsa-npm'], 'ghsa');
});

test('sourcesView: the four account-bound sources are virtual and keep their ids', () => {
  const view = fresh.sourcesView();
  const virtual = view.filter((s) => s.virtual);
  assert.deepEqual(virtual.map((s) => s.id), ACCOUNT);
  assert.ok(virtual.every((s) => typeof s.type === 'string' && s.type.length));
  assert.ok(virtual.every((s) => s.on === true));
  assert.deepEqual(virtual.map((s) => [s.id, s.type, s.name]), [
    ['bluesky', 'bluesky', 'Bluesky (search)'],
    ['x', 'x-search', 'X (social search)'],
    ['github', 'github-hype', 'GitHub (trending AI repos)'],
    ['steam', 'steam', 'Steam (library, patch, sale)'],
  ]);
});

test('sourcesView: a preset can be switched off and back on', () => {
  assert.equal(fresh.toggleSource('hn', false), true);
  assert.equal(fresh.sourcesView().find((s) => s.id === 'hn').on, false);
  assert.equal(fresh.toggleSource('hn', true), true);
  assert.equal(fresh.sourcesView().find((s) => s.id === 'hn').on, true);
});

test('sourcesView: an account-bound source can be switched off and back on too', () => {
  assert.equal(fresh.toggleSource('x', false), true);
  assert.equal(fresh.sourcesView().find((s) => s.id === 'x').on, false);
  assert.equal(fresh.toggleSource('x', true), true);
  assert.equal(fresh.sourcesView().find((s) => s.id === 'x').on, true);
});

test('freshStatus: keeps the x, bluesky, steam and github keys', () => {
  const status = fresh.freshStatus();
  for (const key of ACCOUNT) assert.ok(status[key] && typeof status[key] === 'object', `${key} is reported`);
  assert.equal(status.bluesky.unavailable, 'no queries configured');
  assert.equal(typeof status.x.cap, 'number');
  assert.equal(status.github.unavailable, undefined, 'the token is only needed at fetch time; the status is configured from the registry');
  assert.equal(typeof status.steam.configured, 'boolean');
});
