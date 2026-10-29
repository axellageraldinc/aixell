// HERMES_WEB_FRESH_OFFLINE=1 still answers all four account-bound connectors from the local mocks:
// no network, no login to a real service, no paid call. The contexts are built the way
// src/fresh/index.js builds them (per-instance state, the shared ledger, a provider registry).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../helpers/env.js';
import { mockHttp } from '../../src/fresh/mock.js';
import { stateFor } from '../../src/connectors/state.js';
import { createBudget } from '../../src/connectors/budget.js';
import { createRegistry } from '../../src/connectors/registry.js';

const registry = await createRegistry({ dir: path.join(dataDir, 'no-drop-ins'), log: { warn: () => {} } });
const LEDGER = path.join(dataDir, 'fresh-x.json');

// The offline `ctx.fetch` of src/fresh/index.js: the mock in the { status, body } shape.
const mockFetch = async (url, options) => {
  const res = mockHttp(String(url), options);
  return { status: res.status, url: String(url), type: 'application/json', body: res.body ?? Buffer.from(JSON.stringify(res.data ?? null)) };
};

// A fake socialSearch that counts calls and answers like the offline mock (no network, no bill).
function fakeSearch() {
  const calls = [];
  return {
    calls,
    pricing: { perCallMicro: 100_000_000 },
    async search(request) {
      calls.push(request);
      return { answer: '- @someone: A new model release with a longer context window. https://x.com/someone/status/1', citations: [], costMicro: 100_000_000 };
    },
  };
}

const ctxOf = (id, config, { search = fakeSearch(), now = Date.now() } = {}) => ({
  config: { id, ...config },
  state: stateFor(id),
  budget: createBudget({ file: LEDGER, timezone: 'UTC', now: () => now }),
  secret: (key) => ({ handle: 'mock', appPassword: 'mock', token: 'mock', steam_id: '1', api_key: 'mock' })[key] ?? null,
  fetch: mockFetch,
  providers: { get: (capability) => (capability === 'socialSearch' ? search : null) },
  now: () => now,
  timezone: 'UTC',
  enabled: true,
  log: { warn: () => {} },
});

beforeEach(() => {
  fs.rmSync(LEDGER, { force: true });
  for (const id of ['bluesky-offline', 'x-offline', 'github-offline', 'steam-offline']) {
    stateFor(id).set('bluesky-last-run', 0);
    stateFor(id).set('gh-run', 0);
    stateFor(id).set('steam-run', 0);
    stateFor(id).set('steam-cache', null);
  }
});

test('offline: Bluesky answers from the mock without a real login', async () => {
  const ctx = ctxOf('bluesky-offline', { queries: [{ q: 'local model', cat: 'ai', minEngagement: 8 }] });
  const items = await registry.get('bluesky').fetch(ctx);
  assert.ok(items.length >= 1);
  assert.ok(items.every((item) => /^https?:\/\//.test(item.url)));
});

test('offline: X search answers from the fake provider once, then stops for that slot', async () => {
  const search = fakeSearch();
  const ctx = ctxOf('x-offline', { slots: [{ at: '00:00', topic: 'New AI model releases', cats: ['ai'] }] }, { search });
  const items = await registry.get('x-search').fetch(ctx);
  assert.ok(items.length >= 1);
  assert.equal(search.calls.length, 1, 'one paid call, through the fake');
  assert.equal(ctx.budget.spentToday().calls, 1);
  const again = await registry.get('x-search').fetch(ctx);
  assert.deepEqual(again, [], 'the slot already ran today');
  assert.equal(search.calls.length, 1, 'no second call');
});

test('offline: GitHub hype answers from the mock', async () => {
  const ctx = ctxOf('github-offline', { topics: ['ai-agents'] });
  const items = await registry.get('github-hype').fetch(ctx);
  assert.ok(items.length >= 1);
  assert.ok(items.every((item) => item.meta?.via === 'github'));
});

test('offline: Steam answers from the mock', async () => {
  const ctx = ctxOf('steam-offline', {});
  const items = await registry.get('steam').fetch(ctx);
  assert.ok(items.length >= 1);
  assert.ok(items.every((item) => item.meta?.via === 'steam'));
});

test('offline: with the neutral shipped defaults nothing is called and nothing is spent', async () => {
  const search = fakeSearch();
  const bluesky = ctxOf('bluesky-offline', { queries: [] }, { search });
  assert.deepEqual(await registry.get('bluesky').fetch(bluesky), []);
  const x = ctxOf('x-offline', { dailyCap: 7 }, { search });
  // The connector's default slot exists, but the offline path still needs a provider; with one it
  // answers from the fake, as the acceptance test above does. Here: a missing provider.
  const none = { ...x, providers: { get: () => null } };
  assert.deepEqual(await registry.get('x-search').fetch(none), []);
  assert.equal(search.calls.length, 0, 'nothing was paid for');
  assert.equal(fs.existsSync(LEDGER), false, 'nothing was written to the ledger');
});
