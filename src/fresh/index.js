import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { settings as deployment } from '../config/instance.js';
import { resolveSecret } from '../config/secrets.js';
import { CAT_IDS, PRIMARY_CAT } from './profile.js';
import { CATEGORIES, KINDS, discoverFeed, fetchSource } from './feeds.js';
import { createRegistry } from '../connectors/registry.js';
import { DEFAULT_CONNECTOR_PRESETS, fromLegacySource, legacyKindOf } from '../connectors/presets.js';
import { ingest as ingestConnector } from '../connectors/ingest.js';
import { createBudget } from '../connectors/budget.js';
import { stateFor } from '../connectors/state.js';
import { safeFetch } from './net.js';
import { categoryOf, collapse, idOf, jaccard, scoreOf, sig, stackFlag, tokens } from './rank.js';
import { pageInfo, readerBlocks, saveImage } from './enrich.js';
import { MAX_MERGES_PER_ROUND, findDuplicates, pickHost } from './dedupe.js';
import { WRITE_BATCH, glossaryRules, llmUsage, triage, writeCards } from './llm.js';
import { setPerMin } from '../providers/ratelimit.js';
import { setPrimaryAgent, providersFor } from '../providers/compat.js';
import { NOTIFY_DEFAULTS, init as initNotify, maybeNotify, normalizeNotify, notifyView, tick as notifyTick } from './notify.js';
import { noteHandle, langRejected } from '../connectors/x-search.js';
import { bootstrapProgress, startBootstrap } from './bootstrap.js';
import { forYouPage } from './timeline.js';
import { content } from './content.js';
import { timezone } from '../time.js';
import { resolveItems } from './links.js';
import { groupThreads } from './threads.js';
import * as store from './store.js';
import { createScheduler } from '../scheduler/scheduler.js';

// "Fresh": the home timeline of the Feed style. A background worker gathers stories from feeds, Bluesky search, X (paid, rationed,
// see connectors/x-search.js) and the reader's Steam account, drops duplicates, has System One judge each one, has a model write the survivors
// as short cards in the configured content language, and keeps a pool of READY cards. Reading never waits for any of that: the timeline is ranked from the
// pool on request (timeline.js). Stories are kept for 14 days.
const MAX_AGE_H = 72;
const MIN_SCORE = 1.0;
const PER_RUN = 24;
const PER_SOURCE = 4; // per round
const PRIORITY = new Set(['x', 'w-x']); // paid and freshest: never wait behind the free feeds, and not held to PER_SOURCE
const DAILY_CAP = 200;
const KEEP_DAYS = 14;
const RELEASE_GAP_MS = 3 * 86_400_000;
const offline = () => process.env.HERMES_WEB_FRESH_OFFLINE === '1';

const settingsFile = path.join(config.dataDir, 'fresh', 'settings.json');
let settings = { enabled: true, intervalMin: 30, off: [], custom: [], x: { enabled: true } };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* first run */ }
settings.x = { enabled: true, ...settings.x };
settings.notify = normalizeNotify(settings.notify, NOTIFY_DEFAULTS);
if (settings.llmPerMin) setPerMin(settings.llmPerMin);
const persist = () => { fs.writeFileSync(`${settingsFile}.tmp`, JSON.stringify(settings, null, 2), { mode: 0o600 }); fs.renameSync(`${settingsFile}.tmp`, settingsFile); };

// The order of the category chips (after "All"); "saved" is a chip too. Unknown ids are dropped, missing ones follow in default order.
export const normalizeCatOrder = (list) => {
  const DEFAULT_ORDER = [...CAT_IDS, 'saved'];
  const seen = new Set();
  const first = (Array.isArray(list) ? list : []).filter((id) => DEFAULT_ORDER.includes(id) && !seen.has(id) && seen.add(id));
  return [...first, ...DEFAULT_ORDER.filter((id) => !seen.has(id))];
};
export const catOrder = () => normalizeCatOrder(settings.catOrder);
export const getFreshSettings = () => ({ enabled: settings.enabled, intervalMin: settings.intervalMin, catOrder: catOrder(), llmPerMin: settings.llmPerMin ?? 20, notify: notifyView(settings.notify), x: xStatusView() });
export function setFreshSettings({ enabled, intervalMin, x, catOrder: order, notify, llmPerMin }) {
  if (typeof enabled === 'boolean') settings.enabled = enabled;
  if (Number.isFinite(intervalMin)) settings.intervalMin = Math.max(10, Math.min(360, Math.round(intervalMin)));
  if (Array.isArray(order)) settings.catOrder = normalizeCatOrder(order);
  if (x && typeof x.enabled === 'boolean') settings.x.enabled = x.enabled; // the kill switch for the paid X calls
  if (notify && typeof notify === 'object') settings.notify = normalizeNotify(notify, settings.notify);
  if (Number.isFinite(llmPerMin) && llmPerMin > 0) { settings.llmPerMin = Math.max(1, Math.min(100, Math.round(llmPerMin))); setPerMin(settings.llmPerMin); }
  persist();
  schedule();
}

// ---------- connectors ----------
// The instance list: the configured `connectors` when non-empty, else the shipped presets. Custom
// sources saved by the Settings dialog are appended; they still carry the old `kind` and are mapped
// on load (the settings file is never rewritten for that).
const connectorsDir = deployment.connectorsDir
  ? (path.isAbsolute(deployment.connectorsDir) ? deployment.connectorsDir : path.resolve(config.dataDir, deployment.connectorsDir))
  : undefined;
const registry = await createRegistry({ dir: connectorsDir });
// The four types that need a login, a key or a paid provider. They are ordinary connector
// instances now, but the Settings panel still shows them in its "virtual" group, and health records
// and `settings.off` keep their legacy ids (`bluesky`, `x`, `github`, `steam`).
const ACCOUNT_TYPES = new Set(['bluesky', 'x-search', 'github-hype', 'steam']);
const ACCOUNT_PRESETS = DEFAULT_CONNECTOR_PRESETS.filter((preset) => ACCOUNT_TYPES.has(preset.type));
const instanceList = () => {
  const custom = settings.custom.map(fromLegacySource);
  if (!(Array.isArray(deployment.connectors) && deployment.connectors.length)) return [...DEFAULT_CONNECTOR_PRESETS, ...custom];
  // An explicit `connectors` list is the instance list, but the four account-bound sources were
  // always listed (and fetched) outside it: keep that, unless the list describes one itself.
  const configured = deployment.connectors;
  const seen = new Set(configured.map((entry) => String(entry?.id ?? '')));
  return [...configured, ...ACCOUNT_PRESETS.filter((preset) => !seen.has(preset.id)), ...custom];
};

// The old source shape the rest of Fresh and the Settings UI expect. `kind` stays for the UI; `type`
// is the connector type. A custom Bluesky handle is a single account feed, not the keyword search,
// and keeps its own fetcher (feeds.js), exactly as before.
//
// Credential *references* stay in `credentialRefs` (id -> { key: ref }) and are never part of a
// source, an instance or a view; only the context resolves them, on demand.
const credentialRefs = new Map();
function sourcesFromInstances() {
  const entries = instanceList();
  credentialRefs.clear();
  for (const entry of entries) if (entry?.id && entry.credentials) credentialRefs.set(String(entry.id), { ...entry.credentials });
  return registry.instances(entries).map((instance) => {
    const legacy = instance.legacy === 'bluesky-account';
    const source = {
      id: instance.id, name: instance.name, kind: legacy ? 'bluesky' : legacyKindOf(instance.type), type: instance.type,
      cat: instance.cat, url: instance.config.url ?? '', limit: instance.limit, stack: instance.stack,
      enabled: instance.enabled, config: instance.config, schedule: instance.schedule,
    };
    if (legacy) { source.legacy = instance.legacy; delete source.error; }
    else if (instance.error) source.error = instance.error;
    return source;
  });
}

// Credentials are resolved on demand and never copied into a source, an instance, a view or a log.
// A ref is "env:NAME" / "agentEnv:NAME" / "file:path"; a bare key (say "token") looks up this
// instance's `credentials` map first, so a connector can call ctx.secret('token').
const secretFor = (ref) => {
  if (typeof ref !== 'string' || !ref) return null;
  try { return resolveSecret(ref, { dataDir: config.dataDir, allowInline: deployment.allowInlineSecrets === true, env: process.env }); }
  catch { return null; }
};
const secretForInstance = (id) => (ref) => {
  const refs = credentialRefs.get(id) ?? {};
  return secretFor(Object.hasOwn(refs, ref) ? refs[ref] : ref);
};

// The shared cost ledger of the metered connectors: the same file and format the X search code
// kept before (`data/fresh-x.json`), with day boundaries in the configured time zone.
const budget = createBudget({ file: path.join(config.dataDir, 'fresh-x.json'), timezone: deployment.timezone ?? 'UTC' });

// The provider registry the search connectors ask for a capability. Built lazily (it reads the
// agent's .env), and null when there is nothing to build from.
let providersCache = { key: null, registry: null };
function providersNow() {
  const current = agent ?? null;
  const key = `${current?.name ?? ''}|${current?.provider ?? ''}|${current?.baseUrl ?? ''}|${current?.home ?? ''}`;
  if (providersCache.key !== key) providersCache = { key, registry: providersFor(current) };
  return providersCache.registry;
}

// The connector context's `fetch` is the SSRF-guarded one, except under the offline switch: then it
// answers from src/fresh/mock.js in the same shape (status + body), so every connector runs without
// a network and without a bill. Tests pass their own `fetch` stub and never reach either.
async function connectorFetch(url, options) {
  if (!offline()) return safeFetch(url, options);
  const { mockHttp } = await import('./mock.js');
  const res = mockHttp(url, options);
  const body = res?.body !== undefined ? res.body : Buffer.from(JSON.stringify(res?.data ?? null));
  return { status: res?.status ?? 404, url: String(url), type: 'application/json', body };
}

// One context per instance and call. `state` is a per-instance KV over the Fresh kv table, with the
// instance id as the key prefix (the unprefixed key is read as a legacy fallback); `budget` is the
// shared ledger; `providers` asks the provider registry for a capability.
function contextFor(source, signal, { force = false } = {}) {
  return {
    config: source.config,
    secret: secretForInstance(source.id),
    state: stateFor(source.id),
    fetch: (url, options) => connectorFetch(url, options),
    providers: { get: (capability) => providersNow()?.get(capability) ?? null },
    budget,
    log: console,
    signal,
    now: () => Date.now(),
    timezone: deployment.timezone ?? 'UTC',
    enabled: isOn(source.id),
    force,
  };
}

async function fetchInstance(source, { force = false } = {}) {
  if (source.legacy) {
    const items = await fetchSource(source);
    return (items ?? []).map((item) => ({ ...item, name: source.name, stack: source.stack }));
  }
  const connector = registry.get(source.type);
  if (!connector) throw new Error(source.error ?? 'unknown connector type');
  const signal = AbortSignal.timeout(30_000);
  const items = await connector.fetch(contextFor(source, signal, { force }));
  return (items ?? []).map(({ hints, ...item }) => ({ ...item, source: hints?.source ?? source.id, cat: item.cat ?? source.cat, name: source.name, stack: hints?.stack ?? source.stack }));
}

const allSources = () => sourcesFromInstances();
// The free feed sources (the interval-based fetch). The account-bound ones keep their own clocks
// and credentials and are fetched by fetchAccountSources below.
const feedSources = () => allSources().filter((s) => s.legacy || !ACCOUNT_TYPES.has(s.type));
// HERMES_WEB_FRESH_OFFLINE=1 (tests): no feed is fetched from the internet; the connectors answer
// from the local mocks.
const activeSources = () => (offline() ? [] : feedSources().filter((s) => s.enabled !== false && !s.error && !settings.off.includes(s.id)));
const isOn = (id) => !settings.off.includes(id);
const nameOf = (id, meta) => (id === 'github' ? 'GitHub' : null) ?? allSources().find((s) => s.id === id)?.name ?? meta?.name ?? id;

export function sourcesView() {
  const health = new Map(store.healthAll().map((h) => [h.source, h]));
  return allSources().map((s) => ({ id: s.id, name: s.name, kind: s.kind, type: s.type ?? s.kind, cat: s.cat, url: s.url, custom: s.id.startsWith('c-'), virtual: ACCOUNT_TYPES.has(s.type), on: isOn(s.id), ok: health.get(s.id)?.ok ?? null, fails: health.get(s.id)?.fails ?? 0, count: health.get(s.id)?.count ?? 0, error: s.error ?? health.get(s.id)?.error ?? '' }));
}
export function toggleSource(id, on) {
  if (!allSources().some((s) => s.id === id)) return false;
  settings.off = settings.off.filter((x) => x !== id);
  if (!on) settings.off.push(id);
  persist();
  return true;
}
export async function addSource({ url, cat = PRIMARY_CAT, name = '' }) {
  if (!CATEGORIES[cat]) throw new Error('unknown category');
  if (settings.custom.length >= 40) throw new Error('too many sources (40 at most)');
  let kind = 'rss';
  let feedUrl = String(url).trim();
  let title = name;
  const handle = feedUrl.match(/^(?:https?:\/\/bsky\.app\/profile\/|@)([\w.-]+)\/?$/)?.[1];
  if (handle) { kind = 'bluesky'; feedUrl = handle; title ||= `@${handle}`; }
  else {
    if (!/^https?:\/\//i.test(feedUrl)) feedUrl = `https://${feedUrl}`;
    const found = await discoverFeed(feedUrl);
    feedUrl = found.url;
    title ||= found.title;
  }
  const id = `c-${crypto.createHash('sha1').update(`${kind}|${feedUrl}`).digest('hex').slice(0, 8)}`;
  if (allSources().some((s) => s.id === id)) throw new Error('this source is already added');
  const source = { id, name: String(title).slice(0, 60), kind, cat, url: feedUrl };
  settings.custom.push(source);
  persist();
  return source;
}
export function removeSource(id) {
  const before = settings.custom.length;
  settings.custom = settings.custom.filter((s) => s.id !== id);
  settings.off = settings.off.filter((x) => x !== id);
  persist();
  return settings.custom.length < before;
}

// ---------- gathering ----------
let agent = null;
let running = null;
let lastRun = { at: 0, added: 0, ready: 0, merged: 0, failed: [] };
const nextDue = new Map(); // source id -> time it is fetched again (the free feeds follow intervalMin)

// Another outlet (or the GitHub source) found a page that already has a card.
function joinOutlets(row, outlets, item) {
  const also = new Set([...(row.also ? JSON.parse(row.also) : [row.source]), ...outlets]);
  if (also.size > row.outlets) store.corroborate(row.id, also.size, [...also]);
  if (item.meta?.gh && !JSON.parse(row.meta ?? '{}').gh) store.mergeMeta(row.id, { gh: item.meta.gh, readme: item.meta.readme });
}

// `stats` (a bootstrap step) is filled in as it goes: how many stories were seen, were already known, or were set aside by score.
function addCandidates(items, { now = Date.now(), stats = null } = {}) {
  const tally = (k) => { if (stats) stats[k] += 1; };
  const fresh = items.filter((i) => i.url && i.title && i.ts > now - MAX_AGE_H * 3_600_000 && i.ts < now + 3_600_000);
  const known = store.recentSigs(now - 48 * 3_600_000).map((r) => ({ ...r, s: r.sig ?? sig(r.title) }));
  let added = 0;
  const releasesSeen = new Set();
  for (const item of collapse(fresh)) {
    tally('seen');
    const id = idOf(item.url);
    const outlets = [...item.outlets];
    const spike = /[?&]spike=\d/.test(item.url); // a repo coming back after a much bigger spike is a card of its own
    // The same page already has a card (say Hacker News linked the repo): one card, one more outlet, and the repo's GitHub numbers.
    const existing = store.hasItem(id) ? store.getItem(id) : (item.meta?.gh && !spike ? store.itemsByRepo(item.meta.gh.repo).map((r) => store.getItem(r.id)).find(Boolean) : null);
    if (existing) { joinOutlets(existing, outlets, item); tally('dup'); continue; }
    const s = sig(item.title);
    // (A GitHub repo is judged by its own page: a news article with a similar title is a card of its own, a model merges them later.)
    const twin = item.meta?.gh ? null : known.find((k) => k.s && s && jaccard(k.s, s) >= 0.55);
    if (twin) {
      // The same story from another source: one card that lists every outlet (an X or Bluesky mention shows as "also popular on ...").
      const also = new Set([...(twin.also ? JSON.parse(twin.also) : [twin.source]), ...outlets]);
      if (also.size > twin.outlets) store.corroborate(twin.id, also.size, [...also]);
      tally('dup');
      continue;
    }
    // A repo that ships often is not news every time: one release card per three days unless this one is a big step.
    if (item.meta?.release && item.meta.repo && !item.meta.substantial && (releasesSeen.has(item.source) || store.recentFromSource(item.source, now - RELEASE_GAP_MS))) { tally('dup'); continue; }
    if (item.meta?.release && item.meta.repo) releasesSeen.add(item.source);
    const cat = categoryOf(item);
    const flagged = stackFlag(item);
    const score = scoreOf(item, { outlets: outlets.length, now, boost: steamBoostOf(`${item.title} ${item.snippet ?? ''}`) });
    const row = {
      id, url: item.url, title: item.title.slice(0, 300), source: item.source, cat, published: item.ts, first_seen: now, score, outlets: outlets.length, also: JSON.stringify(outlets),
      meta: JSON.stringify({ ...item.meta, snippet: item.snippet, image: item.image ?? null, name: item.name }), sig: s, status: score >= MIN_SCORE ? 'new' : 'skip', kind: item.kind ?? null, flag: flagged ? 'stack' : null,
    };
    store.insertCandidate(row);
    if (row.status === 'new') { added += 1; tally('added'); } else tally('skipped');
    known.push({ id, title: row.title, s, source: row.source, outlets: 1, also: row.also });
  }
  return added;
}

// The Steam taste boost comes from the connector (registry.get('steam').boost) and is 0 when Steam
// is not configured.
const steamBoostOf = (text) => registry.get('steam')?.boost?.(text) ?? 0;

// System One reads each new story: category, how well it fits the reader, and whether it is something never wanted (deals,
// layoffs, listicles ...). Whatever fails is set aside; the rest waits for the writer, best first.
async function triageNew() {
  const rows = store.untriaged(60);
  if (!rows.length) return 0;
  const toJudge = [];
  for (const row of rows) {
    const meta = JSON.parse(row.meta ?? '{}');
    // Steam's own cards (patch notes, releases, sale summaries) are already known to be wanted.
    if (meta.via === 'steam') { store.setTriage(row.id, { cat: CAT_IDS[0], rel: 0.85, ban: 0, status: 'new' }); continue; }
    toJudge.push({ id: row.id, title: row.title, snippet: meta.snippet ?? '', cat: row.cat, source: row.source, handle: meta.handle, flag: row.flag, release: meta.release, substantial: meta.substantial, gh: Boolean(meta.gh), lang: meta.lang });
  }
  const verdicts = await triage(agent, toJudge);
  let kept = 0;
  for (const it of toJudge) {
    const v = verdicts.get(it.id);
    const stack = it.flag === 'stack';
    // A routine point release is a changelog, not news: only a substantial one passes, the rest is set aside.
    const routineRelease = it.release && !it.substantial && !stack;
    const wanted = !routineRelease && (stack || it.release || ((v.cat || it.gh) && v.ban < 0.6 && v.news >= 0.35 && v.rel >= 0.25 && v.info >= 0.3));
    // The model's category wins for every card except GitHub's, which keeps the one its connector declares (see categoryOf).
    // When the model names none, setTriage coalesces to the category the card came in with.
    store.setTriage(it.id, { cat: it.gh ? null : v.cat, rel: stack ? Math.max(v.rel, 0.7) : v.rel, ban: v.ban, status: wanted ? 'new' : 'skip' });
    if (wanted) { store.setScore(it.id, (store.getItem(it.id)?.score ?? 0) + v.rel * 3); kept += 1; }
    if (it.handle) noteHandle(it.handle, wanted, 1, it.lang, xLearnContext());
  }
  return kept;
}

// The same event told by several outlets in different words: a model groups the recent headlines, one story of each group stays
// (with all outlets listed), the others are set aside.
async function dedupe() {
  if (!agent) return 0;
  const rows = store.windowItems(Date.now() - 72 * 3_600_000).sort((a, b) => (b.ready_at ?? 0) - (a.ready_at ?? 0));
  let merged = 0;
  let groups = [];
  try { groups = await findDuplicates(agent, rows); } catch (err) { console.warn(`[fresh] dedupe failed: ${err.message}`); return 0; }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const ids of groups) {
    const members = ids.map((id) => byId.get(id));
    const host = pickHost(members);
    const also = new Set(members.flatMap((m) => (m.also ? JSON.parse(m.also) : [m.source])));
    for (const m of members) {
      if (m.id === host.id) continue;
      if (m.saved || m.seen_at || merged >= MAX_MERGES_PER_ROUND) continue; // seen or saved cards stay; the rest wait for the next round
      store.markDup(m.id);
      merged += 1;
    }
    if (also.size > host.outlets) store.corroborate(host.id, also.size, [...also]);
  }
  return merged;
}

const ready = (p, card, llm) => ({ id: p.id, title_local: card?.title_local ?? null, summary: card?.summary ?? (p.description || p.snippet || '').slice(0, 240), why: card?.why ?? '', topics: JSON.stringify(card?.topics?.length ? card.topics : tokens(p.title).slice(0, 4)), image: p.image ? 1 : 0, llm, writer: card?.path ?? 'plain' });

// Posts on Reddit, Bluesky and X carry memes and reaction pictures: for those only the og:image of the article they link to may be
// used (and it still has to pass the quality gate in saveImage); a post that links nowhere stays text-only.
const SOCIAL_HOST = /(^|\.)(reddit\.com|redd\.it|bsky\.app|x\.com|twitter\.com|t\.co)$/i;
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const isCommunity = (row) => ['localllama', 'bluesky', 'x'].includes(row.source) || row.source.startsWith('w-') || SOCIAL_HOST.test(hostOf(row.url));
export function pictureFor(row, meta, info) {
  if (!isCommunity(row)) return meta.image || info.image;
  return SOCIAL_HOST.test(hostOf(row.url)) ? '' : info.image;
}

async function enrich(limit = PER_RUN) {
  const today = store.dailyCount(Date.now() - 24 * 3_600_000);
  const room = Math.max(0, Math.min(limit, DAILY_CAP - today));
  const pending = store.pendingItems(PER_RUN * 6).sort((a, b) => b.score - a.score);
  // X first (paid, freshest, no per-source cap). The rest of the round goes to the categories in turn, best of each first, the one
  // with the thinnest unread stock picking first, so a chatty category (security feeds) cannot fill the pool. No single source may
  // fill a round either (Hacker News alone would): the best few of each come first, the rest only if there is room.
  const taken = new Map();
  const chosen = [];
  for (const row of pending) if (PRIORITY.has(row.source) && chosen.length < room) chosen.push(row);
  const since = Date.now() - 3 * 86_400_000;
  const lanes = CAT_IDS.map((cat) => ({ cat, stock: store.unseenReady([cat], since), rows: pending.filter((r) => r.cat === cat && !chosen.includes(r)) })).filter((l) => l.rows.length).sort((a, b) => a.stock - b.stock);
  for (let more = true; more && chosen.length < room;) {
    more = false;
    for (const lane of lanes) {
      while (lane.rows.length && chosen.length < room) {
        const row = lane.rows.shift();
        const n = taken.get(row.source) ?? 0;
        if (n >= PER_SOURCE) continue;
        chosen.push(row); taken.set(row.source, n + 1); more = true;
        break;
      }
    }
  }
  // Whatever is left over is dropped once it is too old to matter.
  for (const row of pending) if (!chosen.includes(row) && Date.now() - row.published > 36 * 3_600_000) store.markSkipped(row.id);
  const work = chosen.map((row) => ({ row, meta: JSON.parse(row.meta ?? '{}') }));
  const prepared = [];
  for (let i = 0; i < work.length; i += 4) {
    await Promise.all(work.slice(i, i + 4).map(async ({ row, meta }) => {
      const info = offline() ? { image: '', description: '', text: '' } : await pageInfo(row.url);
      const src = pictureFor(row, meta, info);
      const image = src && !offline() ? await saveImage(row.id, src) : false;
      prepared.push({ id: row.id, title: row.title, sourceName: nameOf(row.source, meta), snippet: meta.snippet ?? '', description: meta.gh ? meta.snippet ?? '' : info.description, text: meta.gh ? `${meta.snippet ?? ''}\n${meta.readme ?? ''}` : info.text, image, tries: meta.tries ?? 0, release: meta.release === true, finished: row.kind === 'steam-sale' || (meta.release === true && meta.via === 'steam') });
    }));
  }
  // Cards that arrive already written (Steam summaries) skip the writer.
  const toWrite = prepared.filter((p) => !p.finished);
  const done = new Map();
  const deferred = new Set(); // the free writer stayed busy: not a failed try
  // The glossary question for the whole round goes out as one System One call; the writer takes WRITE_BATCH cards a call.
  const rules = toWrite.length > WRITE_BATCH ? await glossaryRules(agent, toWrite) : null;
  for (let i = 0; i < toWrite.length; i += WRITE_BATCH) {
    const batch = toWrite.slice(i, i + WRITE_BATCH);
    try {
      const out = await writeCards(agent, batch, rules ? { rules } : {});
      out.forEach((v, k) => done.set(k, v));
      out.deferred?.forEach((id) => deferred.add(id));
    } catch (err) { console.warn(`[fresh] writing failed: ${err.message}`); }
  }
  let count = 0;
  for (const p of prepared) {
    const card = done.get(p.id);
    // A story no model could write yet waits for the next round; after three tries it goes out in its own words.
    if (!card && deferred.has(p.id)) continue;
    if (!card && !p.finished && p.tries < 2) { store.bumpTries(p.id); continue; }
    // The writer found nothing concrete in it (a meme, a joke, a reaction): not a card.
    if (card && card.substance === false && !p.finished && !p.release) { store.markSkipped(p.id); continue; }
    store.markReady(p.finished ? { ...ready(p, null, 1), title_local: p.title, summary: p.snippet, writer: 'steam' } : ready(p, card, card ? 1 : 0));
    count += 1;
  }
  return count;
}

async function fetchFeeds(force) {
  const now = Date.now();
  const sources = activeSources().filter((s) => force || (nextDue.get(s.id) ?? 0) <= now);
  const results = await Promise.allSettled(sources.map((s) => fetchInstance(s)));
  const items = [];
  const failed = [];
  results.forEach((r, i) => {
    const src = sources[i];
    nextDue.set(src.id, now + settings.intervalMin * 60_000 - 30_000);
    if (r.status === 'fulfilled') { items.push(...r.value); store.recordHealth(src.id, true, null, r.value.length); }
    else { failed.push(src.id); store.recordHealth(src.id, false, r.reason?.message, 0); }
  });
  return { items, failed };
}

// The account-bound sources (Bluesky, X, GitHub hype, Steam) are connector instances too: they run
// even under the offline switch, where the free feeds are skipped, because their mocks answer
// without a network. Each connector keeps its own clock and checks its own credentials.
const accountSources = () => allSources().filter((s) => ACCOUNT_TYPES.has(s.type) && !s.legacy && s.id !== 'x' && s.enabled !== false && !s.error && !settings.off.includes(s.id));

async function fetchAccountSources(force) {
  const sources = accountSources();
  const results = await Promise.allSettled(sources.map((source) => fetchInstance(source, { force })));
  const items = [];
  const failed = [];
  results.forEach((result, i) => {
    const source = sources[i];
    if (result.status === 'fulfilled') { items.push(...result.value); store.recordHealth(source.id, true, null, result.value.length); }
    else { failed.push(source.id); store.recordHealth(source.id, false, result.reason?.message, 0); }
  });
  return { items, failed };
}

// The status of one instance's connector, with that instance's context (no signal: it is a read).
function sourceStatus(id) {
  const source = allSources().find((s) => s.id === id);
  if (!source) return {};
  const connector = registry.get(source.type);
  if (!connector?.status) return {};
  try { return connector.status(contextFor(source, AbortSignal.timeout(5_000))) ?? {}; } catch { return {}; }
}

async function gather(force = false) {
  const cycleStart = Date.now();
  const [feeds, accounts] = await Promise.all([fetchFeeds(force), fetchAccountSources(force)]);
  const added = addCandidates(await resolveItems([...feeds.items, ...accounts.items]));
  await drain();
  const ready = store.stats().ready ?? 0;
  const merged = added || ready ? await dedupe() : 0;
  store.purge(Date.now() - KEEP_DAYS * 86_400_000);
  store.trimSignals(Date.now() - 30 * 86_400_000);
  // Complete = every source was asked (above) and nothing found in this cycle is still waiting to be judged or written.
  await finishCycle(cycleStart);
  return { at: Date.now(), added, ready, merged, failed: [...feeds.failed, ...accounts.failed] };
}

// A few more rounds for what this cycle found when the first ones did not clear it, then the "new stories ready" push if it is all done.
async function finishCycle(cycleStart) {
  try {
    for (let n = 0; n < 4 && store.cycleQueue(cycleStart) > 0; n += 1) {
      const out = await round();
      if (!out.made && !out.kept) break;
    }
    await maybeNotify(settings.notify, { complete: store.cycleQueue(cycleStart) === 0 });
  } catch (err) { console.warn(`[fresh] notify failed: ${err.message}`); }
}

// Judge and write what is waiting. A new install starts empty: a few rounds fill the timeline so there is something to scroll.
// One round: judge, fold threads, write.
async function round() {
  const kept = await triageNew();
  await groupThreads(agent).catch((err) => console.warn(`[fresh] threads failed: ${err.message}`));
  return { kept, made: await enrich() };
}
async function drain() {
  let made = 0;
  for (let n = 0; n < ((store.stats().ready ?? 0) < 30 ? 4 : 2); n += 1) {
    const out = await round();
    made += out.made;
    if (!out.made && !out.kept) break;
  }
  return made;
}

// The worker runs by itself; asking for a refresh only wakes it. Returns at once with what the reader needs to know.
export function kick({ force = false } = {}) {
  if (!running) {
    running = gather(force).then((r) => { lastRun = r; return r; }).catch((err) => { console.warn(`[fresh] gather failed: ${err.message}`); return { ...lastRun, error: err.message }; }).finally(() => { running = null; });
    return { started: true, running: true };
  }
  return { started: false, running: true };
}
// Same, but waits for the round to finish (the schedule, tests, ingest).
export function refresh({ force = false } = {}) {
  if (running) return running;
  if (!force && Date.now() - lastRun.at < 60_000) return Promise.resolve(lastRun);
  kick({ force });
  return running;
}

export function refreshNow() {
  const k = kick();
  const viewed = store.kvGet('view-at', 0);
  return { ok: true, ...k, newCount: store.countSince(viewed), newest: store.newestReady().t ?? 0, lastRunAt: lastRun.at };
}

// A Hermes worker (for anything that needs a login or a tool) hands over what it found. The route
// validates and normalises the posted batch (src/connectors/ingest.js) and hands the items here.
export async function ingest(items) {
  const clean = Array.isArray(items) ? items : [];
  const added = addCandidates(await resolveItems(clean));
  kick({ force: true });
  return { received: clean.length, added };
}
let ingestKeyCache = null;
export function ingestToken() {
  if (ingestKeyCache) return ingestKeyCache;
  const file = path.join(config.dataDir, 'fresh', 'ingest-token');
  try { ingestKeyCache = fs.readFileSync(file, 'utf8').trim(); } catch { /* make one */ }
  if (!ingestKeyCache) { ingestKeyCache = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(file, ingestKeyCache, { mode: 0o600 }); }
  return ingestKeyCache;
}

// X: checked every few minutes, a call only when a slot is due (the x-search connector decides and
// rations). Never from a refresh. What X answered becomes candidates. Short links are followed
// first; an affiliate post whose real link turns out to be an affiliate / referral link is dropped
// only now (the short link hid it).
async function ingestX(found, stats = null) {
  // A language slot's junk filter runs again after the short links were followed (the real link
  // may turn out to be an affiliate one); other posts keep the old behaviour and are not filtered here.
  const items = (await resolveItems(found)).filter((item) => !(item.meta?.lang && langRejected(item, item.meta.lang)));
  if (stats) stats.fetched += found.length;
  const added = addCandidates(items, { stats });
  store.recordHealth('x', true, null, found.length);
  return added;
}
// The x-search connector's context, with the kill switch applied.
function xContext(signal) {
  const source = allSources().find((s) => s.id === 'x');
  if (!source) return null;
  const ctx = contextFor(source, signal);
  ctx.enabled = settings.x.enabled && isOn('x');
  return ctx;
}
async function xTick() {
  if (!agent) return;
  const ctx = xContext(AbortSignal.timeout(90_000));
  if (!ctx) return;
  const connector = registry.get('x-search');
  if (!connector) return;
  try {
    const found = await connector.fetch(ctx);
    if (found?.length && (await ingestX(found))) kick();
  } catch (err) { store.recordHealth('x', false, String(err.message), 0); }
}
export { xTick };

// The x-search connector's status for the settings panel and /status, with the kill switch applied.
function xStatusView() {
  const ctx = xContext(AbortSignal.timeout(5_000));
  if (!ctx) return {};
  const connector = registry.get('x-search');
  try { return connector?.status?.(ctx) ?? {}; } catch { return {}; }
}

// Handle learning belongs to the x-search instance, even when a card is judged or scored elsewhere.
function xLearnContext() {
  const source = allSources().find((s) => s.id === 'x') ?? { id: 'x', config: {} };
  return { config: source.config, state: stateFor(source.id) };
}

// ---------- bootstrap: everything once, now (bootstrap.js) ----------
const bootDeps = () => {
  const add = async (items, step) => { step.fetched += items.length; addCandidates(await resolveItems(items), { stats: step }); };
  return {
    agent,
    // Waits for a gathering round in progress, then holds `running` so the schedule and refreshes do not start a second one.
    exclusive: async (fn) => {
      while (running) await running.catch(() => {});
      running = fn().finally(() => { running = null; });
      await running;
      lastRun = { ...lastRun, at: Date.now() };
    },
    feeds: async (step) => { const r = await fetchFeeds(true); await add(r.items, step); return r; },
    bluesky: async (step) => {
      const source = allSources().find((s) => s.id === 'bluesky');
      if (!source || !isOn('bluesky')) return { skipped: 'off or not configured' };
      if (sourceStatus('bluesky').unavailable) return { skipped: sourceStatus('bluesky').unavailable };
      const items = await fetchInstance(source, { force: true });
      if (!items.length) return { skipped: 'no new posts' };
      await add(items, step);
      return undefined;
    },
    github: async (step) => {
      const source = allSources().find((s) => s.id === 'github');
      if (!source || !isOn('github')) return { skipped: 'off or not configured' };
      if (sourceStatus('github').unavailable) return { skipped: sourceStatus('github').unavailable };
      const items = await fetchInstance(source, { force: true });
      if (!items.length) return { skipped: 'no new repos' };
      await add(items, step);
      return undefined;
    },
    steam: async (step) => {
      const source = allSources().find((s) => s.id === 'steam');
      if (!source || !isOn('steam')) return { skipped: 'off or not configured' };
      if (sourceStatus('steam').unavailable) return { skipped: sourceStatus('steam').unavailable };
      const items = await fetchInstance(source, { force: true });
      if (!items.length) return { skipped: 'nothing new' };
      await add(items, step);
      return undefined;
    },
    xOn: () => settings.x.enabled && isOn('x'),
    xSlots: () => {
      const source = allSources().find((s) => s.id === 'x');
      const connector = registry.get('x-search');
      return source && connector?.slots ? connector.slots(source.config) : [];
    },
    runXSlot: async (n, options = {}) => {
      const ctx = xContext(AbortSignal.timeout(120_000));
      const connector = registry.get('x-search');
      if (!ctx || !connector) return { slot: n, error: 'no provider' };
      ctx.enabled = settings.x.enabled && isOn('x');
      return connector.runSlot(ctx, n, options);
    },
    ingestX: (found, step) => { const before = step.added; return ingestX(found, step).then(() => step.added - before); },
    round,
    dedupe,
    notify: (complete) => maybeNotify(settings.notify, { complete, why: 'bootstrap' }),
    room: () => DAILY_CAP - store.dailyCount(Date.now() - 24 * 3_600_000),
  };
};
export const runBootstrap = ({ force = false } = {}) => startBootstrap(bootDeps(), { force });
export { bootstrapProgress };

// ---------- reading ----------
const BUZZ = { x: 'also trending on X', bluesky: 'also trending on Bluesky', hn: 'also trending on HN', localllama: 'also trending on Reddit' };
// The API payload keeps the field name the client has always read (`title`); only the column and
// the internal card object are called `title_local` in this phase, because public/ is untouched.
function present(row) {
  const meta = JSON.parse(row.meta ?? '{}');
  const also = row.also ? JSON.parse(row.also) : [];
  return {
    id: row.id, url: row.url, title: row.title_local || row.title, original: row.title, summary: row.summary ?? '', why: row.why ?? '',
    topics: row.topics ? JSON.parse(row.topics) : [], source: row.source, sourceName: nameOf(row.source, meta), cat: row.cat, catLabel: CATEGORIES[row.cat] ?? '',
    ts: row.published, outlets: row.outlets, also: also.map((s) => nameOf(s, null)).slice(0, 5), image: row.image ? `/api/fresh/img/${row.id}` : '',
    lang: meta.lang ?? '', saved: Boolean(row.saved), read: Boolean(row.read_at), points: meta.points ?? 0, translated: Boolean(row.llm),
    seen: Boolean(row.seen_at), alert: row.flag === 'stack', kind: row.kind ?? '', buzz: [...new Set(also.filter((s) => s === 'x' || s === 'bluesky' || ((s === 'hn' || s === 'localllama') && s !== row.source)).map((s) => BUZZ[s]))],
    gh: meta.gh ? { repo: meta.gh.repo, stars: meta.gh.stars, d24: meta.gh.d24 ?? 0, d7: meta.gh.d7 ?? 0, today: meta.gh.today ?? 0, lang: meta.gh.lang ?? '', license: meta.gh.license ?? '', coba: meta.gh.coba ?? '' } : null,
  };
}

// What the client needs to label cards and times: the content language and the deployment time zone.
export const localeInfo = () => ({ contentLang: content().languageCode, contentLanguage: content().language, timezone: timezone() });

export function listFresh({ cat = '', saved = false, cursor = '', limit = 12, mode = 'foryou' } = {}) {
  limit = Math.max(1, Math.min(30, limit));
  const c = CATEGORIES[cat] ? cat : '';
  const newest = store.newestReady().t ?? 0;
  if (!cursor && !saved) { store.kvSet('last-open', Date.now()); store.kvSet('view-at', Date.now()); }
  if (!saved && mode !== 'latest') {
    const out = forYouPage({ cat: c, cursor, limit });
    return { items: out.rows.map(present), next: out.next, newest, mode: 'foryou', snapshot: out.snapshot, total: out.total, catOrder: catOrder(), ...localeInfo() };
  }
  const { rows, more } = store.page({ cat: c, saved, cursor, limit });
  const last = rows.at(-1);
  return { items: rows.map(present), next: more && last ? `${saved ? last.saved_at : last.published}:${last.id}` : '', newest, mode: saved ? 'saved' : 'latest', catOrder: catOrder(), ...localeInfo() };
}
export const pollFresh = (since) => ({ count: store.countSince(since), newest: store.newestReady().t ?? 0, running: Boolean(running) });
export const freshStatus = () => ({
  ...lastRun, running: Boolean(running), enabled: settings.enabled, ...store.stats(), queue: store.queueSizes(), llm: llmUsage(agent),
  x: xStatusView(), scheduler: scheduler.list(), bluesky: sourceStatus('bluesky'), steam: sourceStatus('steam'), github: sourceStatus('github'),
});

export function actOn(id, action) {
  if (!store.getItem(id)) return null;
  if (action === 'save') store.setFlag('saved', id, true);
  else if (action === 'unsave') store.setFlag('saved', id, false);
  else if (action === 'hide') store.setFlag('hidden', id, true);
  else if (action === 'read') { store.setFlag('read', id, true); store.markSeen([id]); }
  else return null;
  return { ok: true };
}

// What the reader does: kept only so the feed knows a card was seen, and to rate-limit the client.
// kind: open | read | dwell | skip | ask | save | share.
const SIGNALS = new Set(['open', 'read', 'dwell', 'skip', 'ask', 'save', 'share']);
const RATE_PER_MIN = 120;
export function signalOn(id, kind, ms) {
  const row = store.getItem(id);
  if (!row || !SIGNALS.has(kind)) return null;
  const now = Date.now();
  if (store.signalCount(now - 60_000) >= RATE_PER_MIN) return { ok: false, limited: true };
  // The same signal on the same card counts once in ten minutes (a dwell once in thirty).
  if (store.signalSeen(id, kind, now - (kind === 'dwell' ? 30 : 10) * 60_000)) return { ok: true, counted: false };
  const dwell = Math.max(0, Math.min(600_000, Number(ms) || 0));
  store.addSignal(id, kind, dwell || null);
  store.markSeen([id]);
  return { ok: true, counted: true };
}
export function markSeen(ids) {
  const clean = (Array.isArray(ids) ? ids : []).map(String).filter((i) => /^[a-f0-9]{16}$/.test(i)).slice(0, 100);
  store.markSeen(clean);
  return { ok: true, count: clean.length };
}

export async function readerOf(id) {
  const row = store.getItem(id);
  if (!row) return null;
  store.setFlag('read', id, true);
  store.markSeen([id]);
  if (row.reader) return { ...present(row), blocks: JSON.parse(row.reader) };
  let blocks = [];
  try { blocks = await readerBlocks(row.url); } catch { /* the page is left to the browser */ }
  if (blocks.length) store.setReader(id, JSON.stringify(blocks));
  return { ...present(row), blocks };
}
export const hasImage = (id) => store.getItem(id)?.image === 1;
export { imageFile } from './enrich.js';

// ---------- schedule ----------
// One in-process scheduler (src/scheduler). Free connectors are still fetched inside gather(), so
// only the gather round, the X slot check and the notify check are jobs here.
const scheduler = createScheduler({
  store: { get: (k) => store.kvGet(k, null), set: (k, v) => store.kvSet(k, v) },
  timezone: deployment.timezone ?? 'UTC',
  log: console,
});
const GATHER_JOB = 'pipeline:gather';
let firstRound = true; // the 8 s first kick happens once, not again when a setting changes
let gatherKey = '';
function schedule() {
  const key = settings.enabled ? String(settings.intervalMin) : 'off';
  if (key === gatherKey && !firstRound) return;
  gatherKey = key;
  scheduler.remove(GATHER_JOB);
  if (!settings.enabled) return;
  scheduler.add({
    id: GATHER_JOB, schedule: { every: `${settings.intervalMin}m` }, runOnStart: firstRound ? 8000 : false,
    timeoutMs: 0, overlap: 'skip', run: async () => { kick(); },
  });
}
export function startFresh(freshAgent) {
  agent = freshAgent;
  setPrimaryAgent(agent);
  initNotify();
  scheduler.add({ id: 'connector:x', schedule: { every: '5m' }, timeoutMs: 120_000, overlap: 'skip', run: () => xTick() });
  scheduler.add({ id: 'notify:tick', schedule: { every: '5m' }, timeoutMs: 120_000, overlap: 'skip', run: () => notifyTick(settings.notify, { idle: !running }).catch(() => {}) });
  firstRound = true;
  schedule();
  scheduler.start();
  firstRound = false;
}
export function stopFresh() { scheduler.stop(); firstRound = true; }
// For tests: give the module an agent without starting timers.
export const _setAgent = (a) => { agent = a; setPrimaryAgent(a); };
export { KINDS, CATEGORIES };
export const _enrich = enrich;
export const _finishCycle = finishCycle;
export const _settings = () => settings;
export const _addCandidates = addCandidates;
export const _fetchFeeds = fetchFeeds;
