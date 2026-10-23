// Login (password + authenticator code), sessions, CSRF and logout, against the real app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD, RECOVERY_CODE } from '../helpers/boot.js';

let app;
before(async () => { app = await boot(); });
after(async () => { await app.stop(); });

const login = (client, body, options) => client.call('POST', '/api/login', { json: body, ...options });
const good = () => ({ username: USERNAME, password: PASSWORD, code: totp(TOTP_SECRET) });

test('the API and the app shell need a session', async () => {
  const anon = app.client();
  assert.equal((await anon.get('/api/me')).status, 401);
  assert.equal((await anon.get('/api/agents')).status, 401);
  const shell = await anon.raw('GET', '/');
  assert.equal(shell.status, 302);
  assert.equal(shell.headers.get('location'), '/login.html');
  assert.equal((await anon.raw('GET', '/login.html')).status, 200, 'the login page itself is public');
  assert.equal((await anon.raw('GET', '/app.js')).status, 401, 'app code is not public');
});

test('wrong password, wrong code and missing code all fail with the same generic message', async () => {
  const anon = app.client();
  const results = [
    await login(anon, { ...good(), password: 'not the password at all' }),
    await login(anon, { ...good(), code: '000000' }),
    await login(anon, { username: USERNAME, password: PASSWORD }),
  ];
  for (const r of results) {
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'login_failed');
    assert.equal(r.headers.get('set-cookie'), null);
  }
  assert.equal(new Set(results.map((r) => r.data.error.message)).size, 1, 'the message does not reveal which factor failed');
  assert.equal((await login(anon, { ...good(), username: 'someone-else' })).status, 401);
  await app.login(); // a good login clears this client's failure count, so the next tests are not locked out
});

test('login rejects malformed bodies', async () => {
  const anon = app.client();
  assert.equal((await anon.call('POST', '/api/login', { body: 'not json', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await anon.call('POST', '/api/login', { json: [1, 2] })).status, 400);
  assert.equal((await login(anon, { username: 42, password: {}, code: [] })).status, 401);
  await app.login();
});

test('a good login sets a HttpOnly SameSite cookie and the session works', async () => {
  const anon = app.client();
  const response = await anon.raw('POST', '/api/login', { json: good() });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^hw_session=[A-Za-z0-9_-]{20,};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Secure/, 'plain http on loopback: no Secure flag unless configured');
  anon.cookie = cookie.split(';')[0];
  const me = await anon.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.username, USERNAME);
  assert.match(me.data.csrf, /\S{16,}/);
  assert.ok(me.data.expiresAt > Date.now());
  assert.equal(me.headers.get('cache-control'), 'no-store');
});

test('a made-up session cookie does not work', async () => {
  const anon = app.client();
  anon.cookie = 'hw_session=not-a-real-token';
  assert.equal((await anon.get('/api/me')).status, 401);
});

test('state-changing requests need the CSRF token', async () => {
  const me = await app.login();
  const noToken = await me.call('POST', '/api/logout', { csrf: '' });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.data.error.code, 'bad_csrf');
  assert.equal((await me.call('POST', '/api/logout', { csrf: 'wrong-token' })).data.error.code, 'bad_csrf');
  assert.equal((await me.get('/api/me')).status, 200, 'still signed in after the refused attempts');
});

test('logout ends the session and clears the cookie', async () => {
  const me = await app.login();
  const out = await me.post('/api/logout', {});
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await me.get('/api/me')).status, 401, 'the old cookie is dead on the server');
});

test('logout-all ends every session', async () => {
  const a = await app.login();
  const b = await app.login();
  assert.equal((await a.post('/api/logout-all', {})).status, 200);
  assert.equal((await b.get('/api/me')).status, 401);
});

test('a recovery code works once in place of the authenticator code', async () => {
  const anon = app.client();
  const body = { username: USERNAME, password: PASSWORD, code: RECOVERY_CODE };
  assert.equal((await login(anon, body)).status, 200);
  assert.equal((await login(anon, body)).status, 401, 'the second use is refused');
});

test('login checks Origin when the browser sends one', async () => {
  const anon = app.client();
  const r = await login(anon, good(), { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'bad_origin');
});
