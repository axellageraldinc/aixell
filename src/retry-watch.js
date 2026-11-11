import fs from 'node:fs';
import path from 'node:path';

// While a reply waits, the agent may be retrying a failing model call (a 503 from the provider, a rate limit). The agent's
// API does not stream that, but it logs it with the chat's id. This reads those lines (best effort, read-only) so the chat
// can say what is happening instead of sitting silent. Anything that does not parse is ignored; the log is never shown raw.
const TAIL_BYTES = 256 * 1024;
const LINE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)[,.]\d+ \w+ \[([^\]]+)\] \S+: (.*)$/;
const REASON_MAX = 200;

const clip = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);

// text: the end of the log. Returns the retry state of the chat after `sinceMs`, or null when the last model call went through.
//   { attempt, max, waitSeconds, model, reason, recovery: { cycle, of } | null }
export function parseRetryState(text, sessionId, sinceMs = 0) {
  let state = null;
  for (const raw of String(text).split('\n')) {
    const m = LINE.exec(raw);
    if (!m || m[7] !== sessionId) continue;
    const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    if (at < sinceMs) continue;
    const body = m[8];
    let hit;
    if ((hit = /^API call failed \(attempt (\d+)\/(\d+)\).*?\bmodel=(\S+)(?: summary=(.*))?$/.exec(body))) {
      state = { attempt: +hit[1], max: +hit[2], waitSeconds: null, model: hit[3], reason: clip(hit[4]), recovery: state?.recovery ?? null };
    } else if ((hit = /^Retrying API call in ([\d.]+)s \(attempt (\d+)\/(\d+)\)/.exec(body)) && state) {
      state = { ...state, attempt: +hit[2], max: +hit[3], waitSeconds: Math.round(+hit[1]) };
    } else if ((hit = /auto-recovery cycle (\d+)\/(\d+), retrying in (\d+)s/.exec(body))) {
      state = { ...(state ?? { attempt: 0, max: 0, model: null, reason: clip(body.split(' — ')[0]) }), waitSeconds: +hit[3], recovery: { cycle: +hit[1], of: +hit[2] } };
    } else if (/^API call #\d+: /.test(body)) {
      state = null; // a call went through: the trouble is over
    }
  }
  return state;
}

export function readRetryState(agent, sessionId, sinceMs) {
  try {
    const file = path.join(agent.home, 'logs', 'agent.log');
    const { size } = fs.statSync(file);
    const length = Math.min(size, TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return parseRetryState(buffer.toString('utf8'), sessionId, sinceMs);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
