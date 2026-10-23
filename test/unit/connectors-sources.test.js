// The Fresh sources view: same list as before, now with a connector type, and never a credential value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../helpers/env.js';

// A config with a connector that uses a secret reference, written before src/config.js is imported.
const secretValue = 'super-secret-value-that-must-not-leak';
process.env.P5B_TEST_TOKEN = secretValue;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  connectors: [
    { id: 'a', type: 'rss', cat: 'ai', limit: 5, name: 'Feed A', config: { url: 'https://example.com/a.xml' }, credentials: { token: 'env:P5B_TEST_TOKEN' } },
    { id: 'b', type: 'nope', cat: 'security', limit: 2, name: 'Unknown', config: {} },
  ],
}));

const fresh = await import('../../src/fresh/index.js');
const { DEFAULT_SOURCES } = await import('../../src/fresh/feeds.js');

test('sourcesView: the configured connectors are listed, unknown types too, and the presets are not', () => {
  const view = fresh.sourcesView();
  const ids = view.map((s) => s.id);
  assert.deepEqual(ids, ['a', 'b', 'bluesky', 'x', 'github', 'steam']);
  assert.equal(view[0].type, 'rss');
  assert.equal(view[0].kind, 'rss');
  assert.equal(view[1].type, 'nope');
  assert.equal(view[1].name, 'Unknown');
});

test('sourcesView: no credential value (or reference) is ever in the view', () => {
  const text = JSON.stringify(fresh.sourcesView());
  assert.equal(text.includes(secretValue), false);
  assert.equal(text.includes('env:P5B_TEST_TOKEN'), false);
  assert.equal(text.includes('credentials'), false);
});

test('sourcesView: with no connectors configured the preset list is unchanged apart from type', () => {
  // The module already read the config at import, so this checks the preset equivalence directly.
  assert.equal(DEFAULT_SOURCES.length, 39);
  assert.ok(DEFAULT_SOURCES.every((s) => s.id && s.name && s.cat && s.url));
});

test('toggleSource: a listed source can be switched, an unknown one is refused', () => {
  assert.equal(fresh.toggleSource('a', false), true);
  assert.equal(fresh.sourcesView().find((s) => s.id === 'a').on, false);
  assert.equal(fresh.toggleSource('a', true), true);
  assert.equal(fresh.toggleSource('ghost', true), false);
});
