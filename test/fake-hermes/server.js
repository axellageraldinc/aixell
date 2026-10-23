// A fake Hermes Agent API for tests: in-memory sessions and messages, a scripted chat stream, and the few other endpoints
// the web app calls (health, models, runs). It listens on 127.0.0.1 and, unless told otherwise, on a random free port.
//
//   import { startFakeHermes } from './test/fake-hermes/server.js';
//   const fake = await startFakeHermes();   // { port, key, url, requests, sessions, close() }
//
// Run on its own: node test/fake-hermes/server.js [port]
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FAKE_KEY = 'fake-agent-key';
export const REPLY_TEXT = 'This is the scripted reply of the fake agent.';
const SAMPLE = fileURLToPath(new URL('../../docs/sse-sample.txt', import.meta.url));

const TOPICS = ['Pasta recipes', 'Database transactions', 'Laptop prices', 'Train timetable', 'Movie reviews', 'Learning guitar', 'Saving electricity', 'Queues compared', 'Holiday plan', 'Coffee and health'];

// The web app finds the run id and the usage block in the raw bytes with a regex that expects `"key": value` (a space after the
// colon), the way Python's json.dumps writes it. JSON.stringify does not, so frames are written with the spaces added.
const pyJson = (value) => JSON.stringify(value).replace(/"(run_id|input_tokens|usage)":/g, '"$1": ');
const frame = (event, data) => `event: ${event}\ndata: ${pyJson(data)}\n\n`;

function message(sessionId, id, role, content, timestamp) {
  return {
    id, session_id: sessionId, role, content, tool_call_id: null, tool_calls: null, tool_name: null, timestamp, token_count: null,
    finish_reason: role === 'assistant' ? 'stop' : null, reasoning: null, reasoning_content: null, display_kind: null,
  };
}

// options: port (0 = random), sessions (how many canned sessions), replyDelayMs (pause between stream frames),
// replaySample (stream docs/sse-sample.txt instead of the generated reply), failChat (answer the chat call with this status).
export async function startFakeHermes(options = {}) {
  const { port = 0, sessionCount = 25, replyDelayMs = 0, replaySample = false } = options;
  const state = {
    key: FAKE_KEY, requests: [], sessions: new Map(), messages: new Map(), chatBodies: [], runs: [], stopped: [], steered: [], approvals: [],
    failChat: options.failChat ?? null, blockDelete: false, dropConnections: false, replyDelayMs, replaySample,
  };
  let sessionSeq = 1, messageSeq = 1000, runSeq = 1;
  const now = () => Date.now() / 1000;

  function addSession(id, title, started, pairs) {
    const rows = pairs.map(([role, content], index) => message(id, messageSeq++, role, content, started + index));
    state.messages.set(id, rows);
    state.sessions.set(id, {
      id, source: 'api_server', user_id: null, model: 'fake-model', title, started_at: started, ended_at: null, end_reason: null,
      message_count: rows.length, tool_call_count: 0, input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0,
      reasoning_tokens: 0, estimated_cost_usd: 0, actual_cost_usd: null, api_call_count: 1, parent_session_id: null,
      last_active: started + rows.length, preview: String(pairs[0]?.[1] ?? '').slice(0, 60), pinned: false, archived: false, hidden: false,
    });
    return state.sessions.get(id);
  }
  for (let i = 0; i < sessionCount; i++) {
    const topic = TOPICS[i % TOPICS.length] + (i >= TOPICS.length ? ` ${Math.floor(i / TOPICS.length) + 1}` : '');
    addSession(`api_fake_${String(i).padStart(3, '0')}`, topic, now() - i * 5400, [['user', `Please explain: ${topic}`], ['assistant', `A short answer about ${topic}.\n\n- point one\n- point two`]]);
  }
  // A session that came from another platform: the web app must refuse to edit it.
  addSession('tg_fake_001', 'From elsewhere', now() - 99_999, [['user', 'hello'], ['assistant', 'hi']]).source = 'telegram';

  const readBody = (req) => new Promise((resolve) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts).toString('utf8'))); });
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const wrap = (session) => ({ object: 'hermes.session', session });
  const gone = (res) => send(res, 404, { error: { message: 'No such session.', code: 'not_found' } });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function streamChat(req, res, session) {
    const body = JSON.parse((await readBody(req)) || '{}');
    state.chatBodies.push({ sessionId: session.id, body });
    if (state.failChat) return send(res, state.failChat, { error: { message: 'The fake agent refused.', code: 'fake_refusal' } });
    const input = body.input;
    const text = typeof input === 'string' ? input : (Array.isArray(input) ? input.map((part) => part?.text ?? '').join(' ') : '');
    const runId = `run_${(runSeq++).toString(16).padStart(32, '0')}`;
    state.runs.push(runId);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    const frames = [];
    if (state.replaySample) {
      // Replays the recorded stream as it is (its run id and session id are the recording's own).
      frames.push(...fs.readFileSync(SAMPLE, 'utf8').split('\n\n').filter(Boolean).map((chunk) => `${chunk}\n\n`));
    } else {
      frames.push(frame('run.started', { run_id: runId, session_id: session.id, user_message: { role: 'user', content: text } }));
      frames.push(frame('message.started', { message: { id: 'msg_fake', role: 'assistant' }, run_id: runId }));
      for (const word of REPLY_TEXT.split(' ')) frames.push(frame('assistant.delta', { delta: `${word} `, run_id: runId }));
      frames.push(frame('assistant.completed', { content: REPLY_TEXT, run_id: runId }));
      frames.push(frame('run.completed', { run_id: runId, usage: { input_tokens: 120, output_tokens: 12 } }));
      frames.push(frame('done', {}));
    }
    for (const chunk of frames) {
      res.write(chunk);
      if (state.replyDelayMs) await sleep(state.replyDelayMs);
    }
    res.end();
    if (!state.replaySample) {
      const rows = state.messages.get(session.id);
      rows.push(message(session.id, messageSeq++, 'user', text, now()), message(session.id, messageSeq++, 'assistant', REPLY_TEXT, now()));
      Object.assign(session, { message_count: rows.length, last_active: now(), api_call_count: session.api_call_count + 1, preview: text.slice(0, 60) });
      if (!session.title) session.title = text.slice(0, 40) || 'New chat';
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const m = req.method;
    state.requests.push(`${m} ${p}${url.search}`);
    if (state.dropConnections) return req.socket.destroy(); // simulates an agent that is down
    try {
      if (p === '/health') return send(res, 200, { status: 'ok', platform: 'hermes-agent', version: 'fake' });
      // A stand-in for the model provider named in the fake profile's config.yaml (its base_url points at this server).
      if (p === '/v1/models') return send(res, 200, { data: [{ id: 'fake-model' }] });
      if (p === '/v1/chat/completions') return send(res, 200, { choices: [{ message: { content: 'A scripted completion.' } }] });
      if (req.headers.authorization !== `Bearer ${state.key}`) return send(res, 401, { error: { message: 'Bad key.', code: 'unauthorized' } });

      if (p === '/api/model/options') {
        return send(res, 200, { providers: [{ slug: 'fake-provider', name: 'Fake provider', is_current: true, is_user_defined: false, models: ['fake-model'], total_models: 1, source: 'hermes', authenticated: true, capabilities: { 'fake-model': { fast: false, reasoning: true } } }] });
      }
      if (p === '/api/sessions' && m === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 20);
        const offset = Number(url.searchParams.get('offset') || 0);
        const source = url.searchParams.get('source');
        const all = [...state.sessions.values()].filter((s) => !source || s.source === source).sort((a, b) => b.last_active - a.last_active);
        return send(res, 200, { object: 'list', data: all.slice(offset, offset + limit), has_more: offset + limit < all.length, total: all.length });
      }
      if (p === '/api/sessions' && m === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const session = addSession(`api_fake_new_${sessionSeq++}`, body.title ?? null, now(), []);
        return send(res, 200, wrap(session));
      }
      let hit;
      if ((hit = p.match(/^\/api\/sessions\/([^/]+)\/messages$/)) && m === 'GET') {
        const rows = state.messages.get(hit[1]);
        if (!rows) return gone(res);
        const limit = Number(url.searchParams.get('limit') || 50);
        const offset = Number(url.searchParams.get('offset') || 0);
        const ordered = ['latest', 'newest'].includes(url.searchParams.get('order')) ? [...rows].reverse() : rows;
        return send(res, 200, { object: 'list', session_id: hit[1], data: ordered.slice(offset, offset + limit), has_more: offset + limit < rows.length });
      }
      if ((hit = p.match(/^\/api\/sessions\/([^/]+)\/chat\/stream$/)) && m === 'POST') {
        const session = state.sessions.get(hit[1]);
        return session ? await streamChat(req, res, session) : gone(res);
      }
      if ((hit = p.match(/^\/api\/sessions\/([^/]+)$/))) {
        const session = state.sessions.get(hit[1]);
        if (!session) return gone(res);
        if (m === 'GET') return send(res, 200, wrap(session));
        if (m === 'PATCH') {
          const body = JSON.parse((await readBody(req)) || '{}');
          if (body.title !== undefined) session.title = body.title;
          return send(res, 200, wrap(session));
        }
        if (m === 'DELETE') {
          if (state.blockDelete) return send(res, 409, { error: { message: 'A turn is active.', code: 'session_active_turn' } });
          state.sessions.delete(hit[1]);
          state.messages.delete(hit[1]);
          return send(res, 200, { ok: true });
        }
      }
      if ((hit = p.match(/^\/v1\/runs\/([^/]+)\/(stop|steer|approval)$/)) && m === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        (hit[2] === 'stop' ? state.stopped : hit[2] === 'steer' ? state.steered : state.approvals).push({ run: hit[1], body });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: { message: `The fake agent has no route ${m} ${p}.`, code: 'not_found' } });
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: { message: String(error.message), code: 'fake_error' } });
      else res.destroy();
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const bound = server.address().port;
  return Object.assign(state, {
    port: bound, url: `http://127.0.0.1:${bound}`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const fake = await startFakeHermes({ port: Number(process.argv[2] || 0) });
  console.log(`fake hermes agent on ${fake.url} (key: ${FAKE_KEY})`);
}
