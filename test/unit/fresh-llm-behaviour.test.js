// Characterization tests for the tuned behaviour of Fresh's model calls (src/fresh/llm.js). They were written against the
// code before it was routed through the provider layer and must keep passing after it, so the model chain, the per-model
// limiter, the 429 pause, the idle preference, the paid cap, the wait times and the writer chain stay as they are.
//
// The gateway is a local fake (test/helpers/fake-gateway.js); time is a fake clock in src/providers/ratelimit.js, so no test
// waits a real minute. The providers point at the fake gateway, which is also what the
// built-in compat provider config binds to, so the same tests run before and after the refactor.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/env.js';
import { startFakeGateway, startGateway, GW_KEY } from '../helpers/fake-gateway.js';

// These tests talk to the local fake gateway instead of the offline mock that helpers/env.js switches on.
process.env.HERMES_WEB_FRESH_OFFLINE = '0';

const llm = await import('../../src/fresh/llm.js');
const store = await import('../../src/fresh/store.js');
const rl = await import('../../src/providers/ratelimit.js');
const compat = await import('../../src/providers/compat.js');

const FREE = 'deepseek-v4-1-flash:free';
const PAID = 'deepseek-v4-1-flash';
const clock = { t: 1_700_000_000_000, sleeps: [] };

const agentOf = (baseUrl) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-llm-'));
  fs.writeFileSync(path.join(home, '.env'), `GATEWAY_API_KEY=${GW_KEY}\n`);
  process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
  return { name: `llm-${Math.random().toString(36).slice(2, 8)}`, home, provider: 'gateway', model: 'chat-a', baseUrl };
};

const dayKey = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const usage = (patch = {}) => ({
  day: dayKey(), s1: {}, s1Fail: 0, free: 0, paid: 0, rejected: 0, writeErrors: 0, written: 0,
  paidDueToLimit: 0, paidDueToQuality: 0, paidDueToError: 0, deferredByLimit: 0, ...patch,
});

const CARD = { title: 'New AI model released at a lower price', summary: 'The model brings a larger context window and a lower price per token for API users.', why: 'The lower price makes experiments cheaper.', topics: ['llm', 'api'], substance: true };
const card = (patch = {}) => JSON.stringify([{ id: 'a1', ...CARD, ...patch }]);
const paidCard = () => JSON.stringify([{ id: 'a1', ...CARD, title: 'PAID rewrite of the story', why: 'PAID why.' }]);
const batch = () => [{ id: 'a1', title: 'A new model is out', sourceName: 'Example', text: 'The model is cheaper and has a larger context window.' }];

const answerSystemOne = (req) => {
  const answers = {};
  for (const [id, q] of Object.entries(req.body.questions ?? {})) {
    answers[id] = q.type === 'choice' ? { type: 'choice', choice: Object.keys(q.criteria)[0] } : q.type === 'score' ? { type: 'score', score: q.criteria.length - 1 } : { type: 'bool', p: 0.9 };
  }
  return { status: 200, body: { answers } };
};

// Sends every classifier question to the gateway but counts which model answered.
const classifier = (gw, answer = answerSystemOne) => {
  const seen = [];
  gw.handlers['POST /classify'] = (req) => { seen.push(req.body.model); return answer(req); };
  return seen;
};
// The writer answers per model; a function gets the request body and may return { status, body } instead of text.
const writer = (gw, byModel) => {
  const seen = [];
  gw.handlers['POST /chat/completions'] = (req) => {
    seen.push(req.body.model);
    const out = byModel[req.body.model];
    if (typeof out === 'function') return out(req);
    return { status: 200, body: { choices: [{ message: { content: out ?? '[]' } }] } };
  };
  return seen;
};

beforeEach(() => {
  compat.setProviderConfig(null);
  compat.setTransport(null);
  rl.reset();
  clock.t = 1_700_000_000_000;
  clock.sleeps = [];
  rl.setClock({ now: () => clock.t, sleep: async (ms) => { clock.sleeps.push(ms); clock.t += ms; } });
  store.kvSet('llm-usage', null);
});

afterEach(() => {
  rl.resetClock();
  rl.reset();
  compat.setProviderConfig(null);
  compat.setTransport(null);
});

async function withGateway(fn, opts = { extras: true }) {
  const gw = await startGateway(compat, opts);
  try { return await fn(gw, agentOf(gw.url)); } finally { await gw.close(); }
}

// ---------- classifier chain ----------
test('classifier chain: the idle preference answers with jev first, a 500 falls over to clef and is counted', async () => {
  await withGateway(async (gw, agent) => {
    const seen = classifier(gw, (req) => (req.body.model.startsWith('jev') ? { status: 500, body: {} } : answerSystemOne(req)));
    const out = await llm.systemOne(agent, { q: { type: 'noul', instructions: { item: 'x', question: 'y' }, criteria: { true: 'yes', false: 'no' } } });
    assert.deepEqual(seen, ['jev-1-13:free', 'clef:free']);
    assert.equal(out.q.noul, 0.9);
    const u = llm.llmUsage();
    assert.equal(u.s1['clef:free'], 1);
    assert.equal(u.s1Fail, 1);
  });
});

test('classifier chain: a 429 pauses that model for Retry-After and the next call takes another model', async () => {
  await withGateway(async (gw, agent) => {
    let jev429 = true;
    const seen = classifier(gw, (req) => {
      if (req.body.model.startsWith('jev') && jev429) { jev429 = false; return { status: 429, body: {}, headers: { 'Retry-After': '30' } }; }
      return answerSystemOne(req);
    });
    const q = { q: { type: 'noul', instructions: { item: 'x', question: 'y' }, criteria: { true: 'yes', false: 'no' } } };
    assert.equal((await llm.systemOne(agent, q)).q.noul, 0.9);
    assert.deepEqual(llm.restingModels(), ['jev-1-13:free']);
    await llm.systemOne(agent, q);
    assert.deepEqual(seen, ['jev-1-13:free', 'clef:free', 'clef:free'], 'the paused model is not tried again');
    clock.t += 31_000;
    await llm.systemOne(agent, q);
    assert.equal(seen.at(-1), 'jev-1-13:free', 'the pause ends after Retry-After');
  });
});

test('classifier chain: with every model failing, triage falls back to the keyword heuristic without throwing', async () => {
  await withGateway(async (gw, agent) => {
    classifier(gw, () => ({ status: 500, body: {} }));
    const verdicts = await llm.triage(agent, [{ id: 'a1', title: 'New NVIDIA GPU driver improves benchmark performance', snippet: '', cat: 'pcbuild' }]);
    const v = verdicts.get('a1');
    assert.equal(v.by, 'words');
    assert.ok(v.rel >= 0 && v.rel <= 1);
    assert.equal(typeof v.ban, 'number');
    assert.equal(llm.llmUsage().s1Fail >= 3, true);
  });
});

test('classifier answers become the triage shape (category, relevance, bans)', async () => {
  await withGateway(async (gw, agent) => {
    gw.handlers['POST /classify'] = (req) => {
      const answers = {};
      for (const [id, q] of Object.entries(req.body.questions)) {
        if (id.startsWith('c:')) answers[id] = { type: 'choice', choice: 'ai' };
        else if (id.startsWith('r:')) answers[id] = { type: 'score', score: 4 };
        else if (id.startsWith('b:')) answers[id] = { type: 'bool', p: 0.1 };
        else answers[id] = { type: 'bool', p: 0.8 };
      }
      return { status: 200, body: { answers } };
    };
    const v = (await llm.triage(agent, [{ id: 'a1', title: 'New model release', snippet: '', cat: 'ai' }])).get('a1');
    assert.deepEqual(v, { cat: 'ai', rel: 1, ban: 0.1, news: 0.8, info: 0.8, by: 'model' });
  });
});

// ---------- writer chain ----------
test('writer: a full per-minute window on the free model is waited out, never replaced by the paid model', async () => {
  await withGateway(async (gw, agent) => {
    classifier(gw);
    const seen = writer(gw, { [FREE]: card(), [PAID]: paidCard() });
    for (let i = 0; i < 20; i += 1) await rl.acquire(FREE);
    assert.equal(rl.capacity(FREE), 0);
    const done = await llm.writeCards(agent, batch(), { rules: new Map() });
    assert.deepEqual(seen, [FREE], 'the paid model is not called');
    assert.equal(done.get('a1').path, 'free');
    assert.notEqual(done.get('a1').title_local, 'PAID rewrite of the story');
    assert.ok(clock.sleeps.length > 0, 'the call waited for the window');
    assert.equal(llm.llmUsage().free, 1);
  });
});

test('writer: a wait longer than the writer limit defers the batch for the next round and pays nothing', async () => {
  await withGateway(async (gw, agent) => {
    classifier(gw);
    const seen = writer(gw, { [FREE]: card(), [PAID]: paidCard() });
    rl.pause(FREE, 0, 200_000);
    const done = await llm.writeCards(agent, batch(), { rules: new Map() });
    assert.deepEqual([...done.deferred], ['a1']);
    assert.equal(done.size, 0);
    assert.deepEqual(seen, [], 'neither model was called');
    const u = llm.llmUsage();
    assert.equal(u.deferredByLimit, 1);
    assert.equal(u.paid, 0);
  });
});

test('writer: a 429 on the free model is waited out and the retry still uses the free model', async () => {
  await withGateway(async (gw, agent) => {
    classifier(gw);
    let first = true;
    const seen = writer(gw, {
      [FREE]: () => {
        if (!first) return { status: 200, body: { choices: [{ message: { content: card() } }] } };
        first = false;
        return { status: 429, body: {}, headers: { 'Retry-After': '30' } };
      },
      [PAID]: paidCard(),
    });
    const done = await llm.writeCards(agent, batch(), { rules: new Map() });
    assert.deepEqual(seen, [FREE, FREE]);
    assert.equal(done.get('a1').path, 'free');
    assert.ok(clock.sleeps.length > 0);
  });
});

test('writer: a real error from the free model sends the batch to the paid model', async () => {
  await withGateway(async (gw, agent) => {
    classifier(gw);
    const seen = writer(gw, { [FREE]: () => ({ status: 500, body: {} }), [PAID]: paidCard() });
    const done = await llm.writeCards(agent, batch(), { rules: new Map() });
    assert.deepEqual(seen, [FREE, PAID]);
    assert.equal(done.get('a1').path, 'paid');
    assert.equal(done.get('a1').title_local, 'PAID rewrite of the story');
    const u = llm.llmUsage();
    assert.equal(u.writeErrors, 1);
    assert.equal(u.paid, 1);
    assert.equal(u.paidDueToError, 1);
  });
});

test('writer: the free model writes, System One checks the card, and only a rejected card goes to the paid model', async () => {
  await withGateway(async (gw, agent) => {
    // A hype word fails the cheap plain checks, so the card is not sent to the quality check at all.
    const seen = writer(gw, { [FREE]: card({ why: 'This is game-changing and revolutionary.' }), [PAID]: paidCard() });
    classifier(gw);
    const done = await llm.writeCards(agent, batch(), { rules: new Map() });
    assert.deepEqual(seen, [FREE, PAID]);
    assert.equal(done.get('a1').path, 'paid');
    assert.equal(llm.llmUsage().paidDueToQuality, 1);
  });
});

test('writer: a card System One rates badly goes to the paid model', async () => {
  await withGateway(async (gw, agent) => {
    const seen = writer(gw, { [FREE]: card(), [PAID]: paidCard() });
    classifier(gw, (req) => {
      const answers = {};
      for (const [id, q] of Object.entries(req.body.questions)) answers[id] = id.startsWith('ok:') ? { type: 'bool', p: 0.1 } : { type: 'bool', p: 0.9 };
      return { status: 200, body: { answers } };
    });
    const done = await llm.writeCards(agent, batch(), { rules: new Map() });
    assert.deepEqual(seen, [FREE, PAID]);
    assert.equal(done.get('a1').path, 'paid');
    assert.equal(llm.llmUsage().paidDueToQuality, 1);
    assert.equal(llm.llmUsage().rejected, 1);
  });
});

test('writer: a card System One accepts stays with the free model', async () => {
  await withGateway(async (gw, agent) => {
    const seen = writer(gw, { [FREE]: card(), [PAID]: paidCard() });
    classifier(gw);
    const done = await llm.writeCards(agent, batch(), { rules: new Map() });
    assert.deepEqual(seen, [FREE]);
    assert.equal(done.get('a1').path, 'free');
    assert.equal(llm.llmUsage().paid, 0);
  });
});

test('writer: the paid daily cap stops the paid model; the free daily allowance sends the batch to it', async () => {
  await withGateway(async (gw, agent) => {
    classifier(gw);
    let seen = writer(gw, { [FREE]: () => ({ status: 500, body: {} }), [PAID]: paidCard() });
    store.kvSet('llm-usage', usage({ paid: 200 }));
    const done = await llm.writeCards(agent, batch(), { rules: new Map() });
    assert.deepEqual(seen, [FREE], 'the paid model is over its cap');
    assert.equal(done.size, 0);

    store.kvSet('llm-usage', usage({ free: 3000 }));
    seen = writer(gw, { [FREE]: card(), [PAID]: paidCard() });
    const out = await llm.writeCards(agent, batch(), { rules: new Map() });
    assert.deepEqual(seen, [PAID], 'the free allowance is used up, so the paid model writes');
    assert.equal(out.get('a1').path, 'paid');
    assert.equal(llm.llmUsage().paidDueToLimit, 1);
  });
});

// ---------- chatChain (dedupe, threads) ----------
test('chatChain: the free model answers; a limit defers the job instead of paying for it', async () => {
  await withGateway(async (gw, agent) => {
    const seen = writer(gw, { [FREE]: '[]', [PAID]: '[]' });
    const out = await llm.chatChain(agent, { system: 's', user: 'u' }, (text) => JSON.parse(text));
    assert.deepEqual(out, []);
    assert.deepEqual(seen, [FREE]);

    rl.pause(FREE, 0, 60_000);
    await assert.rejects(llm.chatChain(agent, { system: 's', user: 'u' }, (text) => JSON.parse(text)), (e) => e.code === 'ratewait');
    assert.deepEqual(seen, [FREE], 'a busy free model never becomes a paid call');
    assert.equal(llm.llmUsage().deferredByLimit, 1);
  });
});

test('chatChain: an answer the parser refuses is paid for once, and the paid cap is honoured', async () => {
  await withGateway(async (gw, agent) => {
    const seen = writer(gw, { [FREE]: 'not json', [PAID]: '[]' });
    assert.deepEqual(await llm.chatChain(agent, { system: 's', user: 'u' }, (text) => JSON.parse(text)), []);
    assert.deepEqual(seen, [FREE, PAID]);
    assert.equal(llm.llmUsage().paidDueToError, 1);

    store.kvSet('llm-usage', usage({ paid: 200 }));
    seen.length = 0;
    await assert.rejects(llm.chatChain(agent, { system: 's', user: 'u' }, (text) => JSON.parse(text)), /paid cap reached/);
    assert.deepEqual(seen, [FREE]);
  });
});

// ---------- counters ----------
test('the usage counters are kept under the deployment day key', async () => {
  assert.equal(llm.llmUsage().day, dayKey());
  assert.equal(llm.llmUsage().perMinLimit, 20);
  assert.equal(typeof llm.llmUsage().models, 'object');
});
