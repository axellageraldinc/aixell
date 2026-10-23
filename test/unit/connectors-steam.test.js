// The Steam connector: the boost is zero when Steam is not configured, the credentials come from
// ctx.secret with the field names of the old data file, and the event patterns are config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const steam = await import('../../src/connectors/steam.js');
const { stateFor } = await import('../../src/connectors/state.js');
const registry = await import('../../src/connectors/registry.js');

let n = 0;
const ctxOf = ({ config = {}, secret = { steam_id: '123', api_key: 'key' }, fetch = null } = {}) => {
  const id = `steam-test-${process.pid}-${n += 1}`;
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

const silenceOffline = (value) => {
  const before = process.env.HERMES_WEB_FRESH_OFFLINE;
  process.env.HERMES_WEB_FRESH_OFFLINE = value;
  return () => { process.env.HERMES_WEB_FRESH_OFFLINE = before; };
};

test('steamBoost is zero when Steam is not configured', () => {
  steam.resetBoosts();
  assert.equal(steam.steamBoost('Mock Souls patch 1.2 is out'), 0);
});

test('steamBoost follows the cached account: a played game raises a story that names it', async () => {
  const restore = silenceOffline('0');
  try {
    const ctx = ctxOf({
      fetch: async (url) => {
        const u = new URL(String(url));
        if (u.pathname.includes('GetOwnedGames')) return { status: 200, body: Buffer.from(JSON.stringify({ response: { game_count: 1, games: [{ appid: 1, name: 'Space Odyssey', playtime_forever: 5000 }] } })) };
        if (u.pathname.includes('GetRecentlyPlayedGames')) return { status: 200, body: Buffer.from(JSON.stringify({ response: { games: [] } })) };
        if (u.pathname.includes('GetWishlist')) return { status: 200, body: Buffer.from(JSON.stringify({ response: { items: [] } })) };
        return { status: 404, body: Buffer.from('{}') };
      },
    });
    await steam.refreshSteam(ctx, { force: true });
    steam.resetBoosts();
    assert.ok(steam.steamBoost('Space Odyssey gets a new patch') > 0);
    assert.equal(steam.steamBoost('A different game entirely'), 0);
  } finally { restore(); }
});

test('no credentials: status says unavailable and fetch returns [] without a request', async () => {
  const restore = silenceOffline('0');
  try {
    let calls = 0;
    const ctx = ctxOf({ secret: null, fetch: async () => { calls += 1; return { status: 200, body: Buffer.from('{}') }; } });
    assert.deepEqual(await steam.fetch(ctx), []);
    assert.equal(calls, 0);
    assert.equal(steam.statusOf(ctx).unavailable, 'no credentials');
  } finally { restore(); }
});

test('the credentials are the field names of the old data file', () => {
  assert.deepEqual(steam.default.credentials.map((c) => c.key), ['steam_id', 'api_key']);
  assert.equal(steam.default.defaultSchedule.every, '3h');
  assert.deepEqual(steam.default.cost, { kind: 'free' });
});

test('the event patterns are part of the config, with neutral English defaults', () => {
  assert.ok(steam.EVENT_PATTERNS.every((pattern) => !/[^\x00-\x7f]/.test(pattern)));
  assert.ok(steam.EVENT_PATTERNS.some((pattern) => /next fest/i.test(pattern)));
});

test('the registry exposes the boost for the scoring path, and it is zero unconfigured', async () => {
  const reg = await registry.createRegistry({ dir: '/nonexistent-connectors-dir', log: { warn: () => {} } });
  const connector = reg.get('steam');
  assert.equal(typeof connector.boost, 'function');
  steam.resetAccount();
  assert.equal(connector.boost('Space Odyssey patch'), 0);
});

test('a sale event becomes one summary card, and a patch note becomes a card', async () => {
  const restore = silenceOffline('0');
  try {
    const now = Date.now();
    const ctx = ctxOf({
      config: { events: ['\\bnext fest\\b'] },
      fetch: async (url) => {
        const u = new URL(String(url));
        if (u.pathname.includes('GetOwnedGames')) return { status: 200, body: Buffer.from(JSON.stringify({ response: { game_count: 1, games: [{ appid: 1, name: 'Space Odyssey', playtime_forever: 5000 }] } })) };
        if (u.pathname.includes('GetRecentlyPlayedGames')) return { status: 200, body: Buffer.from(JSON.stringify({ response: { games: [] } })) };
        if (u.pathname.includes('GetWishlist')) return { status: 200, body: Buffer.from(JSON.stringify({ response: { items: [] } })) };
        if (u.pathname.includes('GetNewsForApp') && u.searchParams.get('appid') === '593110') {
          return { status: 200, body: Buffer.from(JSON.stringify({ appnews: { newsitems: [{ gid: 'e1', title: 'Steam Next Fest is here', url: 'https://store.steampowered.com/nextfest', contents: 'Demos.', date: Math.floor(now / 1000) - 3600 }] } })) };
        }
        if (u.pathname.includes('GetNewsForApp')) {
          return { status: 200, body: Buffer.from(JSON.stringify({ appnews: { newsitems: [{ gid: 'p1', title: 'Space Odyssey patch 1.4 notes', url: 'https://steamcommunity.com/games/1/announcements/detail/2', contents: 'Fixes.', date: Math.floor(now / 1000) - 7200 }] } })) };
        }
        return { status: 404, body: Buffer.from('{}') };
      },
    });
    const items = await steam.fetch(ctx);
    assert.ok(items.some((item) => item.kind === 'steam-sale' && /Next Fest/.test(item.title)), 'one summary card for the event');
    assert.ok(items.some((item) => item.meta.patch === true), 'a patch note is a card');
  } finally { restore(); }
});
