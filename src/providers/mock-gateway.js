import { OpenAICompatible } from './openai-compatible.js';
import { ProviderError, noKey, retryAfterOf } from './errors.js';

// A gateway with extras, for the offline sandbox (HERMES_WEB_FRESH_OFFLINE=1) and the tests: an OpenAI-compatible server that
// also offers typed classification (POST /classify) and paid social search (POST /search). It documents the wire shapes a
// provider with those capabilities can follow; nothing in production configures it unless asked to.
//   POST /classify  { model, state, questions: { id: { type: choice|score|bool, instructions: { item, question }, criteria } } }
//                   -> { answers: { id: { choice } | { score } | { p } } }
//   POST /search    { query, filter: { from?, allowed_handles?, excluded_handles? } } -> { answer, citations, cost_micro }
export class MockGateway extends OpenAICompatible {
  constructor(opts) {
    super({ ...opts, type: opts.type ?? 'mock-gateway', sendReasoningEffort: true });
    this.classify = { maxTasksPerCall: 150, classify: (req) => this.#classify(req) };
    this.search = {
      label: 'mock-gateway',
      endpoint: `${this.baseUrl.replace(/^https?:\/\//, '')}/search`,
      pricing: { perCallMicro: 100_000_000, currency: 'USD' },
      search: (req) => this.#search(req),
    };
  }

  async #classify({ state, tasks, model, timeoutMs }) {
    const questions = {};
    for (const t of tasks) {
      const instructions = { item: t.item, question: t.question };
      if (t.type === 'choice') questions[t.id] = { type: 'choice', instructions, criteria: t.options };
      else if (t.type === 'score') questions[t.id] = { type: 'score', instructions, criteria: t.scale };
      else questions[t.id] = { type: 'bool', instructions, criteria: { true: t.true, false: t.false } };
    }
    const response = await this.call('/classify', { method: 'POST', timeoutMs, body: { model, state, questions } });
    if (!response) throw noKey();
    if (!response.ok) throw new ProviderError(`${model} ${response.status}`, { status: response.status, retryAfter: retryAfterOf(response) });
    const json = await response.json();
    if (!json?.answers || typeof json.answers !== 'object') throw new Error(`${model} no answers`);
    const out = {};
    for (const [id, a] of Object.entries(json.answers)) {
      out[id] = { ...(a?.choice !== undefined ? { choice: a.choice } : {}), ...(typeof a?.score === 'number' ? { score: a.score } : {}), ...(typeof a?.p === 'number' ? { p: a.p } : {}) };
    }
    return out;
  }

  async #search({ query, filter = {}, timeoutMs = 120_000 }) {
    const wire = { from: filter.from };
    if (filter.allowedHandles?.length) wire.allowed_handles = filter.allowedHandles;
    else if (filter.excludedHandles?.length) wire.excluded_handles = filter.excludedHandles;
    const response = await this.call('/search', { method: 'POST', timeoutMs, body: { query, filter: wire } });
    if (!response) throw noKey();
    if (!response.ok) throw new ProviderError(String(response.status), { status: response.status, retryAfter: retryAfterOf(response) });
    const data = await response.json();
    return { answer: data?.answer, citations: data?.citations, costMicro: Number(data?.cost_micro) || 0, raw: data };
  }
}
