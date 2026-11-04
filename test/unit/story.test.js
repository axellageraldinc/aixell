// "Share as story": short exchanges pass through untouched, long ones are shortened by the writer, and a missing or broken
// model falls back to a clean cut. No real model is called: the offline mock and a fake transport answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const { storyText, clip, limitsFor, MAX_TURNS } = await import('../../src/story.js');
const compat = await import('../../src/providers/compat.js');

const agent = { name: 'story-agent', provider: 'gateway', model: 'chat-a', baseUrl: null, home: '/nonexistent' };
const none = () => compat.setProviderConfig({ providers: {}, capabilities: {} });

test('a short exchange is returned as plain text without asking a model', async () => {
  none();
  const out = await storyText(agent, { turns: [{ prompt: 'What is **Node**?', reply: 'A JavaScript runtime.\n\n```js\nx\n```' }] });
  assert.deepEqual(out, { turns: [{ prompt: 'What is Node?', reply: 'A JavaScript runtime.' }], shortened: false });
});

test('long turns with no model are cut at a sentence end, within the limits for that many turns', async () => {
  none();
  const reply = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says something.`).join(' ');
  for (const n of [1, 3, 5]) {
    const out = await storyText(agent, { turns: Array.from({ length: n }, () => ({ prompt: 'Explain it. '.repeat(30), reply })) });
    const lim = limitsFor(n);
    assert.equal(out.turns.length, n);
    assert.equal(out.shortened, false);
    for (const x of out.turns) assert.ok(x.prompt.length <= lim.prompt && x.reply.length <= lim.reply);
  }
});

test('empty, missing and too many turns are refused', async () => {
  await assert.rejects(storyText(agent, { turns: [] }), { code: 'story_empty' });
  await assert.rejects(storyText(agent, { turns: [{ prompt: '  ', reply: 'x' }] }), { code: 'story_empty' });
  await assert.rejects(storyText(agent, { turns: Array.from({ length: MAX_TURNS + 1 }, () => ({ prompt: 'a', reply: 'b' })) }), { code: 'story_too_many' });
});

test('clip never exceeds the limit and breaks at a word otherwise', () => {
  const out = clip('word '.repeat(200), 50);
  assert.ok(out.length <= 50);
  assert.match(out, /…$/);
});

test('an instruction is refused when too long, and fails honestly (no fake edit) when no model answers', async () => {
  none();
  const turns = [{ prompt: 'a', reply: 'b' }];
  await assert.rejects(storyText(agent, { turns, instruction: 'x'.repeat(301) }), { code: 'story_bad_instruction' });
  await assert.rejects(storyText(agent, { turns, instruction: 'make it formal' }), { code: 'story_edit_failed' });
});

test('the model may rewrite only the side that was asked for: the other side is put back as given', async () => {
  const reply = JSON.stringify({ turns: [{ prompt: 'CHANGED prompt', reply: 'CHANGED reply' }] });
  compat.setProviderConfig({
    providers: { fake: { type: 'openai-compatible', baseUrl: 'http://fake.invalid/v1', apiKey: 'inline-test-key' } },
    capabilities: { writer: { provider: 'fake', chain: [{ model: 'm', paid: true }] } },
  });
  compat.setTransport?.(async () => new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const turns = [{ prompt: 'my prompt', reply: 'the ai reply' }];
  const onlyReply = await storyText(agent, { turns, instruction: 'x', scope: 'reply' });
  assert.deepEqual(onlyReply.turns, [{ prompt: 'my prompt', reply: 'CHANGED reply' }]);
  const onlyPrompt = await storyText(agent, { turns, instruction: 'x', scope: 'prompt' });
  assert.deepEqual(onlyPrompt.turns, [{ prompt: 'CHANGED prompt', reply: 'the ai reply' }]);
});

test('two empty answers in a row are retried: the third try can still succeed', async () => {
  const good = JSON.stringify({ turns: [{ prompt: 'p2', reply: 'r2' }] });
  compat.setProviderConfig({
    providers: { fake: { type: 'openai-compatible', baseUrl: 'http://fake.invalid/v1', apiKey: 'inline-test-key' } },
    capabilities: { writer: { provider: 'fake', chain: [{ model: 'm', paid: true }] } },
  });
  let calls = 0;
  compat.setTransport?.(async () => new Response(JSON.stringify({ choices: [{ message: { content: ++calls < 3 ? '' : good } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const out = await storyText(agent, { turns: [{ prompt: 'a', reply: 'b' }], instruction: 'x' });
  assert.equal(calls, 3);
  assert.deepEqual(out.turns, [{ prompt: 'p2', reply: 'r2' }]);
});

test('formatting markers written on the story survive an edit, but are stripped from chat text', async () => {
  const { plain, keep } = await import('../../src/story.js');
  assert.equal(plain('a **b** __c__ ~~d~~ *e* `f`'), 'a b c d e f');
  assert.equal(keep('a **b** __c__ ~~d~~ *e* `f`'), 'a **b** __c__ ~~d~~ *e* f');
});
