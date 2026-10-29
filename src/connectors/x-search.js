import { CATEGORIES, CAT_IDS } from '../fresh/profile.js';
import { loadLangPack } from '../fresh/filters.js';
import '../fresh/offline.js';
import { canon } from '../fresh/rank.js';
import * as store from '../fresh/store.js';
import { dayOf } from './budget.js';

// X search, as a connector. It goes through the agent's `socialSearch` provider and is PAID, so
// it is rationed hard:
//  - at most `dailyCap` calls per day in `ctx.timezone` (the counter is saved BEFORE the call, so
//    a crash cannot overspend), and a kill switch (ctx.enabled),
//  - slots a day, each with a fixed topic and hour. A slot always runs when its hour comes; the only
//    thing that stops it is the daily cap (it used to be skipped for free when the pool held plenty of
//    unseen stories or the reader had been away for a day, which left the feed without searches),
//  - each query asks for distinct items and lists what was already captured, so repeats are not
//    paid for twice,
//  - a slot restricted to an allowed list of handles that brought back fewer than MIN_ITEMS items
//    runs its NEXT turn as an open search on the topic,
//  - the last raw answer of every slot is kept for diagnosis (kv 'x-raw').
//
// The ledger (`ctx.budget`) keeps the exact file and format the old code used (data/fresh-x.json).
// Config:
//   slots: [{ at: 'HH:MM', topic, lang?, days?, cats, handles?: string[]|'name', type?, minLikes? }]
//   minLikes: a "viral" slot. Each answer line must carry the main post's like count as [likes: N]; a line below
//             minLikes, or without a count, is dropped, and citations (which carry no count) are ignored.
//   dailyCap: number (default 7)
//   handles: { <name>: [handle, ...] }   named handle lists a slot may follow
//   learned: { pass, fail, passRatio, failRatio, max, lang: {...} }   thresholds of handle learning
//   windowHours: 4                       a slot that could not run within this many hours is lost
//   minItems: 3                          a handle-restricted call below this opens the next turn
//
// `lang` is generic: the alternate-day "only learned handles" rule and the junk filter key on it. The junk words of a language live in the filter pack
// data/filters/<lang>.json (see src/fresh/filters.js), never in this file.
export const DAILY_CAP = 7;
export const MIN_ITEMS = 3;
export const WINDOW_H = 4;
const DAY_MS = 86_400_000;
const RAW_MAX = 20_000;
const RAW_STATUS = 3_000;
const OTHER = 'ignore replies, ads, giveaways and reposts of the same story';
const ESTIMATED_COST_MICRO = 100_000_000;
const MAX_HANDLES = 20;
const offline = () => process.env.HERMES_WEB_FRESH_OFFLINE === '1';

export const LEARNED = { pass: 4, fail: 4, passRatio: 3, failRatio: 2, max: 20, lang: { pass: 2, fail: 3, passRatio: 2, failRatio: 2, max: 20, min: 8 } };

// The shipped default: one generic daily slot at noon, built from the configured categories. It
// is neutral and English; a deployment with a tuned set describes its own slots in config.json.
export const defaultSlots = () => [{
  at: '12:00',
  type: 'daily',
  cats: [...CAT_IDS],
  topic: `Notable news, releases and hands-on write-ups about ${CAT_IDS.map((id) => CATEGORIES[id] ?? id).join(', ')} from the last day`,
}];
export const SLOTS = defaultSlots();

const atMinutes = (at) => {
  const match = String(at ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
};

export function configOf(config = {}) {
  // `slots` given as an array (even an empty one) is the deployment's own list: an empty list means
  // "no slots yet", which the connector reports as unavailable. Without the key at all, the shipped
  // default slot (one generic daily one at noon) applies.
  const rawSlots = Array.isArray(config.slots) ? config.slots : defaultSlots();
  const slots = rawSlots.map((slot, index) => {
    const cats = (Array.isArray(slot?.cats) && slot.cats.length ? slot.cats : [CAT_IDS[0]]).map(String);
    return {
      n: index + 1,
      at: typeof slot?.at === 'string' ? slot.at : '12:00',
      minutes: atMinutes(slot?.at) ?? 12 * 60,
      topic: String(slot?.topic ?? '').trim() || `Notable news about ${cats.map((cat) => CATEGORIES[cat] ?? cat).join(', ')}`,
      lang: typeof slot?.lang === 'string' && slot.lang ? String(slot.lang).slice(0, 2).toLowerCase() : '',
      days: Number.isFinite(slot?.days) ? slot.days : null,
      cats,
      type: typeof slot?.type === 'string' && slot.type ? slot.type : cats[0],
      handles: slot?.handles ?? null,
      excludeLearned: slot?.excludeLearned === true,
      minLikes: Number.isFinite(slot?.minLikes) && slot.minLikes > 0 ? Math.floor(slot.minLikes) : 0,
    };
  });
  const learned = { ...LEARNED, ...(config.learned && typeof config.learned === 'object' ? config.learned : {}), lang: { ...LEARNED.lang, ...(config.learned?.lang && typeof config.learned.lang === 'object' ? config.learned.lang : {}) } };
  const handles = config.handles && typeof config.handles === 'object' && !Array.isArray(config.handles) ? config.handles : {};
  return {
    slots,
    dailyCap: Number.isFinite(config.dailyCap) && config.dailyCap >= 0 ? config.dailyCap : DAILY_CAP,
    handles,
    learned,
    windowHours: Number.isFinite(config.windowHours) ? config.windowHours : WINDOW_H,
    minItems: Number.isFinite(config.minItems) ? config.minItems : MIN_ITEMS,
  };
}

// ---------- time in the connector's zone ----------
export const minutesOfDay = (now, timezone = 'UTC') => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
};
const zone = (ctx) => ctx?.timezone || 'UTC';

// The even/odd day alternation a language slot uses once enough of its own handles are learned.
export const onlyDay = (now, timezone = 'UTC') => Math.floor(Date.parse(`${dayOf(now, timezone)}T00:00:00Z`) / DAY_MS) % 2 === 1;

// ---------- learned handles ----------
const emptyHandles = () => ({ stats: {}, allowed: [], excluded: [], langs: {} });
function readHandles(ctx) {
  const raw = ctx.state.get('x-handles', {}) ?? {};
  const h = { ...emptyHandles(), ...raw, langs: { ...(raw.langs ?? {}) } };
  // The pre-connector file kept one language's lists under `idStats` / `idAllowed` / `idExcluded`.
  if (raw.idStats || raw.idAllowed?.length || raw.idExcluded?.length) {
    h.langs.id ??= { stats: raw.idStats ?? {}, allowed: raw.idAllowed ?? [], excluded: raw.idExcluded ?? [] };
  }
  for (const [code, row] of Object.entries(h.langs)) h.langs[code] = { stats: row?.stats ?? {}, allowed: row?.allowed ?? [], excluded: row?.excluded ?? [] };
  return h;
}
const langRow = (h, lang) => (h.langs[lang] ??= { stats: {}, allowed: [], excluded: [] });

function evaluate(row, name, learned) {
  const stats = row.stats[name];
  const pass = stats?.pass ?? 0;
  const fail = stats?.fail ?? 0;
  if (fail >= learned.fail && fail > learned.failRatio * pass && !row.excluded.includes(name)) {
    row.excluded.push(name);
    row.allowed = row.allowed.filter((handle) => handle !== name);
    row.excluded = row.excluded.slice(-learned.max);
  } else if (pass >= learned.pass && pass >= learned.passRatio * fail && !row.allowed.includes(name) && !row.excluded.includes(name)) {
    row.allowed = [...row.allowed, name].slice(-learned.max);
  }
}

// pass: the story got through scoring; fail: it was rejected, or the reader asked for less of it.
// A language slot judges its accounts on its own (its own stats and lists).
export function noteHandle(name, pass, weight = 1, lang = '', ctx = null) {
  if (!/^\w{1,15}$/.test(name ?? '')) return;
  const holder = ctx ?? { state: { get: (key, fallback) => store.kvGet(key, fallback), set: (key, value) => store.kvSet(key, value) } };
  const learned = configOf(holder.config ?? {}).learned;
  const h = readHandles(holder);
  const row = lang ? langRow(h, String(lang).slice(0, 2).toLowerCase()) : h;
  const stats = (row.stats[name] ??= { pass: 0, fail: 0 });
  if (pass) stats.pass += weight; else stats.fail += weight;
  evaluate(row, name, lang ? { ...learned, ...learned.lang } : learned);
  holder.state.set('x-handles', h);
}

const unique = (list) => [...new Set(list)];

export function handleLists(slot, now, cfg, ctx) {
  const h = readHandles(ctx);
  if (slot.lang) {
    const row = langRow(h, slot.lang);
    if (row.allowed.length >= cfg.learned.lang.min && onlyDay(now, zone(ctx))) return { allowed: row.allowed.slice(0, MAX_HANDLES), excluded: null };
    return { allowed: null, excluded: row.excluded.length ? row.excluded.slice(-MAX_HANDLES) : null };
  }
  const named = typeof slot.handles === 'string' ? cfg.handles[slot.handles] : Array.isArray(slot.handles) ? slot.handles : null;
  const base = Array.isArray(named) ? named : null;
  const allowed = base ? unique([...h.allowed, ...base]).filter((handle) => /^\w{1,15}$/.test(handle) && !h.excluded.includes(handle)).slice(0, MAX_HANDLES) : null;
  return { allowed, excluded: !allowed && slot.excludeLearned && h.excluded.length ? h.excluded.slice(-MAX_HANDLES) : null };
}

// ---------- query and answer ----------
export function buildQuery(slot, others = []) {
  const covered = others.slice(0, 14).map((title) => String(title).replace(/\s+/g, ' ').slice(0, 60)).join('; ');
  const language = slot.lang ? ` Only posts in language ${slot.lang} (lang:${slot.lang}).` : '';
  const viral = slot.minLikes ? ` Only stories that are viral right now: the main post must have at least ${slot.minLikes} likes. End each line with the approximate like count of that post as [likes: N] (for example [likes: 2400]).` : '';
  return `${slot.topic}. List 15 to 25 DISTINCT items, one per line, in this form: "- @handle: one-sentence summary. URL". Each item must be a different story or release with exactly ONE link (the article, repo or product page rather than the post itself when there is one). No duplicates, ${OTHER}.${language}${viral}${covered ? ` Other than: ${covered}.` : ''}`;
}

const URL_RE = /https?:\/\/[^\s)\]>"']+/g;
const LIKES_RE = /\[?\s*likes?\s*[:=]\s*~?\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?\s*\]?/i;
// "[likes: 2.4k]" -> 2400; null when the line carries no count.
export function likesOf(text) {
  const match = String(text ?? '').match(LIKES_RE);
  if (!match) return null;
  const n = Number.parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * ({ k: 1e3, m: 1e6 }[(match[2] ?? '').toLowerCase()] ?? 1));
}

// Language-neutral junk: affiliate / referral parameters and short links that hide one.
const AFFILIATE_URL = /[?&](?:fpr|ref|ref_id|refcode|referral|aff\w*|via|sub_id|coupon)=|[?&]utm_campaign=[^&]*affil|\/aff(?:iliate)?\//i;

// The drop rules of the slot language's pack (data/filters/<lang>.json, else the shipped pack of
// that id). No pack for that language means no extra filter: the English pack never applies to
// another language's posts.
const packCache = new Map();
function rulesForLang(lang) {
  const code = String(lang ?? '').slice(0, 2).toLowerCase();
  if (!code) return [];
  if (packCache.has(code)) return packCache.get(code);
  let rules = [];
  try {
    const pack = loadLangPack(code);
    rules = (pack?.rules ?? []).filter((rule) => rule.action === 'drop').map((rule) => rule.re);
  } catch { rules = []; }
  packCache.set(code, rules);
  return rules;
}
// Tests and a config reload call this after changing a pack file.
export const clearFilterCache = () => packCache.clear();

export function langRejected(item, lang = '') {
  const text = `${item.title ?? ''} ${item.snippet ?? ''}`;
  if (AFFILIATE_URL.test(item.url ?? '') || AFFILIATE_URL.test(item.meta?.short ?? '') || AFFILIATE_URL.test(text)) return true;
  for (const re of rulesForLang(lang)) if (re.test(text)) return true;
  return false;
}

const isX = (url) => /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(url);

const BULLET_RE = /^\s{0,3}(?:[-*\u2022]|\d{1,2}[.)])\s+/;
const HANDLE_START_RE = /^\s{0,3}@\w{1,15}\b/;
const TABLE_ROW_RE = /^\s*\|.*https?:\/\//;
const NOTHING_RE = /\b(?:no (?:relevant |matching |recent )?(?:posts?|results?|items?|tweets?)|(?:could(?: not|n't)|unable to|did not|didn't) find|nothing (?:found|relevant))\b/i;
const LABEL_RE = /\b(?:post link|link|source|post|tweet)\s*:\s*/gi;
const stripMd = (text) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(URL_RE, ' ').replace(LABEL_RE, ' ').replace(/\*\*|__|`/g, '').replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
const firstSentence = (text) => text.split(/(?<=[.!?])\s+(?=[A-Z@(])/)[0].replace(/[\s.;:,]+$/, '');
const clip = (text, n) => (text.length <= n ? text : `${text.slice(0, n).replace(/\s+\S*$/, '')}…`);

function itemBlocks(answer) {
  const blocks = [];
  let current = null;
  for (const raw of String(answer ?? '').split('\n')) {
    if (!raw.trim()) { current = null; continue; }
    if (BULLET_RE.test(raw)) { current = [raw.replace(BULLET_RE, '')]; blocks.push(current); }
    else if (HANDLE_START_RE.test(raw)) { current = [raw.trim()]; blocks.push(current); }
    else if (TABLE_ROW_RE.test(raw) && !/^\s*\|[\s:|-]+\|?\s*$/.test(raw)) { current = null; blocks.push([raw.replace(/\|/g, ' ').trim()]); }
    else if (current) current.push(raw.trim());
  }
  if (!blocks.length) for (const raw of String(answer ?? '').split('\n')) if (/https?:\/\//.test(raw)) blocks.push([raw.trim()]);
  return blocks;
}

export function parseAnswer(data, slot) { return parseAnswerStats(data, slot).items; }
// -> { items (what is kept), parsed (items found before the language filter), kept, nothing }
export function parseAnswerStats(data, slot = {}) {
  const out = [];
  let parsed = 0;
  let fromAnswer = 0;
  const seen = new Set();
  const posts = new Set();
  const reject = (item) => (slot.lang ? langRejected(item, slot.lang) : false);
  const push = (candidate) => { const key = canon(candidate.url); if (!seen.has(key)) { seen.add(key); out.push(candidate); } };
  const statusId = (url) => url.match(/\/status(?:es)?\/(\d+)/)?.[1];
  for (const rawLines of itemBlocks(data?.answer)) {
    const likes = likesOf(rawLines.join(' '));
    const lines = rawLines.map((line) => line.replace(new RegExp(LIKES_RE.source, 'gi'), '').trimEnd());
    const full = lines.join(' ');
    const urls = (full.match(URL_RE) ?? []).map((url) => url.replace(/[.,;:]+$/, ''));
    if (!urls.length) continue;
    const post = urls.find(isX) ?? '';
    const pathHandle = post.match(/(?:x|twitter)\.com\/(\w{1,15})\/status/i)?.[1];
    const handle = (pathHandle && pathHandle.toLowerCase() !== 'i' ? pathHandle : '') || full.match(/@(\w{1,15})/)?.[1] || '';
    const link = urls.find((url) => !isX(url)) ?? urls[0];
    const first = lines[0].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    const bold = first.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)(\s*\([^)]*\))?\s*[:\u2013\u2014-]?\s*/);
    let title;
    let snippet;
    if (bold) {
      const name = stripMd(bold[1] + (bold[2] ?? ''));
      const rest = stripMd(first.slice(bold[0].length)) || stripMd(lines.slice(1).join(' '));
      snippet = rest;
      const short = firstSentence(rest);
      title = short ? `${name}: ${clip(short, 100)}` : name;
    } else {
      snippet = stripMd(first) || stripMd(full);
      title = snippet.replace(/^@\w+:?\s*/, '');
    }
    snippet = snippet.replace(/^@\w+:?\s*/, '');
    if (stripMd(full).length < 15 || title.length < 8) continue;
    if (post) posts.add(statusId(post));
    const item = { source: 'x', name: handle ? `X · @${handle}` : 'X', cat: (slot.cats ?? [CAT_IDS[0]])[0], title: clip(title, 160), url: link, snippet: snippet.slice(0, 400), ts: Date.now(), meta: { via: 'x', handle, slot: slot.n, post, ...(likes != null ? { likes } : {}), ...(slot.lang ? { lang: slot.lang } : {}) } };
    parsed += 1;
    fromAnswer += 1;
    if (slot.minLikes && !(likes >= slot.minLikes)) continue;
    if (reject({ ...item, snippet: full })) continue;
    push(item);
  }
  for (const citation of slot.minLikes ? [] : data?.citations ?? []) {
    if (!citation?.url || !/^https?:/.test(citation.url)) continue;
    const title = String(citation.title ?? '').trim();
    if (!title || title === citation.url || /^https?:\/\/\S+$/.test(title)) continue;
    if (posts.has(statusId(citation.url))) continue;
    const item = { source: 'x', name: 'X', cat: (slot.cats ?? [CAT_IDS[0]])[0], title: title.slice(0, 160), url: citation.url, snippet: title.slice(0, 200), ts: Date.now(), meta: { via: 'x', handle: '', slot: slot.n, post: '', ...(slot.lang ? { lang: slot.lang } : {}) } };
    parsed += 1;
    if (reject(item)) continue;
    push(item);
  }
  return { items: out, parsed, kept: out.length, nothing: !fromAnswer && NOTHING_RE.test(String(data?.answer ?? '').slice(0, 600)) };
}

// ---------- raw answers and slot health (kv, in the data dir, never in git) ----------
const rawOf = (slotN, { query, filter, data, parsed, kept, setup }) => {
  const raw = { at: Date.now(), query: String(query).slice(0, 2000), filter, setup, parsed, kept, answer: String(data?.answer ?? ''), citations: (data?.citations ?? []).slice(0, 40).map((c) => ({ url: String(c?.url ?? '').slice(0, 300), title: String(c?.title ?? '').slice(0, 160) })) };
  while (JSON.stringify(raw).length > RAW_MAX && raw.answer.length > 200) raw.answer = raw.answer.slice(0, Math.max(200, raw.answer.length - 2000));
  while (JSON.stringify(raw).length > RAW_MAX && raw.citations.length) raw.citations.pop();
  return raw;
};
function keepRaw(ctx, slotN, raw) {
  try { ctx.state.set('x-raw', { ...(ctx.state.get('x-raw', {}) ?? {}), [slotN]: raw }); } catch { /* diagnosis only */ }
}
const lastRaw = (ctx) => Object.fromEntries(Object.entries(ctx.state.get('x-raw', {}) ?? {}).map(([n, raw]) => [n, { ...raw, answer: String(raw.answer ?? '').slice(0, RAW_STATUS), citations: (raw.citations ?? []).slice(0, 20) }]));
const slotHealth = (ctx) => ctx.state.get('x-slot-health', {}) ?? {};
function noteSlot(ctx, n, { setup, parsed, nothing, now, minItems }) {
  const all = slotHealth(ctx);
  const current = all[n] ?? { weak: 0, openNext: false };
  const weak = parsed < minItems;
  all[n] = { weak: weak ? current.weak + 1 : 0, openNext: weak && setup !== 'open', lastSetup: setup, nothing: Boolean(nothing), at: now };
  ctx.state.set('x-slot-health', all);
}

// ---------- status ----------
export function statusOf(ctx) {
  const cfg = configOf(ctx?.config ?? {});
  const budget = ctx?.budget;
  const now = ctx?.now ? ctx.now() : Date.now();
  const timezone = zone(ctx);
  const today = budget?.spentToday ? budget.spentToday(now) : { day: dayOf(now, timezone), calls: 0, costMicro: 0, slots: {} };
  const ledger = budget?.read ? budget.read() : { days: {}, last: {} };
  const month = Object.entries(ledger.days ?? {}).filter(([key]) => key.slice(0, 7) === today.day.slice(0, 7)).reduce((sum, [, row]) => ({ calls: sum.calls + (row.calls ?? 0), costMicro: sum.costMicro + (row.costMicro ?? 0) }), { calls: 0, costMicro: 0 });
  const h = ctx ? readHandles(ctx) : emptyHandles();
  const langHandles = Object.entries(h.langs).find(([, row]) => row.allowed?.length) ?? Object.entries(h.langs)[0] ?? ['', { allowed: [] }];
  const search = ctx?.providers?.get?.('socialSearch') ?? null;
  const minutes = minutesOfDay(now, timezone);
  const unavailable = !cfg.slots.length ? 'no slots configured' : !search ? 'needs a socialSearch provider' : undefined;
  return {
    enabled: ctx ? ctx.enabled !== false : true,
    cap: cfg.dailyCap,
    day: today.day,
    callsToday: today.calls,
    provider: search?.label ?? '',
    currency: search?.pricing?.currency ?? 'USD',
    costToday: today.costMicro / 1e6, // in `currency`
    callsMonth: month.calls,
    costMonth: month.costMicro / 1e6,
    slots: [...cfg.slots].sort((a, b) => a.minutes - b.minutes).map((slot) => ({
      n: slot.n,
      at: slot.at,
      hour: Math.floor(slot.minutes / 60),
      // The Settings panel reads this field name; the value is the hour in ctx.timezone.
      hourLocal: Math.floor(slot.minutes / 60),
      type: slot.type,
      lang: slot.lang,
      state: today.slots[slot.n]?.state ?? (minutes < slot.minutes ? 'pending' : 'due'),
      items: today.slots[slot.n]?.items ?? 0,
      kept: today.slots[slot.n]?.kept ?? today.slots[slot.n]?.items ?? 0,
      setup: today.slots[slot.n]?.setup ?? '',
      reason: today.slots[slot.n]?.reason ?? '',
    })),
    handles: { allowed: h.allowed, excluded: h.excluded, id: langHandles[1]?.allowed ?? [], byLang: Object.fromEntries(Object.entries(h.langs).map(([code, row]) => [code, { allowed: row.allowed, excluded: row.excluded }])) },
    blockedUntil: ledger.blockedUntil ?? 0,
    slotHealth: slotHealth(ctx),
    lastRaw: lastRaw(ctx),
    ...(unavailable ? { unavailable } : {}),
  };
}

// ---------- the scheduler ----------
let busy = false;
let hold = false;
export const holdScheduler = (on) => { hold = Boolean(on); };

const sinceOf = (ctx, days, now) => (days ? dayOf(now - days * DAY_MS, zone(ctx)) : null);

// Called every few minutes. Runs at most one due slot; returns { slot, items, ... } when it
// called X, { skipped } when a slot was passed over for free, or null.
export async function runDueSlot(ctx, { now = ctx?.now?.() ?? Date.now() } = {}) {
  const cfg = configOf(ctx.config ?? {});
  if (ctx.enabled === false || busy || hold) return null;
  const budget = ctx.budget;
  if (!budget) return null;
  const ledger = budget.read();
  if ((ledger.blockedUntil ?? 0) > now) return null;
  const day = dayOf(now, zone(ctx));
  ledger.days ??= {};
  const row = (ledger.days[day] ??= { calls: 0, costMicro: 0, slots: {} });
  const minutes = minutesOfDay(now, zone(ctx));
  const due = cfg.slots.filter((slot) => !row.slots[slot.n] && minutes >= slot.minutes && minutes < Math.min(24 * 60, slot.minutes + cfg.windowHours * 60)).sort((a, b) => a.minutes - b.minutes)[0];
  // A slot whose window passed without running is closed for the day.
  let changed = false;
  for (const slot of cfg.slots) {
    if (!row.slots[slot.n] && minutes >= slot.minutes + cfg.windowHours * 60 && minutes < 24 * 60) { row.slots[slot.n] = { state: 'missed', at: now }; changed = true; }
  }
  if (!due) { if (changed) budget.write(ledger); return null; }
  if (changed) budget.write(ledger);

  const skip = (reason) => { row.slots[due.n] = { state: 'skipped', reason, at: now }; budget.write(ledger); return { skipped: due.n, reason }; };
  if (row.calls >= cfg.dailyCap) return skip('cap');
  return pay(ctx, cfg, due, { now, ledger, row, day });
}

// Bootstrap: one slot, right now, whatever the clock says. Still recorded
// in the ledger like any call (so today's cap may be used up afterwards).
export async function runSlotNow(ctx, n, { now = ctx?.now?.() ?? Date.now(), days } = {}) {
  const cfg = configOf(ctx.config ?? {});
  const slot = cfg.slots.find((entry) => entry.n === Number(n));
  if (!slot) return { slot: Number(n), error: 'no such slot' };
  if (busy) return { slot: slot.n, error: 'busy' };
  if (!ctx.budget) return { slot: slot.n, error: 'no budget' };
  const ledger = ctx.budget.read();
  if ((ledger.blockedUntil ?? 0) > now) return { slot: slot.n, error: 'blocked' };
  const day = dayOf(now, zone(ctx));
  ledger.days ??= {};
  return pay(ctx, cfg, slot, { now, ledger, row: (ledger.days[day] ??= { calls: 0, costMicro: 0, slots: {} }), day, days });
}

const estimateMicro = (search) => {
  const price = Number(search?.pricing?.perCallMicro);
  return Number.isFinite(price) && price >= 0 ? price : ESTIMATED_COST_MICRO;
};

// Pay: the counter is saved before the request.
async function pay(ctx, cfg, slot, { now, ledger, row, day, days }) {
  const budget = ctx.budget;
  const search = ctx.providers?.get?.('socialSearch') ?? null;
  if (!search) {
    budget.markSlot(slot.n, { state: 'error', reason: 'no provider', at: now }, now);
    return { slot: slot.n, error: 'no provider' };
  }
  if (row.calls >= cfg.dailyCap) {
    budget.markSlot(slot.n, { state: 'skipped', reason: 'cap', at: now }, now);
    return { slot: slot.n, error: 'cap' };
  }
  busy = true;
  const costMicro = estimateMicro(search);
  const reserved = budget.reserve(costMicro, { cap: cfg.dailyCap, slot: slot.n, at: now });
  if (!reserved) { busy = false; budget.markSlot(slot.n, { state: 'skipped', reason: 'cap', at: now }, now); return { slot: slot.n, error: 'cap' }; }
  const open = Boolean(slotHealth(ctx)[slot.n]?.openNext);
  const lists = open ? { allowed: null, excluded: slot.lang ? handleLists(slot, now, cfg, ctx).excluded : null } : handleLists(slot, now, cfg, ctx);
  const setup = lists.allowed?.length ? 'handles' : open ? 'open' : lists.excluded?.length ? 'excluded' : 'open';
  const back = slot.days ?? days;
  const from = sinceOf(ctx, back, now) ?? (ledger.last?.[slot.type] ?? dayOf(now - DAY_MS, zone(ctx)));
  const filter = { from, ...(lists.allowed?.length ? { allowedHandles: lists.allowed } : lists.excluded?.length ? { excludedHandles: lists.excluded } : {}) };
  const others = store.recentTitles(slot.cats, now - 36 * 3_600_000, 14);
  const finish = (patch, { refund = false, cost = 0, last = false } = {}) => {
    budget.update((current) => {
      current.days ??= {};
      const currentDay = (current.days[day] ??= { calls: 0, costMicro: 0, slots: {} });
      if (refund) {
        // reserve() counts the call but adds no cost yet, so a refund only gives the call back.
        currentDay.calls = Math.max(0, currentDay.calls - 1);
      }
      if (cost) currentDay.costMicro += cost;
      currentDay.slots ??= {};
      currentDay.slots[slot.n] = { ...(currentDay.slots[slot.n] ?? {}), ...patch, at: now };
      if (last) (current.last ??= {})[slot.type] = day;
      if (patch.block) current.blockedUntil = now + patch.block;
    });
  };
  try {
    const query = buildQuery(slot, others);
    let data;
    try {
      data = await search.search({ query, topic: slot.topic, ...(slot.lang ? { lang: slot.lang } : {}), filter, timeoutMs: 120_000 });
    } catch (err) {
      // 400 / 429 / 503 and 402 are not charged. A missing balance stops the calls for six hours.
      if (err?.kind === 'nokey') { finish({ state: 'error', reason: 'no provider' }, { refund: true }); return { slot: slot.n, error: 'no provider' }; }
      if (!err?.status) throw err;
      const code = err.status;
      finish({ state: 'error', reason: String(code), block: code === 402 ? 6 * 3_600_000 : 0 }, { refund: true });
      return { slot: slot.n, error: code };
    }
    const wire = { answer: data?.answer, citations: data?.citations, cost_micro: data?.costMicro };
    const parsedOut = parseAnswerStats(wire, slot);
    const cost = Number(wire.cost_micro) || costMicro;
    keepRaw(ctx, slot.n, rawOf(slot.n, { query, filter: { from_date: from, ...(lists.allowed?.length ? { allowed_x_handles: lists.allowed } : lists.excluded?.length ? { excluded_x_handles: lists.excluded } : {}) }, data: wire, parsed: parsedOut.parsed, kept: parsedOut.kept, setup }));
    noteSlot(ctx, slot.n, { setup, parsed: parsedOut.parsed, nothing: parsedOut.nothing, now, minItems: cfg.minItems });
    finish({ state: 'done', items: parsedOut.parsed, kept: parsedOut.kept, setup, ...(parsedOut.nothing ? { note: 'answer says nothing found' } : {}) }, { cost, last: true });
    return { slot: slot.n, items: parsedOut.items, parsed: parsedOut.parsed, kept: parsedOut.kept, costMicro: cost };
  } catch (err) {
    // A timeout may still have been charged: the call stays counted.
    finish({ state: 'error', reason: String(err.message).slice(0, 60) });
    return { slot: slot.n, error: err.message, charged: true };
  } finally { busy = false; }
}

// The generic path: at most one due slot per call; the candidates of that slot. A call that
// failed throws so the caller can record it; a free skip returns [].
export async function fetch(ctx) {
  if (ctx.enabled === false) return [];
  if (!ctx.providers?.get?.('socialSearch')) return [];
  const cfg = configOf(ctx.config ?? {});
  if (!cfg.slots.length) return [];
  const now = ctx.now ? ctx.now() : Date.now();
  // The offline switch is the sandbox: no clock may keep it from
  // answering, so a test run still exercises all four connectors (once per slot and day).
  if (offline()) {
    const today = ctx.budget?.spentToday?.(now) ?? { slots: {} };
    const slot = cfg.slots.find((entry) => !['done', 'running'].includes(today.slots[entry.n]?.state));
    if (!slot) return [];
    const out = await runSlotNow(ctx, slot.n, { now });
    if (out?.error && out.error !== 'cap') throw new Error(String(out.error));
    return out?.items ?? [];
  }
  const out = await runDueSlot(ctx, { now });
  if (out?.error && out.error !== 'cap') throw new Error(String(out.error));
  return out?.items ?? [];
}

export const test = async (ctx) => {
  const search = ctx.providers?.get?.('socialSearch') ?? null;
  if (!search) return { ok: false, detail: 'needs a socialSearch provider' };
  try {
    await search.search({ query: 'A one-line connectivity test; answer with nothing found.', timeoutMs: 30_000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err.message).slice(0, 80) };
  }
};

export default {
  type: 'x-search',
  title: 'X search',
  configSchema: {
    type: 'object',
    properties: {
      slots: { type: 'array', items: { type: 'object', properties: { at: { type: 'string' }, topic: { type: 'string' }, lang: { type: 'string' }, days: { type: 'number' }, cats: { type: 'array' }, handles: {}, minLikes: { type: 'number' } } } },
      dailyCap: { type: 'number' },
      handles: { type: 'object' },
      learned: { type: 'object' },
      windowHours: { type: 'number' },
      minItems: { type: 'number' },
    },
  },
  credentials: [],
  defaultSchedule: { every: '5m' },
  cost: { kind: 'metered', requires: ['socialSearch'] },
  fetch,
  test,
  status: statusOf,
  // Used by the bootstrap (one call per slot, whatever the clock) and by anything that wants the
  // configured slots without a context.
  slots: (config = {}) => configOf(config).slots,
  runSlot: runSlotNow,
};
