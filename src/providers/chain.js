import * as rl from './ratelimit.js';

// The model-chain executor: how a list of models of one provider is walked. Ported unchanged from the code that used to live in
// src/fresh/llm.js, with the pieces that depended on one gateway made generic:
//  - every non-paid model has its own request limit (ratelimit.js): a call WAITS for a slot instead of falling back to a paid model,
//    and a 429 pauses that model (for Retry-After, or a minute);
//  - a classifier chain tries the model with the most free capacity (plus the entry's `bonus` when everything is idle) and moves on
//    when one errors or times out;
//  - a chat chain is: the free model, waited for while it is busy; the paid model only when the free one failed for real.
// A chain entry is { model, timeoutMs?, bonus?, maxPerDay?, paid?, rpm? }. Errors carry `status` and `retryAfter` (see errors.js).
export const REST_MS = 60_000;

// A call to `model` under its limit: waits for a slot (RateWaitError when that would take longer than maxWaitMs), and a 429 pauses
// the model for Retry-After (or a minute). `unmetered`: the offline mock has no limits.
export async function limited(model, fn, maxWaitMs, unmetered = false) {
  if (unmetered) return fn();
  await rl.acquire(model, { maxWaitMs });
  try {
    return await fn();
  } catch (err) {
    if (err?.status === 429) rl.pause(model, err.retryAfter || 0, REST_MS);
    throw err;
  }
}

// The next model to try: among those not yet tried, the one with the most free capacity (plus a small preference for the entries
// with a bonus when everything is idle). When none has a free slot, the one that frees up first (the call then waits for it).
export function pickNext(chain, tried) {
  const open = chain.filter((m) => !tried.has(m.model));
  if (!open.length) return null;
  const free = open.filter((m) => rl.capacity(m.model) > 0);
  const bonus = (m) => m.bonus ?? 0;
  if (free.length) return free.reduce((best, m) => (rl.capacity(m.model) + bonus(m) > rl.capacity(best.model) + bonus(best) ? m : best));
  return open.reduce((best, m) => (rl.eta(m.model) < rl.eta(best.model) ? m : best));
}

// One classifier call, spread over the chain. onSuccess(model) / onFailure(err) feed the caller's counters.
export async function classifyOnce({ classify, chain, state, tasks, waitMs, unmetered = false, onSuccess, onFailure }) {
  let last = null;
  const tried = new Set();
  const t0 = rl.now();
  while (tried.size < chain.length && rl.now() - t0 < waitMs) {
    const next = pickNext(chain, tried);
    if (!next) break;
    const { model, timeoutMs } = next;
    tried.add(model);
    try {
      const answers = await limited(model, () => classify.classify({ state, tasks, model, timeoutMs }), Math.max(0, waitMs - (rl.now() - t0)), unmetered);
      onSuccess?.(model);
      return { answers, model };
    } catch (err) {
      if (err?.status === 429) tried.delete(model); // paused now: a later pick waits for it (or takes another) instead of giving up
      last = err;
      onFailure?.(err);
    }
  }
  throw last ?? new Error('every classifier model is resting');
}

// One chat call to a chain entry. maxWaitMs: how long to wait for a free slot (a paid entry has no limiter); a 429 throws with code
// 'rate429' after pausing the model.
export async function chatOnce(text, entry, { system, user, maxTokens, timeoutMs = 60_000, temperature = 0.3, maxWaitMs = 90_000 }, { unmetered = false } = {}) {
  const run = () => text.chat({ model: entry.model, maxTokens, temperature, reasoningEffort: 'none', timeoutMs, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  try {
    return (entry.paid ? await run() : await limited(entry.model, run, maxWaitMs, unmetered)).text;
  } catch (err) {
    if (err?.status === 429) {
      if (entry.paid) rl.pause(entry.model, err.retryAfter || 0, REST_MS);
      throw Object.assign(new Error(`${entry.model} 429`), { code: 'rate429' });
    }
    throw err;
  }
}

export const isLimit = (err) => err?.code === 'ratewait' || err?.code === 'rate429';

// The free entry, waiting while it is busy: a 429 or a full window is not a failure, the call goes again when the model is free,
// until `waitMs` has passed in all. Throws the limit error then (callers put the work off); other errors pass straight through.
export async function freeChat(text, entry, opts, waitMs, flags) {
  const t0 = rl.now();
  for (;;) {
    try { return await chatOnce(text, entry, { ...opts, maxWaitMs: Math.max(0, waitMs - (rl.now() - t0)) }, flags); }
    catch (err) {
      if (err?.code === 'rate429' && rl.now() - t0 < waitMs) continue; // the model is paused now: the next try waits for it
      throw err;
    }
  }
}
