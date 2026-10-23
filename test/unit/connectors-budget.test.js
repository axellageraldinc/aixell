// The shared budget ledger of the metered connectors: the fresh-x.json format, day boundaries in the
// context's time zone, and a reservation recorded before the call.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/env.js';
const { createBudget, dayOf } = await import('../../src/connectors/budget.js');

let dir;
const fileOf = () => path.join(dir, 'fresh-x.json');
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-budget-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('budget: reserve records the call before anything else and spentToday reads it back', () => {
  const now = Date.UTC(2026, 0, 2, 10, 0);
  const budget = createBudget({ file: fileOf(), timezone: 'UTC', now: () => now });
  assert.equal(budget.reserve(100, { cap: 3 }), true);
  const row = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
  assert.deepEqual(Object.keys(row.days), ['2026-01-02']);
  assert.equal(row.days['2026-01-02'].calls, 1, 'the call is written by reserve()');
  budget.settle(100);
  assert.deepEqual(budget.spentToday(), { day: '2026-01-02', calls: 1, costMicro: 100, slots: {} });
  assert.equal(fs.statSync(fileOf()).mode & 0o777, 0o600, 'the ledger stays private');
});

test('budget: the cap stops a reservation without writing a call', () => {
  const now = Date.UTC(2026, 0, 2, 10, 0);
  const budget = createBudget({ file: fileOf(), timezone: 'UTC', now: () => now });
  assert.equal(budget.reserve(0, { cap: 2 }), true);
  assert.equal(budget.reserve(0, { cap: 2 }), true);
  assert.equal(budget.reserve(0, { cap: 2 }), false);
  assert.equal(budget.spentToday().calls, 2);
});

test('budget: days are counted in the configured zone, not in UTC', () => {
  // 2026-01-02 00:30 UTC is 2026-01-01 23:30 in UTC-1.
  const at = Date.UTC(2026, 0, 2, 0, 30);
  assert.equal(dayOf(at, 'UTC'), '2026-01-02');
  assert.equal(dayOf(at, 'Etc/GMT+1'), '2026-01-01');
  assert.equal(dayOf(at, 'Pacific/Kiritimati'), '2026-01-02');
  assert.equal(dayOf(at, 'Pacific/Honolulu'), '2026-01-01');
});

test('budget: reserve and spentToday roll over at midnight in that zone', () => {
  let now = Date.UTC(2026, 0, 1, 23, 30); // 2026-01-01 23:30 UTC
  const budget = createBudget({ file: fileOf(), timezone: 'Etc/GMT+1', now: () => now }); // 2026-01-01 22:30 there
  budget.reserve(10, { cap: 7 });
  assert.equal(budget.spentToday().day, '2026-01-01');
  assert.equal(budget.spentToday().calls, 1);
  now = Date.UTC(2026, 0, 2, 0, 30); // 2026-01-01 23:30 there: still the same day
  assert.equal(budget.spentToday().day, '2026-01-01');
  assert.equal(budget.spentToday().calls, 1);
  now = Date.UTC(2026, 0, 2, 1, 30); // 2026-01-02 00:30 there: a new day
  assert.equal(budget.spentToday().day, '2026-01-02');
  assert.equal(budget.spentToday().calls, 0);
  assert.equal(budget.reserve(10, { cap: 7 }), true);
  assert.equal(budget.spentToday().calls, 1);
});

test('budget: refund gives a refused call back; markSlot keeps the slot row', () => {
  const now = Date.UTC(2026, 0, 2, 10, 0);
  const budget = createBudget({ file: fileOf(), timezone: 'UTC', now: () => now });
  budget.reserve(100, { cap: 7 });
  budget.refund(100);
  assert.equal(budget.spentToday().calls, 0);
  budget.markSlot(2, { state: 'done', items: 4 });
  assert.equal(budget.spentToday().slots[2].state, 'done');
  assert.equal(budget.spentToday().slots[2].items, 4);
});

test('budget: the file format is the pre-connector one and a missing file starts empty', () => {
  const budget = createBudget({ file: fileOf(), timezone: 'UTC' });
  assert.deepEqual(budget.read(), { days: {}, last: {} });
  budget.update((ledger) => { ledger.last = { models: '2026-01-02' }; });
  const parsed = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
  assert.deepEqual(parsed.last, { models: '2026-01-02' });
  assert.deepEqual(Object.keys(parsed).sort(), ['days', 'last']);
});

test('budget: only the last 70 days are kept', () => {
  const file = fileOf();
  const days = Array.from({ length: 75 }, (_, i) => {
    const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    return [date, { calls: 1, costMicro: 0, slots: {} }];
  });
  fs.writeFileSync(file, JSON.stringify({ days: Object.fromEntries(days), last: {} }));
  const budget = createBudget({ file, timezone: 'UTC' });
  budget.markSlot(1, { state: 'done' });
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(parsed.days).length, 70);
});
