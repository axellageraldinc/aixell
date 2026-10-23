// Cover pictures: the scene comes from the writer's text capability, the picture from the images capability, models in chain order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/env.js';
import { startFakeGateway, startGateway, GW_KEY } from '../helpers/fake-gateway.js';
const compat = await import('../../src/providers/compat.js');
const { makeCover, coverFile } = await import('../../src/covers.js');

const agentOf = (env, extra = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-agent-'));
  fs.writeFileSync(path.join(home, '.env'), env);
  process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
  return { name: `cv-${Math.random().toString(36).slice(2, 8)}`, home, provider: 'gateway', model: 'chat-a', ...extra };
};

test('a cover is drawn: scene from the text model, picture from the first image model; a rate-limited model rests and the next one draws', async () => {
  compat.setProviderConfig(null);
  const gw = await startGateway(compat);
  try {
    const agent = agentOf(`GATEWAY_API_KEY=${GW_KEY}\n`, { baseUrl: gw.url });
    assert.equal(await makeCover(agent, 's1', 'Planning a hiking trip in the mountains next month'), true);
    assert.ok(coverFile(agent, 's1'));
    const chat = gw.requests.find((r) => r.path === '/chat/completions').body;
    assert.equal(chat.model, 'deepseek-v4-1-flash');
    assert.equal(chat.max_tokens, 90);
    assert.equal(chat.reasoning_effort, 'none');
    assert.equal(chat.messages[1].content, 'Planning a hiking trip in the mountains next month');
    const draw = gw.requests.find((r) => r.path === '/images/generations').body;
    assert.equal(draw.model, 'agnes-image-2-5-flash:free');
    assert.match(draw.prompt, /Scene: echo:deepseek-v4-1-flash\./);
    assert.equal(draw.size, '1024x1024');

    // the newest model is busy: the next draws, and the busy one is left alone afterwards
    gw.handlers['POST /images/generations'] = (req) => (req.body.model === 'agnes-image-2-5-flash:free'
      ? { status: 429, body: { error: { message: 'too many requests' } }, headers: { 'Retry-After': '30' } }
      : { status: 200, body: { data: [{ b64_json: Buffer.alloc(3000, 1).toString('base64') }] } });
    assert.equal(await makeCover(agent, 's2', 'Comparing two budget laptops for programming'), true);
    const tried = gw.requests.filter((r) => r.path === '/images/generations').map((r) => r.body.model);
    assert.deepEqual(tried.slice(1), ['agnes-image-2-5-flash:free', 'agnes-image-2-1-flash:free']);
    assert.equal(await makeCover(agent, 's3', 'Fixing a leaking kitchen tap at home'), true);
    assert.deepEqual(gw.requests.filter((r) => r.path === '/images/generations').map((r) => r.body.model).slice(3), ['agnes-image-2-1-flash:free'], 'the resting model is skipped');
  } finally { await gw.close(); }
});

test('without an image provider no cover is made and nothing is sent', async () => {
  compat.setProviderConfig(null);
  const gw = await startFakeGateway({ extras: true });
  try {
    const agent = agentOf('', { provider: 'opencode-go', baseUrl: gw.url });
    assert.equal(await makeCover(agent, 'none1', 'A topic long enough to draw'), false);
    assert.equal(coverFile(agent, 'none1'), null);
    assert.equal(gw.requests.length, 0);
  } finally { await gw.close(); }
});

test('if the text model is unavailable the topic itself is the scene', async () => {
  compat.setProviderConfig(null);
  const gw = await startGateway(compat);
  try {
    gw.handlers['POST /chat/completions'] = () => ({ status: 500, body: {} });
    const agent = agentOf(`GATEWAY_API_KEY=${GW_KEY}\n`, { baseUrl: gw.url });
    assert.equal(await makeCover(agent, 'plain1', 'Learning to bake sourdough bread'), true);
    assert.match(gw.requests.find((r) => r.path === '/images/generations').body.prompt, /Scene: Learning to bake sourdough bread\./);
  } finally { await gw.close(); }
});
