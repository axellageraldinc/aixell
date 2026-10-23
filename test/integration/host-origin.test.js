// Host header allowlist (anti DNS rebinding) and Origin check on state-changing requests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot } from '../helpers/boot.js';

let app;
before(async () => { app = await boot(); });
after(async () => { await app.stop(); });

// fetch() will not let a script choose the Host header, so these go through node:http.
function rawGet(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: pathname, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a request with an unknown Host header is refused (421), for pages and for the API', async () => {
  for (const host of ['evil.example', `evil.example:${app.port}`, '192.0.2.10', 'localhost.evil.example']) {
    for (const pathname of ['/login.html', '/api/me']) {
      const r = await rawGet(pathname, { Host: host });
      assert.equal(r.status, 421, `${host} ${pathname}`);
      assert.match(r.body, /bad_host/);
    }
  }
});

test('the configured host names are accepted, with or without a port, in any case', async () => {
  for (const host of ['127.0.0.1', `127.0.0.1:${app.port}`, 'localhost', `LOCALHOST:${app.port}`]) {
    assert.equal((await rawGet('/login.html', { Host: host })).status, 200, host);
  }
});

test('extra host names can be allowed with HERMES_WEB_ALLOWED_HOSTS', async () => {
  const other = await boot({ env: { HERMES_WEB_ALLOWED_HOSTS: 'app.example.test, other.example.test' } });
  try {
    const get = (host) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: other.port, path: '/login.html', headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(await get('app.example.test'), 200);
    assert.equal(await get('other.example.test:8443'), 200);
    assert.equal(await get('evil.example'), 421);
  } finally { await other.stop(); }
});

test('Origin must match the Host on writes; reads and requests without Origin are unaffected', async () => {
  const me = await app.login();
  assert.equal((await me.post('/api/agents/test-agent/settings', undefined, { origin: 'http://evil.example' })).status, 403);
  const forged = await me.call('PUT', '/api/agents/test-agent/settings', { json: { personality: 'x' }, origin: 'http://evil.example' });
  assert.equal(forged.status, 403);
  assert.equal(forged.data.error.code, 'bad_origin');
  const samePortOtherHost = await me.call('PUT', '/api/agents/test-agent/settings', { json: { personality: 'x' }, origin: `http://localhost:${app.port}` });
  assert.equal(samePortOtherHost.status, 403, 'Origin must equal the Host header exactly (127.0.0.1 is not localhost)');
  const malformed = await me.call('PUT', '/api/agents/test-agent/settings', { json: { personality: 'x' }, origin: 'not a url' });
  assert.equal(malformed.status, 403);
  assert.equal((await me.call('GET', '/api/me', { origin: 'http://evil.example' })).status, 200, 'GET ignores Origin');
  const noOrigin = await me.call('PUT', '/api/agents/test-agent/settings', { json: { personality: 'be brief' }, origin: '' });
  assert.equal(noOrigin.status, 200, 'non-browser clients send no Origin; they still need the CSRF token');
  const settings = await me.get('/api/agents/test-agent/settings');
  assert.equal(settings.data.personality, 'be brief');
});
