import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFollowups, checkinSeed, isCheckin, CHECKIN_MARK } from '../../src/followups.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2030-01-10T12:00:00Z');

function setup(over = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'followups-'));
  const clock = { t: T0 };
  const delivered = [];
  const cfg = { enabled: true, quietHours: '22:00-08:00', maxPerDay: 1, ...over.cfg };
  const f = createFollowups({
    dataDir, now: () => clock.t, settings: () => cfg,
    localMinutes: (ms) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(), // UTC as the local zone
    dayOf: (ms) => new Date(ms).toISOString().slice(0, 10),
    deliver: over.deliver ?? (async (item) => { delivered.push(item.id); }),
    isBusy: over.isBusy ?? (() => false),
    log: { warn() {} },
  });
  const key = f.keyFor('main', 'sess1');
  const at = (ms) => new Date(clock.t + ms).toISOString().replace('Z', '+00:00');
  const schedule = (ms, extra = {}) => f.call('schedule_followup', { due_at: at(ms), context: 'something happened', question: 'how did it go', ...extra }, key);
  return { f, key, clock, delivered, schedule, dataDir };
}

test('the chat key names the chat and cannot be forged', () => {
  const { f, key } = setup();
  assert.deepEqual(f.chatOfKey(key), { agent: 'main', sessionId: 'sess1' });
  assert.equal(f.chatOfKey(key.slice(0, -2) + 'xx'), null);
  assert.equal(f.chatOfKey('aixf_abc.def'), null);
  assert.equal(f.chatOfKey(undefined), null);
  assert.throws(() => f.call('list_followups', {}, 'nope'), { code: 'bad_key' });
});

test('schedule validates the time and the text', () => {
  const { f, key, schedule } = setup();
  assert.equal(schedule(5 * HOUR).ok, true);
  assert.equal(schedule(-HOUR).ok, false);
  assert.equal(schedule(100 * 24 * HOUR).ok, false);
  assert.equal(f.call('schedule_followup', { due_at: '2030-01-11T09:00:00', context: 'x', question: 'y' }, key).ok, false); // no offset
  assert.equal(f.call('schedule_followup', { due_at: 'tomorrow', context: 'x', question: 'y' }, key).ok, false);
  assert.equal(schedule(5 * HOUR, { question: '' }).ok, false);
});

test('list and cancel work per chat', () => {
  const { f, key, schedule } = setup();
  const { id } = schedule(5 * HOUR);
  assert.equal(f.call('list_followups', {}, key).followups.length, 1);
  assert.equal(f.call('list_followups', {}, f.keyFor('main', 'other')).followups.length, 0);
  assert.equal(f.call('cancel_followup', { id }, f.keyFor('main', 'other')).ok, false);
  assert.equal(f.call('cancel_followup', { id }, key).ok, true);
  assert.equal(f.call('list_followups', {}, key).followups.length, 0);
});

test('at most five pending per chat', () => {
  const { schedule } = setup();
  for (let i = 0; i < 5; i += 1) assert.equal(schedule((i + 2) * HOUR).ok, true);
  assert.equal(schedule(10 * HOUR).ok, false);
});

test('a due follow-up is delivered once, in the daytime', async () => {
  const { f, clock, delivered, schedule } = setup();
  schedule(2 * HOUR);
  clock.t += HOUR;
  assert.equal((await f.tick()).sent, 0);
  clock.t += 2 * HOUR;
  assert.equal((await f.tick()).sent, 1);
  assert.equal((await f.tick()).sent, 0);
  assert.equal(delivered.length, 1);
});

test('nothing is sent in quiet hours; it goes out when they end', async () => {
  const { f, clock, delivered, schedule } = setup();
  schedule(11 * HOUR); // 23:00 UTC
  clock.t += 11.5 * HOUR;
  assert.equal((await f.tick()).quiet, true);
  assert.equal(delivered.length, 0);
  clock.t += 9 * HOUR; // 08:30 next day
  assert.equal((await f.tick()).sent, 1);
});

test('the daily limit holds the rest back until tomorrow', async () => {
  const { f, clock, delivered, schedule } = setup();
  schedule(2 * HOUR);
  schedule(3 * HOUR);
  clock.t += 4 * HOUR;
  assert.equal((await f.tick()).sent, 1);
  assert.equal((await f.tick()).sent, 0);
  clock.t += 24 * HOUR;
  assert.equal((await f.tick()).sent, 1);
  assert.equal(delivered.length, 2);
});

test('a busy chat is skipped and tried again later', async () => {
  let busy = true;
  const { f, clock, delivered, schedule } = setup({ isBusy: () => busy });
  schedule(2 * HOUR);
  clock.t += 3 * HOUR;
  assert.equal((await f.tick()).sent, 0);
  busy = false;
  assert.equal((await f.tick()).sent, 1);
  assert.equal(delivered.length, 1);
});

test('a failed delivery is retried, then given up', async () => {
  let calls = 0;
  const { f, clock, schedule } = setup({ cfg: { maxPerDay: 10 }, deliver: async () => { calls += 1; throw new Error('down'); } });
  schedule(2 * HOUR);
  clock.t += 3 * HOUR;
  for (let i = 0; i < 5; i += 1) { await f.tick(); clock.t += HOUR; }
  assert.equal(calls, 3);
  assert.equal(f.list()[0].status, 'failed');
});

test('the agent is told to back off after two unanswered check-ins; an answer resets it', async () => {
  const { f, key, clock, schedule } = setup({ cfg: { maxPerDay: 10 } });
  for (let i = 0; i < 2; i += 1) {
    schedule(2 * HOUR);
    clock.t += 3 * HOUR;
    await f.tick();
  }
  const refused = schedule(2 * HOUR);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /not answered/);
  f.noteUserTurn('main', 'sess1');
  assert.equal(schedule(2 * HOUR).ok, true);
  assert.ok(key);
});

test('a stale follow-up is dropped instead of sent', async () => {
  const { f, clock, delivered, schedule } = setup();
  schedule(2 * HOUR);
  clock.t += 5 * 24 * HOUR;
  await f.tick();
  assert.equal(delivered.length, 0);
  assert.equal(f.list()[0].status, 'expired');
});

test('disabled means nothing is accepted or sent', async () => {
  const { f, key } = setup({ cfg: { enabled: false } });
  assert.throws(() => f.call('schedule_followup', {}, key), { code: 'followups_off' });
  assert.deepEqual(await f.tick(), { sent: 0 });
});

test('the list survives a restart and the file is private', () => {
  const a = setup();
  a.schedule(5 * HOUR);
  const b = createFollowups({ dataDir: a.dataDir, now: () => T0, settings: () => ({ enabled: true }), localMinutes: () => 600, dayOf: () => 'd', deliver: async () => {} });
  assert.equal(b.pendingOf({ agent: 'main', sessionId: 'sess1' }).length, 1);
  assert.equal(fs.statSync(path.join(a.dataDir, 'followups.json')).mode & 0o777, 0o600);
});

test('the check-in note carries the mark the chat page hides', () => {
  const seed = checkinSeed({ context: 'c', question: 'q' });
  assert.ok(seed.startsWith(CHECKIN_MARK));
  assert.equal(isCheckin(seed), true);
  assert.equal(isCheckin('hello'), false);
});
