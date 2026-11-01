// "Share as story": short exchanges pass through untouched, long ones are shortened by the writer, and a missing or broken
// model falls back to a clean cut. No real model is called: the offline mock and a fake transport answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const { storyText, clip, LIMITS } = await import('../../src/story.js');
const compat = await import('../../src/providers/compat.js');

const agent = { name: 'story-agent', provider: 'gateway', model: 'chat-a', baseUrl: null, home: '/nonexistent' };

test('a short exchange is returned as plain text without asking a model', async () => {
  compat.setProviderConfig({ providers: {}, capabilities: {} });
  const out = await storyText(agent, { prompt: 'What is **Node**?', reply: 'A JavaScript runtime.\n\n```js\nx\n```' });
  assert.deepEqual(out, { prompt: 'What is Node?', reply: 'A JavaScript runtime.', shortened: false });
});

test('a long exchange with no model is cut at a sentence end, within the limits', async () => {
  compat.setProviderConfig({ providers: {}, capabilities: {} });
  const reply = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says something.`).join(' ');
  const out = await storyText(agent, { prompt: 'Explain it. '.repeat(30), reply });
  assert.equal(out.shortened, false);
  assert.ok(out.prompt.length <= LIMITS.prompt && out.reply.length <= LIMITS.reply);
  assert.match(out.reply, /\.$/);
});

test('an empty side is refused', async () => {
  await assert.rejects(storyText(agent, { prompt: '  ', reply: 'x' }), { code: 'story_empty' });
});

test('clip never exceeds the limit and breaks at a word otherwise', () => {
  const out = clip('word '.repeat(200), 50);
  assert.ok(out.length <= 50);
  assert.match(out, /…$/);
});

test('an instruction is refused when too long, and fails honestly (no fake edit) when no model answers', async () => {
  compat.setProviderConfig({ providers: {}, capabilities: {} });
  await assert.rejects(storyText(agent, { prompt: 'a', reply: 'b', instruction: 'x'.repeat(301) }), { code: 'story_bad_instruction' });
  await assert.rejects(storyText(agent, { prompt: 'a', reply: 'b', instruction: 'make it formal' }), { code: 'story_edit_failed' });
});
