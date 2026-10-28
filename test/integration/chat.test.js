// The chat stream proxy, end to end against the fake agent: streaming, replay, run control, validation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, waitFor, AGENT_NAME } from '../helpers/boot.js';
import { REPLY_TEXT } from '../fake-hermes/server.js';
import { parseSse } from '../helpers/sse.js';

let app, me;
before(async () => { app = await boot(); me = await app.login(); });
after(async () => { await app.stop(); });

const CHAT = `/api/agents/${AGENT_NAME}/chat`;
const send = async (body, client = me) => {
  const response = await client.raw('POST', CHAT, { json: body });
  return { response, text: response.headers.get('content-type')?.includes('event-stream') ? await response.text() : null, status: response.status };
};

test('a new chat creates a session, streams the reply and stores the exchange', async () => {
  const { response, text } = await send({ text: 'Hello agent' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const events = parseSse(text);
  const names = events.map((e) => e.event);
  assert.equal(names[0], 'web.run');
  assert.equal(names[1], 'web.session', 'a new chat tells the page its session id first');
  for (const expected of ['run.started', 'message.started', 'assistant.delta', 'assistant.completed', 'run.completed', 'done']) assert.ok(names.includes(expected), expected);
  const sessionId = events[1].data.session_id;
  assert.match(sessionId, /^api_fake_new_/);
  assert.equal(events.filter((e) => e.event === 'assistant.delta').map((e) => e.data.delta).join('').trim(), REPLY_TEXT);
  assert.equal(events.find((e) => e.event === 'assistant.completed').data.content, REPLY_TEXT);

  const forwarded = app.fake.chatBodies.at(-1);
  assert.equal(forwarded.sessionId, sessionId);
  assert.equal(forwarded.body.input, 'Hello agent');
  assert.match(forwarded.body.system_message, /web/i, 'the web hint rides along');

  const messages = await me.get(`/api/agents/${AGENT_NAME}/sessions/${sessionId}/messages`);
  assert.deepEqual(messages.data.data.map((m) => m.role), ['user', 'assistant']);
  assert.equal(messages.data.data[1].content, REPLY_TEXT);
});

test('a follow-up in an existing chat reuses the session and passes the model options through', async () => {
  const first = parseSse((await send({ text: 'first' })).text);
  const sessionId = first[1].data.session_id;
  const { text } = await send({ text: 'second', sessionId, model: 'fake-model', provider: 'fake-provider', reasoningEffort: 'high', serviceTier: 'priority' });
  const names = parseSse(text).map((e) => e.event);
  assert.ok(!names.includes('web.session'), 'no new session event for an existing chat');
  const body = app.fake.chatBodies.at(-1).body;
  assert.equal(body.model, 'fake-model');
  assert.equal(body.provider, 'fake-provider');
  assert.deepEqual(body.model_options, { reasoning_effort: 'high', service_tier: 'priority' });
  const settings = await me.get(`/api/agents/${AGENT_NAME}/sessions/${sessionId}`);
  assert.equal(settings.data.session.web_settings.model, 'fake-model', 'the choice is remembered for the chat');
});

test('the visualize switch adds the diagram instructions to the system message only when asked', async () => {
  await send({ text: 'plain' });
  const plain = app.fake.chatBodies.at(-1).body.system_message;
  await send({ text: 'draw', visualize: true });
  const visual = app.fake.chatBodies.at(-1).body.system_message;
  assert.ok(visual.length > plain.length + 500);
});

test('a spoken turn tells the agent its answer will be read aloud, for that turn only', async () => {
  await send({ text: 'typed' });
  const typed = app.fake.chatBodies.at(-1).body.system_message;
  await send({ text: 'said', spoken: true });
  const said = app.fake.chatBodies.at(-1).body.system_message;
  assert.ok(!/read aloud/.test(typed));
  assert.match(said, /read aloud/);
  await send({ text: 'typed again' });
  assert.ok(!/read aloud/.test(app.fake.chatBodies.at(-1).body.system_message), 'the next typed turn is unchanged');
});

test('input is validated before the agent is bothered', async () => {
  const before = app.fake.chatBodies.length;
  const cases = [
    [{}, 400, 'empty_message'],
    [{ text: '   ' }, 400, 'empty_message'],
    [{ text: 'x'.repeat(200_001) }, 413, 'too_large'],
    [{ text: 'hi', model: 'bad model!' }, 400, 'bad_model'],
    [{ text: 'hi', provider: 5 }, 400, 'bad_model'],
    [{ text: 'hi', reasoningEffort: 'turbo' }, 400, 'bad_effort'],
    [{ text: 'hi', serviceTier: 'ultra' }, 400, 'bad_tier'],
    [{ text: 'hi', attachments: Array(11).fill('a'.repeat(24)) }, 400, 'too_many_attachments'],
    [{ text: 'hi', attachments: ['nope'] }, 404, 'upload_not_found'],
    [{ text: 'hi', sessionId: 'no_such_session' }, 404, 'not_found'],
    [{ text: 'hi', sessionId: '../etc' }, 400, 'bad_id'],
  ];
  for (const [body, status, code] of cases) {
    const r = await me.post(CHAT, body);
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 60));
    assert.equal(r.data.error.code, code);
  }
  assert.equal(app.fake.chatBodies.length, before);
});

test('chat needs a session and the CSRF token', async () => {
  assert.equal((await app.client().post(CHAT, { text: 'hi' })).status, 401);
  assert.equal((await me.call('POST', CHAT, { json: { text: 'hi' }, csrf: '' })).status, 403);
  assert.equal((await me.post('/api/agents/not-an-agent/chat', { text: 'hi' })).status, 404);
});

test('an error from the agent is passed on with its message and code', async () => {
  app.fake.failChat = 400;
  try {
    const r = await me.post(CHAT, { text: 'hi' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'fake_refusal');
    assert.equal(r.data.error.message, 'The fake agent refused.');
    app.fake.failChat = 503;
    assert.equal((await me.post(CHAT, { text: 'hi' })).status, 502, 'a 5xx from the agent is a 502 from here');
  } finally { app.fake.failChat = null; }
});

test('the recorded stream (docs/sse-sample.txt) is proxied with all its events', async () => {
  app.fake.replaySample = true;
  try {
    const { text } = await send({ text: 'replay' });
    const names = parseSse(text).map((e) => e.event);
    assert.equal(names[0], 'web.run');
    for (const expected of ['run.started', 'assistant.delta', 'tool.progress', 'assistant.completed', 'run.completed', 'done']) assert.ok(names.includes(expected), expected);
    assert.match(text, /"run_id": "run_a042fbd05ef84b819fdf6033f7f8a3ca"/);
  } finally { app.fake.replaySample = false; }
});

test('an agent that is down gives a clear 502', async () => {
  const dead = await boot();
  const client = await dead.login();
  dead.fake.dropConnections = true; // closing the port would work too, but a refused connection can take seconds to be reported
  const r = await client.post(CHAT, { text: 'hello' });
  assert.equal(r.status, 502);
  assert.equal(r.data.error.code, 'agent_unreachable');
  const agents = await client.get('/api/agents');
  assert.equal(agents.data.agents[0].online, false);
  await dead.stop();
});

test('a reply in progress can be re-attached after the page was closed, and a second send is refused', async () => {
  const slow = await boot({ fake: { replyDelayMs: 120 } });
  try {
    const client = await slow.login();
    const url = `/api/agents/${AGENT_NAME}/chat`;
    const controller = new AbortController();
    const first = await fetch(slow.base + url, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Origin: slow.base, Cookie: client.cookie, 'X-CSRF-Token': client.csrf },
      body: JSON.stringify({ text: 'slow one' }),
    });
    const reader = first.body.getReader();
    let seen = '';
    while (!/web\.session/.test(seen)) seen += new TextDecoder().decode((await reader.read()).value);
    const sessionId = /"session_id":"([^"]+)"/.exec(seen)[1];
    controller.abort(); // the tab is closed mid-reply; the run goes on server side
    await reader.cancel().catch(() => {});

    const busy = await client.post(url, { text: 'again', sessionId });
    assert.equal(busy.status, 409);
    assert.equal(busy.data.error.code, 'run_in_progress');

    const info = await client.get(`/api/agents/${AGENT_NAME}/sessions/${sessionId}`);
    assert.ok(info.data.session.web_run, 'the session says a run is in flight');

    const replay = await client.raw('GET', `/api/agents/${AGENT_NAME}/sessions/${sessionId}/stream`);
    assert.equal(replay.status, 200);
    const events = parseSse(await replay.text());
    assert.equal(events[0].event, 'web.run');
    assert.ok(events.some((e) => e.event === 'assistant.delta'), 'the replay includes what was missed');
    assert.equal(events.at(-1).event, 'done', 'and follows the run to its end');

    const gone = await client.get(`/api/agents/${AGENT_NAME}/sessions/${sessionId}/stream`);
    assert.equal(gone.status, 404);
    assert.equal(gone.data.error.code, 'no_run');
  } finally { await slow.stop(); }
});

test('run control: stop, steer and approval are forwarded with validation', async () => {
  const run = `run_${'a'.repeat(32)}`;
  assert.equal((await me.post(`/api/agents/${AGENT_NAME}/runs/not-a-run/stop`, {})).status, 400);
  assert.equal((await me.post(`/api/agents/${AGENT_NAME}/runs/${run}/stop`, {})).status, 200);
  assert.equal(app.fake.stopped.at(-1).run, run);

  assert.equal((await me.post(`/api/agents/${AGENT_NAME}/runs/${run}/steer`, { text: '  ' })).status, 400);
  assert.equal((await me.post(`/api/agents/${AGENT_NAME}/runs/${run}/steer`, { text: 'x'.repeat(8001) })).status, 400);
  assert.equal((await me.post(`/api/agents/${AGENT_NAME}/runs/${run}/steer`, { text: ' use the other file ' })).status, 200);
  assert.deepEqual(app.fake.steered.at(-1).body, { input: 'use the other file' });

  for (const choice of ['always', 'session', undefined, 'ONCE']) {
    assert.equal((await me.post(`/api/agents/${AGENT_NAME}/runs/${run}/approval`, { choice })).status, 400, String(choice));
  }
  assert.equal((await me.post(`/api/agents/${AGENT_NAME}/runs/${run}/approval`, { choice: 'once', requestId: 'req-1' })).status, 200);
  assert.deepEqual(app.fake.approvals.at(-1).body, { choice: 'once', request_id: 'req-1' });
  assert.equal((await me.post(`/api/agents/${AGENT_NAME}/runs/${run}/approval`, { decision: 'deny' })).status, 200);
  await waitFor(() => app.fake.approvals.length === 2);
});
