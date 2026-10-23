import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Model / effort / speed last used in each web chat, so reopening it (or another device) shows the same choice.
const file = path.join(config.dataDir, 'session-settings.json');
const FIELDS = ['model', 'provider', 'reasoningEffort', 'serviceTier'];
// Visualize is a per-chat switch, not a model choice: it is stored as a boolean next to them.
const FLAGS = ['visualize'];
let store = {};
try { store = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run */ }

const keyOf = (agentName, sessionId) => `${agentName}:${sessionId}`;

function persist() {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export const getSettings = (agentName, sessionId) => store[keyOf(agentName, sessionId)] ?? null;

export function saveSettings(agentName, sessionId, body) {
  const next = {};
  for (const field of FIELDS) if (typeof body[field] === 'string') next[field] = body[field];
  for (const flag of FLAGS) if (typeof body[flag] === 'boolean') next[flag] = body[flag];
  const key = keyOf(agentName, sessionId);
  if (JSON.stringify(store[key]) === JSON.stringify(next)) return;
  store[key] = next;
  persist();
}

// Latest prompt size per chat (tokens), recorded when a run ends. approx = averaged over several calls.
const contextFile = path.join(config.dataDir, 'session-context.json');
let contexts = {};
try { contexts = JSON.parse(fs.readFileSync(contextFile, 'utf8')) || {}; } catch { /* first run */ }

function persistContexts() {
  const temporary = `${contextFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(contexts), { mode: 0o600 });
  fs.renameSync(temporary, contextFile);
}

export const getContext = (agentName, sessionId) => contexts[keyOf(agentName, sessionId)] ?? null;

export function saveContext(agentName, sessionId, value) {
  contexts[keyOf(agentName, sessionId)] = value;
  persistContexts();
}

export function forgetSettings(agentName, sessionId) {
  if (delete store[keyOf(agentName, sessionId)]) persist();
  if (delete contexts[keyOf(agentName, sessionId)]) persistContexts();
}
