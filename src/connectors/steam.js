import * as store from '../fresh/store.js';
import { fetchJson } from './http.js';

// The reader's Steam account, as a connector. It tells Fresh what to care about:
//  - games they play (playtime) and wish for raise stories that name them (`boost`),
//  - patch notes of the games they play most or recently become candidates,
//  - wishlist games that just released become candidates,
//  - a Steam sale or Next Fest becomes ONE summary card per event (never a card per deal).
//
// Credentials: `steam_id` and `api_key` (e.g. `file:steam.json#steam_id`,
// `file:steam.json#api_key`). Config:
//   events: ['steam ... sale', 'next fest']   title patterns of the sale events (English defaults)
//   everyHours: 3                             its own clock
//
// Games the profile calls social-only (played with friends, not a taste) do not count as taste.
export const API = 'https://api.steampowered.com';
export const STORE = 'https://store.steampowered.com/api';
export const DAY = 86_400_000;
export const SOCIAL_ONLY = /\b(the finals|dota 2|ea sports fc|fc 2\d|arc raiders|delta force|marvel rivals|counter-strike|cs2|apex legends|pubg|valorant|fortnite)\b/i;
export const PATCH = /\b(patch|hotfix|update|changelog|notes|version|v?\d+\.\d+|season|expansion|dlc)\b/i;
export const NOT_PATCH = /\b(sale|% off|discount|bundle|dev ?stream|giveaway|event|twitch drops|livestream|merch)\b/i;
export const EVENT_PATTERNS = [
  String.raw`\bsteam\b.*\b(?:sale|next fest|festival)\b`,
  String.raw`\bnext fest\b`,
  String.raw`\bsteam (?:summer|autumn|winter|spring|lunar new year) sale\b`,
];
const DEFAULT_EVENTS = EVENT_PATTERNS.map((pattern) => new RegExp(pattern, 'i'));

const states = new Map();
const defaultState = () => ({ configured: false, at: 0, owned: 0, wishlist: 0, recent: 0, error: '' });
const stateOf = (ctx) => {
  const id = String(ctx?.config?.id ?? 'steam');
  if (!states.has(id)) states.set(id, defaultState());
  return states.get(id);
};

const offline = () => process.env.HERMES_WEB_FRESH_OFFLINE === '1';
const pause = (ms) => (offline() ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)));

const social = (name) => SOCIAL_ONLY.test(norm(name));
const norm = (s) => String(s ?? '').toLowerCase().replace(/[™®©:'’!?,.\-–—]/g, ' ').replace(/\s+/g, ' ').trim();

function credentials(ctx) {
  const id = ctx.secret('steam_id');
  const key = ctx.secret('api_key');
  return id && key ? { id: String(id), key: String(key) } : null;
}

export const hasSteam = (ctx = null) => offline() || Boolean(ctx && credentials(ctx));

function eventsOf(config = {}) {
  const patterns = Array.isArray(config.events) && config.events.length ? config.events : EVENT_PATTERNS;
  const out = [];
  for (const pattern of patterns) {
    try { out.push(pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i')); } catch { /* skip a bad pattern */ }
  }
  return out.length ? out : DEFAULT_EVENTS;
}

// ---------- the account (cached for a day) ----------
const cacheOf = (ctx) => ctx.state.get('steam-cache', null);

async function fetchAccount(ctx, c) {
  const q = `key=${c.key}&steamid=${c.id}&format=json`;
  const owned = await fetchJson(ctx, `${API}/IPlayerService/GetOwnedGames/v1/?${q}&include_appinfo=1&include_played_free_games=1`, { timeoutMs: 20_000 });
  if (owned.status !== 200) throw new Error(`steam owned ${owned.status}`);
  const recent = await fetchJson(ctx, `${API}/IPlayerService/GetRecentlyPlayedGames/v1/?${q}&count=10`).catch(() => ({ data: null }));
  const wish = await fetchJson(ctx, `${API}/IWishlistService/GetWishlist/v1/?${q}`).catch(() => ({ data: null }));
  const games = (owned.data?.response?.games ?? []).map((g) => ({ appid: g.appid, name: g.name ?? '', minutes: g.playtime_forever ?? 0 }));
  return {
    ownedCount: owned.data?.response?.game_count ?? games.length,
    games: games.sort((a, b) => b.minutes - a.minutes).slice(0, 150),
    recent: (recent.data?.response?.games ?? []).map((g) => ({ appid: g.appid, name: g.name ?? '', minutes: g.playtime_2weeks ?? 0 })),
    wishlist: (wish.data?.response?.items ?? []).map((w) => ({ appid: w.appid, priority: w.priority ?? 0 })),
  };
}

// Names of wishlist games (not in the wishlist call): asked once each, kept for good.
async function nameWishlist(ctx, wish, names) {
  let asked = 0;
  for (const w of wish) {
    if (names[w.appid] || asked >= 40) continue;
    asked += 1;
    try {
      const r = await fetchJson(ctx, `${STORE}/appdetails?appids=${w.appid}&filters=basic&l=en`);
      names[w.appid] = r.data?.[w.appid]?.data?.name ?? '';
    } catch { /* next time */ }
    await pause(1100);
  }
  return names;
}

export async function refreshSteam(ctx, { force = false } = {}) {
  const state = stateOf(ctx);
  const c = offline() ? { id: '1', key: 'mock' } : credentials(ctx);
  state.configured = Boolean(c);
  if (!c) return null;
  const hit = cacheOf(ctx);
  if (!force && hit && Date.now() - hit.at < DAY) return hit;
  try {
    const acct = await fetchAccount(ctx, c);
    const names = await nameWishlist(ctx, acct.wishlist, hit?.names ?? {});
    const next = { ...acct, names, at: Date.now() };
    ctx.state.set('steam-cache', next);
    lastAccount = next;
    Object.assign(state, { owned: acct.ownedCount, wishlist: acct.wishlist.length, recent: acct.recent.length, error: '' });
    return next;
  } catch (err) {
    state.error = String(err.message).slice(0, 80);
    return hit;
  }
}

// ---------- taste ----------
let boostCache = { at: 0, table: [] };
function boostTable(c) {
  if (!c) return [];
  if (boostCache.at === c.at) return boostCache.table;
  const table = [];
  const top = c.games.filter((g) => g.minutes > 120 && !social(g.name));
  const maxMin = Math.max(1, ...top.map((g) => g.minutes));
  for (const g of top) table.push({ name: norm(g.name), weight: 0.12 + 0.18 * Math.sqrt(g.minutes / maxMin) });
  for (const g of c.recent) if (!social(g.name)) table.push({ name: norm(g.name), weight: 0.3 });
  for (const w of c.wishlist) if (c.names?.[w.appid]) table.push({ name: norm(c.names[w.appid]), weight: 0.3 });
  boostCache = { at: c.at, table: table.filter((b) => b.name.length >= 5) };
  return boostCache.table;
}
export const resetBoosts = () => { boostCache = { at: 0, table: [] }; };
// For tests: forget the account kept in memory (the next boost reads the cached one from the store).
export const resetAccount = () => { lastAccount = null; boostCache = { at: 0, table: [] }; };

// The cached account of the last fetch, for the scoring path that has no context.
let lastAccount = null;
const cachedAccount = () => lastAccount ?? store.kvGet('steam-cache', null);

// 0..0.3: a story that names a game the reader plays, or waits for. Zero when Steam is not configured.
export function steamBoost(text) {
  const t = norm(text);
  let best = 0;
  for (const b of boostTable(cachedAccount())) if (b.weight > best && t.includes(b.name)) best = b.weight;
  return best;
}

// ---------- candidates ----------
const clean = (s) => String(s ?? '').replace(/\[\/?[a-z0-9*=]+[^\]]*\]/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function patchNotes(ctx, c, now) {
  const apps = [...c.recent, ...c.games].filter((g) => g.minutes > 60 && !social(g.name));
  const seen = new Set();
  const top = apps.filter((g) => !seen.has(g.appid) && seen.add(g.appid)).slice(0, 10);
  const out = [];
  for (const g of top) {
    const r = await fetchJson(ctx, `${API}/ISteamNews/GetNewsForApp/v2/?appid=${g.appid}&count=4&maxlength=500&feeds=steam_community_announcements`).catch(() => null);
    for (const n of r?.data?.appnews?.newsitems ?? []) {
      const ts = (n.date ?? 0) * 1000;
      if (now - ts > 4 * DAY || NOT_PATCH.test(n.title) || !(PATCH.test(n.title) || (n.tags ?? []).includes('patchnotes'))) continue;
      out.push({ name: `Steam · ${g.name}`, cat: ctx.config?.cat, title: `${g.name}: ${n.title}`.slice(0, 200), url: n.url, snippet: clean(n.contents).slice(0, 400), ts, meta: { patch: true, steamApp: g.appid, via: 'steam' } });
    }
    await pause(250);
  }
  return out;
}

async function released(ctx, c, now) {
  const out = [];
  const done = ctx.state.get('steam-released', {}) ?? {};
  const ids = c.wishlist.map((w) => w.appid).filter((id) => c.names?.[id] && !done[id]).slice(0, 25);
  for (const id of ids) {
    const r = await fetchJson(ctx, `${STORE}/appdetails?appids=${id}&filters=release_date&l=en`).catch(() => null);
    const rd = r?.data?.[id]?.data?.release_date;
    if (rd && rd.coming_soon === false) {
      done[id] = now;
      const when = Date.parse(rd.date);
      if (Number.isFinite(when) && now - when < 5 * DAY) out.push({ name: 'Steam · wishlist', cat: ctx.config?.cat, title: `${c.names[id]} is out on Steam`, url: `https://store.steampowered.com/app/${id}`, snippet: `A game on your wishlist came out ${rd.date}.`, ts: now, meta: { release: true, steamApp: id, via: 'steam' } });
    } else if (rd && rd.coming_soon === true) done[id] = 0;
    await pause(1100);
  }
  ctx.state.set('steam-released', done);
  return out;
}

// One summary card per sale event: the event announcement plus the wishlist games on discount now.
async function saleCards(ctx, c, now) {
  const r = await fetchJson(ctx, `${API}/ISteamNews/GetNewsForApp/v2/?appid=593110&count=8&maxlength=300`).catch(() => null);
  const events = eventsOf(ctx.config);
  const items = (r?.data?.appnews?.newsitems ?? []).filter((n) => events.some((re) => re.test(n.title)) && now - n.date * 1000 < 3 * DAY && !/client|beta|achievement|deck update/i.test(n.title));
  const handled = ctx.state.get('steam-events', {}) ?? {};
  const out = [];
  for (const ev of items.slice(0, 1)) {
    const key = norm(ev.title).replace(/\s+/g, '-').slice(0, 60);
    if (handled[key]) continue;
    const ids = c.wishlist.map((w) => w.appid).slice(0, 80);
    let deals = [];
    if (ids.length && !/next fest/i.test(ev.title)) {
      const p = await fetchJson(ctx, `${STORE}/appdetails?appids=${ids.join(',')}&filters=price_overview`).catch(() => null);
      deals = ids.map((id) => ({ id, name: c.names?.[id] || '', off: p?.data?.[id]?.data?.price_overview?.discount_percent ?? 0, price: p?.data?.[id]?.data?.price_overview?.final_formatted ?? '' }))
        .filter((d) => d.off >= 10 && d.name).sort((a, b) => b.off - a.off);
    }
    const nextFest = /next fest/i.test(ev.title);
    if (!nextFest && !deals.length) continue;
    handled[key] = now;
    const list = deals.slice(0, 6).map((d) => `${d.name} (-${d.off}%${d.price ? `, ${d.price}` : ''})`).join('; ');
    const name = clean(ev.title).replace(/!+$/, '');
    out.push({
      name: 'Steam', cat: ctx.config?.cat, kind: 'steam-sale',
      title: nextFest ? `${name} is live: time to try the demos` : `${name} is live: ${deals.length} wishlist games on sale`,
      url: ev.url, snippet: nextFest ? `${name}. Try the demos of games on your wishlist before the festival ends.` : `Wishlist games on sale: ${list}.`,
      ts: ev.date * 1000, meta: { event: key, deals: deals.length, summary: true, via: 'steam' },
    });
  }
  ctx.state.set('steam-events', handled);
  return out;
}

// -> candidates (patch notes, fresh releases, sale summaries). Cheap when nothing changed.
export async function steamCandidates(ctx, { now = Date.now(), force = false } = {}) {
  const state = stateOf(ctx);
  const c = await refreshSteam(ctx, { force });
  if (!c) return [];
  lastAccount = c;
  resetBoosts();
  const last = ctx.state.get('steam-run', 0);
  const everyMs = (Number.isFinite(ctx.config?.everyHours) ? ctx.config.everyHours : 3) * 3_600_000;
  if (!force && now - last < everyMs && !offline()) return [];
  ctx.state.set('steam-run', now);
  const parts = await Promise.allSettled([patchNotes(ctx, c, now), released(ctx, c, now), saleCards(ctx, c, now)]);
  return parts.flatMap((p) => (p.status === 'fulfilled' ? p.value : []));
}

// The generic path.
export async function fetch(ctx) {
  return steamCandidates(ctx, { now: ctx.now ? ctx.now() : Date.now(), force: ctx.force === true });
}

export function statusOf(ctx) {
  const state = stateOf(ctx);
  const configured = hasSteam(ctx);
  const cache = ctx ? cacheOf(ctx) : null;
  return { ...state, ...(cache ? { at: cache.at } : {}), configured, ...(configured ? {} : { unavailable: 'no credentials' }) };
}

export default {
  type: 'steam',
  title: 'Steam library',
  configSchema: {
    type: 'object',
    properties: {
      events: { type: 'array', items: { type: 'string' } },
      everyHours: { type: 'number' },
    },
  },
  credentials: [
    { key: 'steam_id', label: 'Steam ID', secret: true, required: true },
    { key: 'api_key', label: 'Steam API key', secret: true, required: true },
  ],
  defaultSchedule: { every: '3h' },
  cost: { kind: 'free' },
  fetch,
  status: statusOf,
  // The scoring path (index.js) asks the registry for this, with no context.
  boost: steamBoost,
};
