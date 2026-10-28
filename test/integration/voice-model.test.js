// A spoken turn asks the agent for the speech capability's `chatModel`; written turns and voice turns without one are untouched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, AGENT_NAME } from '../helpers/boot.js';

const CHAT = `/api/agents/${AGENT_NAME}/chat`;
const providers = (speech) => JSON.stringify({ providers: { gw: { type: 'mock-gateway' } }, capabilities: { speech: { provider: 'gw', model: 'tts-test', ...speech } } });
let withModel, without, a, b;
before(async () => {
  withModel = await boot({ files: { 'providers.json': providers({ chatModel: 'fast-voice' }) } });
  without = await boot({ files: { 'providers.json': providers({}) } });
  [a, b] = [await withModel.login(), await without.login()];
});
after(async () => { await withModel.stop(); await without.stop(); });

const send = async (client, body) => { const r = await client.raw('POST', CHAT, { json: body }); await r.text(); return r.status; };

test('a spoken turn asks for the voice model, a written one keeps the chat model', async () => {
  assert.equal(await send(a, { text: 'said', spoken: true, model: 'chosen-in-chat' }), 200);
  assert.equal(withModel.fake.chatBodies.at(-1).body.model, 'fast-voice', 'replaces the chat model for the voice turn');
  assert.equal(await send(a, { text: 'typed', model: 'chosen-in-chat' }), 200);
  assert.equal(withModel.fake.chatBodies.at(-1).body.model, 'chosen-in-chat');
  assert.equal(await send(a, { text: 'said again', spoken: true }), 200);
  assert.equal(withModel.fake.chatBodies.at(-1).body.model, 'fast-voice', 'also when the chat picked none');
});

test('without a chatModel a spoken turn is left as it is', async () => {
  assert.equal(await send(b, { text: 'said', spoken: true, model: 'chosen-in-chat' }), 200);
  assert.equal(without.fake.chatBodies.at(-1).body.model, 'chosen-in-chat');
  assert.equal(await send(b, { text: 'said', spoken: true }), 200);
  assert.equal(without.fake.chatBodies.at(-1).body.model, undefined);
});
