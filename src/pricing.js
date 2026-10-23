import path from 'node:path';
import { config } from './config.js';
import { readJsonCached } from './models.js';
import { providersFor } from './providers/compat.js';

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// List price (USD per 1M tokens) of a model from the provider's catalogue, or null when it is unknown.
// A catalog provider's prices come from its live catalogue: call loadPrices(agent) first (async), then priceOf is synchronous.
export const loadPrices = (agent) => providersFor(agent).get('models')?.load() ?? Promise.resolve();

export function priceOf(agent, modelId) {
  const catalog = providersFor(agent).get('models');
  if (catalog) return catalog.priceOf(modelId);
  const cost = readJsonCached(path.join(config.hermesRoot, 'models_dev_cache.json'))?.[agent.provider]?.models?.[modelId]?.cost;
  if (!cost || number(cost.input) == null || number(cost.output) == null) return null;
  return { inputPerM: cost.input, outputPerM: cost.output, cachedPerM: number(cost.cache_read) ?? cost.input, cacheWritePerM: number(cost.cache_write) ?? cost.input };
}

// Hermes records $0 / "unknown" for subscription providers such as OpenCode Go, so the cost is estimated from the
// token counters and the model's API list price. `input_tokens` excludes cached reads, which are priced separately.
export function estimateCost(row, price) {
  // Reported costs are in dollars; a gateway that bills in another currency is always estimated from its own list price.
  const currency = price?.currency ?? 'USD';
  const real = currency === 'USD' ? (row.actual_cost_usd ?? (row.estimated_cost_usd > 0 ? row.estimated_cost_usd : null)) : null;
  if (real != null) return { amount: real, currency, basis: 'reported' };
  if (!price) return null;
  const amount = ((row.input_tokens || 0) * price.inputPerM
    + (row.cache_write_tokens || 0) * price.cacheWritePerM
    + (row.cache_read_tokens || 0) * price.cachedPerM
    + (row.output_tokens || 0) * price.outputPerM) / 1e6;
  return { amount, currency, basis: 'list-price' };
}

// Prompt size of the latest call. The exact value is not exposed, so a session without a recorded run falls back to
// the average prompt per call (which understates a long session).
export function averagePrompt(row) {
  const calls = row.api_call_count || 0;
  const total = (row.input_tokens || 0) + (row.cache_read_tokens || 0) + (row.cache_write_tokens || 0);
  return calls > 0 && total > 0 ? Math.round(total / calls) : null;
}
