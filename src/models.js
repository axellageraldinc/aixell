import fs from 'node:fs';
import path from 'node:path';
import { config, EFFORT_LEVELS, SERVICE_TIERS } from './config.js';
import { readEnvValue } from './agents.js';
import { hiddenCheck } from './hidden-models.js';
import { providersFor } from './providers/compat.js';

// OpenCode Go subscription limits ($10/month plan), approximate, from https://opencode.ai/docs/go (read 14 Oct 2026).
// Real usage can differ; models that are not listed are deliberately left null (never guessed).
const GO_QUOTAS = {
  'glm-5.3-flash': [60, 31580], 'glm-5.3': [15, 1080], 'kimi-k3': [15, 490],
  'deepseek-v4.1-flash': [80, 173330], 'deepseek-v4-pro': [15, 5200],
  'mimo-v2.6-flash': [60, 150400], 'mimo-v2.6-pro': [15, 16300], 'mimo-v2.5': [60, 150400], 'mimo-v2.5-pro': [15, 16300],
};

export const readJsonCached = (() => {
  const cache = new Map();
  return (file) => {
    try {
      const { mtimeMs } = fs.statSync(file);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === mtimeMs) return hit.data;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache.set(file, { mtimeMs, data });
      return data;
    } catch { return null; }
  };
})();

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function listModelIds(agent) {
  const provider = agent.provider;
  for (const home of [agent.home, config.hermesRoot]) {
    const cached = readJsonCached(path.join(home, 'provider_models_cache.json'))?.[provider]?.models;
    if (Array.isArray(cached) && cached.length) return cached.filter((id) => typeof id === 'string');
  }
  const dev = readJsonCached(path.join(config.hermesRoot, 'models_dev_cache.json'))?.[provider]?.models;
  const ids = dev ? Object.keys(dev) : [];
  return ids.length ? ids : [agent.model].filter(Boolean);
}

// The provider's own list of models enabled for this account (so models switched off in its console disappear).
// Hermes' built-in catalogue still lists them. null = could not ask, keep Hermes' list.
const LIVE_KEY_ENV = { 'opencode-go': 'OPENCODE_GO_API_KEY' };
const LIVE_TTL_MS = 60_000;
const liveCache = new Map();

async function liveModelIds(agent) {
  const keyName = LIVE_KEY_ENV[agent.provider];
  const key = keyName && readEnvValue(agent, keyName);
  if (!key) return null;
  const hit = liveCache.get(agent.provider);
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.ids;
  let ids = null;
  try {
    const base = (agent.baseUrl || 'https://opencode.ai/zen/go/v1').replace(/\/+$/, '');
    const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'hermes-web' }, signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const list = ((await response.json())?.data ?? []).map((m) => m?.id).filter((id) => typeof id === 'string');
      if (list.length) ids = new Set(list);
    }
  } catch { /* offline or provider hiccup: fall back to Hermes' list */ }
  liveCache.set(agent.provider, { at: Date.now(), ids });
  return ids;
}

// A configured catalog provider: its own list of models, with its own prices and modalities.
// A `routed` catalog (a gateway that resolves the real model per request, e.g. xellter) has nothing to choose from:
// its /models answer is the set of presets it serves, not chat models, so the picker shows the route instead of a list.
async function getCatalogModels(agent, catalog, routed = false) {
  const isHidden = hiddenCheck(agent.provider);
  const base = { current: { provider: agent.provider, model: agent.model }, effortLevels: EFFORT_LEVELS, serviceTiers: ['default'] };
  if (routed) {
    return { ...base, routed: true, models: [{ id: agent.model, provider: agent.provider, reasoning: false, contextWindow: null, modalities: null, hidden: false, price: null, quota: null, note: null }] };
  }
  const models = (await catalog.listModels({ currentModel: agent.model })).map((m) => ({
    id: m.id, provider: agent.provider,
    reasoning: m.reasoning,
    contextWindow: m.contextWindow,
    modalities: m.modalities,
    hidden: isHidden(m.id),
    price: m.price,
    quota: m.quota,
    note: m.note,
  }));
  return { ...base, models };
}

export async function getModels(agent) {
  const registry = providersFor(agent);
  const catalog = registry.get('models');
  if (catalog) return getCatalogModels(agent, catalog, registry.config('models')?.routed === true);
  const provider = agent.provider;
  const devModels = readJsonCached(path.join(config.hermesRoot, 'models_dev_cache.json'))?.[provider]?.models || {};
  const isGo = provider === 'opencode-go';
  const live = await liveModelIds(agent);
  const isHidden = hiddenCheck(provider);
  const models = listModelIds(agent).filter((id) => !live || live.has(id) || id === agent.model).map((id) => {
    const info = devModels[id];
    const cost = info?.cost;
    const quota = isGo ? GO_QUOTAS[id] : null;
    return {
      id, provider,
      reasoning: typeof info?.reasoning === 'boolean' ? info.reasoning : true,
      contextWindow: number(info?.limit?.context),
      // What the model accepts / produces beyond text, from the provider catalogue. null = not documented there.
      modalities: Array.isArray(info?.modalities?.input) ? { input: info.modalities.input, output: Array.isArray(info.modalities.output) ? info.modalities.output : [] } : null,
      hidden: isHidden(id),
      price: cost ? { inputPerM: number(cost.input), outputPerM: number(cost.output), cachedPerM: number(cost.cache_read) } : null,
      quota: quota ? { monthlyUsd: quota[0], requestsPerMonth: quota[1] } : null,
      note: isGo ? 'Price: API list (for reference). "—" = unknown.' : null,
    };
  });
  return {
    current: { provider: agent.provider, model: agent.model },
    effortLevels: EFFORT_LEVELS, serviceTiers: SERVICE_TIERS, models,
  };
}
