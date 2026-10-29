import { safeFetch } from '../fresh/net.js';
import { ProviderError, noKey } from './errors.js';

// Social search through the official X API v2 (recent search, GET /2/tweets/search/recent). It implements the `search`
// capability only. The request is turned into search operators:
//   topic words      -> (word OR word ...)           the words of `request.topic` (else of `request.query`), at most 8
//   -is:retweet has:links                            only original posts that carry a link
//   lang:xx                                          `request.lang`, else the configured `lang`
//   allowedHandles   -> (from:a OR from:b)           excludedHandles -> -from:a -from:b
// The answer is rendered the way the x-search connector parses it: one `- @handle: text URL` line per post, with the first
// external link (else the post itself) as the URL.
export const X_API_BASE_URL = 'https://api.x.com';
const MAX_QUERY = 512; // the shortest query limit of the API tiers
const MAX_TOPIC_WORDS = 8;
const WEEK_MS = 7 * 86_400_000;

const wordsOf = (text) => [...new Set(String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_#]{2,}/gu) ?? [])].slice(0, MAX_TOPIC_WORDS);
const handleOk = (h) => /^\w{1,15}$/.test(h);

export function buildXQuery({ topic, query, filter = {}, lang = '' } = {}) {
  const parts = [];
  const words = wordsOf(topic ?? query);
  if (words.length) parts.push(words.length === 1 ? words[0] : `(${words.join(' OR ')})`);
  parts.push('-is:retweet', 'has:links');
  if (/^[a-z]{2,3}$/i.test(lang)) parts.push(`lang:${lang.toLowerCase()}`);
  const allowed = (filter.allowedHandles ?? []).filter(handleOk);
  const excluded = (filter.excludedHandles ?? []).filter(handleOk);
  if (allowed.length) parts.push(allowed.length === 1 ? `from:${allowed[0]}` : `(${allowed.map((h) => `from:${h}`).join(' OR ')})`);
  else if (excluded.length) parts.push(...excluded.map((h) => `-from:${h}`));
  return parts.join(' ').slice(0, MAX_QUERY);
}

export class XApi {
  // opts: { id, bearer: () => string|null, costMicro, currency, lang, maxResults, baseUrl, fetch, now }
  //   fetch(url, { headers, timeoutMs }) -> Promise<{ status, body: Buffer|string }>; the default is the SSRF-guarded fetch.
  constructor(opts) {
    this.id = opts.id ?? 'x-api';
    this.type = 'x-api';
    this.bearer = opts.bearer ?? (() => null);
    this.baseUrl = String(opts.baseUrl || X_API_BASE_URL).replace(/\/+$/, '');
    this.lang = opts.lang ?? '';
    this.maxResults = Math.min(100, Math.max(10, Number(opts.maxResults) || 30));
    this.fetch = opts.fetch ?? ((url, o) => safeFetch(url, { ...o, accept: 'application/json', maxBytes: 4_000_000 }));
    this.now = opts.now ?? Date.now;
    const costMicro = Number(opts.costMicro);
    this.search = {
      label: 'x-api',
      endpoint: `${this.baseUrl.replace(/^https?:\/\//, '')}/2/tweets/search/recent`,
      pricing: { perCallMicro: Number.isFinite(costMicro) && costMicro >= 0 ? costMicro : 0, currency: opts.currency || 'USD' },
      search: (req) => this.#search(req),
    };
  }

  async #search({ query, topic, lang, filter = {}, timeoutMs = 30_000 }) {
    const token = this.bearer();
    if (!token) throw noKey('No bearer token for the X API.');
    const params = new URLSearchParams({
      query: buildXQuery({ topic, query, filter, lang: lang || this.lang }),
      max_results: String(this.maxResults),
      'tweet.fields': 'created_at,entities,lang',
      expansions: 'author_id',
      'user.fields': 'username',
    });
    const from = Date.parse(`${filter.from ?? ''}T00:00:00Z`);
    if (Number.isFinite(from)) params.set('start_time', new Date(Math.max(from, this.now() - WEEK_MS + 120_000)).toISOString());
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/2/tweets/search/recent?${params}`, { headers: { Authorization: `Bearer ${token}` }, timeoutMs });
    } catch (err) {
      throw new ProviderError('X API request failed.', { kind: 'timeout', detail: String(err?.message ?? err).slice(0, 120) });
    }
    const text = Buffer.isBuffer(response.body) ? response.body.toString('utf8') : String(response.body ?? '');
    if (response.status < 200 || response.status >= 300) throw new ProviderError(String(response.status), { status: response.status, detail: text.slice(0, 200) });
    let data;
    try { data = JSON.parse(text); } catch { throw new ProviderError('X API answered with something that is not JSON.', { kind: 'empty' }); }
    const users = new Map((data?.includes?.users ?? []).map((u) => [u.id, u.username]));
    const lines = [];
    const citations = [];
    for (const post of data?.data ?? []) {
      const handle = users.get(post.author_id);
      if (!handle) continue;
      const urls = post.entities?.urls ?? [];
      const link = `https://x.com/${handle}/status/${post.id}`; // a card links to the post, never to a page the post mentions
      let body = String(post.text ?? '');
      for (const u of urls) body = body.split(u.url).join(' ');
      body = body.replace(/\s+/g, ' ').trim();
      lines.push(`- @${handle}: ${body} ${link}`);
      citations.push({ url: link, title: `@${handle}` });
    }
    return { answer: lines.join('\n'), citations, costMicro: this.search.pricing.perCallMicro, raw: { result_count: data?.meta?.result_count ?? lines.length } };
  }
}
