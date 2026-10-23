import { hardBan } from '../fresh/profile.js';
import { fetchJson } from './http.js';

// Bluesky keyword search, as a connector. It needs a login (`credentials.handle` and
// `credentials.appPassword`, e.g. `file:bluesky.json#handle` and `file:bluesky.json#app_password`).
//
// Search is noisy (other languages, deal bots, bare reactions), so a post only becomes a candidate
// when it is in one of the configured languages, has some engagement, comes from something that
// does not look like a bot, and (preferably) links to an article: that article is the card, the
// post is its snippet. The shipped defaults are neutral and empty: without `queries` the connector
// reports `unavailable: no queries configured` and never logs in.
//
// Config:
//   queries: [{ q, cat, minEngagement }]   keyword searches (empty by default)
//   languages: ['en']                      accepted post languages; the first one is sent to the API
//   maxQueries: 12                         most searches per run
//   botHandlePattern: string               optional regex for bot-like handles
//   sinceMinutes: 360                      how far back the first run looks
//   retryDelayMs: 350                      pause between searches (skipped offline)
export const PDS = 'https://bsky.social';
export const MAX_QUERIES = 12;
export const LANGS = ['en'];
export const DEFAULT_BOT_PATTERN = String.raw`(?:^|[._-])(?:bot|deals?|news|feed|jobs?|alerts?|rss|daily|updates?|headlines?)(?:[._-]|\.bsky|$)|bot\.bsky`;
const BAD_LINK = /(?:^|\.)(?:amazon\.[a-z.]+|amzn\.to|ebay\.[a-z.]+|aliexpress\.com|bit\.ly|ow\.ly|dlvr\.it|go\.redirectingat\.com|slickdeals\.net|dealnews\.com|bsky\.app)$/i;
const SIX_HOURS = 6 * 3_600_000;

// The shipped default is empty on purpose: an instance without queries is listed as unavailable
// and makes no login attempt. Tests and the owner's export keep importing `QUERIES`.
export const QUERIES = [];

const states = new Map();
const defaultState = () => ({ configured: false, loggedIn: false, lastRun: 0, lastAdded: 0, queries: 0, errors: 0 });
const stateOf = (ctx) => {
  const id = String(ctx?.config?.id ?? 'bluesky');
  if (!states.has(id)) states.set(id, defaultState());
  return states.get(id);
};
const sessions = new Map();
export const blueskyStatus = (ctx = null) => ({ ...(ctx ? stateOf(ctx) : defaultState()) });
export const status = blueskyStatus;

const offline = () => process.env.HERMES_WEB_FRESH_OFFLINE === '1';

export function configOf(config = {}) {
  const queries = (Array.isArray(config.queries) ? config.queries : [])
    .map((row) => (Array.isArray(row) ? { q: row[0], cat: row[1], minEngagement: row[2] } : row))
    .filter((row) => row && typeof row.q === 'string' && row.q.trim())
    .map((row) => ({ q: String(row.q).trim(), cat: row.cat ? String(row.cat) : undefined, minEngagement: Number.isFinite(row.minEngagement) ? row.minEngagement : 8 }))
    .slice(0, Number.isFinite(config.maxQueries) ? config.maxQueries : MAX_QUERIES);
  const languages = (Array.isArray(config.languages) && config.languages.length ? config.languages : LANGS)
    .map((lang) => String(lang).slice(0, 2).toLowerCase()).filter(Boolean);
  return {
    queries,
    languages: [...new Set(languages.length ? languages : LANGS)],
    maxQueries: Number.isFinite(config.maxQueries) ? config.maxQueries : MAX_QUERIES,
    bot: botPattern(config.botHandlePattern),
    sinceMs: (Number.isFinite(config.sinceMinutes) ? config.sinceMinutes : 360) * 60_000,
    retryDelayMs: Number.isFinite(config.retryDelayMs) ? config.retryDelayMs : 350,
  };
}

function botPattern(value) {
  if (typeof value !== 'string' || !value) return new RegExp(DEFAULT_BOT_PATTERN, 'i');
  try { return new RegExp(value, 'i'); } catch { return new RegExp(DEFAULT_BOT_PATTERN, 'i'); }
}

function credentials(ctx) {
  const handle = ctx.secret('handle');
  const password = ctx.secret('appPassword');
  return handle && password ? { handle, password } : null;
}

// bsky.social sometimes times out; a retry usually gets through.
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try { return await fn(); } catch (err) { last = err; }
  }
  throw last;
}

async function login(ctx) {
  const id = String(ctx?.config?.id ?? 'bluesky');
  const creds = offline() ? { handle: 'mock', password: 'mock' } : credentials(ctx);
  if (!creds) throw new Error('no Bluesky credentials');
  const res = await withRetry(() => fetchJson(ctx, `${PDS}/xrpc/com.atproto.server.createSession`, { method: 'POST', json: { identifier: creds.handle, password: creds.password }, timeoutMs: 15_000 }));
  if (res.status !== 200 || !res.data?.accessJwt) throw new Error(`bluesky login ${res.status}`);
  const endpoint = res.data.didDoc?.service?.find?.((service) => service.type === 'AtprotoPersonalDataServer')?.serviceEndpoint;
  sessions.set(id, { access: res.data.accessJwt, refresh: res.data.refreshJwt, pds: /^https:\/\/[\w.-]+$/.test(endpoint ?? '') ? endpoint : PDS });
  stateOf(ctx).loggedIn = true;
}

async function refreshSession(ctx) {
  const id = String(ctx?.config?.id ?? 'bluesky');
  const session = sessions.get(id);
  if (!session?.refresh) return login(ctx);
  const res = await fetchJson(ctx, `${session.pds}/xrpc/com.atproto.server.refreshSession`, { method: 'POST', headers: { Authorization: `Bearer ${session.refresh}` }, timeoutMs: 15_000 }).catch(() => null);
  if (res?.status === 200 && res.data?.accessJwt) {
    sessions.set(id, { ...session, access: res.data.accessJwt, refresh: res.data.refreshJwt ?? session.refresh });
    return undefined;
  }
  return login(ctx);
}

async function search(ctx, cfg, q, { sort = 'latest', since, limit = 25 } = {}) {
  const id = String(ctx?.config?.id ?? 'bluesky');
  if (!sessions.has(id)) await login(ctx);
  const session = sessions.get(id);
  const url = () => `${session.pds}/xrpc/app.bsky.feed.searchPosts?${new URLSearchParams({ q, sort, lang: cfg.languages[0] ?? 'en', limit: String(limit), ...(since ? { since: new Date(since).toISOString() } : {}) })}`;
  let res = await withRetry(() => fetchJson(ctx, url(), { headers: { Authorization: `Bearer ${session.access}` }, timeoutMs: 20_000 }));
  if (res.status === 401 || (res.status === 400 && /expired/i.test(res.data?.error ?? ''))) {
    await refreshSession(ctx);
    const fresh = sessions.get(id);
    res = await fetchJson(ctx, `${fresh.pds}/xrpc/app.bsky.feed.searchPosts?${new URLSearchParams({ q, sort, lang: cfg.languages[0] ?? 'en', limit: String(limit), ...(since ? { since: new Date(since).toISOString() } : {}) })}`, { headers: { Authorization: `Bearer ${fresh.access}` }, timeoutMs: 20_000 });
  }
  if (res.status !== 200) throw new Error(`bluesky search ${res.status}`);
  return res.data?.posts ?? [];
}

// One post -> a candidate, or null when it fails the filters. `languages` is the accepted set.
export function candidateOf(post, { minEngagement = 8, cat = undefined, languages = LANGS, bot = DEFAULT_BOT_PATTERN } = {}) {
  const text = String(post?.record?.text ?? '').replace(/\s+/g, ' ').trim();
  const handle = post?.author?.handle ?? '';
  if (!text || !handle) return null;
  const accepted = new Set((languages ?? LANGS).map((lang) => String(lang).slice(0, 2).toLowerCase()));
  const langs = post.record.langs ?? [];
  if (langs.length ? !langs.some((lang) => accepted.has(String(lang).slice(0, 2))) : /[^\x00-\x7f]{6,}/.test(text)) return null;
  const engagement = (post.likeCount ?? 0) + (post.repostCount ?? 0);
  if (engagement < minEngagement) return null;
  const botRe = bot instanceof RegExp ? bot : botPattern(bot);
  if (botRe.test(handle) || hardBan(text)) return null;
  const ext = post.embed?.external ?? post.embed?.media?.external;
  let link = '';
  try { if (ext?.uri) { const url = new URL(ext.uri); if (!BAD_LINK.test(url.hostname)) link = url.href; } } catch { /* no usable link */ }
  // A bare post (no article) has to be clearly worth it: many reactions and enough to say.
  if (!link && (engagement < minEngagement * 4 || text.length < 100)) return null;
  const postUrl = `https://bsky.app/profile/${handle}/post/${post.uri.split('/').pop()}`;
  return {
    cat, title: (link ? ext.title || text : text).slice(0, 160), url: link || postUrl, snippet: text.slice(0, 400),
    ts: Date.parse(post.record.createdAt) || Date.now(), image: link ? ext?.thumb || null : post.embed?.images?.[0]?.fullsize ?? null,
    meta: { likes: engagement, author: handle, via: 'bluesky', post: postUrl },
  };
}

// -> candidates from up to `maxQueries` searches. `since` (ms) limits to new posts; one failed
// query does not stop the others. Exported for the bootstrap and tests.
export async function gatherBluesky(ctx, { since, queries } = {}) {
  const cfg = configOf(ctx.config ?? {});
  const state = stateOf(ctx);
  const out = [];
  const byAuthor = new Map();
  let failed = 0;
  for (const row of (queries ?? cfg.queries).slice(0, cfg.maxQueries)) {
    try {
      const posts = await search(ctx, cfg, row.q, { sort: 'top', since });
      state.queries += 1;
      for (const post of posts) {
        const candidate = candidateOf(post, { minEngagement: row.minEngagement, cat: row.cat, languages: cfg.languages, bot: cfg.bot });
        if (!candidate) continue;
        byAuthor.set(candidate.meta.author, (byAuthor.get(candidate.meta.author) ?? 0) + 1);
        out.push(candidate);
      }
    } catch (err) { failed += 1; state.errors += 1; if (failed >= 3) throw err; }
    if (!offline()) await new Promise((resolve) => setTimeout(resolve, cfg.retryDelayMs));
  }
  // Somebody who fills the results with posts is posting on a schedule, not sharing: those go.
  const kept = out.filter((candidate) => (byAuthor.get(candidate.meta.author) ?? 0) < 4);
  state.lastRun = Date.now();
  state.lastAdded = kept.length;
  return kept;
}

export async function fetch(ctx) {
  const cfg = configOf(ctx.config ?? {});
  const state = stateOf(ctx);
  state.configured = offline() || Boolean(credentials(ctx));
  if (!cfg.queries.length) return [];
  if (!state.configured) return [];
  const last = ctx.state.get('bluesky-last-run', 0);
  if (!ctx.force && Date.now() - last < 60 * 60_000) return [];
  ctx.state.set('bluesky-last-run', Date.now());
  const since = ctx.state.get('bluesky-since', Date.now() - cfg.sinceMs);
  const items = await gatherBluesky(ctx, { since });
  ctx.state.set('bluesky-since', Date.now() - 10 * 60_000);
  return items;
}

export async function test(ctx) {
  try {
    await login(ctx);
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err.message).slice(0, 80) };
  }
}

export function statusOf(ctx) {
  const cfg = configOf(ctx.config ?? {});
  const state = stateOf(ctx);
  const configured = offline() || Boolean(credentials(ctx));
  const unavailable = !cfg.queries.length ? 'no queries configured' : !configured ? 'no credentials' : undefined;
  return { ...state, configured, ...(unavailable ? { unavailable } : {}) };
}

export default {
  type: 'bluesky',
  title: 'Bluesky search',
  configSchema: {
    type: 'object',
    properties: {
      queries: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, cat: { type: 'string' }, minEngagement: { type: 'number' } } } },
      languages: { type: 'array', items: { type: 'string' } },
      maxQueries: { type: 'number' },
      botHandlePattern: { type: 'string' },
      sinceMinutes: { type: 'number' },
    },
  },
  credentials: [
    { key: 'handle', label: 'Bluesky handle', secret: true, required: true },
    { key: 'appPassword', label: 'App password', secret: true, required: true },
  ],
  defaultSchedule: { every: '60m' },
  cost: { kind: 'free' },
  fetch,
  test,
  status: statusOf,
};
