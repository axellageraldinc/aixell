// The agent <-> browser extension bridge: who may connect, who may call, and that a command reaches the extension and back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, AGENT_NAME } from '../helpers/boot.js';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXT}`;
let app; let on; let off;
before(async () => {
  on = await boot({ env: { HERMES_WEB_BROWSER_EXTENSION_IDS: EXT } });
  off = await boot();
});
after(async () => { await on.stop(); await off.stop(); });

const EXT_HEADERS = { origin: '', headers: { 'Sec-Fetch-Site': 'none' } };
const callBody = (tool, args, key) => ({ tool, args, ...(key ? { key } : {}) });
const CHAT = `/api/agents/${AGENT_NAME}/chat`;
// A chat started from the extension panel with a session selected; resolves with the key the agent was given in its instructions.
async function extensionChat(client, sessionRef, name = sessionRef, text = 'hello') {
  await (await client.raw('POST', CHAT, { json: { text }, headers: { 'X-Aixell-Ext-Session': sessionRef, 'X-Aixell-Ext-Session-Name': encodeURIComponent(name) } })).text();
  const system = on.fake.chatBodies.at(-1).body.system_message;
  return { key: /chat_key: (aixk_[A-Za-z0-9_-]+)/.exec(system)?.[1], system };
}
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
  assert.equal((await local(client, callBody('tabs_list', {}))).status, 403, 'right token, but no chat key');
  assert.equal((await local(client, callBody('tabs_list', {}, 'aixk_notarealkeyatallnotarealkey'))).status, 403, 'a key nobody was given');
  const { key } = await extensionChat(client, 's1', 'Shopping');
  assert.match(key, /^aixk_/);
  assert.equal((await local(client, callBody('delete_everything', {}, key))).status, 400, 'unknown tool');
  assert.equal((await local(client, callBody('tabs_list', {}, key))).status, 503, 'right token and key, but no browser connected');
});

test('a command goes to the extension and its answer comes back', async () => {
  const client = await on.login();
  const { key } = await extensionChat(client, 's1', 'Shopping'); // before the browser connects, so aixell has no context question to ask
  const stream = await client.raw('GET', '/api/browser/events', { origin: '', headers: { 'Sec-Fetch-Site': 'none' } }); // how Chrome marks the extension: no Origin, Sec-Fetch-Site none
  assert.equal(stream.status, 200);
  const sse = events(stream);
  assert.equal((await sse.next()).name, 'hello');
  assert.equal((await client.get('/api/browser/status')).data.connected, true);

  const pending = local(client, callBody('page_read', { tabId: 7, mode: 'text' }, key));
  const cmd = await sse.next();
  assert.equal(cmd.name, 'cmd');
  assert.deepEqual(cmd.data.scope, { sessionId: 's1' }, 'the extension is told which session this chat may use');
  assert.equal(cmd.data.args.chat_key, undefined, 'the key itself never reaches the browser');
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
  const failing = local(client, callBody('page_act', { tabId: 7, action: 'click', ref: 'e1' }, key));
  const cmd2 = await sse.next();
  await asExtension({ id: cmd2.data.id, ok: false, error: { code: 'denied', message: 'The user did not allow this action.' } });
  assert.deepEqual(await (await failing).json(), { ok: false, error: { code: 'denied', message: 'The user did not allow this action.' } });

  // when the browser goes away, waiting callers are released at once
  const stuck = local(client, callBody('tabs_list', {}, key));
  await sse.next();
  sse.close();
  assert.equal((await stuck).status, 502);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await client.get('/api/browser/status')).data.connected, false);
});

test('only the configured extension may frame the app; with no extension configured nobody may', async () => {
  const framed = await on.client().raw('GET', '/login.html');
  assert.match(framed.headers.get('content-security-policy'), new RegExp(`frame-ancestors chrome-extension://${EXT}(;|$)`));
  assert.doesNotMatch(framed.headers.get('content-security-policy'), /frame-ancestors[^;]*(\*|https?:|'self')/);
  assert.equal(framed.headers.get('x-frame-options'), null);
  const client = await on.login();
  assert.deepEqual((await client.get('/api/browser/status')).data.extensionOrigins, [ORIGIN]);
});

test('a chat started from the extension is tied to its session and keyed; other chats get no key and are told how to get access', async () => {
  const client = await on.login();
  // not connected, not from the extension: nothing about the browser
  await (await client.raw('POST', CHAT, { json: { text: 'plain web chat' } })).text();
  assert.doesNotMatch(on.fake.chatBodies.at(-1).body.system_message, /browser extension|chat_key/);
  // the browser connects
  const stream = await client.raw('GET', '/api/browser/events', EXT_HEADERS);
  const sse = events(stream);
  assert.equal((await sse.next()).name, 'hello');
  // a web chat while the browser is connected: told it needs an extension chat, and has no key
  await (await client.raw('POST', CHAT, { json: { text: 'web chat again' } })).text();
  const web = on.fake.chatBodies.at(-1).body.system_message;
  assert.match(web, /only work in chats started from the extension panel/);
  assert.doesNotMatch(web, /chat_key|aixk_/);
  // an extension chat bound to session s2 ("Work"): keyed, with the context question answered by the extension
  const asking = extensionChat(client, 's2', 'Work');
  const ask = await sse.next();
  assert.equal(ask.data.tool, 'session_context');
  assert.deepEqual(ask.data.scope, { sessionId: 's2' });
  await client.raw('POST', '/api/browser/results', { json: { id: ask.data.id, ok: true, result: { session: 'Work', tabs: [{ host: 'docs.example.org' }, { host: 'shop.example' }, { host: 'evil host <b>' }] } }, origin: '', headers: { 'Sec-Fetch-Site': 'none', 'X-CSRF-Token': client.csrf } });
  const work = await asking;
  assert.match(work.system, /tied to the session "Work"/);
  assert.match(work.system, /Pages shared in this session right now: 2 \(docs\.example\.org, shop\.example\)\./, 'host names only, and only sane ones');
  assert.match(work.system, /"this page"/);
  assert.match(work.system, /Never send several page_act calls at once/);
  assert.match(work.system, /never type it into a page/);
  // another chat gets another key and its own session
  const other = extensionChat(client, 's1', 'Shopping');
  const ask2 = await sse.next();
  assert.deepEqual(ask2.data.scope, { sessionId: 's1' });
  await client.raw('POST', '/api/browser/results', { json: { id: ask2.data.id, ok: true, result: { session: 'Shopping', tabs: [] } }, origin: '', headers: { 'Sec-Fetch-Site': 'none', 'X-CSRF-Token': client.csrf } });
  const shopping = await other;
  assert.notEqual(shopping.key, work.key);
  assert.match(shopping.system, /No page is shared in this session yet/);
  // a key opens its own session only: the command carries that scope, whatever the agent puts in its arguments
  const call = local(client, callBody('tabs_list', { session: 'Shopping' }, work.key));
  const cmd = await sse.next();
  assert.deepEqual(cmd.data.scope, { sessionId: 's2' });
  await client.raw('POST', '/api/browser/results', { json: { id: cmd.data.id, ok: true, result: {} }, origin: '', headers: { 'Sec-Fetch-Site': 'none', 'X-CSRF-Token': client.csrf } });
  await call;
  sse.close();
});

test('a chat keeps its session and key for good; a later message from the web, or from another session, does not change them', async () => {
  const client = await on.login();
  const first = await extensionChat(client, 's1', 'Shopping', 'first message');
  assert.ok(first.key);
  assert.match(first.system, /browser is not connected at the moment/);
  const sessionId = on.fake.chatBodies.at(-1).sessionId;
  await (await client.raw('POST', CHAT, { json: { text: 'from the web', sessionId } })).text();
  const web = on.fake.chatBodies.at(-1).body.system_message;
  assert.match(web, new RegExp(`chat_key: ${first.key}`), 'continuing the chat from the web keeps its key');
  await (await client.raw('POST', CHAT, { json: { text: 'from another session', sessionId }, headers: { 'X-Aixell-Ext-Session': 's2', 'X-Aixell-Ext-Session-Name': 'Work' } })).text();
  const again = on.fake.chatBodies.at(-1).body.system_message;
  assert.match(again, /tied to the session "Shopping"/, 'the binding is never changed');
  assert.match(again, new RegExp(`chat_key: ${first.key}`));
});

test('the extension session header is validated', async () => {
  const client = await on.login();
  for (const bad of ['', 'has space', 'a'.repeat(60), '../x', 'x;y']) {
    await (await client.raw('POST', CHAT, { json: { text: 'hi' }, headers: { 'X-Aixell-Ext-Session': bad } })).text();
    assert.doesNotMatch(on.fake.chatBodies.at(-1).body.system_message, /chat_key/, `"${bad}" does not make an extension chat`);
  }
});
