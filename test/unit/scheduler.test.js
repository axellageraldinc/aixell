import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, nextDue, validateSpec } from '../../src/scheduler/schedule-spec.js';
import { createScheduler } from '../../src/scheduler/scheduler.js';

const iso = (ms, tz = 'UTC') => new Date(ms).toLocaleString('sv-SE', { timeZone: tz });

function fakeClock(start = Date.UTC(2026, 0, 1, 0, 0, 0)) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { at: t + ms, fn, id }); return { id, unref() {} }; },
    clearTimer(h) { if (h) timers.delete(h.id); },
    pending: () => timers.size,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.values()].filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id);
        t = Math.max(t, due.at);
        due.fn();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      }
      t = end;
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
  };
}
const memStore = (m = new Map()) => ({ get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), m });
const quiet = { warn() {}, log() {} };

test('spec: every units', () => {
  assert.equal(parseSpec({ every: '45s' }).ms, 45_000);
  assert.equal(parseSpec({ every: '30m' }).ms, 1_800_000);
  assert.equal(parseSpec({ every: '6h' }).ms, 21_600_000);
});
test('spec: invalid specs throw clear errors', () => {
  for (const bad of [null, {}, { every: 'soon' }, { every: '0m' }, { every: '5m', at: ['10:00'] }, { at: [] }, { at: ['25:00'] }, { at: ['10:00'], days: [7] }, { cron: '* * *' }, { cron: '60 * * * *' }, { cron: '*/0 * * * *' }, { cron: 'a b c d e' }]) {
    assert.throws(() => parseSpec(bad), /schedule/, JSON.stringify(bad));
  }
  assert.equal(validateSpec({ every: '5m' }), null);
  assert.match(validateSpec({ every: 'x' }), /invalid interval/);
});
test('nextDue: every', () => {
  assert.equal(nextDue({ every: '5m' }, 1000), 1000 + 300_000);
});
test('nextDue: at in UTC, today then tomorrow', () => {
  const from = Date.UTC(2026, 0, 1, 6, 0);
  assert.equal(iso(nextDue({ at: ['07:30', '21:00'] }, from)), '2026-01-01 07:30:00');
  assert.equal(iso(nextDue({ at: ['07:30', '21:00'] }, Date.UTC(2026, 0, 1, 22, 0))), '2026-01-02 07:30:00');
  assert.equal(iso(nextDue({ at: ['07:30'] }, Date.UTC(2026, 0, 1, 7, 30))), '2026-01-02 07:30:00', 'strictly after');
});
test('nextDue: at with days and a time zone', () => {
  // 2026-01-01 is a Thursday. Bangkok is UTC+7.
  const tz = 'Asia/Bangkok';
  const from = Date.UTC(2026, 0, 1, 5, 0); // 12:00 local
  assert.equal(iso(nextDue({ at: ['21:00'] }, from, tz), tz), '2026-01-01 21:00:00');
  assert.equal(iso(nextDue({ at: ['09:00'], days: [1] }, from, tz), tz), '2026-01-05 09:00:00'); // next Monday
});
test('nextDue: midnight rollover', () => {
  const tz = 'America/New_York';
  const from = Date.parse('2026-03-01T04:59:00Z'); // 23:59 local on Feb 28
  assert.equal(iso(nextDue({ at: ['00:00'] }, from, tz), tz), '2026-03-01 00:00:00');
  assert.equal(iso(nextDue({ at: ['00:00'] }, from + 60_000, tz), tz), '2026-03-02 00:00:00');
});
test('nextDue: DST spring forward and fall back keep local wall time', () => {
  const tz = 'America/New_York';
  // Spring forward: 2026-03-08. 09:00 local before is UTC-5 (14:00Z), after is UTC-4 (13:00Z).
  const a = nextDue({ at: ['09:00'] }, Date.parse('2026-03-07T15:00:00Z'), tz);
  assert.equal(new Date(a).toISOString(), '2026-03-08T13:00:00.000Z');
  // Fall back: 2026-11-01. 09:00 local after is UTC-5 (14:00Z).
  const b = nextDue({ at: ['09:00'] }, Date.parse('2026-10-31T14:00:00Z'), tz);
  assert.equal(new Date(b).toISOString(), '2026-11-01T14:00:00.000Z');
  // A time inside the spring-forward gap still fires that day, just after the gap.
  const c = nextDue({ at: ['02:30'] }, Date.parse('2026-03-08T06:00:00Z'), tz);
  assert.equal(iso(c, tz).slice(0, 10), '2026-03-08');
});
test('nextDue: cron lists, ranges, steps, dow/dom', () => {
  const from = Date.UTC(2026, 0, 1, 8, 7); // Thu 08:07
  assert.equal(iso(nextDue({ cron: '*/15 * * * *' }, from)), '2026-01-01 08:15:00');
  assert.equal(iso(nextDue({ cron: '0 9-17/4 * * *' }, from)), '2026-01-01 09:00:00');
  assert.equal(iso(nextDue({ cron: '30 6,18 * * *' }, from)), '2026-01-01 18:30:00');
  assert.equal(iso(nextDue({ cron: '0 12 * * 1-5' }, Date.UTC(2026, 0, 2, 13, 0))), '2026-01-05 12:00:00'); // Fri -> Mon
  assert.equal(iso(nextDue({ cron: '0 0 15 2 *' }, from)), '2026-02-15 00:00:00');
  assert.equal(iso(nextDue({ cron: '0 0 1 1 *' }, from)), '2027-01-01 00:00:00');
});

const base = (clock, store) => ({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, store, log: quiet });

test('scheduler: every job fires on time and keeps going', async () => {
  const c = fakeClock();
  const s = createScheduler(base(c, memStore()));
  let n = 0;
  s.add({ id: 'a', schedule: { every: '10m' }, run: async () => { n += 1; } });
  s.start();
  await c.advance(9 * 60_000);
  assert.equal(n, 0);
  await c.advance(2 * 60_000);
  assert.equal(n, 1);
  await c.advance(30 * 60_000);
  assert.equal(n, 4);
  assert.equal(s.list()[0].running, false);
});
test('scheduler: runOnStart', async () => {
  const c = fakeClock();
  const s = createScheduler(base(c, memStore()));
  let n = 0;
  s.add({ id: 'a', schedule: { every: '1h' }, runOnStart: 8000, run: async () => { n += 1; } });
  s.start();
  await c.advance(7000);
  assert.equal(n, 0);
  await c.advance(2000);
  assert.equal(n, 1);
  await c.advance(60 * 60_000);
  assert.equal(n, 2);
});
test('scheduler: overlap skip drops a firing while the previous run is pending', async () => {
  const c = fakeClock();
  const s = createScheduler(base(c, memStore()));
  let n = 0;
  let release;
  s.add({ id: 'a', schedule: { every: '1m' }, overlap: 'skip', run: () => { n += 1; return new Promise((r) => { release = r; }); } });
  s.start();
  await c.advance(5 * 60_000 + 1);
  assert.equal(n, 1);
  assert.equal(s.list()[0].running, true);
  release();
  await c.advance(0);
  assert.equal(s.list()[0].running, false);
  await c.advance(60_000);
  assert.equal(n, 2);
});
test('scheduler: overlap queue runs once after the pending run', async () => {
  const c = fakeClock();
  const s = createScheduler(base(c, memStore()));
  let n = 0;
  const releases = [];
  s.add({ id: 'a', schedule: { every: '1m' }, overlap: 'queue', run: () => { n += 1; return new Promise((r) => releases.push(r)); } });
  s.start();
  await c.advance(3 * 60_000 + 1);
  assert.equal(n, 1);
  releases[0]();
  await c.advance(0);
  assert.equal(n, 2);
});
test('scheduler: timeout abandons the run, aborts the signal and logs', async () => {
  const c = fakeClock();
  const s = createScheduler(base(c, memStore()));
  let signal;
  s.add({ id: 'a', schedule: { every: '10m' }, timeoutMs: 1000, run: (ctx) => { signal = ctx.signal; return new Promise(() => {}); } });
  s.start();
  await c.advance(10 * 60_000);
  assert.equal(s.list()[0].running, true);
  await c.advance(1000);
  assert.equal(signal.aborted, true);
  assert.equal(s.list()[0].running, false);
  assert.match(s.list()[0].lastError, /timed out/);
});
test('scheduler: a throwing job never kills the chain', async () => {
  const c = fakeClock();
  const s = createScheduler(base(c, memStore()));
  let n = 0;
  s.add({ id: 'a', schedule: { every: '1m' }, run: async () => { n += 1; throw new Error('boom'); } });
  s.add({ id: 'b', schedule: { every: '1m' }, run: () => { throw new Error('sync boom'); } });
  s.start();
  await c.advance(3 * 60_000);
  assert.equal(n, 3);
  assert.equal(s.list().find((j) => j.id === 'a').lastError, 'boom');
  assert.equal(s.list().find((j) => j.id === 'b').lastError, 'sync boom');
});
test('scheduler: persisted nextDue survives a new instance; a missed every job fires once', async () => {
  const st = memStore();
  const c1 = fakeClock();
  const s1 = createScheduler(base(c1, st));
  let n = 0;
  s1.add({ id: 'a', schedule: { every: '1h' }, run: async () => { n += 1; } });
  s1.start();
  await c1.advance(60 * 60_000);
  assert.equal(n, 1);
  s1.stop();
  // Restart 20 minutes later: not due yet, must not refire.
  const c2 = fakeClock(c1.now() + 20 * 60_000);
  const s2 = createScheduler(base(c2, st));
  s2.add({ id: 'a', schedule: { every: '1h' }, run: async () => { n += 1; } });
  s2.start();
  await c2.advance(30 * 60_000);
  assert.equal(n, 1);
  await c2.advance(15 * 60_000);
  assert.equal(n, 2);
  s2.stop();
  // Down for 5 hours: the missed run fires once on start, not five times.
  const c3 = fakeClock(c2.now() + 5 * 3_600_000);
  const s3 = createScheduler(base(c3, st));
  s3.add({ id: 'a', schedule: { every: '1h' }, run: async () => { n += 1; } });
  s3.start();
  await c3.advance(1);
  assert.equal(n, 3);
});
test('scheduler: a missed at job is not backfilled', async () => {
  const st = memStore();
  const c1 = fakeClock(Date.UTC(2026, 0, 1, 6, 0));
  let n = 0;
  const job = { id: 'a', schedule: { at: ['07:00'] }, run: async () => { n += 1; } };
  const s1 = createScheduler(base(c1, st));
  s1.add(job);
  s1.start();
  s1.stop();
  const c2 = fakeClock(Date.UTC(2026, 0, 1, 12, 0)); // down across 07:00
  const s2 = createScheduler(base(c2, st));
  s2.add(job);
  s2.start();
  await c2.advance(60_000);
  assert.equal(n, 0);
  assert.equal(new Date(s2.list()[0].nextDue).toISOString(), '2026-01-02T07:00:00.000Z');
  await c2.advance(19 * 3_600_000);
  assert.equal(n, 1);
});
test('scheduler: remove cancels, runNow runs, add after start arms at once', async () => {
  const c = fakeClock();
  const s = createScheduler(base(c, memStore()));
  let n = 0;
  s.start();
  s.add({ id: 'a', schedule: { every: '1m' }, run: async () => { n += 1; } });
  await c.advance(60_000);
  assert.equal(n, 1);
  await s.runNow('a');
  assert.equal(n, 2);
  assert.equal(s.remove('a'), true);
  await c.advance(10 * 60_000);
  assert.equal(n, 2);
  assert.equal(c.pending(), 0);
  assert.equal(s.list().length, 0);
  await assert.rejects(s.runNow('a'), /unknown job/);
});
test('scheduler: daily budget caps runs per local day', async () => {
  const c = fakeClock();
  const s = createScheduler(base(c, memStore()));
  let n = 0;
  s.add({ id: 'a', schedule: { every: '1h' }, budget: { maxPerDay: 3 }, run: async () => { n += 1; } });
  s.start();
  await c.advance(10 * 3_600_000);
  assert.equal(n, 3);
  await c.advance(15 * 3_600_000); // past midnight
  assert.ok(n > 3);
});
test('scheduler: stop clears every timer; invalid spec is rejected by add', async () => {
  const c = fakeClock();
  const s = createScheduler(base(c, memStore()));
  s.add({ id: 'a', schedule: { every: '1m' }, run: async () => {} });
  s.start();
  s.stop();
  assert.equal(c.pending(), 0);
  assert.throws(() => s.add({ id: 'b', schedule: { every: 'x' }, run: async () => {} }), /invalid interval/);
});
