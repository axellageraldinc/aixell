// Static serving: auth gating, security headers, caching, compression, path traversal, build-id rewriting, module preloads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot } from '../helpers/boot.js';

let app, me;
before(async () => { app = await boot(); me = await app.login(); });
after(async () => { await app.stop(); });

test('every response carries the security headers', async () => {
  const r = await app.client().raw('GET', '/login.html');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('content-type'), /^text\/html/);
});

test('a signed-in visitor is sent from the login page to the app', async () => {
  const r = await me.raw('GET', '/login.html');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
});

test('the app shell gets the build id on its local scripts and styles, and a modulepreload list', async () => {
  const html = await (await me.raw('GET', '/')).text();
  const ids = [...html.matchAll(/(?:src|href)="\/[^"?]+\.(?:js|css)\?v=([a-z0-9]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 3, 'scripts and styles are versioned');
  assert.equal(new Set(ids).size, 1, 'one build id everywhere');
  const preloads = [...html.matchAll(/<link rel="modulepreload" href="(\/[^"]+\.js)\?v=([a-z0-9]+)">/g)];
  assert.ok(preloads.length >= 10, `expected many preloads, got ${preloads.length}`);
  assert.ok(preloads.every((m) => m[2] === ids[0]));
  assert.ok(!preloads.some((m) => m[1] === '/app.js'), 'the entry module itself is not preloaded');
  assert.doesNotMatch(html, /(?:src|href)="\/vendor\/[^"]*\?v=/, 'vendored files are not versioned');
});

test('every preloaded module exists and is served', async () => {
  const html = await (await me.raw('GET', '/')).text();
  const hrefs = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
  for (const href of hrefs.slice(0, 12)) assert.equal((await me.raw('GET', href)).status, 200, href);
});

test('imports inside JS modules are rewritten with the same build id', async () => {
  const html = await (await me.raw('GET', '/')).text();
  const id = /\/app\.js\?v=([a-z0-9]+)/.exec(html)[1];
  const js = await (await me.raw('GET', `/app.js?v=${id}`)).text();
  const imports = [...js.matchAll(/from\s*'(\.\/[^']+\.js)(\?v=[a-z0-9]+)?'/g)];
  assert.ok(imports.length > 3);
  assert.ok(imports.every((m) => m[2] === `?v=${id}`), 'no import is left without the build id');
});

test('caching: a build-id URL is immutable, a plain URL is revalidated with an ETag (304)', async () => {
  const html = await (await me.raw('GET', '/')).text();
  const id = /\/app\.js\?v=([a-z0-9]+)/.exec(html)[1];
  const pinned = await me.raw('GET', `/app.js?v=${id}`);
  assert.match(pinned.headers.get('cache-control'), /immutable/);
  const plain = await me.raw('GET', '/app.js');
  assert.equal(plain.headers.get('cache-control'), 'no-cache');
  const etag = plain.headers.get('etag');
  assert.match(etag, /^W\//);
  assert.equal((await me.raw('GET', '/app.js', { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await me.raw('GET', '/app.js', { headers: { 'If-None-Match': 'W/"nope"' } })).status, 200);
});

test('large text files are compressed when the client accepts it', async () => {
  const r = await me.raw('GET', '/app.css', { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-encoding'), 'br');
  assert.equal(r.headers.get('vary'), 'Accept-Encoding');
  const plain = await me.raw('GET', '/app.css', { headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal((await r.text()).length, (await plain.text()).length, 'same content either way');
});

test('path traversal and odd paths are refused', async () => {
  for (const p of ['/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/vendor/..%2f..%2fserver.js', '/%00', '/%zz']) {
    const r = await me.raw('GET', p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(await r.text(), /root:|import http/);
  }
  assert.equal((await me.raw('GET', '/does-not-exist.js')).status, 404);
  assert.equal((await me.raw('GET', '/lib')).status, 404, 'a directory is not a file');
});

test('only GET and HEAD are allowed for static files', async () => {
  const r = await me.call('POST', '/index.html', { json: {} });
  assert.equal(r.status, 405);
  const head = await me.raw('HEAD', '/app.css');
  assert.equal(head.status, 200);
  assert.equal((await head.text()), '');
});

test('the build id changes when an app file changes, and only reachable static imports are preloaded', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-web-public-'));
  fs.mkdirSync(path.join(pub, 'lib'));
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><html><head><title>t</title><script type="module" src="/app.js"></script><link rel="stylesheet" href="/style.css"></head><body></body></html>');
  fs.writeFileSync(path.join(pub, 'app.js'), "import { a } from './lib/a.js';\nimport('./lib/lazy.js');\nexport default a;\n");
  fs.writeFileSync(path.join(pub, 'lib', 'a.js'), "import { b } from './b.js';\nexport const a = b;\n");
  fs.writeFileSync(path.join(pub, 'lib', 'b.js'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(pub, 'lib', 'lazy.js'), 'export const lazy = 1;\n');
  fs.writeFileSync(path.join(pub, 'style.css'), 'body{margin:0}\n');
  const small = await boot({ publicDir: pub });
  try {
    const client = await small.login();
    const first = await (await client.raw('GET', '/')).text();
    const id1 = /\/app\.js\?v=([a-z0-9]+)/.exec(first)[1];
    assert.match(first, new RegExp(`href="/style\\.css\\?v=${id1}"`));
    const preloads = [...first.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1].split('?')[0]).sort();
    assert.deepEqual(preloads, ['/lib/a.js', '/lib/b.js'], 'the dynamic import() stays lazy');
    const appJs = await (await client.raw('GET', '/app.js')).text();
    assert.match(appJs, new RegExp(`from './lib/a\\.js\\?v=${id1}'`));
    assert.match(appJs, new RegExp(`import\\('./lib/lazy\\.js\\?v=${id1}'\\)`));
    await new Promise((resolve) => setTimeout(resolve, 1100)); // the id is cached for a second
    fs.writeFileSync(path.join(pub, 'lib', 'b.js'), 'export const b = 2; // changed\n');
    const second = await (await client.raw('GET', '/')).text();
    const id2 = /\/app\.js\?v=([a-z0-9]+)/.exec(second)[1];
    assert.notEqual(id2, id1);
  } finally { await small.stop(); fs.rmSync(pub, { recursive: true, force: true }); }
});
