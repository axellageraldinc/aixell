// The registry: built-ins, drop-ins, and the instances it builds from a config list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/env.js';
const { createRegistry, BUILTINS } = await import('../../src/connectors/registry.js');
const { DEFAULT_CONNECTOR_PRESETS } = await import('../../src/connectors/presets.js');

const silent = { warn: () => {} };
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-connectors-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const connectorSource = (type) => `
export default {
  type: ${JSON.stringify(type)},
  title: 'Drop-in',
  cost: { kind: 'free' },
  fetch: async () => [{ url: 'https://example.com/a', title: 'A', ts: Date.now() }],
};
`;

test('registry: the built-in types load', async () => {
  const registry = await createRegistry({ dir: tempDir(), log: silent });
  assert.deepEqual(registry.types(), ['bluesky', 'ghsa', 'github-hype', 'github-releases', 'hn', 'rss', 'steam', 'x-search', 'youtube']);
  assert.equal(registry.get('rss')?.type, 'rss');
  assert.equal(registry.get('nope'), null);
  assert.deepEqual(registry.warnings, []);
});

test('registry: a missing connector directory is fine', async () => {
  const registry = await createRegistry({ dir: path.join(tempDir(), 'missing'), log: silent });
  assert.deepEqual(registry.types(), ['bluesky', 'ghsa', 'github-hype', 'github-releases', 'hn', 'rss', 'steam', 'x-search', 'youtube']);
  assert.deepEqual(registry.warnings, []);
});

test('registry: a drop-in file is loaded from a temp dir', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'example.js'), connectorSource('example'));
  const registry = await createRegistry({ dir, log: silent });
  assert.ok(registry.types().includes('example'));
  assert.equal(registry.get('example')?.title, 'Drop-in');
});

test('registry: an invalid drop-in is skipped with a warning, not a crash', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'broken.js'), 'export default { type: "broken", title: "No fetch" };\n');
  fs.writeFileSync(path.join(dir, 'throws.js'), 'throw new Error("boom at import");\n');
  fs.writeFileSync(path.join(dir, 'not-a-connector.js'), 'export const nope = 1;\n');
  fs.writeFileSync(path.join(dir, 'good.js'), connectorSource('good'));
  const registry = await createRegistry({ dir, log: silent });
  assert.deepEqual(registry.types(), ['bluesky', 'ghsa', 'github-hype', 'github-releases', 'good', 'hn', 'rss', 'steam', 'x-search', 'youtube']);
  assert.equal(registry.warnings.length, 3);
  assert.ok(registry.warnings.some((w) => w.includes('broken.js') && w.includes('fetch')));
  assert.ok(registry.warnings.some((w) => w.includes('throws.js') && w.includes('could not be loaded')));
  assert.ok(registry.warnings.some((w) => w.includes('not-a-connector.js')));
});

test('registry: a drop-in with a built-in type is rejected', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'rss-again.js'), connectorSource('rss'));
  const registry = await createRegistry({ dir, log: silent });
  assert.equal(registry.get('rss'), BUILTINS.find((c) => c.type === 'rss'), 'the built-in wins');
  assert.ok(registry.warnings.some((w) => w.includes('rss-again.js') && w.includes('built in')));
});

test('registry: a drop-in duplicating another drop-in is rejected', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.js'), connectorSource('twice'));
  fs.writeFileSync(path.join(dir, 'b.js'), connectorSource('twice'));
  const registry = await createRegistry({ dir, log: silent });
  assert.ok(registry.types().includes('twice'));
  assert.equal(registry.warnings.filter((w) => w.includes('twice')).length, 1);
});

test('registry: instances carry the config, and an unknown type is listed with an error', async () => {
  const registry = await createRegistry({ dir: tempDir(), log: silent });
  const [known, unknown] = registry.instances([
    { id: 'a', type: 'rss', cat: 'ai', limit: 7, name: 'Feed A', config: { url: 'https://example.com/feed' } },
    { id: 'b', type: 'nope', cat: 'ai', limit: 3, name: 'Nope' },
  ]);
  assert.equal(known.id, 'a');
  assert.equal(known.type, 'rss');
  assert.equal(known.enabled, true);
  assert.equal(known.cat, 'ai');
  assert.equal(known.limit, 7);
  assert.equal(known.name, 'Feed A');
  assert.equal(known.config.url, 'https://example.com/feed');
  assert.equal(known.config.limit, 7, 'the instance config carries the instance settings');
  assert.deepEqual(known.schedule, { every: '30m' });
  assert.equal(known.error, undefined);
  assert.equal(unknown.error, 'unknown connector type');
});

test('registry: instances respect enabled/stack and never carry credentials', async () => {
  const registry = await createRegistry({ dir: tempDir(), log: silent });
  const [instance] = registry.instances([{ id: 'a', type: 'rss', cat: 'ai', limit: 2, enabled: false, stack: true, config: { url: 'https://example.com/f' }, credentials: { token: 'env:SOME_TOKEN' } }]);
  assert.equal(instance.enabled, false);
  assert.equal(instance.stack, true);
  assert.deepEqual(Object.keys(instance).sort(), ['cat', 'config', 'enabled', 'id', 'limit', 'name', 'schedule', 'stack', 'type']);
  assert.equal(JSON.stringify(instance).includes('env:SOME_TOKEN'), false, 'credential refs stay outside the instance');
});

test('registry: every preset type is known to the registry', async () => {
  const registry = await createRegistry({ dir: tempDir(), log: silent });
  const types = new Set(registry.types());
  assert.ok(DEFAULT_CONNECTOR_PRESETS.every((preset) => types.has(preset.type)));
});
