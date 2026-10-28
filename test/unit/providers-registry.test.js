// The registry, the built-in compat config, secret references, the llm-classifier and the catalog callers (models, pricing, usage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '../helpers/env.js';
import { startFakeGateway, startGateway, GW_KEY } from '../helpers/fake-gateway.js';
const compat = await import('../../src/providers/compat.js');
const { buildRegistry, secretResolver } = await import('../../src/providers/registry.js');
const { llmClassifier, buildPrompt, parseAnswers } = await import('../../src/providers/llm-classifier.js');
const { getModels } = await import('../../src/models.js');
const { priceOf, loadPrices } = await import('../../src/pricing.js');

const home = (env = '') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-agent-'));
  fs.writeFileSync(path.join(dir, '.env'), env);
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const agentOf = (provider, env, extra = {}) => ({ name: `a-${Math.random().toString(36).slice(2)}`, home: home(env), provider, model: 'chat-a', baseUrl: null, ...extra });

test('compat default: no providers without a config file, so every capability is null', () => {
  compat.setProviderConfig(null);
  const reg = compat.providersFor(agentOf('any-provider', 'GATEWAY_API_KEY=abc\n'));
  assert.deepEqual(reg.flags(), { writer: false, classifier: false, images: false, socialSearch: false, transcription: false, speech: false, models: false, usage: false });
  assert.equal(reg.get('writer'), null);
});

test('gatewayCapabilities binds every capability of one provider and a gateway offers them all', () => {
  compat.setProviderConfig({ providers: { gw: { type: 'mock-gateway', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'agentEnv:GATEWAY_API_KEY' } }, capabilities: compat.gatewayCapabilities('gw') });
  try {
    const reg = compat.providersFor(agentOf('any-provider', 'GATEWAY_API_KEY=abc\n'));
    assert.deepEqual(reg.flags(), { writer: true, classifier: true, images: true, socialSearch: true, transcription: true, speech: true, models: true, usage: false });
    assert.equal(reg.provider('writer').type, 'mock-gateway');
    assert.equal(reg.config('classifier').chain[0].model, 'jev-1-13:free');
    assert.equal(reg.config('writer').chain.find((e) => e.paid).maxPerDay, 200);
  } finally { compat.setProviderConfig(null); }
});

test('an explicit config replaces the compat default; an empty one resolves every capability to null', () => {
  compat.setProviderConfig({ providers: {}, capabilities: {} });
  try {
    const reg = compat.providersFor(agentOf('any-provider', 'GATEWAY_API_KEY=abc\n'));
    assert.ok(Object.values(reg.flags()).every((v) => v === false));
  } finally { compat.setProviderConfig(null); }
});

test('a capability bound to an unknown provider or one that cannot do it is null; a classifier is derived from a chat model', () => {
  const types = { 'openai-compatible': (id, c) => ({ id, text: { chat: async () => ({ text: '{}' }) } }), null: (id) => ({ id }) };
  const reg = buildRegistry({
    providers: { local: { type: 'openai-compatible' }, nothing: { type: 'null' }, weird: { type: 'nope' } },
    capabilities: { writer: { provider: 'local', chain: [{ model: 'm1' }] }, images: { provider: 'local' }, socialSearch: { provider: 'ghost' }, transcription: { provider: 'nothing' } },
  }, {}, types);
  assert.equal(typeof reg.get('writer').chat, 'function');
  assert.equal(reg.get('images'), null, 'the provider has no image capability');
  assert.equal(reg.get('socialSearch'), null, 'unknown provider');
  assert.equal(reg.get('transcription'), null, 'null provider');
  assert.equal(reg.get('models'), null, 'not configured');
  assert.equal(typeof reg.get('classifier').classify, 'function', 'derived from the writer\'s provider (llm-classifier)');
  assert.equal(reg.flags().classifier, true);
});

test('secret references: env, file inside the data directory, agentEnv; literals and path escapes are refused', () => {
  fs.writeFileSync(path.join(dataDir, 'a-key'), ' file-secret \n');
  process.env.HW_TEST_SECRET = 'env-secret';
  const secret = secretResolver({ dataDir, agentEnv: (n) => (n === 'K' ? 'agent-secret' : null) });
  assert.equal(secret('env:HW_TEST_SECRET'), 'env-secret');
  assert.equal(secret('file:a-key'), 'file-secret');
  assert.equal(secret('file:../outside'), null);
  assert.equal(secret('agentEnv:K'), 'agent-secret');
  assert.equal(secret('agentEnv:MISSING'), null);
  assert.equal(secret('sk-literal'), null);
  assert.equal(secretResolver({ dataDir, allowInlineSecrets: true })('sk-literal'), 'sk-literal');
  delete process.env.HW_TEST_SECRET;
});

// ---------- llm-classifier ----------
const TASKS = [
  { id: 'c:1', type: 'choice', item: 'New GPU driver', question: 'Which category?', options: { pcbuild: 'PC parts', ai: 'AI' } },
  { id: 'r:1', type: 'score', item: 'New GPU driver', question: 'How relevant?', scale: ['no', 'weak', 'yes'] },
  { id: 'b:1', type: 'bool', item: 'New GPU driver', question: 'A deal?', true: 'yes, a deal', false: 'no' },
];

test('llm-classifier: the prompt is the golden shape (system rules plus a compact JSON task list)', () => {
  const { system, user } = buildPrompt('a PC gamer', TASKS);
  assert.equal(system, [
    'You are a careful classifier. Reply with ONLY one JSON object that maps every task id to its answer, no commentary.',
    'Task types:',
    '- "choice": the answer is the KEY of the option that fits best (one of the keys in "options").',
    '- "score": the answer is an integer, the 0-based position of the label in "scale" that fits best.',
    '- "bool": the answer is a number from 0 to 1, the probability that the answer is yes ("true" describes yes, "false" describes no).',
    'Context: a PC gamer',
  ].join('\n'));
  assert.equal(user, JSON.stringify([
    { id: 'c:1', type: 'choice', item: 'New GPU driver', question: 'Which category?', options: { pcbuild: 'PC parts', ai: 'AI' } },
    { id: 'r:1', type: 'score', item: 'New GPU driver', question: 'How relevant?', scale: ['no', 'weak', 'yes'] },
    { id: 'b:1', type: 'bool', item: 'New GPU driver', question: 'A deal?', true: 'yes, a deal', false: 'no' },
  ]));
});

test('llm-classifier: parses answers, clamps, ignores unknown choices and surrounding prose', () => {
  assert.deepEqual(parseAnswers('Sure!\n```json\n{"c:1":"pcbuild","r:1":2,"b:1":0.9}\n```', TASKS), { 'c:1': { choice: 'pcbuild' }, 'r:1': { score: 2 }, 'b:1': { p: 0.9 } });
  assert.deepEqual(parseAnswers('{"c:1":"cooking","r:1":9,"b:1":true}', TASKS), { 'r:1': { score: 2 }, 'b:1': { p: 1 } });
  assert.deepEqual(parseAnswers('{"c:1":{"answer":"ai"},"r:1":-3,"b:1":false}', TASKS), { 'c:1': { choice: 'ai' }, 'r:1': { score: 0 }, 'b:1': { p: 0 } });
  assert.throws(() => parseAnswers('no json here', TASKS), /without JSON/);
});

test('llm-classifier: asks the chat model once for all tasks and rejects an answer with nothing usable', async () => {
  const seen = [];
  const text = { chat: async (req) => { seen.push(req); return { text: '{"c:1":"ai","r:1":1,"b:1":0.1}' }; } };
  const c = llmClassifier(text, { model: 'small' });
  assert.deepEqual(await c.classify({ state: 's', tasks: TASKS }), { 'c:1': { choice: 'ai' }, 'r:1': { score: 1 }, 'b:1': { p: 0.1 } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, 'small');
  assert.equal(seen[0].temperature, 0);
  assert.equal(seen[0].messages[1].content, buildPrompt('s', TASKS).user);
  const empty = llmClassifier({ chat: async () => ({ text: '{}' }) }, { model: 'small' });
  await assert.rejects(empty.classify({ tasks: TASKS }), /small no answers/);
  assert.ok(c.maxTasksPerCall > 0 && c.maxTasksPerCall < 150);
});

// ---------- the catalog callers ----------
test('models and pricing go through the catalog of the agent\'s provider', async () => {
  const gw = await startGateway(compat);
  try {
    const agent = agentOf('any-provider', `GATEWAY_API_KEY=${GW_KEY}\n`);
    const out = await getModels(agent);
    assert.deepEqual(out.current, { provider: 'any-provider', model: 'chat-a' });
    assert.deepEqual(out.serviceTiers, ['default']);
    assert.deepEqual(out.models.map((m) => m.id).sort(), ['chat-a', 'chat-b']);
    const a = out.models.find((m) => m.id === 'chat-a');
    assert.deepEqual(Object.keys(a), ['id', 'provider', 'reasoning', 'contextWindow', 'modalities', 'hidden', 'price', 'quota', 'note']);
    assert.equal(a.price.currency, 'USD');
    await loadPrices(agent);
    assert.equal(priceOf(agent, 'chat-b').outputPerM, 2);
    assert.equal(priceOf(agent, 'chat-b').currency, 'USD');
  } finally { compat.setProviderConfig(null); await gw.close(); }
});

test('a configured openai-compatible catalog serves the model list and prices of an agent that is not on the main gateway', async () => {
  const gw = await startFakeGateway();
  try {
    compat.setProviderConfig({ providers: { local: { type: 'openai-compatible', baseUrl: gw.url, apiKey: 'env:HW_LOCAL_KEY' } }, capabilities: { models: { provider: 'local' } } });
    process.env.HW_LOCAL_KEY = GW_KEY;
    const agent = agentOf('local-llm', '');
    const out = await getModels(agent);
    assert.deepEqual(out.models.map((m) => m.id), ['chat-a', 'chat-b']);
    assert.equal(out.models[0].price.currency, 'USD');
    await loadPrices(agent);
    assert.ok(Math.abs(priceOf(agent, 'chat-a').inputPerM - 1.5) < 1e-9);
  } finally { compat.setProviderConfig(null); delete process.env.HW_LOCAL_KEY; await gw.close(); }
});
