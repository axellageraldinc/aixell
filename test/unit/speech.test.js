// Speech goes through the agent's speech provider; its failures map to the HTTP errors the voice chat knows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/env.js';
import { startGateway, GW_KEY } from '../helpers/fake-gateway.js';
const compat = await import('../../src/providers/compat.js');
const { synthesizeSpeech, MAX_SPEECH_CHARS } = await import('../../src/speech.js');

const agentOf = (env, extra = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-agent-'));
  fs.writeFileSync(path.join(home, '.env'), env);
  process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
  return { name: `t-${Math.random().toString(36).slice(2)}`, home, provider: 'gateway', model: 'chat-a', ...extra };
};

test('synthesizeSpeech sends the configured model and voice and returns the audio', async () => {
  compat.setProviderConfig(null);
  const gw = await startGateway(compat);
  try {
    const agent = agentOf(`GATEWAY_API_KEY=${GW_KEY}\n`, { baseUrl: gw.url });
    const out = await synthesizeSpeech(agent, '  Halo dunia.  ');
    assert.equal(out.audio.toString(), 'ID3 fake mp3');
    assert.deepEqual(gw.requests.find((r) => r.path === '/audio/speech').body, { model: 'tts-1', input: 'Halo dunia.', voice: 'alloy', response_format: 'mp3' });
  } finally { await gw.close(); }
});

test('synthesizeSpeech refuses empty and over-long text before calling the provider', async () => {
  compat.setProviderConfig(null);
  const gw = await startGateway(compat);
  try {
    const agent = agentOf(`GATEWAY_API_KEY=${GW_KEY}\n`, { baseUrl: gw.url });
    await assert.rejects(synthesizeSpeech(agent, '   '), (e) => e.status === 400 && e.code === 'tts_empty');
    await assert.rejects(synthesizeSpeech(agent, 'a'.repeat(MAX_SPEECH_CHARS + 1)), (e) => e.status === 413 && e.code === 'tts_too_long');
    assert.equal(gw.count('POST /audio/speech'), 0);
  } finally { await gw.close(); }
});

test('synthesizeSpeech maps provider failures to HTTP errors', async () => {
  compat.setProviderConfig(null);
  const gw = await startGateway(compat);
  try {
    const agent = agentOf(`GATEWAY_API_KEY=${GW_KEY}\n`, { baseUrl: gw.url });
    gw.handlers['POST /audio/speech'] = () => ({ status: 500, body: {} });
    await assert.rejects(synthesizeSpeech(agent, 'Halo'), (e) => e.status === 502 && e.code === 'tts_failed' && /500/.test(e.message));
    gw.handlers['POST /audio/speech'] = () => ({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, raw: Buffer.alloc(0) });
    await assert.rejects(synthesizeSpeech(agent, 'Halo'), (e) => e.status === 502 && e.code === 'tts_empty_audio');
    const keyless = agentOf('', { baseUrl: gw.url });
    await assert.rejects(synthesizeSpeech(keyless, 'Halo'), (e) => e.status === 501 && e.code === 'no_speech_backend');
  } finally { await gw.close(); }
});

test('synthesizeSpeech without a speech provider is a 501', async () => {
  compat.setProviderConfig(null);
  await assert.rejects(synthesizeSpeech(agentOf(''), 'Halo'), (e) => e.status === 501 && e.code === 'no_speech_backend');
});

test('synthesizeSpeech passes an optional speed on and refuses one out of range', async () => {
  compat.setProviderConfig(null);
  const gw = await startGateway(compat);
  try {
    const agent = agentOf(`GATEWAY_API_KEY=${GW_KEY}\n`, { baseUrl: gw.url });
    await synthesizeSpeech(agent, 'Halo', { speed: 0.9 });
    assert.deepEqual(gw.requests.filter((r) => r.path === '/audio/speech').at(-1).body, { model: 'tts-1', input: 'Halo', voice: 'alloy', speed: 0.9, response_format: 'mp3' });
    for (const speed of [0.1, 3, 'fast', null, NaN]) {
      await assert.rejects(synthesizeSpeech(agent, 'Halo', { speed }), (e) => e.status === 400 && e.code === 'tts_bad_speed', String(speed));
    }
  } finally { await gw.close(); }
});
