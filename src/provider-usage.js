import { agentJson } from './agents.js';
import { providersFor } from './providers/compat.js';

// Subscription usage of the agent's provider (OpenCode Go: rolling / weekly / monthly windows). Hermes already asks the
// provider for it and lists it with the model inventory, so no provider key is needed here.
const TTL_MS = 30_000;
const STALE_MS = 10 * 60_000;
const cache = new Map();
const inflight = new Map();

// Fresh for 30 s; up to 10 min old it is served at once while a refresh runs in the background (the lookup is slow).
export async function getProviderUsage(agent, { fresh = false } = {}) {
  const hit = cache.get(agent.name);
  const age = fresh ? Infinity : hit ? Date.now() - hit.at : Infinity;
  if (age < TTL_MS) return hit.data;
  if (!inflight.has(agent.name)) {
    inflight.set(agent.name, fetchUsage(agent).finally(() => inflight.delete(agent.name)));
  }
  if (!fresh && age < STALE_MS) { inflight.get(agent.name).catch(() => {}); return hit.data; }
  return inflight.get(agent.name);
}

async function fetchUsage(agent) {
  const catalog = providersFor(agent).get('models');
  if (catalog?.usage) {
    const data = await catalog.usage({ provider: agent.provider, currentModel: agent.model });
    cache.set(agent.name, { at: Date.now(), data });
    return data;
  }
  const options = await agentJson(agent, '/api/model/options?include_unconfigured=false', { timeoutMs: 20_000 });
  const entry = (options?.providers ?? []).find((p) => p.slug === agent.provider);
  const windows = (entry?.usage?.windows ?? [])
    .filter((w) => Number.isFinite(w?.used_percent))
    .map((w) => ({ label: String(w.label ?? ''), usedPercent: w.used_percent, resetsAt: w.resets_at ?? null }));
  const data = { provider: agent.provider, name: entry?.name ?? agent.provider, windows };
  cache.set(agent.name, { at: Date.now(), data });
  return data;
}
