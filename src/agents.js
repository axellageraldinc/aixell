import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './http.js';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const WANTED_KEYS = new Set(['API_SERVER_ENABLED', 'API_SERVER_PORT', 'API_SERVER_KEY', 'API_SERVER_HOST']);

// Reads ONLY the API_SERVER_* lines: the rest of a profile's .env holds unrelated secrets.
function readApiSettings(envFile) {
  const found = {};
  let text;
  try { text = fs.readFileSync(envFile, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && WANTED_KEYS.has(match[1])) found[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  const port = Number(found.API_SERVER_PORT);
  if (found.API_SERVER_ENABLED !== 'true' || !found.API_SERVER_KEY || !Number.isInteger(port)) return null;
  return { port, key: found.API_SERVER_KEY };
}

// Minimal reader for the `model:` block of a profile's config.yaml (default model + provider).
function readModelBlock(configFile) {
  let text;
  try { text = fs.readFileSync(configFile, 'utf8'); } catch { return {}; }
  const result = {};
  let inside = false;
  for (const line of text.split('\n')) {
    if (/^model:\s*(#.*)?$/.test(line)) { inside = true; continue; }
    if (inside && /^\S/.test(line)) break;
    const match = inside && line.match(/^\s{2}(default|provider|base_url):\s*"?([^"#\n]+?)"?\s*(#.*)?$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function discover() {
  const homes = [{ name: 'default', home: config.hermesRoot }];
  const profilesDir = path.join(config.hermesRoot, 'profiles');
  let entries = [];
  try { entries = fs.readdirSync(profilesDir, { withFileTypes: true }); } catch { /* no profiles yet */ }
  for (const entry of entries) {
    if (entry.isDirectory() && NAME_PATTERN.test(entry.name)) homes.push({ name: entry.name, home: path.join(profilesDir, entry.name) });
  }
  const agents = [];
  for (const { name, home } of homes) {
    if (!config.agentNames.includes(name)) continue;
    const api = readApiSettings(path.join(home, '.env'));
    if (!api) continue;
    const model = readModelBlock(path.join(home, 'config.yaml'));
    agents.push({ name, home, port: api.port, key: api.key, provider: model.provider || null, model: model.default || null, baseUrl: model.base_url || null });
  }
  return agents;
}

// Reads one named variable from a profile's .env. Used only for provider keys that the web needs to ask the provider
// itself (the live model list); the value never leaves the server.
export function readEnvValue(agent, name) {
  try {
    for (const line of fs.readFileSync(path.join(agent.home, '.env'), 'utf8').split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && match[1] === name) return match[2].trim().replace(/^["']|["']$/g, '') || null;
    }
  } catch { /* no .env */ }
  return null;
}

let cache = { at: 0, agents: [] };
export function listAgentDefinitions() {
  if (Date.now() - cache.at > 10_000) cache = { at: Date.now(), agents: discover() };
  return cache.agents;
}

export function getAgent(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new HttpError(404, 'Agent not found.', 'agent_not_found');
  const agent = listAgentDefinitions().find((candidate) => candidate.name === name);
  if (!agent) throw new HttpError(404, 'Agent not found.', 'agent_not_found');
  return agent;
}

export async function agentFetch(agent, urlPath, { method = 'GET', headers = {}, body, signal, timeoutMs = 30_000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(`http://127.0.0.1:${agent.port}${urlPath}`, {
      method, body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${agent.key}`, ...headers },
    });
  } catch (error) {
    throw new HttpError(502, `Agent "${agent.name}" is unreachable.`, 'agent_unreachable', { detail: error.name });
  }
}

export async function agentJson(agent, urlPath, options) {
  const response = await agentFetch(agent, urlPath, options);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!response.ok) {
    const message = data?.error?.message || `The agent replied ${response.status}.`;
    throw new HttpError(response.status >= 500 ? 502 : response.status, message, data?.error?.code || 'agent_error');
  }
  return data;
}

export async function isOnline(agent) {
  try {
    const response = await agentFetch(agent, '/health', { timeoutMs: 1500 });
    return response.ok;
  } catch { return false; }
}

export const publicAgent = (agent, online) => ({
  name: agent.name, label: agent.name, online, isDefault: agent.name === 'default', provider: agent.provider, model: agent.model,
});
