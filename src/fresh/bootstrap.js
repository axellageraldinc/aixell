import crypto from 'node:crypto';
import * as store from './store.js';
import { holdScheduler } from '../connectors/x-search.js';

// "Run everything now": a one-off first fill, inside the live server process (the same engine and the same database as the
// schedule, so nothing can run twice). Steps, in order: every feed, Bluesky, GitHub, Steam, each X slot once, then the write queue
// is drained until nothing is waiting, the writer's daily cap is reached, nothing moves any more, or an hour has passed.
//  - X is paid: at most X_BUDGET (7) calls, one per slot, never retried. They go through the normal ledger, so today's cap may be
//    spent afterwards, which is accepted. While the bootstrap runs, the X schedule stays out of the way.
//  - Once per 24 hours (a guard saved when it starts), unless force.
//  - The progress object below is what GET /api/fresh/bootstrap returns; the last one is kept in the database.
export const X_BUDGET = 7;
export const DRAIN_MS = 60 * 60_000;
const GUARD_MS = 24 * 3_600_000;
const STEPS = ['feeds', 'bluesky', 'github', 'steam', 'x', 'drain'];

let current = null;
const view = (job) => JSON.parse(JSON.stringify(job));
export const bootstrapProgress = () => (current ? view(current) : store.kvGet('bootstrap-job', null));
export const bootstrapIsRunning = () => current?.state === 'running';

const counts = () => ({ fetched: 0, seen: 0, added: 0, dup: 0, skipped: 0 });
const queueTotal = () => { const q = store.queueSizes(); return (q.untriaged ?? 0) + (q.pending ?? 0); };

async function source(job, name, fn) {
  const step = job.steps[name];
  step.status = 'running';
  try {
    const out = await fn(step);
    if (out?.skipped) { step.status = 'skipped'; step.reason = out.skipped; } else step.status = 'done';
  } catch (err) {
    step.status = 'error';
    step.error = String(err.message).slice(0, 160);
    job.errors.push(`${name}: ${step.error}`);
  }
}

// X: every slot once, in order, ignoring the clock, the owner and the stock. A refusal for balance (402) ends the round of calls.
async function xStep(job, deps, step) {
  if (!deps.xOn()) return { skipped: 'X is switched off' };
  Object.assign(step, { attempts: 0, calls: 0, cost: 0, slots: [] });
  for (const slot of [...deps.xSlots()].sort((a, b) => a.n - b.n)) {
    if (step.attempts >= X_BUDGET) break;
    step.attempts += 1;
    const out = await deps.runXSlot(slot.n, { days: 2 });
    const line = { slot: slot.n, type: slot.type, items: out.parsed ?? out.items?.length ?? 0, kept: out.kept ?? out.items?.length ?? 0, added: 0 }; // items = found in the answer, kept = after the junk filter
    if (out.items || out.charged) step.calls += 1;
    if (out.costMicro) step.cost += out.costMicro / 1e6;
    if (out.error) { line.error = String(out.error); job.errors.push(`x slot ${slot.n}: ${line.error}`); }
    if (out.items?.length) line.added = await deps.ingestX(out.items, step);
    step.slots.push(line);
    if (out.error === 402 || out.error === 'blocked') break;
  }
  job.x = { calls: step.calls, cost: step.cost, budget: X_BUDGET };
  return undefined;
}

// The write queue: judge, fold threads, write, then dedupe, round after round.
async function drainStep(job, deps, step) {
  Object.assign(step, { rounds: 0, ready: 0, merged: 0, queueLeft: queueTotal(), stopped: '' });
  const t0 = Date.now();
  const before = store.statusCounts();
  let stalled = 0;
  while (!step.stopped) {
    const waiting = queueTotal();
    if (!waiting) { step.stopped = 'empty'; break; }
    if (Date.now() - t0 > DRAIN_MS) { step.stopped = 'timeout'; break; }
    if (deps.room() <= 0 && !(store.queueSizes().untriaged ?? 0)) { step.stopped = 'daily write cap'; break; }
    const out = await deps.round();
    step.rounds += 1;
    step.ready += out.made;
    step.merged += await deps.dedupe();
    const left = queueTotal();
    stalled = left >= waiting && !out.made && !out.kept ? stalled + 1 : 0;
    if (stalled >= 2) step.stopped = 'stalled';
    step.queueLeft = left;
  }
  step.queueLeft = queueTotal();
  const after = store.statusCounts();
  step.skipped = (after.skip ?? 0) - (before.skip ?? 0);
  step.elapsedMs = Date.now() - t0;
}

async function run(job, deps) {
  holdScheduler(true);
  try {
    await source(job, 'feeds', async (st) => { const r = await deps.feeds(st); st.failed = r.failed; });
    await source(job, 'bluesky', (st) => deps.bluesky(st));
    await source(job, 'github', (st) => deps.github(st));
    await source(job, 'steam', (st) => deps.steam(st));
    await source(job, 'x', (st) => xStep(job, deps, st));
    await source(job, 'drain', (st) => drainStep(job, deps, st));
    const s = job.steps;
    job.summary = {
      added: STEPS.slice(0, 5).reduce((n, k) => n + (s[k].added ?? 0), 0), dup: STEPS.slice(0, 5).reduce((n, k) => n + (s[k].dup ?? 0), 0),
      ready: s.drain.ready ?? 0, merged: s.drain.merged ?? 0, skipped: (s.drain.skipped ?? 0) + STEPS.slice(0, 5).reduce((n, k) => n + (s[k].skipped ?? 0), 0),
      xCalls: job.x.calls, xCost: job.x.cost, queueLeft: queueTotal(), readyTotal: store.stats().ready ?? 0, errors: job.errors.length, stopped: s.drain.stopped ?? '',
    };
    job.state = job.errors.length ? 'done-with-errors' : 'done';
    // One "new feed ready" push for the whole first fill, only when the write queue was drained completely.
    try { job.notify = await deps.notify?.(s.drain.stopped === 'empty'); } catch (err) { job.notify = { sent: false, reason: String(err.message).slice(0, 80) }; }
  } catch (err) {
    job.state = 'error';
    job.errors.push(`bootstrap: ${String(err.message).slice(0, 160)}`);
  } finally {
    holdScheduler(false);
    job.finishedAt = Date.now();
    store.kvSet('bootstrap-job', view(job));
  }
}

// -> { job } started, { busy: job } when one is running, { recent: ms } when one ran in the last 24 hours (unless force).
export function startBootstrap(deps, { force = false, now = Date.now() } = {}) {
  if (bootstrapIsRunning()) return { busy: view(current) };
  const last = store.kvGet('bootstrap-last', 0);
  if (!force && now - last < GUARD_MS) return { recent: last + GUARD_MS };
  store.kvSet('bootstrap-last', now);
  const job = { id: crypto.randomBytes(6).toString('hex'), state: 'running', force, startedAt: now, finishedAt: 0, x: { calls: 0, cost: 0, budget: X_BUDGET }, steps: {}, summary: null, errors: [] };
  for (const name of STEPS) job.steps[name] = { status: 'pending', ...(name === 'drain' ? {} : counts()) };
  current = job;
  deps.exclusive(() => run(job, deps)).catch(() => {});
  return { job: view(job) };
}
