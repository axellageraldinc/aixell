// One in-process scheduler: a setTimeout chain (never setInterval), timers unref'd, lastRun / nextDue
// persisted in a small kv store (key prefix "sched:") so a restart does not refire everything.
import { nextDue as computeNext, parseSpec, _localParts } from './schedule-spec.js';

const MAX_DELAY = 2 ** 31 - 1;
const defaultSetTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };

export function createScheduler({ now = Date.now, setTimer = defaultSetTimer, clearTimer = clearTimeout, store = null, timezone = 'UTC', log = console, random = Math.random } = {}) {
  const jobs = new Map(); // id -> entry
  let started = false;

  const kvKey = (id) => `sched:${id}`;
  const load = (id) => { try { return store?.get(kvKey(id)) ?? null; } catch { return null; } };
  const save = (e) => {
    try { store?.set(kvKey(e.job.id), { lastRun: e.lastRun, nextDue: e.nextDue, runs: e.runs }); } catch (err) { log.warn?.(`[scheduler] persist failed: ${err.message}`); }
  };
  const tz = () => (typeof timezone === 'function' ? timezone() : timezone);
  const dayKey = (ms) => { const p = _localParts(ms, tz()); return `${p.year}-${p.month}-${p.day}`; };
  const unref = (t) => { t?.unref?.(); return t; };

  function arm(e) {
    if (e.timer) { clearTimer(e.timer); e.timer = null; }
    if (!started || e.nextDue == null) return;
    const delay = Math.min(Math.max(0, e.nextDue - now()), MAX_DELAY);
    e.timer = unref(setTimer(() => {
      e.timer = null;
      if (jobs.get(e.job.id) !== e) return;
      if (e.nextDue - now() > 0) { arm(e); return; } // long delay chunk: re-arm
      fire(e, false);
    }, delay));
  }

  function planNext(e, from) {
    const base = computeNext(e.job.schedule, from, tz());
    const jitter = e.job.jitterMs ? Math.floor(random() * e.job.jitterMs) : 0;
    e.nextDue = base + jitter;
  }

  function initialDue(e) {
    const saved = load(e.job.id);
    const t = now();
    if (saved) { e.lastRun = saved.lastRun ?? null; e.runs = saved.runs ?? null; }
    if (e.job.runOnStart) {
      e.nextDue = t + (typeof e.job.runOnStart === 'number' ? e.job.runOnStart : 0);
      return;
    }
    if (saved?.nextDue != null) {
      if (saved.nextDue > t) { e.nextDue = saved.nextDue; return; }
      if (e.spec.kind === 'every') { e.nextDue = t; return; } // missed: fire once
      // at / cron missed while down: no backfill
    }
    planNext(e, t);
  }

  function runs(e) {
    const day = dayKey(now());
    if (!e.runs || e.runs.day !== day) e.runs = { day, n: 0 };
    return e.runs;
  }

  // Executes one run. Resolves when it settles, times out or is skipped.
  function fire(e, manual) {
    const job = e.job;
    if (e.running) {
      if (job.overlap === 'queue') e.queued = true;
      else log.warn?.(`[scheduler] ${job.id}: previous run still pending, skipped`);
      if (!manual) { planNext(e, now()); save(e); arm(e); }
      return Promise.resolve({ skipped: true });
    }
    if (!manual && job.budget?.maxPerDay != null && runs(e).n >= job.budget.maxPerDay) {
      log.warn?.(`[scheduler] ${job.id}: daily budget used, skipped`);
      planNext(e, now()); save(e); arm(e);
      return Promise.resolve({ skipped: true, budget: true });
    }
    e.running = true;
    e.lastError = null;
    e.lastRun = now();
    runs(e).n += 1;
    if (!manual) planNext(e, now()); // schedule the next before running, so a hang cannot stall the chain
    save(e);
    if (!manual) arm(e);
    const ac = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      let timeoutTimer = null;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimer(timeoutTimer);
        e.running = false;
        if (error) { e.lastError = error; log.warn?.(`[scheduler] ${job.id}: ${error}`); }
        resolve({ error: error ?? null });
        if (e.queued) { e.queued = false; if (jobs.get(job.id) === e) fire(e, true); }
      };
      if (job.timeoutMs) {
        timeoutTimer = unref(setTimer(() => { ac.abort(new Error('timeout')); finish(`timed out after ${job.timeoutMs} ms`); }, job.timeoutMs));
      }
      let p;
      try { p = Promise.resolve(job.run({ signal: ac.signal, now, id: job.id, log })); } catch (err) { p = Promise.reject(err); }
      p.then(() => finish(null), (err) => finish(String(err?.message ?? err)));
    });
  }

  return {
    add(job) {
      if (!job?.id || typeof job.run !== 'function') throw new Error('scheduler.add: job needs an id and a run function');
      const spec = parseSpec(job.schedule);
      this.remove(job.id);
      const e = { job: { overlap: 'skip', timeoutMs: 0, ...job }, spec, timer: null, running: false, queued: false, lastRun: null, nextDue: null, lastError: null, runs: null };
      jobs.set(job.id, e);
      if (started) { initialDue(e); save(e); arm(e); }
      return job.id;
    },
    remove(id) {
      const e = jobs.get(id);
      if (!e) return false;
      if (e.timer) clearTimer(e.timer);
      jobs.delete(id);
      return true;
    },
    start() {
      if (started) return;
      started = true;
      for (const e of jobs.values()) { initialDue(e); save(e); arm(e); }
    },
    stop() {
      started = false;
      for (const e of jobs.values()) { if (e.timer) clearTimer(e.timer); e.timer = null; }
    },
    runNow(id) {
      const e = jobs.get(id);
      if (!e) return Promise.reject(new Error(`scheduler: unknown job "${id}"`));
      return fire(e, true);
    },
    list() {
      return [...jobs.values()].map((e) => ({ id: e.job.id, schedule: e.job.schedule, lastRun: e.lastRun, nextDue: e.nextDue, running: e.running, lastError: e.lastError }));
    },
  };
}
