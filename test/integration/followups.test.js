// Follow-ups end to end against the fake agent: the chat is told how to schedule one, the loopback tool route accepts it only with
// the shared secret and the chat's key, and a due check-in becomes a hidden turn in the same chat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, waitFor, AGENT_NAME } from '../helpers/boot.js';
import { parseSse } from '../helpers/sse.js';
import { REPLY_TEXT } from '../fake-hermes/server.js';

let app, me;
before(async () => {
  app = await boot({ config: { followups: { enabled: true, quietHours: '', maxPerDay: 5 } }, env: { HERMES_WEB_TEST_FOLLOWUP_TICK: '1s' } });
  me = await app.login();
});
after(async () => { await app.stop(); });

const call = (tool, args, key, token) => fetch(`${app.base}/api/followups/call`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ tool, args, key }),
});

test('a check-in is scheduled by the agent and delivered as a hidden turn in the same chat', async () => {
  const response = await me.raw('POST', `/api/agents/${AGENT_NAME}/chat`, { json: { text: 'I have a hard day tomorrow' } });
  const events = parseSse(await response.text());
  const sessionId = events.find((e) => e.event === 'web.session').data.session_id;
  const hint = app.fake.chatBodies.at(-1).body.system_message;
  const key = /chat_key: (aixf_\S+)/.exec(hint)?.[1];
  assert.ok(key, 'the chat is told its follow-up key');

  const token = fs.readFileSync(path.join(app.dataDir, 'followups-secret'), 'utf8').trim();
  assert.equal((await call('list_followups', {}, key)).status, 401, 'no secret, no access');
  assert.equal((await call('list_followups', {}, 'aixf_x.y', token)).status, 403, 'a forged key is refused');

  const due = new Date(Date.now() + 1500).toISOString().replace('Z', '+00:00');
  const scheduled = await (await call('schedule_followup', { due_at: due, context: 'Hard day tomorrow.', question: 'How did it go?' }, key, token)).json();
  assert.equal(scheduled.result.ok, true);

  await waitFor(() => app.fake.chatBodies.filter((c) => c.sessionId === sessionId).length >= 2, { what: 'the check-in turn', timeoutMs: 15_000 });
  const seed = app.fake.chatBodies.filter((c) => c.sessionId === sessionId).at(-1).body.input;
  assert.match(seed, /^\[\[aixell:checkin\]\]/);
  assert.match(seed, /Hard day tomorrow\./);

  const messages = (await me.get(`/api/agents/${AGENT_NAME}/sessions/${sessionId}/messages`)).data.data;
  assert.equal(messages.filter((m) => m.role === 'assistant').at(-1).content, REPLY_TEXT);
  assert.equal((await (await call('list_followups', {}, key, token)).json()).result.followups.length, 0, 'a sent check-in is no longer pending');
});
