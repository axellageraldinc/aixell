// The x-search connector goes through the `socialSearch` provider. The provider is a local fake that
// counts calls; the ledger is the real one in the temp data dir. Nothing reaches the network.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../helpers/env.js';
import { stateFor } from '../../src/connectors/state.js';
import { createBudget } from '../../src/connectors/budget.js';

process.env.HERMES_WEB_FRESH_OFFLINE = '0';

const x = await import('../../src/connectors/x-search.js');

const LEDGER = path.join(dataDir, 'fresh-x.json');

// A fake socialSearch provider: it counts the calls, checks the filter it got and answers a fixed
// answer. `beforeAnswer` runs while the call is in flight (to see the ledger state).
function fakeSearch({ answer = '- @someone: A new model release with a longer context window. https://example.com/a', costMicro = 100_000_000, beforeAnswer } = {}) {
  const calls = [];
  return {
    calls,
    pricing: { perCallMicro: costMicro, currency: 'USD' },
    async search(request) {
      calls.push(request);
      if (beforeAnswer) beforeAnswer(request);
      return { answer, citations: [], costMicro };
    },
  };
}

function contextOf({ search = null, config = {}, now = Date.now(), enabled = true } = {}) {
  return {
    config: { id: 'x', windowHours: 24, ...config }, // wide window: a 00:00 slot must not expire as the real clock passes 04:00
    state: stateFor('x'),
    budget: createBudget({ file: LEDGER, timezone: 'UTC', now: () => now }),
    providers: { get: (capability) => (capability === 'socialSearch' ? search : null) },
    secret: () => null,
    fetch: async () => { throw new Error('no network in this test'); },
    log: { warn: () => {} },
    signal: AbortSignal.timeout(5_000),
    now: () => now,
    timezone: 'UTC',
    enabled,
  };
}

const slot1 = { at: '00:00', topic: 'New AI model releases', cats: ['ai'] };

beforeEach(() => {
  fs.rmSync(LEDGER, { force: true });
  fs.rmSync(path.join(dataDir, 'filters', 'xx.json'), { force: true });
  stateFor('x').set('x-handles', { stats: {}, allowed: [], excluded: [], langs: {} });
  stateFor('x').set('x-slot-health', {});
  stateFor('x').set('x-raw', {});
  x.clearFilterCache();
});
afterEach(() => { fs.rmSync(path.join(dataDir, 'filters', 'xx.json'), { force: true }); });

test('a due slot pays through the search provider, parses the answer and records the cost in the ledger', async () => {
  const search = fakeSearch();
  const ctx = contextOf({ search, config: { slots: [slot1] } });
  const out = await x.runDueSlot(ctx, { now: Date.now(), lastOpen: Date.now() });
  assert.equal(out.slot, 1);
  assert.ok(out.parsed >= 1, 'the fake answer has items');
  assert.equal(out.kept, out.items.length);
  assert.equal(out.costMicro, 100_000_000);
  assert.equal(search.calls.length, 1);
  assert.match(search.calls[0].query, /New AI model releases/);
  assert.match(search.calls[0].query, /List 15 to 25 DISTINCT items/);
  assert.equal(typeof search.calls[0].filter.from, 'string');
  assert.ok(out.items.every((i) => i.source === 'x' && /^https?:/.test(i.url)));
  const status = x.statusOf(ctx);
  assert.equal(status.callsToday, 1);
  assert.equal(status.costToday, 100);
  assert.equal(status.slots.find((s) => s.n === 1).state, 'done');
  assert.ok(status.lastRaw[1].answer, 'the raw answer is kept for diagnosis');
});

test('the call is recorded in the ledger BEFORE the provider is called', async () => {
  let seenDuringCall = null;
  const search = fakeSearch({ beforeAnswer: () => { seenDuringCall = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } });
  const ctx = contextOf({ search, config: { slots: [slot1] } });
  await x.runDueSlot(ctx, { now: Date.now(), lastOpen: Date.now() });
  assert.ok(seenDuringCall, 'the ledger file exists while the call is in flight');
  const day = x.statusOf(ctx).day;
  assert.equal(seenDuringCall.days[day].calls, 1, 'the call is counted before the answer');
});

test('a 402 blocks the connector for six hours and is not charged; a 500 is not charged either', async () => {
  const failing = { calls: 0, pricing: { perCallMicro: 100_000_000 }, async search() { this.calls += 1; const err = new Error('payment required'); err.status = 402; throw err; } };
  const ctx = contextOf({ search: failing, config: { slots: [slot1] } });
  const out = await x.runSlotNow(ctx, 1, { now: Date.now() });
  assert.equal(out.error, 402);
  let status = x.statusOf(ctx);
  assert.equal(status.callsToday, 0, 'a refused call is refunded');
  assert.ok(status.blockedUntil > Date.now());
  assert.equal((await x.runSlotNow(ctx, 1, { now: Date.now() })).error, 'blocked');

  // Clear the block and try a server error: not charged, no block.
  fs.writeFileSync(LEDGER, JSON.stringify({ days: {}, last: {} }));
  const broken = { calls: 0, pricing: { perCallMicro: 100_000_000 }, async search() { const err = new Error('server error'); err.status = 500; throw err; } };
  const ctx2 = contextOf({ search: broken, config: { slots: [slot1] } });
  assert.equal((await x.runSlotNow(ctx2, 1, { now: Date.now() })).error, 500);
  status = x.statusOf(ctx2);
  assert.equal(status.callsToday, 0);
  assert.equal(status.blockedUntil, 0);
});

test('without a socialSearch provider the slot reports it, sends nothing and is not charged', async () => {
  const ctx = contextOf({ search: null, config: { slots: [slot1] } });
  const out = await x.runDueSlot(ctx, { now: Date.now(), lastOpen: Date.now() });
  assert.equal(out.error, 'no provider');
  assert.equal(x.statusOf(ctx).callsToday, 0);
  assert.deepEqual(await x.fetch(ctx), [], 'fetch returns no candidates');
});

test('fetch with no provider returns [] and spends nothing', async () => {
  const ctx = contextOf({ search: null, config: { slots: [slot1] } });
  assert.deepEqual(await x.fetch(ctx), []);
  assert.equal(fs.existsSync(LEDGER), false, 'no ledger write at all');
});

test('the daily cap stops the calls: the next slot is skipped, not paid', async () => {
  const search = fakeSearch();
  const ctx = contextOf({ search, config: { slots: [slot1, { ...slot1, at: '00:05' }], dailyCap: 1 } });
  const first = await x.runSlotNow(ctx, 1, { now: Date.now() });
  assert.equal(first.calls ?? 1, 1);
  const second = await x.runSlotNow(ctx, 2, { now: Date.now() });
  assert.equal(second.error, 'cap');
  assert.equal(search.calls.length, 1, 'only one paid call');
});

test('a slot becomes due in its own time zone, including across a day boundary', () => {
  const config = { slots: [{ at: '23:30', topic: 'late', cats: ['ai'] }] };
  const utc = x.configOf(config);
  assert.equal(utc.slots[0].minutes, 23 * 60 + 30);
  // 2026-01-02 00:10 UTC is 2026-01-01 23:10 in UTC-1: the slot (23:30) is not due yet.
  const at = Date.UTC(2026, 0, 2, 0, 10);
  assert.equal(x.minutesOfDay(at, 'UTC'), 10);
  assert.equal(x.minutesOfDay(at, 'Etc/GMT+1'), 23 * 60 + 10);
  assert.equal(x.minutesOfDay(at, 'Pacific/Kiritimati'), 14 * 60 + 10);
});

test('the day key of the ledger follows the connector time zone', async () => {
  const search = fakeSearch();
  const now = Date.UTC(2026, 0, 2, 0, 30); // 2026-01-01 23:30 in UTC-1
  const ctx = { ...contextOf({ search, config: { slots: [{ at: '23:00', topic: 'late', cats: ['ai'] }] } }), timezone: 'Etc/GMT+1' };
  ctx.budget = createBudget({ file: LEDGER, timezone: 'Etc/GMT+1', now: () => now });
  const out = await x.runDueSlot(ctx, { now, lastOpen: now });
  assert.equal(out.slot, 1, '23:30 is inside the 23:00 slot window');
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  assert.deepEqual(Object.keys(ledger.days), ['2026-01-01']);
});

test('an empty slots list means no paid call, and status says so', async () => {
  const search = fakeSearch();
  const ctx = contextOf({ search, config: { slots: [] } });
  assert.deepEqual(await x.fetch(ctx), []);
  assert.equal(search.calls.length, 0);
  assert.equal(x.statusOf(ctx).unavailable, 'no slots configured');
});

test('status says unavailable when there is no socialSearch provider', () => {
  const ctx = contextOf({ search: null, config: { slots: [slot1] } });
  assert.equal(x.statusOf(ctx).unavailable, 'needs a socialSearch provider');
  assert.equal(x.statusOf(ctx).cap, 7);
});

test('a language slot is filtered by that language\'s pack, not by the English one', async () => {
  fs.mkdirSync(path.join(dataDir, 'filters'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'filters', 'xx.json'), JSON.stringify({
    id: 'xx', lang: 'xx', rules: [{ name: 'giveaway', action: 'drop', test: '\\bgiveaway\\b' }],
  }));
  x.clearFilterCache();
  const search = fakeSearch({ answer: '- @one: A useful tool write-up with numbers. https://example.com/one\n- @two: Giveaway: premium accounts for ten people. https://example.com/two' });
  const ctx = contextOf({ search, config: { slots: [{ at: '00:00', topic: 'tools', cats: ['ai'], lang: 'xx' }] } });
  const out = await x.runSlotNow(ctx, 1, { now: Date.now() });
  assert.equal(out.parsed, 2);
  assert.equal(out.kept, 1, 'the giveaway line is dropped by the pack');
  assert.equal(out.items[0].meta.lang, 'xx');
});

test('learned-handle thresholds are unchanged: 4 passes to allow, 4 fails to exclude', () => {
  const ctx = contextOf({ config: {} });
  for (let i = 0; i < 3; i += 1) x.noteHandle('goodone', true, 1, '', ctx);
  assert.deepEqual(x.statusOf(ctx).handles.allowed, []);
  x.noteHandle('goodone', true, 1, '', ctx);
  assert.deepEqual(x.statusOf(ctx).handles.allowed, ['goodone']);
  for (let i = 0; i < 4; i += 1) x.noteHandle('badone', false, 1, '', ctx);
  assert.ok(x.statusOf(ctx).handles.excluded.includes('badone'));
});

test('a language slot judges its accounts on their own list', () => {
  const ctx = contextOf({ config: {} });
  for (let i = 0; i < 2; i += 1) x.noteHandle('langone', true, 1, 'xx', ctx);
  assert.deepEqual(x.statusOf(ctx).handles.allowed, [], 'a language account never enters the global list');
  assert.deepEqual(x.statusOf(ctx).handles.byLang.xx.allowed, ['langone']);
});

test('a due slot always runs: a full pool, an owner who has not opened Fresh and weak earlier results do not skip it', async () => {
  const search = fakeSearch();
  const ctx = contextOf({ search, config: { slots: [slot1] } });
  stateFor('x').set('x-slot-health', { 1: { weak: 5, at: Date.now() } });
  const out = await x.runDueSlot(ctx, { now: Date.now() }); // no lastOpen: the owner has been away
  assert.equal(out.skipped, undefined, `the slot was skipped: ${out.reason}`);
  assert.equal(search.calls.length, 1);
});

test('the daily cap is the one thing that skips a due slot', async () => {
  const search = fakeSearch();
  const ctx = contextOf({ search, config: { slots: [slot1], dailyCap: 0 } });
  const out = await x.runDueSlot(ctx, { now: Date.now() });
  assert.equal(out.reason, 'cap');
  assert.equal(search.calls.length, 0);
});
