// Public chat links: publishing goes to the share host (faked), revoking deletes, and the page holds no app address.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from '../helpers/boot.js';

const calls = [];
let app;
let me;
before(async () => {
  app = await boot({
    inProcess: true,
    env: { HERMES_WEB_ALLOWED_HOSTS: 'chat.private.test' },
    files: { 'share.json': JSON.stringify({ baseUrl: 'https://share.example.test', accountId: 'acc', namespaceId: 'ns', apiToken: 'file:share-secret.json#token', ttlDays: 7 }), 'share-secret.json': '{"token":"t0k3n"}' },
  });
  const { setTransport } = await import('../../src/shares.js');
  setTransport(async (url, options) => { calls.push({ url, ...options }); return { status: 200, body: Buffer.from('{}') }; });
  me = await app.login();
});
after(async () => { await app.stop(); });

test('publish stores the page, lists it, and redacts the app address', async () => {
  const res = await me.post('/api/shares', { agent: app.agentName, sessionId: 'abc', title: 'Hello', body: '<article class="msg"><p>see https://chat.private.test/x</p></article>' });
  assert.equal(res.status, 200);
  assert.match(res.data.url, /^https:\/\/share\.example\.test\/[A-Za-z0-9_-]{43}$/);
  const put = calls.at(-1);
  assert.equal(put.method, 'PUT');
  assert.match(put.url, /expiration_ttl=604800/);
  assert.equal(put.headers.Authorization, 'Bearer t0k3n');
  assert.doesNotMatch(put.body, /chat\.private\.test/);
  const again = await me.post('/api/shares', { agent: app.agentName, sessionId: 'abc', title: 'Hello', body: '<p>newer</p>' });
  assert.equal(again.data.token, res.data.token, 'a refresh keeps the link');
  assert.equal((await me.get('/api/shares')).data.data.length, 1);
});

test('the expiry is per link: custom hours, none, or refused when out of range', async () => {
  const send = (sessionId, ttlHours) => me.post('/api/shares', { agent: app.agentName, sessionId, title: 't', body: '<p>x</p>', ttlHours });
  const hours = await send('ttl-2h', 2);
  assert.equal(hours.status, 200);
  assert.match(calls.at(-1).url, /expiration_ttl=7200/);
  assert.ok(Math.abs(hours.data.expiresAt - (Date.now() + 7200_000)) < 5000);
  const never = await send('ttl-never', null);
  assert.equal(never.status, 200);
  assert.doesNotMatch(calls.at(-1).url, /expiration_ttl/);
  assert.equal(never.data.expiresAt, null);
  assert.equal((await send('ttl-bad', 0)).data.error.code, 'bad_ttl');
  assert.equal((await send('ttl-bad', 'soon')).data.error.code, 'bad_ttl');
  for (const share of [hours.data, never.data]) await me.delete(`/api/shares/${share.token}`);
});

test('markup that could run is refused', async () => {
  const res = await me.post('/api/shares', { agent: app.agentName, sessionId: 'evil', title: 'x', body: '<p onclick="x()">hi</p><script>1</script>' });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'unsafe_html');
});

test('text that merely mentions a handler is not mistaken for markup', async () => {
  const res = await me.post('/api/shares', { agent: app.agentName, sessionId: 'xss-talk', title: 'x', body: '<p>never write &lt;img onerror=alert(1)&gt;</p>' });
  assert.equal(res.status, 200);
  await me.delete(`/api/shares/${res.data.token}`);
});

test('revoking deletes the page from the share host and from the list', async () => {
  const [{ token }] = (await me.get('/api/shares')).data.data;
  const res = await me.delete(`/api/shares/${token}`);
  assert.equal(res.status, 200);
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.equal((await me.get('/api/shares')).data.data.length, 0);
  assert.equal((await me.delete(`/api/shares/${token}`)).status, 404);
});

test('sharing requires a signed-in client', async () => {
  assert.equal((await app.client().call('GET', '/api/shares')).status, 401);
  assert.ok(fs.existsSync(`${app.dataDir}/share.json`));
});
