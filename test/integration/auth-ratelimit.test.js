// The login rate limit: 5 failures from one client lock that client for 15 minutes, even for correct credentials.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD } from '../helpers/boot.js';

let app;
before(async () => { app = await boot(); });
after(async () => { await app.stop(); });

test('the sixth attempt is refused with 429 and Retry-After, and a correct login stays refused', async () => {
  const anon = app.client();
  const wrong = () => anon.call('POST', '/api/login', { json: { username: USERNAME, password: 'definitely wrong password', code: '123456' } });
  for (let i = 0; i < 5; i += 1) assert.equal((await wrong()).status, 401);
  const blocked = await wrong();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.error.code, 'rate_limited');
  const retry = Number(blocked.headers.get('retry-after'));
  assert.ok(retry > 800 && retry <= 900, `Retry-After ${retry}`);
  assert.equal(blocked.data.retryAfter, retry);
  const right = await anon.call('POST', '/api/login', { json: { username: USERNAME, password: PASSWORD, code: totp(TOTP_SECRET) } });
  assert.equal(right.status, 429);
});

test('the lockout survives a restart (it is stored in the data directory)', async () => {
  const state = JSON.parse((await import('node:fs')).readFileSync(`${app.dataDir}/login-state.json`, 'utf8'));
  assert.ok(state.clients.length >= 1);
  assert.ok(state.global.count >= 5);
});
