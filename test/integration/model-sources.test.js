// Several model sources in the chat picker (`capabilities.models.sources`): a routed gateway next to plain catalogues,
// a fixed list, and a source that is down. A pick is forwarded to the agent as {provider, model}; anything not offered is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, AGENT_NAME } from '../helpers/boot.js';
import { startFakeGateway, GW_KEY } from '../helpers/fake-gateway.js';

test('sources are merged and grouped, a dead source is skipped, and picks are validated and forwarded', async () => {
  const routed = await startFakeGateway();
  const plain = await startFakeGateway();
  routed.handlers['GET /session'] = () => ({ status: 200, body: { object: 'session', model: 'real-model', models: ['real-model'] } });
  const providers = {
    providers: {
      gw: { type: 'openai-compatible', baseUrl: routed.url, apiKey: 'env:HW_LOCAL_KEY' },
      plain: { type: 'openai-compatible', baseUrl: plain.url, apiKey: 'env:HW_LOCAL_KEY' },
      dead: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'env:HW_LOCAL_KEY' },
    },
    capabilities: { models: { sources: [
      { provider: 'gw', hermesProvider: 'gw-route', routed: true, model: 'auto', servedModelPath: '/session', label: 'Auto' },
      { provider: 'plain', hermesProvider: 'plain-h', allow: ['chat-a'], label: 'Plain' },
      { provider: 'dead', hermesProvider: 'dead-h' },
      { hermesProvider: 'fixed-h', models: ['fx-1', 'fx-2'], label: 'Fixed' },
    ] } },
  };
  const app = await boot({ files: { 'providers.json': JSON.stringify(providers) }, env: { HW_LOCAL_KEY: GW_KEY } });
  try {
    const me = await app.login();
    const data = (await me.get(`/api/agents/${AGENT_NAME}/models`)).data;
    assert.equal(data.routed, undefined, 'not every source is routed');
    assert.deepEqual(data.sources.map((s) => s.provider), ['gw-route', 'plain-h', 'dead-h', 'fixed-h']);
    const visible = data.models.filter((m) => !m.hidden).map((m) => `${m.provider}/${m.id}`);
    assert.deepEqual(visible, ['gw-route/auto', 'plain-h/chat-a', 'fixed-h/fx-1', 'fixed-h/fx-2']);
    assert.equal(data.models[0].routed, true);
    assert.equal(data.models[0].source, 'Auto');

    const send = (body) => me.raw('POST', `/api/agents/${AGENT_NAME}/chat`, { json: { text: 'hi', ...body } });
    const ok = await send({ provider: 'fixed-h', model: 'fx-2' });
    assert.equal(ok.status, 200);
    await ok.text();
    const forwarded = app.fake.chatBodies.at(-1).body;
    assert.equal(forwarded.provider, 'fixed-h');
    assert.equal(forwarded.model, 'fx-2');

    for (const body of [{ provider: 'fixed-h', model: 'nope' }, { provider: 'elsewhere', model: 'fx-1' }, { provider: 'plain-h', model: 'chat-b' }]) {
      const refused = await send(body);
      assert.equal(refused.status, 400, JSON.stringify(body));
    }
  } finally {
    await app.stop();
    await routed.close();
    await plain.close();
  }
});
