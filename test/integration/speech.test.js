// POST /api/agents/:agent/speech: needs a session, validates the text, and says so when no speech provider is configured.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, AGENT_NAME } from '../helpers/boot.js';

let app, me;
before(async () => { app = await boot(); me = await app.login(); });
after(async () => { await app.stop(); });

const SPEECH = `/api/agents/${AGENT_NAME}/speech`;

test('speech needs a signed-in session', async () => {
  const r = await app.client().post(SPEECH, { text: 'Halo' });
  assert.equal(r.status, 401);
});

test('speech refuses empty text and says when there is no speech provider', async () => {
  assert.equal((await me.post(SPEECH, { text: '  ' })).data.error.code, 'tts_empty');
  const r = await me.post(SPEECH, { text: 'Halo' });
  assert.equal(r.status, 501);
  assert.equal(r.data.error.code, 'no_speech_backend');
});
