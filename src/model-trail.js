// Which real model a routed gateway served, over time, per chat. The gateway pins a model per conversation and may
// move the pin between turns or between the model calls of one turn; the server samples it while a reply runs and
// keeps each change here, so a reloaded chat can still name the model(s) behind every reply.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.dataDir, 'session-models.json');
const MAX_PER_CHAT = 300;
let trails = {};
try { trails = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run */ }

const keyOf = (agentName, sessionId) => `${agentName}:${sessionId}`;

function persist() {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(trails), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// [{ ts (seconds), model }], oldest first.
export const getTrail = (agentName, sessionId) => trails[keyOf(agentName, sessionId)] ?? [];

// Appends when the model differs from the last one noted. Returns true when something was recorded.
export function noteModel(agentName, sessionId, model, ts = Date.now() / 1000) {
  if (typeof model !== 'string' || !model) return false;
  const key = keyOf(agentName, sessionId);
  const trail = trails[key] ?? (trails[key] = []);
  if (trail.at(-1)?.model === model) return false;
  trail.push({ ts, model });
  if (trail.length > MAX_PER_CHAT) trail.splice(0, trail.length - MAX_PER_CHAT);
  persist();
  return true;
}

export function forgetTrail(agentName, sessionId) {
  if (delete trails[keyOf(agentName, sessionId)]) persist();
}
