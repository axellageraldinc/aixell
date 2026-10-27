// The effort the owner picked must reach the server, whatever kind of catalogue the agent has.
//
// A plain catalogue says which of its models can think, so an effort is only sent for those. A routed gateway
// (xellter) resolves the real model per request and its catalogue entry carries no such flag: the effort used to
// be dropped in the browser and the gateway never heard about the choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// public/lib/state.js reads matchMedia at import time (the Back button).
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { state, sessionKey } = await import('../../public/lib/state.js');
const { chatOptions } = await import('../../public/lib/models.js');

const catalogue = (models, extra = {}) => ({
  models: models.map((m) => ({ id: m.id, reasoning: m.reasoning })),
  current: { model: models[0].id, provider: 'gw' },
  ...extra,
});

test('a routed agent sends the effort the owner chose', () => {
  state.models = catalogue([{ id: 'xellter', reasoning: false }], { routed: true, defaultEffort: 'none' });
  assert.equal(chatOptions().reasoningEffort, 'none', 'the route has no reasoning flag, but the effort still goes');
});

test('a routed agent sends the effort of this chat over the default', () => {
  state.models = catalogue([{ id: 'xellter', reasoning: false }], { routed: true, defaultEffort: 'none' });
  state.settings.set(sessionKey(state.agent, state.sessionId), { reasoningEffort: 'high' });
  assert.equal(chatOptions().reasoningEffort, 'high');
  state.settings.clear();
});

test('a plain catalogue sends the effort only for a model that can think', () => {
  state.models = catalogue([{ id: 'thinker', reasoning: true }], { defaultEffort: 'medium' });
  assert.equal(chatOptions().reasoningEffort, 'medium');

  state.models = catalogue([{ id: 'plain', reasoning: false }], { defaultEffort: 'medium' });
  assert.equal(chatOptions().reasoningEffort, undefined, 'a model that cannot think has no effort to set');
});
