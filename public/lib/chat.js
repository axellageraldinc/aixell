// Chat flow: send a message (or re-attach to a reply that is still running), read the SSE stream and map Hermes
// events onto the thread. A run belongs to one chat: it keeps streaming while another chat is open, so several
// chats can be working at once. Unknown events are ignored.
import { api, fetchRaw, toApiError, agentPath } from './api.js';
import { readSse } from './sse.js';
import { state, emit, on, sessionKey, saveLastSession, liveRun } from './state.js';
import { chatOptions, adoptNewSessionSettings, markContextStale, hadLiveSeed, clearLiveSeed, loadServedModel } from './models.js';
import { createAssistantMessage } from './stream-message.js';
import { userNode } from './message-nodes.js';
import { appendUserMessage, addLive, removeLive, dropLive, rekeyLive, loadSession, settleRun } from './messages.js';
import { approvalBlock } from './approval.js';
import { uploadFile } from './attachments.js';
import { notify } from './ui.js';
import { provisionalFrom, setProvisional } from './auto-title.js';
import { setPaused, rekeyQueue, enqueue } from './queue.js';
import { t } from './i18n.js';

// attachments: [{ id, name, kind }] from the composer. voice: a recording (File) sent with the Send button while it was
// still recording: the message is shown at once and the upload and transcription run as the first step of the reply.
// Returns false when no run could start.
export async function sendMessage({ text, attachments, voice = null }) {
  const agent = state.agent;
  if (!agent || liveRun(agent, state.sessionId)) return false;

  const ctx = newRun(agent, state.sessionId);
  if (!state.sessionId) ctx.firstTitle = provisionalFrom(text);
  ctx.userEl = appendUserMessage(ctx.key, text, voice ? [...attachments, { name: voice.name, kind: 'audio' }] : attachments);
  ctx.message = createAssistantMessage({ startMs: ctx.run.startMs });
  addLive(ctx.key, ctx.message.node);

  // Retry is only offered when the request never produced a run; it replaces the failed turn.
  ctx.retry = () => {
    removeLive(ctx.key, ctx.userEl);
    removeLive(ctx.key, ctx.message.node);
    forget(ctx);
    return sendMessage({ text, attachments, voice });
  };

  if (voice) {
    const step = ctx.message.prepare(t('chat.activity.transcribing'));
    try {
      const sent = await uploadFile(voice);
      attachments = [...attachments, sent];
      voice = null;
      step.done();
    } catch (err) {
      step.fail();
      ctx.failure(err.message);
      await conclude(ctx);
      return true;
    }
  }
  const body = { text, ...chatOptions() };
  if (state.sessionId) body.sessionId = state.sessionId;
  if (attachments.length) body.attachments = attachments.map((a) => a.id);

  try {
    ctx.controller = new AbortController();
    const res = await fetchRaw(`${agentPath(agent)}/chat`, { method: 'POST', body, headers: { Accept: 'text/event-stream' }, signal: ctx.controller.signal });
    if (!res.ok) throw await toApiError(res);
    if (await follow(res, ctx) === FINISHED) return true;
  } catch (err) {
    ctx.failure(err.message);
  }
  await conclude(ctx);
  return true;
}

// The chat was opened while its reply is still running on the server: replay the buffered events, then follow
// live. Skipped when this tab is already streaming that run.
async function resume({ sessionId, userShown }) {
  if (!state.agent || sessionId !== state.sessionId || liveRun(state.agent, sessionId)) return;
  const ctx = newRun(state.agent, sessionId);
  ctx.resumed = true;
  ctx.userShown = Boolean(userShown);
  try {
    ctx.controller = new AbortController();
    const res = await openStream(ctx, sessionId);
    if (res.status === 404) {
      // It finished in the meantime: the stored history is complete.
      forget(ctx);
      await loadSession(sessionId);
      return;
    }
    if (!res.ok) throw await toApiError(res);
    if (await follow(res, ctx) === FINISHED) return;
  } catch (err) {
    ctx.failure(err.message);
  }
  await conclude(ctx);
}

on('run:resume', resume);

function newRun(agent, sessionId) {
  const run = { agent, sessionId, runId: null, sawDone: false, failed: false, startMs: Date.now(), startedAtServer: null, skew: 0, endTs: null, startTs: null };
  clearLiveSeed(sessionKey(agent, sessionId));
  const before = state.lastPromptTokens.get(sessionKey(agent, sessionId));
  const ctx = { agent, key: sessionKey(agent, sessionId), contextBefore: before && !before.approx ? before.tokens : null, run, message: null, userEl: null, resumed: false, userShown: false, retry: null };
  ctx.failure = (reason) => {
    if (run.failed) return;
    run.failed = true;
    ensureMessage(ctx);
    const actions = [];
    if (!run.runId && ctx.retry) actions.push({ label: t('common.retry'), onClick: ctx.retry });
    if (run.sessionId) actions.push({ label: t('chat.reloadHistory'), onClick: () => loadSession(run.sessionId) });
    ctx.message.setNote(reason, { error: true, actions });
  };
  state.runs.set(ctx.key, ctx);
  emit('run:state');
  return ctx;
}

// Drops a run from the registry (the nodes stay where they are).
function forget(ctx) {
  state.runs.delete(ctx.key);
  emit('run:state');
}

// A resumed reply has no nodes yet: they are created from the replayed run.started event.
function ensureMessage(ctx) {
  if (ctx.message) return;
  ctx.message = createAssistantMessage({ startMs: ctx.run.startMs, skew: ctx.run.skew });
  addLive(ctx.key, ctx.message.node);
}

const openStream = (ctx, sessionId) => fetchRaw(`${agentPath(ctx.agent)}/sessions/${encodeURIComponent(sessionId)}/stream`, { headers: { Accept: 'text/event-stream' }, signal: ctx.controller.signal });

async function consume(res, ctx) {
  ctx.lastActivity = Date.now();
  for await (const { event, data } of readSse(res.body, () => { ctx.lastActivity = Date.now(); })) handleEvent(event, data ?? {}, ctx);
  if (!ctx.run.sawDone && !ctx.run.failed) throw new Error(t('chat.error.disconnected'));
}

// The reply keeps running on the server when this connection drops (phone in the background, a network switch),
// so the stream is reopened and replayed from the start instead of giving up. A reconnect rebuilds the message
// from the replay; only a chat that never got a session (nothing to reconnect to) or repeated failures surface an error.
const FINISHED = Symbol('finished');
const RECONNECT_TRIES = 6;

async function follow(res, ctx) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await consume(res, ctx);
      return null;
    } catch (err) {
      const sessionId = ctx.run.sessionId;
      if (!sessionId || ctx.run.failed || err.code === 'unauthorized' || attempt >= RECONNECT_TRIES) throw err;
      ctx.message?.setNote(t('chat.reconnecting'));
      await whenOnlineAndVisible(attempt);
      if (ctx.run.sessionId !== sessionId) throw err;
      // Drop what the broken attempt drew; the replay redraws it.
      if (ctx.message) { removeLive(ctx.key, ctx.message.node); ctx.message.node.remove(); }
      ctx.message = null;
      ctx.steered = null;
      ctx.segStartTs = undefined;
      ctx.resumed = true;
      ctx.userShown = true;
      ctx.run.sawDone = false;
      ctx.controller = new AbortController();
      try {
        res = await openStream(ctx, sessionId);
      } catch (openErr) {
        if (attempt + 1 >= RECONNECT_TRIES) throw openErr;
        res = { ok: false, status: 0, retry: true };
      }
      if (res.status === 404) {
        // Finished while we were away: the stored history is complete.
        forget(ctx);
        emit('sessions:reload');
        await loadSession(sessionId);
        emit('run:concluded', { key: ctx.key });
        return FINISHED;
      }
      if (res.retry) { res = { body: new ReadableStream({ start(c) { c.close(); } }) }; continue; }
      if (!res.ok) throw await toApiError(res);
    }
  }
}

// Waits (with a growing pause) until the tab is visible and the network is back, so the retry is not wasted.
async function whenOnlineAndVisible(attempt) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(300 * (attempt + 1), 3000)));
  const ready = () => document.visibilityState === 'visible' && navigator.onLine !== false;
  if (ready()) return;
  await new Promise((resolve) => {
    const check = () => { if (!ready()) return; for (const type of ['visibilitychange', 'online']) window.removeEventListener(type, check); document.removeEventListener('visibilitychange', check); resolve(); };
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
  });
}

// Back from another app: a socket the phone silently killed looks open but never delivers. If a running stream
// has been quiet for longer than the server's keep-alive interval, cut it so follow() reconnects.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  for (const ctx of state.runs.values()) {
    if (ctx.controller && ctx.run.sessionId && Date.now() - (ctx.lastActivity ?? 0) > 20_000) ctx.controller.abort();
  }
});

async function conclude(ctx) {
  const { run } = ctx;
  const from = ctx.segStartTs ?? run.startTs;
  const total = run.endTs != null && from != null ? run.endTs - from : null;
  ensureMessage(ctx);
  ctx.message.finish(total, run.endTs);
  // A chat that is not on screen keeps nothing: opening it again loads the stored turn. Only a run that is
  // still shown can be settled in place.
  const visible = ctx.key === sessionKey(state.agent, state.sessionId);
  const key = ctx.key;
  // The server may still hold the previous run's prompt size for a moment; see markContextStale.
  if (!run.failed && ctx.contextBefore != null) markContextStale(key, ctx.contextBefore);
  setPaused(key, Boolean(run.failed || ctx.stopped));
  forget(ctx);
  emit('sessions:reload');
  if (!run.failed) emit('title:watch', run.sessionId);
  emit('usage:changed');
  // Reload what the server stored for this turn (reasoning, tool output, exact timing) unless the run failed.
  if (visible && !run.failed && run.sessionId && run.startedAtServer != null) {
    await settleRun(run.sessionId, run.startedAtServer / 1000);
    emit('run:concluded', { key });
    return;
  }
  if (!visible) dropLive(ctx.key);
  emit('run:concluded', { key });
}

function handleEvent(event, data, ctx) {
  const { run } = ctx;
  const ts = typeof data.ts === 'number' ? data.ts : null;
  switch (event) {
    case 'web.run':
      run.startedAtServer = data.started_at;
      run.skew = data.now - Date.now();
      run.startMs = data.started_at - run.skew;
      break;
    case 'web.session':
      adoptSession(ctx, data.session_id);
      break;
    case 'run.started':
      run.runId = data.run_id ?? null;
      run.startTs = ts;
      if (!run.sessionId && data.session_id) run.sessionId = data.session_id;
      if (ctx.resumed && !ctx.userEl && !ctx.userShown) ctx.userEl = appendUserMessage(ctx.key, data.user_message?.content ?? '');
      ensureMessage(ctx);
      ctx.message.begin(ts);
      emit('sessions:reload');
      emit('run:state');
      break;
    case 'assistant.delta':
      splitForSteer(ctx, ts);
      ensureMessage(ctx);
      ctx.message.appendDelta(data.delta ?? '', ts);
      // The first answer means the gateway has served this conversation: ask which real model it pinned.
      if (!ctx.servedAsked) { ctx.servedAsked = true; loadServedModel(ctx.run.sessionId ?? state.sessionId); }
      break;
    case 'assistant.commentary':
      // already_streamed: the same words arrived as assistant.delta events and are on screen; drawing them again doubles them.
      if (data.already_streamed) break;
      ensureMessage(ctx);
      ctx.message.addCommentary(data.text ?? '');
      break;
    case 'assistant.completed':
      emit('run:step');
      ensureMessage(ctx);
      if (typeof data.content === 'string') ctx.message.setText(data.content);
      loadServedModel(ctx.run.sessionId ?? state.sessionId);
      if (data.interrupted) { ctx.stopped = true; ctx.message.setNote(t('chat.stopped')); }
      break;
    case 'tool.started':
      emit('run:step');
      splitForSteer(ctx, ts);
      ensureMessage(ctx);
      ctx.message.toolStarted(data.tool_name ?? 'tool', data.args ?? data.preview ?? null, ts);
      break;
    case 'tool.progress':
      if (data.tool_name === '_thinking') {
        splitForSteer(ctx, ts);
        ensureMessage(ctx);
        ctx.message.thinkingDelta(data.delta ?? '');
      }
      break;
    case 'tool.completed':
      emit('run:step');
      ctx.message?.toolDone(data.tool_name ?? 'tool', 'done', ts);
      if (ctx.steered) ctx.steered.afterTool = true;
      break;
    case 'tool.failed':
      emit('run:step');
      ctx.message?.toolDone(data.tool_name ?? 'tool', 'failed', ts);
      if (ctx.steered) ctx.steered.afterTool = true;
      break;
    case 'approval.request':
      ensureMessage(ctx);
      ctx.message.addPart(approvalBlock(data, (decision) => sendDecision(run, data, decision)));
      break;
    case 'run.completed': {
      run.endTs = ts;
      // usage.input_tokens adds up the prompts of every model call in the run: divide by the calls it made.
      const tokens = data.usage?.input_tokens;
      if (typeof tokens === 'number' && !hadLiveSeed(sessionKey(ctx.agent, run.sessionId))) {
        const calls = Math.max(1, ctx.message?.llmCalls() ?? 1);
        state.lastPromptTokens.set(sessionKey(ctx.agent, run.sessionId), { tokens: Math.round(tokens / calls), approx: calls > 1 });
      }
      emit('usage:changed');
      // A steer the agent never got to read (it finished first) is not lost: it goes first in the queue.
      if (typeof data.pending_steer === 'string' && data.pending_steer.trim()) {
        if (ctx.steered) { removeLive(ctx.key, ctx.steered.el); ctx.steered = null; }
        enqueue({ text: data.pending_steer.trim() }, { key: ctx.key, front: true });
      }
      break;
    }
    case 'done':
      run.sawDone = true;
      break;
    case 'replay.truncated':
      break;
    case 'error':
      ctx.failure(data.message ?? t('common.error.generic'));
      break;
    default:
      break;
  }
}

// The agent reads a steer right after a tool batch, so the first model activity after a finished tool is its answer
// to it: seal the message so far and continue in a new one below the user's bubble.
function splitForSteer(ctx, ts) {
  const steered = ctx.steered;
  if (!steered?.afterTool || !ctx.message) return;
  ctx.steered = null;
  steered.el.classList.remove('is-pending');
  ctx.message.finish(null, ts, { partial: true });
  ctx.segStartTs = ts;
  ctx.message = createAssistantMessage({ startMs: ts != null ? ts * 1000 - ctx.run.skew : Date.now(), skew: ctx.run.skew });
  addLive(ctx.key, ctx.message.node);
  ctx.message.begin(ts);
}

// A new chat became a real session mid-run: the run and its live nodes move to the new key. The open chat
// follows only when it is the one this run belongs to (sending in a new chat and switching away is allowed).
function adoptSession(ctx, sessionId) {
  if (ctx.firstTitle) setProvisional(sessionId, ctx.firstTitle);
  adoptNewSessionSettings(ctx.agent, sessionId);
  const follows = ctx.key === sessionKey(state.agent, state.sessionId);
  const previous = ctx.key;
  ctx.run.sessionId = sessionId;
  ctx.key = sessionKey(ctx.agent, sessionId);
  state.runs.delete(previous);
  state.runs.set(ctx.key, ctx);
  rekeyLive(previous, ctx.key);
  rekeyQueue(previous, ctx.key);
  if (follows) {
    state.sessionId = sessionId;
    saveLastSession(ctx.agent, sessionId);
    // The box that was the nameless chat now belongs to the real session: its draft moves with it.
    emit('session:adopted', { from: previous, to: ctx.key });
    emit('session:changed');
  }
  // The chat exists from now on: list it in the sidebar at once instead of when its first reply ends.
  emit('sessions:reload');
  emit('run:state');
}

function sendDecision(run, data, decision) {
  const runId = data.run_id ?? run.runId;
  if (!runId) throw new Error(t('chat.error.noRunId'));
  return api(`${agentPath(run.agent)}/runs/${encodeURIComponent(runId)}/approval`, { method: 'POST', body: { decision } });
}

// Stops the reply of the chat that is open.
export async function stopRun() {
  const ctx = liveRun(state.agent, state.sessionId);
  if (!ctx?.run.runId) return;
  try {
    await api(`${agentPath(ctx.agent)}/runs/${encodeURIComponent(ctx.run.runId)}/stop`, { method: 'POST' });
  } catch (err) {
    notify(err.message);
  }
}

// Slips text into the reply that is running in the chat that is open. False when the agent cannot take it now.
export async function steerRun(text) {
  const ctx = liveRun(state.agent, state.sessionId);
  if (!ctx?.run.runId) return false;
  try {
    await api(`${agentPath(ctx.agent)}/runs/${encodeURIComponent(ctx.run.runId)}/steer`, { method: 'POST', body: { text } });
  } catch (err) {
    if (err.status === 409) return false;
    notify(err.message);
    return false;
  }
  // The message shows up as a bubble at once; the reply continues in a new message below it as soon as the agent has read it.
  const el = userNode(text, null);
  el.classList.add('is-pending');
  ctx.steered = { text, el, afterTool: false };
  addLive(ctx.key, el);
  return true;
}
