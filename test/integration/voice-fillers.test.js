// GET /api/agents/:agent/voice-fillers: needs a session; the default English sets, or the ones in data/voice-fillers.json.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, AGENT_NAME } from '../helpers/boot.js';
import { DEFAULT_FILLERS } from '../../src/voice-fillers.js';

const URL_PATH = `/api/agents/${AGENT_NAME}/voice-fillers`;
const mine = { start: ['Hold on.'], waits: [{ after: [5], phrases: ['Still here.'] }] };
let plain, custom;
before(async () => {
  plain = await boot();
  custom = await boot({ files: { 'voice-fillers.json': JSON.stringify(mine) } });
});
after(async () => { await plain.stop(); await custom.stop(); });

test('fillers need a signed-in session', async () => {
  assert.equal((await plain.client().get(URL_PATH)).status, 401);
});

test('the defaults are served, and a custom file replaces them', async () => {
  assert.deepEqual((await (await plain.login()).get(URL_PATH)).data, DEFAULT_FILLERS);
  assert.deepEqual((await (await custom.login()).get(URL_PATH)).data, { speed: 1, ...mine });
});
