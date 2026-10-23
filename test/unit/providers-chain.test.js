// The chain executor (src/providers/chain.js): the model-walking rules that src/fresh/llm.js relies on, tested on their own.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const chain = await import('../../src/providers/chain.js');
const rl = await import('../../src/providers/ratelimit.js');

const clock = { t: 1_700_000_000_000, sleeps: [] };
beforeEach(() => {
  rl.reset();
  clock.t = 1_700_000_000_000;
  clock.sleeps = [];
  rl.setClock({ now: () => clock.t, sleep: async (ms) => { clock.sleeps.push(ms); clock.t += ms; } });
});
afterEach(() => { rl.resetClock(); rl.reset(); });

const CHAIN = [{ model: 'a', timeoutMs: 1000, bonus: 6 }, { model: 'b', timeoutMs: 1000, bonus: 3 }, { model: 'c', timeoutMs: 1000, bonus: 0 }];

const fill = async (model, n = 20) => { for (let i = 0; i < n; i += 1) await rl.acquire(model); };

test('pickNext: the idle preference takes the entry with the bonus, then the one with more room', async () => {
  assert.equal(chain.pickNext(CHAIN, new Set()).model, 'a');
  await rl.acquire('a');
  assert.equal(chain.pickNext(CHAIN, new Set()).model, 'a', 'a has 19 slots left and still the bonus');
  await fill('a', 19); // a is now full (20)
  assert.equal(chain.pickNext(CHAIN, new Set()).model, 'b');
  assert.equal(chain.pickNext(CHAIN, new Set(['a', 'b'])).model, 'c');
  assert.equal(chain.pickNext(CHAIN, new Set(['a', 'b', 'c'])), null, 'nothing left to try');
});

test('pickNext: when every model is full, the one that frees up first is chosen', async () => {
  await fill('b');
  await fill('c');
  clock.t += 5_000;
  await fill('a'); // a's window frees up last
  assert.equal(chain.pickNext(CHAIN, new Set()).model, 'b', 'b and c free up first; the earlier entry wins the tie');
});

test('limited: a full window is waited out, and a 429 pauses the model for Retry-After', async () => {
  await fill('a');
  let calls = 0;
  const value = await chain.limited('a', async () => { calls += 1; return 'ok'; }, 90_000);
  assert.equal(value, 'ok');
  assert.equal(calls, 1);
  assert.ok(clock.sleeps.length > 0, 'it waited for a slot');

  await assert.rejects(chain.limited('b', async () => { throw Object.assign(new Error('b 429'), { status: 429, retryAfter: 30 }); }, 90_000), (e) => e.status === 429);
  assert.deepEqual(rl.pausedModels(), ['b']);
  assert.equal(rl.isPaused('b'), true);
  clock.t += 31_000;
  assert.equal(rl.isPaused('b'), false);
});

test('limited: a wait longer than maxWaitMs rejects with ratewait and takes no slot', async () => {
  rl.pause('a', 0, 200_000);
  const before = rl.capacity('a');
  await assert.rejects(chain.limited('a', async () => 'never', 90_000), (e) => e.code === 'ratewait');
  assert.equal(rl.capacity('a'), before);
  assert.equal(clock.sleeps.length, 0, 'no waiting was attempted');
});

test('classifyOnce: a failing model falls over, a 429 is retried after its pause, and counters see every attempt', async () => {
  const seen = [];
  const ok = [];
  const failed = [];
  const classifier = {
    maxTasksPerCall: 10,
    async classify({ model }) {
      seen.push(model);
      if (model === 'a') throw Object.assign(new Error('a 500'), { status: 500 });
      if (model === 'b') throw Object.assign(new Error('b 429'), { status: 429, retryAfter: 5 });
      return { q: { p: 1 } };
    },
  };
  const out = await chain.classifyOnce({ classify: classifier, chain: CHAIN, state: '', tasks: [], waitMs: 90_000, onSuccess: (m) => ok.push(m), onFailure: () => failed.push(1) });
  assert.deepEqual(out.answers, { q: { p: 1 } });
  assert.deepEqual(seen, ['a', 'b', 'c'], 'the failing model and the paused one are skipped');
  assert.deepEqual(ok, ['c']);
  assert.equal(failed.length, 2);
  // b was paused by the 429, so a later call waits for it instead of failing straight away.
  assert.equal(rl.isPaused('b'), true);
});

test('classifyOnce: with every model refusing, the last error is thrown', async () => {
  const classifier = { maxTasksPerCall: 1, async classify({ model }) { throw Object.assign(new Error(`${model} 500`), { status: 500 }); } };
  await assert.rejects(chain.classifyOnce({ classify: classifier, chain: CHAIN, state: '', tasks: [], waitMs: 90_000 }), /c 500/);
});

test('classifyOnce: unmetered calls take no slot (the offline mock has no quota)', async () => {
  await fill('a');
  const classifier = { maxTasksPerCall: 1, async classify() { return { q: { p: 1 } }; } };
  const out = await chain.classifyOnce({ classify: classifier, chain: CHAIN, state: '', tasks: [], waitMs: 90_000, unmetered: true });
  assert.deepEqual(out.answers, { q: { p: 1 } });
  assert.equal(clock.sleeps.length, 0);
});

test('chatOnce: a paid entry has no limiter; a 429 pauses it and throws rate429', async () => {
  await fill('free');
  const seen = [];
  const text = { chat: async ({ model }) => { seen.push(model); return { text: `answer:${model}` }; } };
  assert.equal(await chain.chatOnce(text, { model: 'free' }, { system: 's', user: 'u' }, { unmetered: false }), 'answer:free');
  assert.ok(clock.sleeps.length > 0, 'the free entry waited for its window');
  assert.equal(await chain.chatOnce(text, { model: 'paid', paid: true }, { system: 's', user: 'u' }), 'answer:paid');

  const refusing = { chat: async () => { throw Object.assign(new Error('paid 429'), { status: 429, retryAfter: 20 }); } };
  await assert.rejects(chain.chatOnce(refusing, { model: 'paid2', paid: true }, { system: 's', user: 'u' }), (e) => e.code === 'rate429' && e.message === 'paid2 429');
  assert.deepEqual(rl.pausedModels(), ['paid2']);
  assert.deepEqual(seen, ['free', 'paid']);
});

test('chatOnce: the request is the tuned writer shape (system, user, no reasoning effort for a plain model)', async () => {
  const seen = [];
  const text = { chat: async (req) => { seen.push(req); return { text: 'ok' }; } };
  await chain.chatOnce(text, { model: 'm' }, { system: 'S', user: 'U', maxTokens: 123, temperature: 0.3, timeoutMs: 5000 });
  assert.deepEqual(seen[0], {
    model: 'm', maxTokens: 123, temperature: 0.3, reasoningEffort: 'none', timeoutMs: 5000,
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
  });
});

test('freeChat: a 429 is retried while the wait allows it, then the limit error is thrown', async () => {
  let calls = 0;
  const text = {
    chat: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('m 429'), { status: 429, retryAfter: 10 });
      return { text: 'second' };
    },
  };
  assert.equal(await chain.freeChat(text, { model: 'm' }, { system: 's', user: 'u' }, 30_000), 'second');
  assert.equal(calls, 2);

  const always = { chat: async () => { throw Object.assign(new Error('m 429'), { status: 429, retryAfter: 40 }); } };
  await assert.rejects(chain.freeChat(always, { model: 'm2' }, { system: 's', user: 'u' }, 30_000), (e) => e.code === 'ratewait' || e.code === 'rate429');
});

test('isLimit recognises the two limiter errors and nothing else', () => {
  assert.equal(chain.isLimit({ code: 'ratewait' }), true);
  assert.equal(chain.isLimit({ code: 'rate429' }), true);
  assert.equal(chain.isLimit({ status: 429 }), false);
  assert.equal(chain.isLimit(new Error('x')), false);
  assert.equal(chain.isLimit(null), false);
});
