// server.js exports start(): the same app can be started inside a test process (and `node server.js` still works, see the other tests).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, AGENT_NAME } from '../helpers/boot.js';
import { parseSse } from '../helpers/sse.js';

let app, me;
before(async () => { app = await boot({ inProcess: true }); me = await app.login(); });
after(async () => { await app.stop(); });

test('start() listens on a free port and serves the app', async () => {
  assert.ok(app.port > 0 && app.port !== 8300);
  assert.equal((await app.client().raw('GET', '/login.html')).status, 200);
  assert.equal((await me.get('/api/me')).data.username, 'tester');
});

test('start() refuses to run without a login record', async () => {
  const fs = await import('node:fs');
  const file = `${app.dataDir}/auth-record.json`;
  const saved = fs.readFileSync(file);
  const { start } = await import('../../server.js');
  fs.unlinkSync(file);
  try { await assert.rejects(() => start({ port: 0, hosts: ['127.0.0.1'], fresh: false }), /No login credentials yet/); }
  finally { fs.writeFileSync(file, saved, { mode: 0o600 }); }
});

test('a chat works through the in-process app', async () => {
  const r = await me.raw('POST', `/api/agents/${AGENT_NAME}/chat`, { json: { text: 'hi' } });
  assert.ok(parseSse(await r.text()).some((e) => e.event === 'done'));
});
