// The offline mock (HERMES_WEB_FRESH_OFFLINE=1) answers through the provider layer: the compat default binds Fresh's classifier
// and writer to the gateway, and the fake transport answers in the real shapes. This is the path the rest of the test suite and
// the sandbox use, so it must keep producing model-shaped answers without a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const llm = await import('../../src/fresh/llm.js');
const compat = await import('../../src/providers/compat.js');
const store = await import('../../src/fresh/store.js');

const agent = { name: 'offline-agent', provider: 'gateway', model: 'chat-a', baseUrl: null, home: '/nonexistent' };
const batch = () => [{ id: 'a1', title: 'A new model is out', sourceName: 'Example', text: 'The model is cheaper and has a larger context window.' }];

test('offline: triage answers through the mock classifier and the writer writes a card, untranslated by a real model', async () => {
  compat.setProviderConfig(null);
  store.kvSet('llm-usage', null);
  const verdicts = await llm.triage(agent, [{ id: 'a1', title: 'New NVIDIA GPU driver improves benchmark performance', snippet: '', cat: 'pcbuild' }]);
  const v = verdicts.get('a1');
  assert.equal(v.by, 'model', 'the mock answered, so the model path was used');
  assert.equal(typeof v.rel, 'number');

  const done = await llm.writeCards(agent, batch(), { rules: new Map() });
  const card = done.get('a1');
  assert.equal(card.path, 'free');
  assert.match(card.summary, /offline mock model/, 'the mock writer answered');
  assert.ok(card.title_local.length > 0);
  const u = llm.llmUsage(agent);
  assert.equal(u.free, 1);
  assert.equal(u.paid, 0);
});

test('offline: the mock has no quota, so no slot is taken and no model is paused', async () => {
  compat.setProviderConfig(null);
  const before = llm.llmUsage(agent).models;
  await llm.systemOne(agent, { q: { type: 'noul', instructions: { item: 'x', question: 'y' }, criteria: { true: 'yes', false: 'no' } } });
  const after = llm.llmUsage(agent).models;
  assert.deepEqual(llm.restingModels(), []);
  assert.equal(after['jev-1-13:free'].perMin, before['jev-1-13:free']?.perMin ?? 0, 'the mock call took no slot');
});
