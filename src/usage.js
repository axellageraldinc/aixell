import { agentJson } from './agents.js';
import { priceOf, estimateCost, loadPrices } from './pricing.js';
import { providersFor } from './providers/compat.js';
import { dayKey } from './time.js';

const cache = new Map();
const TTL_MS = 60_000;

const blank = () => ({ sessions: 0, apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, estimatedCost: 0 });
function add(target, session, cost) {
  target.sessions += 1;
  target.apiCalls += session.api_call_count || 0;
  target.inputTokens += session.input_tokens || 0;
  target.outputTokens += session.output_tokens || 0;
  target.cacheReadTokens += session.cache_read_tokens || 0;
  target.reasoningTokens += session.reasoning_tokens || 0;
  target.estimatedCost += cost ?? 0;
}

// Aggregates every session (web + Telegram + cron) started within the window.
export async function getUsage(agent, days) {
  const key = `${agent.name}:${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  await loadPrices(agent);
  const cutoff = Date.now() / 1000 - days * 86400;
  const totals = blank();
  const byDay = new Map();
  const byModel = new Map();
  for (let offset = 0, pages = 0; pages < 30; pages += 1) {
    const page = await agentJson(agent, `/api/sessions?limit=100&offset=${offset}`, { timeoutMs: 20_000 });
    const rows = page?.data || [];
    for (const session of rows) {
      if (!Number.isFinite(session.started_at) || session.started_at < cutoff) continue;
      // Sessions priced in another currency than the agent's current one (before a provider switch) add tokens, not money.
      const cost = estimateCost(session, priceOf(agent, session.model))?.amount ?? 0;
      add(totals, session, cost);
      const day = byDay.get(dayKey(session.started_at * 1000)) || blank();
      add(day, session, cost);
      byDay.set(dayKey(session.started_at * 1000), day);
      const modelKey = session.model || 'unknown';
      const model = byModel.get(modelKey) || blank();
      add(model, session, cost);
      byModel.set(modelKey, model);
    }
    if (!page?.has_more || !rows.length) break;
    offset += rows.length;
    // Sessions come newest-first; once a whole page is older than the window nothing newer follows.
    if (rows.every((session) => session.started_at < cutoff)) break;
  }
  const data = {
    days,
    currency: providersFor(agent).get('models')?.currency() ?? 'USD',
    totals,
    byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, inputTokens: v.inputTokens, outputTokens: v.outputTokens, estimatedCost: v.estimatedCost, apiCalls: v.apiCalls })),
    byModel: [...byModel].sort(([, a], [, b]) => b.inputTokens - a.inputTokens).map(([model, v]) => ({ model, sessions: v.sessions, apiCalls: v.apiCalls, inputTokens: v.inputTokens, outputTokens: v.outputTokens, estimatedCost: v.estimatedCost })),
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}
