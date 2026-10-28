import fs from 'node:fs';
import path from 'node:path';
import { config, settings } from '../config/instance.js';
import { readEnvValue } from '../agents.js';
import { buildRegistry } from './registry.js';
import { loadProviderDropins } from './dropins.js';
import { OpenAICompatible } from './openai-compatible.js';
import { MockGateway } from './mock-gateway.js';
import { XApi } from './x-api.js';
import { NullProvider } from './null.js';

// The glue between the app and the provider layer.
//  - TYPES: the provider types this build knows.
//  - compatDefault(): the config used when there is no data/providers.json: nothing, except in offline mode
//    (HERMES_WEB_FRESH_OFFLINE=1), where a mock gateway answers everything.
//  - providersFor(agent): the registry for an agent. A data/providers.json ({ providers, capabilities }), when present, replaces the
//    compat default; tests can replace both with setProviderConfig().
const BUILTIN_TYPES = {
  'openai-compatible': (id, c, h) => new OpenAICompatible({ id, baseUrl: c.baseUrl, apiKey: h.secret(c.apiKey), transport: h.transport, sendReasoningEffort: c.sendReasoningEffort === true }),
  'x-api': (id, c, h) => new XApi({ id, bearer: h.secret(c.bearerToken), baseUrl: c.baseUrl, costMicro: c.costMicro, currency: c.currency, lang: c.lang, maxResults: c.maxResults }),
  'mock-gateway': (id, c, h) => new MockGateway({ id, baseUrl: c.baseUrl, apiKey: h.secret(c.apiKey), transport: h.transport }),
  null: (id) => new NullProvider({ id }),
};

// Drop-in types from <dataDir>/providers/*.js are loaded once, when this module is first imported.
const TYPES = { ...(await loadProviderDropins(path.join(config.dataDir, 'providers'), { builtin: Object.keys(BUILTIN_TYPES) })), ...BUILTIN_TYPES };

// Chains moved here unchanged from the code that used to hard-code them (see src/fresh/llm.js for how they are used).
const CLASSIFIER_CHAIN = [{ model: 'jev-1-13:free', timeoutMs: 25_000, bonus: 6 }, { model: 'clef:free', timeoutMs: 15_000, bonus: 3 }, { model: 'clef-flash:free', timeoutMs: 15_000, bonus: 0 }];
const WRITER_CHAIN = [{ model: 'deepseek-v4-1-flash:free', maxPerDay: 3000 }, { model: 'deepseek-v4-1-flash', maxPerDay: 200, paid: true }];
const IMAGE_CHAIN = [{ model: 'agnes-image-2-5-flash:free' }, { model: 'agnes-image-2-1-flash:free' }, { model: 'agnes-image-2-0-flash:free' }];

// Every capability bound to one provider, with the chains the Feed pipeline uses.
export function gatewayCapabilities(provider) {
  return {
    writer: { provider, chain: WRITER_CHAIN, waitMs: 90_000, chatWaitMs: 30_000 },
    classifier: { provider, chain: CLASSIFIER_CHAIN, waitMs: 90_000 },
    socialSearch: { provider },
    images: { provider, chain: IMAGE_CHAIN, sceneModel: 'deepseek-v4-1-flash' },
    transcription: { provider, model: 'whisper-large-v3-turbo' },
    speech: { provider, model: 'tts-1', voice: 'alloy' },
    models: { provider },
  };
}

export function compatDefault({ offline = false } = {}) {
  if (!offline) return { providers: {}, capabilities: {} };
  return { providers: { mock: { type: 'mock-gateway' } }, capabilities: gatewayCapabilities('mock') };
}

function fileConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'providers.json'), 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch { return null; }
}

const state = { override: null, transport: null, offlineTransport: null, registries: new Map(), primary: null };

// Tests: (agent, path, opts) => Response, used instead of the network by every provider.
export const setTransport = (fn) => { state.transport = fn; };
// The offline mock (HERMES_WEB_FRESH_OFFLINE=1): registered by the code that owns the mock; used only with the compat default.
export const setOfflineTransport = (fn) => { state.offlineTransport = fn; state.registries.clear(); };
// Replace the whole config ({ providers, capabilities }); null goes back to data/providers.json or the compat default.
export function setProviderConfig(cfg) { state.override = cfg; state.registries.clear(); }
// For tests: add provider types without a file.
export const registerProviderType = (name, make) => { TYPES[name] = make; state.registries.clear(); };
export const clearProviderCache = () => state.registries.clear();

const offlineMode = () => process.env.HERMES_WEB_FRESH_OFFLINE === '1' && Boolean(state.offlineTransport);

export function providersFor(agent) {
  const key = `${agent?.name}|${agent?.provider}|${agent?.baseUrl}|${agent?.home}`;
  const hit = state.registries.get(key);
  if (hit) return hit;
  const file = state.override ? null : fileConfig();
  const compat = !state.override && !file;
  const cfg = state.override ?? file ?? compatDefault({ offline: offlineMode() });
  const useOffline = compat;
  const ctx = {
    agentEnv: (name) => readEnvValue(agent ?? {}, name),
    dataDir: config.dataDir,
    allowInlineSecrets: settings.allowInlineSecrets,
    transport: () => state.transport ?? (useOffline && offlineMode() ? state.offlineTransport : null),
  };
  const registry = buildRegistry(cfg, ctx, TYPES);
  // The offline mock answers without limits (it has no real quota); a test transport is limited like the real thing.
  registry.unmetered = () => !state.transport && useOffline && offlineMode();
  state.registries.set(key, registry);
  return registry;
}

// The agent Fresh runs for (set when Fresh starts); lets code that has no agent at hand ask what is available.
export const setPrimaryAgent = (agent) => { state.primary = agent; };
export const primaryAgent = () => state.primary;
