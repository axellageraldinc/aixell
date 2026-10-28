// The voice chat's filler phrases: the server's default and custom sets, and the client's phrase picking and audio cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_FILLERS, validateFillers, loadFillers } from '../../src/voice-fillers.js';
import { pickFiller, waitPlan, createFillerCache, PREFETCH_LEAD } from '../../public/lib/voice-fillers.js';

test('the default sets cover the marks from 10 seconds to 6 minutes', () => {
  assert.equal(DEFAULT_FILLERS.start.length >= 4, true);
  assert.deepEqual(waitPlan(DEFAULT_FILLERS.waits).map((m) => m.at), [10, 15, 20, 30, 60, 120, 150, 180, 240, 300, 360]);
  assert.deepEqual(validateFillers(DEFAULT_FILLERS), DEFAULT_FILLERS);
});

test('a custom file is used when it is valid and the defaults otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fillers-'));
  const file = path.join(dir, 'voice-fillers.json');
  assert.equal(loadFillers(file), DEFAULT_FILLERS, 'no file');
  const mine = { start: ['Hold on.'], waits: [{ at: [5, 9], phrases: ['Still here.'] }] };
  fs.writeFileSync(file, JSON.stringify(mine));
  assert.deepEqual(loadFillers(file), mine);
  for (const bad of ['not json', '{}', JSON.stringify({ start: [], waits: mine.waits }), JSON.stringify({ start: ['a'], waits: [{ at: [0], phrases: ['b'] }] }),
    JSON.stringify({ start: ['a'], waits: [{ at: [5], phrases: [''] }] }), JSON.stringify({ start: ['x'.repeat(201)], waits: mine.waits }),
    JSON.stringify({ start: ['a'], waits: [{ at: [4000], phrases: ['b'] }] })]) {
    fs.writeFileSync(file, bad);
    assert.equal(loadFillers(file), DEFAULT_FILLERS, bad.slice(0, 30));
  }
});

test('pickFiller never repeats the last phrase when there is a choice', () => {
  const list = ['a', 'b', 'c'];
  for (let i = 0; i < 50; i += 1) assert.notEqual(pickFiller(list, 'b'), 'b');
  assert.equal(pickFiller(['only'], 'only'), 'only');
  assert.equal(pickFiller(list, '', () => 0.99), 'c');
});

test('waitPlan flattens the tiers in time order', () => {
  const plan = waitPlan([{ at: [30, 60], phrases: ['x'] }, { at: [10], phrases: ['y'] }]);
  assert.deepEqual(plan.map((m) => m.at), [10, 30, 60]);
  assert.deepEqual(plan[0].phrases, ['y']);
  assert.ok(PREFETCH_LEAD > 0);
});

test('the filler cache requests a phrase once and remembers a failure as nothing', async () => {
  const calls = [];
  const cache = createFillerCache(async (text) => {
    calls.push(text);
    if (text === 'bad') throw new Error('down');
    return new ArrayBuffer(4);
  });
  assert.equal(cache.ready('ok'), false);
  const [a, b] = await Promise.all([cache.get('ok'), cache.get('ok')]);
  assert.equal(a.byteLength, 4);
  assert.equal(a, b);
  assert.equal(cache.ready('ok'), true);
  assert.equal(await cache.get('bad'), null);
  assert.equal(await cache.get('bad'), null);
  assert.equal(cache.ready('bad'), false);
  assert.deepEqual(calls, ['ok', 'bad']);
});
