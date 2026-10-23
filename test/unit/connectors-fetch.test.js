// Fetching goes through the registry: a configured drop-in connector is called with a context,
// its candidates get the old {source, cat, name, stack} decoration, and health is recorded. An
// unknown type is listed but never fetched. No network: the drop-in returns items directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-connectors-fetch-'));
process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));
process.env.HERMES_WEB_DATA_DIR = dataDir;
process.env.HERMES_WEB_FRESH_OFFLINE = '0';
process.env.HERMES_WEB_CONFIG = path.join(dataDir, 'config.json');
fs.writeFileSync(process.env.HERMES_WEB_CONFIG, JSON.stringify({
  connectors: [
    { id: 'drop', type: 'drop', cat: 'security', limit: 2, name: 'Drop-in source', config: { url: 'https://example.com/feed' } },
    { id: 'ghost', type: 'not-a-type', cat: 'ai', limit: 1, name: 'Ghost', config: {} },
    { id: 'off', type: 'drop', cat: 'ai', limit: 1, enabled: false, name: 'Off', config: {} },
  ],
}));
fs.mkdirSync(path.join(dataDir, 'connectors'));
fs.writeFileSync(path.join(dataDir, 'connectors', 'drop.js'), `
export default {
  type: 'drop',
  title: 'Drop-in',
  cost: { kind: 'free' },
  async fetch(ctx) {
    if (ctx.config.url !== 'https://example.com/feed') throw new Error('config not passed');
    if (typeof ctx.secret !== 'function' || ctx.signal === undefined || typeof ctx.now() !== 'number') throw new Error('bad context');
    return [{ url: 'https://example.com/a', title: 'A', ts: ctx.now(), cat: 'pcbuild', hints: { stack: true } }];
  },
};
`);

const fresh = await import('../../src/fresh/index.js');
const store = await import('../../src/fresh/store.js');

test('fetchFeeds: a drop-in connector is fetched and decorated; disabled and unknown ones are not', async () => {
  const view = fresh.sourcesView();
  assert.equal(view.find((s) => s.id === 'ghost').error, 'unknown connector type');
  const out = await fresh._fetchFeeds(true);
  assert.deepEqual(out.failed, [], 'an unknown type is never fetched, so it never fails');
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].source, 'drop');
  assert.equal(out.items[0].name, 'Drop-in source');
  assert.equal(out.items[0].cat, 'pcbuild', 'the candidate hint wins');
  assert.equal(out.items[0].stack, true, 'hints.stack is carried');
  assert.equal(out.items[0].hints, undefined, 'hints do not leak into the item');
  const health = new Map(store.healthAll().map((h) => [h.source, h]));
  assert.equal(Boolean(health.get('drop').ok), true);
  assert.equal(health.get('drop').count, 1);
  assert.equal(health.get('ghost'), undefined, 'an unknown type is not fetched');
  assert.equal(health.get('off'), undefined, 'a disabled source is never fetched');
});

test('fetchFeeds: the offline mode still fetches nothing', async () => {
  process.env.HERMES_WEB_FRESH_OFFLINE = '1';
  try {
    assert.deepEqual(await fresh._fetchFeeds(true), { items: [], failed: [] });
  } finally {
    process.env.HERMES_WEB_FRESH_OFFLINE = '0';
  }
});
