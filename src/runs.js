// Registry of chat runs in flight. The upstream stream is pumped independently of any browser, and every
// raw chunk is buffered, so a page that reloads mid-reply can attach again and replay what it missed.

import { config } from './config.js';

const BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const runs = new Map();

const keyOf = (agentName, sessionId) => `${agentName}:${sessionId}`;
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// onOrphan(run) is called once when nobody has watched the run for config.orphanStopMinutes.
export function startRun(agentName, sessionId, startedAt = Date.now(), onOrphan = null) {
  const key = keyOf(agentName, sessionId);
  const run = { key, sessionId, startedAt, chunks: [], bytes: 0, truncated: false, subs: new Map(), ended: false, timer: null, runId: null, usageInput: null, carry: '', lastViewerAt: Date.now(), orphaned: false };
  run.timer = setInterval(() => {
    for (const res of run.subs.keys()) res.write(': ping\n\n');
    if (run.subs.size) run.lastViewerAt = Date.now();
    const limitMs = config.orphanStopMinutes * 60_000;
    if (limitMs > 0 && onOrphan && !run.orphaned && !run.subs.size && Date.now() - run.lastViewerAt > limitMs) {
      run.orphaned = true;
      onOrphan(run);
    }
  }, HEARTBEAT_MS);
  runs.set(key, run);
  return run;
}

export const findRun = (agentName, sessionId) => runs.get(keyOf(agentName, sessionId)) ?? null;

export const runInfo = (agentName, sessionId) => {
  const run = findRun(agentName, sessionId);
  return run ? { startedAt: run.startedAt } : null;
};

export function publish(run, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  // Scan for the run id and the usage block; the carry keeps a match that is split across two chunks.
  const text = run.carry + buffer.toString('latin1');
  if (!run.runId) run.runId = text.match(/"run_id": "(run_[a-f0-9]+)"/)?.[1] ?? null;
  for (const hit of text.matchAll(/"usage": \{"input_tokens": (\d+)/g)) run.usageInput = Number(hit[1]);
  run.carry = text.slice(-64);
  if (run.bytes + buffer.length <= BUFFER_LIMIT_BYTES) {
    run.chunks.push(buffer);
    run.bytes += buffer.length;
  } else {
    run.truncated = true;
  }
  for (const res of run.subs.keys()) res.write(buffer);
}

// Writes the replay, then follows live. Resolves when the response closes or the run ends.
export function attach(run, res) {
  res.write(frame('web.run', { started_at: run.startedAt, now: Date.now(), session_id: run.sessionId }));
  if (run.truncated) res.write(frame('replay.truncated', {}));
  for (const chunk of run.chunks) res.write(chunk);
  if (run.ended) { res.end(); return Promise.resolve(); }
  return new Promise((resolve) => {
    run.subs.set(res, resolve);
    res.once('close', () => { run.subs.delete(res); run.lastViewerAt = Date.now(); resolve(); });
  });
}

export function endRun(run) {
  run.ended = true;
  clearInterval(run.timer);
  runs.delete(run.key);
  for (const [res, resolve] of run.subs) { res.end(); resolve(); }
  run.subs.clear();
  run.chunks = [];
}

export const sseFrame = frame;
