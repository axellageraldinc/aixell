// A routed gateway that reports which real model a conversation is on (`capabilities.models.servedModelPath`):
// `/api/agents/:a/models/served` answers with it, and stays quiet when the gateway has nothing to say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, AGENT_NAME } from '../helpers/boot.js';
import { startFakeGateway, GW_KEY } from '../helpers/fake-gateway.js';

const SESSION = 'api_1793099803_a51abe8c';
const SERVED = 'agnes-3-0-flash:free';

const routedProviders = (url) => ({
  providers: { gw: { type: 'openai-compatible', baseUrl: url, apiKey: 'env:HW_LOCAL_KEY' } },
  capabilities: { models: { provider: 'gw', routed: true, servedModelPath: '/session' } },
});

test('a routed gateway names the real model of a conversation, and answers null when it has no traffic for it', async () => {
  const gw = await startFakeGateway();
  gw.handlers['GET /session'] = (req) => (req.query.includes(`session=${SESSION}`)
    ? { status: 200, body: { object: 'session', session: SESSION, model: SERVED, last_model: SERVED, models: [SERVED] } }
    : { status: 404, body: { error: { message: 'no session', code: 'no_session' } } });
  const app = await boot({ files: { 'providers.json': JSON.stringify(routedProviders(gw.url)) }, env: { HW_LOCAL_KEY: GW_KEY } });
  try {
    const me = await app.login();
    const models = (await me.get(`/api/agents/${AGENT_NAME}/models`)).data;
    assert.equal(models.routed, true, 'the catalogue is routed: there is nothing to choose');

    const served = await me.get(`/api/agents/${AGENT_NAME}/models/served?session=${SESSION}`);
    assert.equal(served.status, 200);
    assert.deepEqual(served.data, { routed: true, model: SERVED, models: [SERVED] });

    // Before the first request of a new conversation the gateway has no session for it: no name, never a guess.
    const empty = await me.get(`/api/agents/${AGENT_NAME}/models/served?session=api_1793099803_deadbeef`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data, { routed: true, model: null, models: [] });

    const bad = await me.get(`/api/agents/${AGENT_NAME}/models/served?session=${encodeURIComponent('not a session')}`);
    assert.equal(bad.status, 400);

    assert.ok(gw.requests.some((r) => r.path === '/session' && r.query.includes(SESSION)), 'the gateway was asked about that conversation');
  } finally {
    await app.stop();
    await gw.close();
  }
});

test('a catalogue that is not routed never asks a gateway for a served model', async () => {
  const gw = await startFakeGateway();
  const providers = {
    providers: { gw: { type: 'openai-compatible', baseUrl: gw.url, apiKey: 'env:HW_LOCAL_KEY' } },
    capabilities: { models: { provider: 'gw', servedModelPath: '/session' } },
  };
  const app = await boot({ files: { 'providers.json': JSON.stringify(providers) }, env: { HW_LOCAL_KEY: GW_KEY } });
  try {
    const me = await app.login();
    const models = (await me.get(`/api/agents/${AGENT_NAME}/models`)).data;
    assert.equal(models.routed, undefined, 'a plain catalogue lists models');
    const served = await me.get(`/api/agents/${AGENT_NAME}/models/served?session=${SESSION}`);
    assert.equal(served.status, 200);
    assert.deepEqual(served.data, { routed: false, model: null, models: [] });
    assert.equal(gw.requests.some((r) => r.path === '/session'), false, 'the gateway was never asked');
  } finally {
    await app.stop();
    await gw.close();
  }
});