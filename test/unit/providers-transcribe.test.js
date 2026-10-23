// Transcription goes through the agent's transcription provider; its failures map to the same HTTP errors as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/env.js';
import { startFakeGateway, startGateway, GW_KEY } from '../helpers/fake-gateway.js';
const compat = await import('../../src/providers/compat.js');
const { runTranscription } = await import('../../src/transcribe.js');
const { setSttLanguage } = await import('../../src/agent-settings.js');

const agentOf = (env, extra = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-agent-'));
  fs.writeFileSync(path.join(home, '.env'), env);
  process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
  return { name: `t-${Math.random().toString(36).slice(2)}`, home, provider: 'gateway', model: 'chat-a', ...extra };
};

test('runTranscription sends the configured model and the language hint through the provider', async () => {
  compat.setProviderConfig(null);
  const gw = await startGateway(compat);
  try {
    const agent = agentOf(`GATEWAY_API_KEY=${GW_KEY}\n`, { baseUrl: gw.url });
    setSttLanguage(agent.name, 'en');
    const registry = compat.providersFor(agent);
    assert.equal(await runTranscription(agent, registry.get('transcription'), Buffer.from('mp3 bytes')), 'hello world');
    const raw = gw.requests.find((r) => r.path === '/audio/transcriptions').raw.toString('latin1');
    assert.match(raw, /name="model"\r\n\r\nwhisper-large-v3-turbo/);
    assert.match(raw, /name="prompt"\r\n\r\nThe speech is in English\./);
  } finally { await gw.close(); }
});

test('runTranscription maps provider failures to the HTTP errors the client already knows', async () => {
  compat.setProviderConfig(null);
  const gw = await startGateway(compat);
  try {
    const agent = agentOf(`GATEWAY_API_KEY=${GW_KEY}\n`, { baseUrl: gw.url });
    const t = compat.providersFor(agent).get('transcription');
    gw.handlers['POST /audio/transcriptions'] = () => ({ status: 500, body: {} });
    await assert.rejects(runTranscription(agent, t, Buffer.from('a')), (e) => e.status === 502 && e.code === 'stt_failed' && /500/.test(e.message));
    gw.handlers['POST /audio/transcriptions'] = () => ({ status: 200, body: { text: '' } });
    await assert.rejects(runTranscription(agent, t, Buffer.from('a')), (e) => e.status === 502 && e.code === 'stt_empty');
    const keyless = agentOf('', { baseUrl: gw.url });
    await assert.rejects(runTranscription(keyless, compat.providersFor(keyless).get('transcription'), Buffer.from('a')), (e) => e.status === 501 && e.code === 'no_audio_backend');
    await gw.close();
    const down = agentOf(`GATEWAY_API_KEY=${GW_KEY}\n`, { baseUrl: gw.url });
    await assert.rejects(runTranscription(down, compat.providersFor(down).get('transcription'), Buffer.from('a')), (e) => e.status === 504 && e.code === 'stt_timeout');
  } finally { await gw.close().catch(() => {}); }
});

test('with no transcription provider the capability is null (the mic record mode is hidden by the client later)', () => {
  compat.setProviderConfig(null);
  const agent = agentOf('', { provider: 'opencode-go' });
  assert.equal(compat.providersFor(agent).get('transcription'), null);
});
