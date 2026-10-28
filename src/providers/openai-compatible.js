import { ProviderError, noKey, retryAfterOf } from './errors.js';

// Any server that speaks the OpenAI REST dialect: /chat/completions, /images/generations, /audio/transcriptions, /audio/speech, /models.
// No search, no classifier of its own (llm-classifier.js builds one from the chat endpoint) and no usage/balance.
const CATALOG_TTL_MS = 10 * 60_000;
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export class OpenAICompatible {
  // opts: { id, type, baseUrl, apiKey: () => string|null, userAgent, transport: () => fn|null, sendReasoningEffort }
  constructor(opts) {
    this.id = opts.id ?? 'openai-compatible';
    this.type = opts.type ?? 'openai-compatible';
    this.baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
    this.key = opts.apiKey ?? (() => null);
    this.userAgent = opts.userAgent ?? 'hermes-web';
    this.transport = opts.transport ?? (() => null);
    this.sendReasoningEffort = opts.sendReasoningEffort === true;
    this.text = { chat: (req) => this.#chat(req) };
    this.image = { generate: (req) => this.#generate(req) };
    this.transcribe = { transcribe: (req) => this.#transcribe(req) };
    this.speech = { synthesize: (req) => this.#synthesize(req) };
    this.catalog = new CatalogBase(this);
  }

  // A JSON request with the key; null when there is no key.
  async request(path, { method = 'GET', body, timeoutMs = 10_000 } = {}) {
    const key = this.key();
    if (!key) return null;
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': this.userAgent },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  // Same, but an injected transport (tests, the offline mock) answers first when there is one.
  call(path, opts = {}) {
    const transport = this.transport();
    return transport ? transport({ name: this.id }, path, opts) : this.request(path, opts);
  }

  async #chat({ model, messages, maxTokens, temperature, reasoningEffort, timeoutMs = 60_000 }) {
    const body = { model, max_tokens: maxTokens, temperature, ...(reasoningEffort && this.sendReasoningEffort ? { reasoning_effort: reasoningEffort } : {}), messages };
    const response = await this.call('/chat/completions', { method: 'POST', timeoutMs, body });
    if (!response) throw noKey();
    if (!response.ok) throw new ProviderError(`${model} ${response.status}`, { status: response.status, retryAfter: retryAfterOf(response) });
    return { text: String((await response.json())?.choices?.[0]?.message?.content ?? '') };
  }

  async #generate({ prompt, model, size = '1024x1024', timeoutMs = 100_000 }) {
    const response = await this.request('/images/generations', { method: 'POST', body: { model, prompt, n: 1, size }, timeoutMs });
    if (!response) throw noKey('No API key for the image model.');
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderError(`${model} answered ${response.status}.`, { status: response.status, retryAfter: retryAfterOf(response), detail });
    }
    const item = (await response.json())?.data?.[0] ?? {};
    const src = item.b64_json || item.url || '';
    const data = src.startsWith('data:') ? src.slice(src.indexOf(',') + 1) : src.startsWith('http') ? null : src;
    let bytes = data ? Buffer.from(data, 'base64') : null;
    if (!bytes && src.startsWith('http')) bytes = Buffer.from(await (await fetch(src, { signal: AbortSignal.timeout(30_000) })).arrayBuffer());
    return { bytes, mime: 'image/*' };
  }

  async #transcribe({ audio, mime = 'audio/mpeg', hint = '', model, timeoutMs = 120_000 }) {
    const key = this.key();
    if (!key) throw noKey('Audio input needs an API key for the transcription provider.');
    const form = new FormData();
    form.append('model', model);
    if (hint) form.append('prompt', hint);
    form.append('file', new Blob([audio], { type: mime }), 'audio.mp3');
    let res;
    try {
      res = await fetch(`${this.baseUrl}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'User-Agent': this.userAgent }, body: form, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new ProviderError('Transcription timed out.', { kind: 'timeout' });
    }
    if (!res.ok) throw new ProviderError(`Transcription failed (${res.status}).`, { status: res.status });
    const text = String((await res.json())?.text ?? '').trim();
    if (!text) throw new ProviderError('No speech was recognised.', { kind: 'empty' });
    return { text };
  }

  async #synthesize({ text, model, voice, speed, format = 'mp3', timeoutMs = 120_000 }) {
    const key = this.key();
    if (!key) throw noKey('Speech needs an API key for the speech provider.');
    let res;
    try {
      res = await fetch(`${this.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': this.userAgent },
        body: JSON.stringify({ model, input: text, ...(voice ? { voice } : {}), ...(speed ? { speed } : {}), response_format: format }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ProviderError('Speech timed out.', { kind: 'timeout' });
    }
    if (!res.ok) throw new ProviderError(`Speech failed (${res.status}).`, { status: res.status });
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new ProviderError('The speech provider returned no audio.', { kind: 'empty' });
    return { audio, mime: res.headers.get('content-type') || 'audio/mpeg' };
  }
}

// GET /models with a 10 minute cache. A failed refresh keeps the previous copy and is retried after 30 s.
export class CatalogBase {
  constructor(provider) { this.provider = provider; this.cache = null; }

  async models() {
    const hit = this.cache;
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.models;
    try {
      const response = await this.provider.request('/models');
      if (response?.ok) {
        const list = (await response.json())?.data ?? [];
        const models = new Map(list.filter((m) => typeof m?.id === 'string').map((m) => [m.id, m]));
        if (models.size) { this.cache = { at: Date.now(), models }; return models; }
      }
    } catch { /* offline: fall through */ }
    this.cache = { at: Date.now() - CATALOG_TTL_MS + 30_000, models: hit?.models ?? new Map() };
    return hit?.models ?? new Map();
  }

  async load() { await this.models(); }
  currency() { return 'USD'; }

  // OpenRouter style prices: USD per token as strings.
  priceOf(modelId) {
    const p = this.cache?.models.get(modelId)?.pricing;
    const input = Number(p?.prompt), output = Number(p?.completion);
    if (!p || !Number.isFinite(input) || !Number.isFinite(output)) return null;
    const perM = (v) => v * 1e6;
    const cached = Number(p.input_cache_read);
    return { currency: 'USD', inputPerM: perM(input), outputPerM: perM(output), cachedPerM: Number.isFinite(cached) ? perM(cached) : perM(input), cacheWritePerM: perM(input) };
  }

  async listModels() {
    const models = await this.models();
    return [...models.values()].map((m) => {
      const price = this.priceOf(m.id);
      const input = m.architecture?.input_modalities ?? m.modalities?.input;
      const output = m.architecture?.output_modalities ?? m.modalities?.output;
      return {
        id: m.id,
        reasoning: m.reasoning === true,
        contextWindow: number(m.context_length),
        modalities: Array.isArray(input) ? { input, output: Array.isArray(output) ? output : [] } : null,
        price: price ? { currency: price.currency, inputPerM: price.inputPerM, outputPerM: price.outputPerM, cachedPerM: price.cachedPerM } : null,
        quota: null,
        note: null,
      };
    });
  }
}
