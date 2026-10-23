// The shipped presets, the legacy kind mapping, and the schema's connector validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const { DEFAULT_CONNECTOR_PRESETS, legacyKindToType, legacyKindOf, fromLegacySource } = await import('../../src/connectors/presets.js');
const { DEFAULT_SOURCES } = await import('../../src/fresh/feeds.js');
const { createRegistry } = await import('../../src/connectors/registry.js');
const { validate } = await import('../../src/config/schema.js');

const silent = { warn: () => {} };
const ACCOUNT = [
  { id: 'bluesky', type: 'bluesky' },
  { id: 'x', type: 'x-search' },
  { id: 'github', type: 'github-hype' },
  { id: 'steam', type: 'steam' },
];

test('presets: the 39 feed sources plus the four account-bound ones', () => {
  assert.equal(DEFAULT_SOURCES.length, 39);
  assert.equal(DEFAULT_CONNECTOR_PRESETS.length, DEFAULT_SOURCES.length + ACCOUNT.length);
  assert.deepEqual(DEFAULT_CONNECTOR_PRESETS.slice(-4).map((p) => ({ id: p.id, type: p.type })), ACCOUNT);
});

test('presets: 43 sources in total, the four account-bound ones included as instances', () => {
  // The old list of 43 was DEFAULT_SOURCES (39 feeds) plus VIRTUAL_SOURCES (4). The four are
  // connector instances now, with the same legacy ids, and the Settings panel still groups them.
  assert.equal(DEFAULT_CONNECTOR_PRESETS.length, 43);
  assert.equal(DEFAULT_SOURCES.length + ACCOUNT.length, 43);
});

test('presets: ids are unique', () => {
  const ids = DEFAULT_CONNECTOR_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('presets: every type is known to the registry', async () => {
  const registry = await createRegistry({ dir: '/nonexistent-connectors-dir', log: silent });
  const types = new Set(registry.types());
  const unknown = DEFAULT_CONNECTOR_PRESETS.filter((p) => !types.has(p.type));
  assert.deepEqual(unknown, []);
});

test('presets: the registry instance equals the old DEFAULT_SOURCES entry on id/name/cat/limit/stack', async () => {
  const registry = await createRegistry({ dir: '/nonexistent-connectors-dir', log: silent });
  const instances = registry.instances(DEFAULT_CONNECTOR_PRESETS);
  assert.equal(instances.length, DEFAULT_CONNECTOR_PRESETS.length);
  instances.slice(0, DEFAULT_SOURCES.length).forEach((instance, i) => {
    const old = DEFAULT_SOURCES[i];
    assert.equal(instance.id, old.id);
    assert.equal(instance.name, old.name);
    assert.equal(instance.cat, old.cat);
    assert.equal(instance.limit, old.limit);
    assert.equal(instance.stack ?? false, old.stack ?? false);
    assert.equal(instance.config.url, old.url);
    assert.equal(instance.error, undefined);
  });
  // The account-bound presets carry neutral config and no error: they are unavailable, not broken.
  for (const instance of instances.slice(DEFAULT_SOURCES.length)) {
    assert.equal(instance.error, undefined);
    assert.equal(typeof instance.config, 'object');
  }
});

test('presets: the account-bound defaults are neutral (no queries, slots or handles of a deployment)', () => {
  const byId = Object.fromEntries(DEFAULT_CONNECTOR_PRESETS.map((p) => [p.id, p]));
  assert.deepEqual(byId.bluesky.config.queries, []);
  assert.equal(byId.x.config.slots, undefined, 'the x-search default slot comes from the connector, built from the categories');
  assert.equal(byId.x.config.handles, undefined);
  assert.deepEqual(byId.github.config.topics, ['ai-agents']);
  assert.equal(byId.github.config.thresholds, undefined, 'the connector thresholds are the defaults');
});

test('presets: the legacy kind mapping is the documented one', () => {
  assert.equal(legacyKindToType.rss, 'rss');
  assert.equal(legacyKindToType.atom, 'rss');
  assert.equal(legacyKindToType.mastodon, 'rss');
  assert.equal(legacyKindToType.yt, 'youtube');
  assert.equal(legacyKindToType.github, 'github-releases');
  assert.equal(legacyKindToType.ghsa, 'ghsa');
  assert.equal(legacyKindToType.hn, 'hn');
  assert.equal(legacyKindToType.nonsense, undefined);
  assert.equal(legacyKindOf('github-releases'), 'github');
});

test('presets: a custom source saved with an old kind maps on load', () => {
  const custom = { id: 'c-1234abcd', name: 'A feed', kind: 'rss', cat: 'ai', url: 'https://example.com/feed' };
  const mapped = fromLegacySource(custom);
  assert.deepEqual(mapped, { id: 'c-1234abcd', type: 'rss', cat: 'ai', limit: undefined, name: 'A feed', config: { url: 'https://example.com/feed' } });
  assert.equal(fromLegacySource({ ...custom, kind: 'yt' }).type, 'youtube');
  assert.equal(fromLegacySource({ ...custom, kind: 'github' }).type, 'github-releases');
  // A custom Bluesky handle is a single account feed, not the keyword search: it stays on the legacy fetcher.
  assert.equal(fromLegacySource({ ...custom, kind: 'bsky-search' }).type, 'bluesky');
  assert.equal(fromLegacySource({ ...custom, kind: 'bsky-search' }).legacy, 'bluesky-account');
});

test('schema: connectors is a validated array, not an opaque object', () => {
  assert.ok(validate({ connectors: {} }).errors[0].startsWith('connectors: '));
  const entry = { id: 'a', type: 'rss', cat: 'ai', limit: 5, config: { url: 'https://example.com/feed' }, credentials: { token: 'env:TOKEN' } };
  const result = validate({ connectors: [entry] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value.connectors, [entry]);
});

test('schema: a bad connector entry is a path-qualified error', () => {
  const base = { id: 'a', type: 'rss', cat: 'ai', limit: 5, config: {} };
  const cases = [
    [{ ...base, id: '' }, 'connectors[0].id'],
    [{ ...base, type: '' }, 'connectors[0].type'],
    [{ ...base, enabled: 'yes' }, 'connectors[0].enabled'],
    [{ ...base, cat: '' }, 'connectors[0].cat'],
    [{ ...base, limit: '5' }, 'connectors[0].limit'],
    [{ ...base, config: [] }, 'connectors[0].config'],
    [{ ...base, credentials: { token: 42 } }, 'connectors[0].credentials.token'],
    [{ ...base, credentials: 'env:TOKEN' }, 'connectors[0].credentials'],
  ];
  for (const [entry, prefix] of cases) {
    const errors = validate({ connectors: [entry] }).errors;
    assert.ok(errors.some((e) => e.startsWith(`${prefix}: `)), `${prefix} should be an error, got ${JSON.stringify(errors)}`);
  }
});

test('schema: duplicate connector ids are refused', () => {
  const entry = { id: 'same', type: 'rss', cat: 'ai', limit: 5, config: {} };
  const errors = validate({ connectors: [entry, { ...entry, type: 'hn' }] }).errors;
  assert.ok(errors.some((e) => e.startsWith('connectors[1].id: duplicate')));
});

test('schema: connectorsDir must be a non-empty string', () => {
  assert.deepEqual(validate({ connectorsDir: 'connectors' }).errors, []);
  assert.ok(validate({ connectorsDir: '' }).errors[0].startsWith('connectorsDir: '));
});

test('schema: unknown connector keys only warn', () => {
  const result = validate({ connectors: [{ id: 'a', type: 'rss', cat: 'ai', limit: 5, config: {}, surprise: true }] });
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((w) => w.startsWith('connectors[0].surprise: ')));
});
