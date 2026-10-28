import { llmClassifier } from './llm-classifier.js';
import { resolveSecret } from '../config/secrets.js';

// Turns a `{ providers, capabilities }` config into provider instances and capability bindings.
//
//   providers:    { <id>: { type, baseUrl, apiKey: "env:NAME" | "file:relative/path" | "agentEnv:NAME", accountKey, ... } }
//   capabilities: { writer|classifier|images|socialSearch|transcription|speech|models: { provider: <id>, chain?, model?, voice?, ... } }
//
// A capability whose provider is missing, unknown or cannot do it resolves to null: callers ask `registry.get('classifier')` and degrade.
// Secrets are never literal values in the config: they are references resolved here (see secretResolver).
export const CAPABILITIES = ['writer', 'classifier', 'images', 'socialSearch', 'transcription', 'speech', 'models'];
const IMPL = { writer: 'text', classifier: 'classify', images: 'image', socialSearch: 'search', transcription: 'transcribe', speech: 'speech', models: 'catalog' };

// ctx: { agentEnv(name) -> string|null, dataDir, transport() -> fn|null, allowInlineSecrets }
// A provider config with a bad reference must not take the app down: a refusal resolves to null, as before.
export function secretResolver(ctx) {
  return (ref) => {
    if (typeof ref !== 'string' || !ref) return null;
    try {
      return resolveSecret(ref, { dataDir: ctx.dataDir, allowInline: ctx.allowInlineSecrets === true, env: process.env, agentEnv: ctx.agentEnv });
    } catch {
      return null;
    }
  };
}

// types: { <type name>: (id, providerConfig, helpers) -> instance }
export function buildRegistry(cfg, ctx, types) {
  const secret = secretResolver(ctx);
  const helpers = { secret: (ref) => () => secret(ref), transport: ctx.transport ?? (() => null) };
  const instances = new Map();
  for (const [id, pc] of Object.entries(cfg?.providers ?? {})) {
    const make = types[pc?.type];
    if (!make) { console.warn(`[providers] "${id}": unknown type "${pc?.type}"`); continue; }
    instances.set(id, make(id, pc, helpers));
  }
  const capabilities = cfg?.capabilities ?? {};
  const cache = new Map();

  function bind(name) {
    let conf = capabilities[name];
    // No classifier configured: a chat model of the writer's provider can do it.
    if (!conf && name === 'classifier' && capabilities.writer) {
      const first = (capabilities.writer.chain ?? []).find((e) => !e.paid) ?? capabilities.writer.chain?.[0];
      conf = { provider: capabilities.writer.provider, chain: first ? [{ model: first.model }] : [], derived: true };
    }
    const instance = conf ? instances.get(conf.provider) : null;
    if (!instance) return { conf: conf ?? null, instance: null, impl: null };
    let impl = instance[IMPL[name]] ?? null;
    if (!impl && name === 'classifier' && instance.text) impl = llmClassifier(instance.text, { model: conf.chain?.[0]?.model ?? conf.model });
    return { conf, instance, impl };
  }

  const registry = {
    instances,
    bound: (name) => { if (!cache.has(name)) cache.set(name, bind(name)); return cache.get(name); },
    get: (name) => registry.bound(name).impl,
    config: (name) => registry.bound(name).conf,
    provider: (name) => registry.bound(name).instance,
    // What the client may rely on (GET /api/capabilities).
    flags: () => ({
      ...Object.fromEntries(CAPABILITIES.map((name) => [name, Boolean(registry.get(name))])),
      usage: typeof registry.get('models')?.usage === 'function',
    }),
  };
  return registry;
}
