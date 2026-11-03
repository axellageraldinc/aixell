// The agent <-> browser extension bridge: who may connect, who may call, and that a command reaches the extension and back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot } from '../helpers/boot.js';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXT}`;
let app; let on; let off;
before(async () => {
  on = await boot({ env: { HERMES_WEB_BROWSER_EXTENSION_IDS: EXT } });
  off = await boot();
});
after(async () => { await on.stop(); await off.stop(); });

const EXT_HEADERS = { origin: '', headers: { 'Sec-Fetch-Site': 'none' } };
const callBody = (tool, args) => ({ tool, args });
const token = () => fs.readFileSync(path.join(on.dataDir, 'browser-bridge-token'), 'utf8').trim();
const local = (client, body, headers = {}) => client.raw('POST', '/api/browser/call', { json: body, headers: { Authorization: `Bearer ${token()}`, ...headers } });

// Reads server-sent events from a response into a queue.
function events(res) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const queue = []; let buffer = ''; let waiter = null;
  (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buffer += value;
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const name = /^event: (.+)$/m.exec(frame)?.[1]; const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (name) { queue.push({ name, data: JSON.parse(data) }); waiter?.(); }
      }
    }
  })();
  return { next: async () => { while (!queue.length) await new Promise((r) => { waiter = r; }); return queue.shift(); }, close: () => reader.cancel().catch(() => {}) };
}

test('the bridge is off (404) unless an extension ID is configured', async () => {
  const client = await off.login();
  assert.equal((await client.raw('GET', '/api/browser/events', { headers: { Origin: ORIGIN } })).status, 404);
  assert.equal((await client.get('/api/browser/status')).data.enabled, false);
});

test('the event stream needs a session AND to look like the extension (not a web page)', async () => {
  assert.equal((await on.client().raw('GET', '/api/browser/events', { headers: { Origin: ORIGIN } })).status, 401, 'no session');
  const client = await on.login();
  assert.equal((await client.raw('GET', '/api/browser/events')).status, 403, 'a plain request');
  assert.equal((await client.raw('GET', '/api/browser/events', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 403, 'the web app itself');
  assert.equal((await client.raw('GET', '/api/browser/events', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'another website');
  assert.equal((await client.raw('GET', '/api/browser/events', { headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'none' } })).status, 403);
  assert.equal((await client.raw('GET', '/api/browser/events', { headers: { Origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' } })).status, 403);
});

test('the call endpoint is for local callers with the token only', async () => {
  const client = await on.login();
  assert.equal((await client.raw('POST', '/api/browser/call', { json: callBody('tabs_list', {}) })).status, 401, 'no token');
  assert.equal((await client.raw('POST', '/api/browser/call', { json: callBody('tabs_list', {}), headers: { Authorization: 'Bearer wrong' } })).status, 401);
  // a request that came through the public tunnel carries these headers, even though the tunnel connects from loopback
  assert.equal((await local(client, callBody('tabs_list', {}), { 'CF-Connecting-IP': '203.0.113.9' })).status, 403);
  assert.equal((await local(client, callBody('delete_everything', {}))).status, 400, 'unknown tool');
  assert.equal((await local(client, callBody('tabs_list', {}))).status, 503, 'right token, but no browser connected');
});

test('a command goes to the extension and its answer comes back', async () => {
  const client = await on.login();
  const stream = await client.raw('GET', '/api/browser/events', { origin: '', headers: { 'Sec-Fetch-Site': 'none' } }); // how Chrome marks the extension: no Origin, Sec-Fetch-Site none
  assert.equal(stream.status, 200);
  const sse = events(stream);
  assert.equal((await sse.next()).name, 'hello');
  assert.equal((await client.get('/api/browser/status')).data.connected, true);

  const pending = local(client, callBody('page_read', { tabId: 7, mode: 'text' }));
  const cmd = await sse.next();
  assert.equal(cmd.name, 'cmd');
  assert.deepEqual({ tool: cmd.data.tool, args: cmd.data.args }, { tool: 'page_read', args: { tabId: 7, mode: 'text' } });

  // answering needs the CSRF token and the extension origin
  const reply = { id: cmd.data.id, ok: true, result: { content: 'hello' } };
  const asExtension = (json, csrf = client.csrf) => client.raw('POST', '/api/browser/results', { json, origin: '', headers: { 'Sec-Fetch-Site': 'none', 'X-CSRF-Token': csrf } });
  assert.equal((await asExtension(reply, 'wrong')).status, 403, 'wrong CSRF token');
  assert.equal((await client.raw('POST', '/api/browser/results', { json: reply, headers: { 'X-CSRF-Token': client.csrf } })).status, 403, 'not marked as the extension');
  assert.equal((await client.raw('POST', '/api/browser/results', { json: reply, origin: 'https://evil.example', headers: { 'X-CSRF-Token': client.csrf } })).status, 403, 'another origin');
  assert.equal((await asExtension(reply)).status, 200);
  const done = await (await pending).json();
  assert.deepEqual(done, { ok: true, result: { content: 'hello' } });
  assert.equal((await asExtension(reply)).status, 404, 'an answer works once');

  // an error from the extension is passed on as an error, not as data
  const failing = local(client, callBody('page_act', { tabId: 7, action: 'click', ref: 'e1' }));
  const cmd2 = await sse.next();
  await asExtension({ id: cmd2.data.id, ok: false, error: { code: 'denied', message: 'The user did not allow this action.' } });
  assert.deepEqual(await (await failing).json(), { ok: false, error: { code: 'denied', message: 'The user did not allow this action.' } });

  // when the browser goes away, waiting callers are released at once
  const stuck = local(client, callBody('tabs_list', {}));
  await sse.next();
  sse.close();
  assert.equal((await stuck).status, 502);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await client.get('/api/browser/status')).data.connected, false);
});
