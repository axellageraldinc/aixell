// Chat sessions: list, create, read, rename, delete, messages, preview. The agent behind it is the fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, AGENT_NAME } from '../helpers/boot.js';

let app, me;
before(async () => { app = await boot({ fake: { sessionCount: 25 } }); me = await app.login(); });
after(async () => { await app.stop(); });

const S = `/api/agents/${AGENT_NAME}/sessions`;

test('list: pages with limit and offset, newest first, web chats only by default', async () => {
  const first = await me.get(`${S}?limit=10`);
  assert.equal(first.status, 200);
  assert.equal(first.data.data.length, 10);
  assert.equal(first.data.total, 25, 'the Telegram-style session is not counted');
  assert.equal(first.data.has_more, true);
  assert.ok(first.data.data.every((s) => s.source === 'api_server'));
  const times = first.data.data.map((s) => s.last_active);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  const ids = new Set(first.data.data.map((s) => s.id));
  const third = await me.get(`${S}?limit=10&offset=20`);
  assert.equal(third.data.data.length, 5);
  assert.equal(third.data.has_more, false);
  assert.ok(third.data.data.every((s) => !ids.has(s.id)));
});

test('list: source=all includes sessions from other platforms; limits are clamped', async () => {
  const all = await me.get(`${S}?source=all&limit=100`);
  assert.equal(all.data.total, 26);
  assert.ok(all.data.data.some((s) => s.source === 'telegram'));
  assert.equal((await me.get(`${S}?limit=100000`)).data.data.length, 25, 'limit is capped at 100');
  assert.equal((await me.get(`${S}?limit=abc&offset=-5`)).data.data.length, 25, 'bad numbers fall back to defaults');
});

test('create, read, rename and delete a session', async () => {
  const created = await me.post(S, { title: '  My new chat  ' });
  assert.equal(created.status, 200);
  const id = created.data.session.id;
  assert.equal(created.data.session.title, 'My new chat', 'the title is trimmed');

  const read = await me.get(`${S}/${id}`);
  assert.equal(read.status, 200);
  assert.equal(read.data.session.id, id);
  for (const key of ['web_run', 'web_settings', 'web_context', 'web_cost']) assert.ok(key in read.data.session, key);
  assert.equal(read.data.session.web_run, null);

  const renamed = await me.patch(`${S}/${id}`, { title: 'Renamed' });
  assert.equal(renamed.status, 200);
  assert.equal((await me.get(`${S}/${id}`)).data.session.title, 'Renamed');
  assert.equal((await me.patch(`${S}/${id}`, { title: '   ' })).data.error.code, 'bad_title');
  assert.equal((await me.patch(`${S}/${id}`, {})).status, 400);
  const long = await me.patch(`${S}/${id}`, { title: 'x'.repeat(500) });
  assert.equal(long.data.session.title.length, 200, 'titles are capped');

  const removed = await me.delete(`${S}/${id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data, { ok: true });
  assert.equal((await me.get(`${S}/${id}`)).status, 404);
  assert.equal((await me.delete(`${S}/${id}`)).status, 404);
});

test('a session from another platform cannot be renamed or deleted from here', async () => {
  for (const r of [await me.patch(`${S}/tg_fake_001`, { title: 'x' }), await me.delete(`${S}/tg_fake_001`)]) {
    assert.equal(r.status, 403);
    assert.equal(r.data.error.code, 'not_web_session');
  }
  assert.ok(app.fake.sessions.has('tg_fake_001'));
});

test('ids are validated and unknown sessions are 404', async () => {
  assert.equal((await me.get(`${S}/api_fake_nope`)).status, 404);
  assert.equal((await me.get(`${S}/bad%20id`)).data.error.code, 'bad_id');
  assert.equal((await me.get(`${S}/${'a'.repeat(101)}`)).status, 400);
  assert.equal((await me.get('/api/agents/Not_An_Agent/sessions')).status, 404);
});

test('delete: a chat that is still busy gives a clear 409 after the web tried to stop it', async () => {
  const id = (await me.post(S, {})).data.session.id;
  app.fake.blockDelete = true;
  try {
    const r = await me.delete(`${S}/${id}`);
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'chat_busy');
  } finally { app.fake.blockDelete = false; }
  assert.equal((await me.delete(`${S}/${id}`)).status, 200);
});

test('messages: oldest first by default, newest first with order=desc, limits are clamped', async () => {
  const id = 'api_fake_000';
  const asc = await me.get(`${S}/${id}/messages`);
  assert.deepEqual(asc.data.data.map((m) => m.role), ['user', 'assistant']);
  const desc = await me.get(`${S}/${id}/messages?order=desc`);
  assert.deepEqual(desc.data.data.map((m) => m.role), ['assistant', 'user']);
  assert.equal((await me.get(`${S}/${id}/messages?limit=1`)).data.data.length, 1);
  assert.equal((await me.get(`${S}/${id}/messages?limit=1&offset=1`)).data.data[0].role, 'assistant');
  assert.equal((await me.get(`${S}/nope/messages`)).status, 404);
});

test('messages: very long content is trimmed for the browser', async () => {
  const id = (await me.post(S, {})).data.session.id;
  app.fake.messages.get(id).push({ id: 99_001, session_id: id, role: 'tool', content: 'x'.repeat(30_000), reasoning: 'y'.repeat(30_000), reasoning_content: 'secret', timestamp: 1 });
  const m = (await me.get(`${S}/${id}/messages`)).data.data[0];
  assert.ok(m.content.length < 12_200 && /truncated/.test(m.content));
  assert.ok(m.reasoning.length < 20_200);
  assert.ok(!('reasoning_content' in m));
});

test('preview: the first question, newest reply and newest question for the Feed home', async () => {
  const p = await me.get(`${S}/api_fake_001/preview`);
  assert.equal(p.status, 200);
  assert.match(p.data.first, /^Please explain: /);
  assert.match(p.data.reply, /^A short answer/);
  assert.match(p.data.ask, /^Please explain: /);
});

test('the agent list reports the fake as online with its provider and model', async () => {
  const r = await me.get('/api/agents');
  assert.deepEqual(r.data.agents.map((a) => [a.name, a.online, a.provider, a.model]), [[AGENT_NAME, true, 'fake-provider', 'fake-model']]);
  assert.ok(app.fake.requests.some((line) => line === 'GET /health'));
});

test('settings and models endpoints answer from the profile', async () => {
  const settings = await me.get(`/api/agents/${AGENT_NAME}/settings`);
  assert.equal(settings.status, 200);
  assert.equal(settings.data.model, 'fake-model');
  assert.equal(settings.data.coversEnabled, false);
  const models = await me.get(`/api/agents/${AGENT_NAME}/models`);
  assert.equal(models.status, 200);
  assert.ok(JSON.stringify(models.data).includes('fake-model'));
});
