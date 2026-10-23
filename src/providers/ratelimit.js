// Per-model request limiter for free chat models (about 25 requests a minute each; we stay at 20). A sliding window of the
// last 60 seconds per model: a call asks for a slot (`acquire`) and WAITS for it instead of firing and failing. A 429 (or a
// Retry-After) pauses that model. Waiting callers of one model are served in order. Metrics per model feed GET /api/fresh/status.
const WINDOW_MS = 60_000;
const HOUR_MS = 3_600_000;
const MAX_PAUSE_MS = 300_000;
export const DEFAULT_PER_MIN = 20;

export class RateWaitError extends Error {
  constructor(model, waitMs) { super(`${model} is rate limited (would wait ${Math.round(waitMs / 1000)}s)`); this.code = 'ratewait'; this.model = model; this.waitMs = waitMs; }
}

const envRate = Number(process.env.HERMES_WEB_FRESH_RPM);
let perMinDefault = envRate > 0 ? envRate : DEFAULT_PER_MIN;
const perMinOf = new Map(); // model -> own limit
let clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
export const setClock = (c) => { clock = { ...clock, ...c }; }; // tests: fake time
export const now = () => clock.now();
export const resetClock = () => { clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }; };
export const setPerMin = (n, model = '') => {
  const v = Math.max(1, Math.min(1000, Math.round(Number(n)) || DEFAULT_PER_MIN));
  if (model) perMinOf.set(model, v); else { perMinDefault = v; perMinOf.clear(); }
};
export const perMinLimit = (model) => perMinOf.get(model) ?? perMinDefault;

const states = new Map();
function st(model) {
  let s = states.get(model);
  if (!s) { s = { starts: [], events: [], pausedUntil: 0, tail: Promise.resolve(), pending: 0 }; states.set(model, s); }
  return s;
}
function prune(s, now) {
  while (s.starts.length && s.starts[0] <= now - WINDOW_MS) s.starts.shift();
  while (s.events.length && s.events[0].t <= now - HOUR_MS) s.events.shift();
}

// Milliseconds until a call to `model` could start (0 = now).
export function waitFor(model) {
  const s = st(model);
  const now = clock.now();
  prune(s, now);
  const limit = perMinLimit(model);
  const slot = s.starts.length >= limit ? s.starts[s.starts.length - limit] + WINDOW_MS - now : 0;
  return Math.max(0, s.pausedUntil - now, slot);
}
// Free slots right now (0 while paused).
export function capacity(model) {
  const s = st(model);
  const now = clock.now();
  prune(s, now);
  return s.pausedUntil > now ? 0 : Math.max(0, perMinLimit(model) - s.starts.length - s.pending);
}
// Rough wait for a call that asks now, counting those already queued behind the window (for choosing between models).
export function eta(model) {
  const s = st(model);
  const limit = perMinLimit(model);
  const backlog = s.starts.length + s.pending - limit + 1;
  return Math.max(waitFor(model), backlog > 0 ? (backlog * WINDOW_MS) / limit : 0);
}
export const isPaused = (model) => st(model).pausedUntil > clock.now();
export const pausedModels = () => [...states].filter(([, s]) => s.pausedUntil > clock.now()).map(([m]) => m);

// Takes a slot for `model`, waiting for it. Rejects with RateWaitError when the wait would exceed maxWaitMs (nothing is taken then).
// Resolves with the milliseconds waited.
export function acquire(model, { maxWaitMs = 90_000 } = {}) {
  const s = st(model);
  const t0 = clock.now();
  const run = async () => {
    for (;;) {
      const wait = waitFor(model);
      if (wait <= 0) {
        const now = clock.now();
        const cur = st(model);
        cur.starts.push(now);
        const waited = now - t0;
        cur.events.push({ t: now, kind: 'call', waited });
        return waited;
      }
      if (clock.now() - t0 + wait > maxWaitMs) throw new RateWaitError(model, clock.now() - t0 + wait);
      await clock.sleep(Math.min(wait, 5_000) + 1);
    }
  };
  s.pending += 1;
  const mine = s.tail.then(run, run);
  s.tail = mine.then(() => {}, () => {});
  const settled = () => { const cur = st(model); if (cur.pending > 0) cur.pending -= 1; };
  mine.then(settled, settled);
  return mine;
}

// The model said 429 (retryAfterSec from the header, if any): leave it alone for that long.
export function pause(model, retryAfterSec = 0, fallbackMs = WINDOW_MS) {
  const s = st(model);
  const now = clock.now();
  const ms = Math.min(MAX_PAUSE_MS, Math.max(1_000, retryAfterSec > 0 ? retryAfterSec * 1000 : fallbackMs));
  s.pausedUntil = Math.max(s.pausedUntil, now + ms);
  s.events.push({ t: now, kind: '429' });
  return ms;
}
export const unpause = (model) => { st(model).pausedUntil = 0; };

export function metrics(models = [...states.keys()]) {
  const now = clock.now();
  const out = {};
  for (const model of models) {
    const s = st(model);
    prune(s, now);
    const calls = s.events.filter((e) => e.kind === 'call');
    out[model] = {
      perMin: s.starts.length, limit: perMinLimit(model), calls1h: calls.length, r429_1h: s.events.length - calls.length,
      waitedMs1h: calls.reduce((n, e) => n + e.waited, 0), pausedS: Math.max(0, Math.ceil((s.pausedUntil - now) / 1000)),
    };
  }
  return out;
}

// Forget everything (tests, "clear resting").
export function reset() { states.clear(); }
