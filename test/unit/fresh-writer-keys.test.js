// Writer output parsing: the JSON keys are {id, title, summary, why, topics, substance}. Goes through the
// writer against the local fake.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/env.js';
import { startFakeGateway, startGateway, GW_KEY } from '../helpers/fake-gateway.js';

process.env.HERMES_WEB_FRESH_OFFLINE = '0';

const llm = await import('../../src/fresh/llm.js');
const store = await import('../../src/fresh/store.js');
const rl = await import('../../src/providers/ratelimit.js');
const compat = await import('../../src/providers/compat.js');

const FREE = 'deepseek-v4-1-flash:free';
const agentOf = (baseUrl) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-parse-'));
  fs.writeFileSync(path.join(home, '.env'), `GATEWAY_API_KEY=${GW_KEY}\n`);
  process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
  return { name: `parse-${Math.random().toString(36).slice(2, 8)}`, home, provider: 'gateway', model: 'chat-a', baseUrl };
};

const batch = () => [{ id: 'a1', title: 'A new model is out', sourceName: 'Example', text: 'The model is cheaper and has a larger context window.' }];
const NEW = { id: 'a1', title: 'A new model with a larger context window', summary: 'The model is cheaper and has a larger context window for every user of the API.', why: 'Cheaper experiments.', topics: ['llm', 'api'], substance: true };

const run = async (card) => {
  const gw = await startGateway(compat);
  try {
    gw.handlers['POST /chat/completions'] = () => ({ status: 200, body: { choices: [{ message: { content: JSON.stringify([card]) } }] } });
    gw.handlers['POST /classify'] = (req) => {
      const answers = {};
      for (const id of Object.keys(req.body.questions ?? {})) answers[id] = { type: 'bool', p: 0.9 };
      return { status: 200, body: { answers } };
    };
    return await llm.writeCards(agentOf(gw.url), batch(), { rules: new Map() });
  } finally {
    await gw.close();
  }
};

beforeEach(() => {
  compat.setProviderConfig(null);
  compat.setTransport(null);
  rl.reset();
  store.kvSet('llm-usage', null);
});

afterEach(() => {
  rl.reset();
  compat.setProviderConfig(null);
  compat.setTransport(null);
});

test('the current keys produce the card', async () => {
  const done = await run(NEW);
  const card = done.get('a1');
  assert.equal(card.title_local, NEW.title);
  assert.equal(card.summary, NEW.summary);
  assert.equal(card.why, NEW.why);
  assert.deepEqual(card.topics, NEW.topics);
  assert.equal(card.path, 'free');
});

test('a card with none of the expected keys is ignored, not crashed on', async () => {
  const done = await run({ id: 'a1', something: 'else' });
  assert.equal(done.size, 0);
});

test('substance false is read from the card', async () => {
  const current = await run({ ...NEW, substance: false });
  assert.equal(current.get('a1').substance, false);
});
