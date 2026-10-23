import { CRYPTO, NOT_WANTED, hardBan } from '../fresh/profile.js';
import * as store from '../fresh/store.js';
import { fetchJson, fetchText } from './http.js';

// "GitHub hype": open-source AI repositories that are suddenly getting stars, as cards. A repo is
// wanted when it is a tool or library one can run today (MCP servers, coding agents, inference,
// evals ...), and it is hyped when its STAR VELOCITY says so.
//
// Credentials: `token` (e.g. `file:github.json#token`, fine-grained, public read-only).
//
// Where candidates come from:
//   - the Search API: repositories built from `topics` / `queries` (a few a run; search allows 30
//     a minute),
//   - the Trending page (daily, plus the extra languages in `trending`), public HTML,
//   - every repo seen in the last two weeks is polled again each run, so the snapshot table
//     (repo_stars) can tell stars gained in 24 hours and in 7 days.
//
// Config:
//   topics: ['ai-agents']            search topics (created recently, some stars)
//   queries: []                      extra raw GitHub search queries
//   thresholds: { ...THRESHOLDS }    star-velocity thresholds
//   trending: ['python', ...]        extra Trending languages
//   everyHours: 6                    its own clock (four runs a day)
//
// The "how to try it" line is an English command copied from the README, or nothing.
export const API = 'https://api.github.com';
export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const THRESHOLDS = { young24: 150, young7: 500, young7Moving: 50, trendingToday: 100, oldSpike: 400, oldRelease: 150, youngDays: 180, minStars: 100, again24: 500, againDays: 14 };
export const TOPICS = ['ai-agents'];
export const EVERY_MS = 6 * HOUR;
const MAX_PER_RUN = 6;
const MAX_DETAILS = 40;
const MAX_READMES = 14;
const MAX_OLD = 2;
const TRACK_DAYS = 14;
const SEARCH_GAP_MS = 2300;
const offline = () => process.env.HERMES_WEB_FRESH_OFFLINE === '1';
const pause = (ms) => (offline() ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)));

const states = new Map();
const defaultState = () => ({ configured: false, lastRun: 0, lastAdded: 0, queries: 0, errors: 0, searched: 0, trending: 0, tracked: 0, passed: 0, paused: 0, error: '', reasons: {} });
const stateOf = (ctx) => {
  const id = String(ctx?.config?.id ?? 'github');
  if (!states.has(id)) states.set(id, defaultState());
  return states.get(id);
};
export const githubStatus = (ctx = null) => ({ ...(ctx ? stateOf(ctx) : defaultState()) });
export const status = githubStatus;

export const hasGithub = (ctx = null) => offline() || Boolean(ctx?.secret?.('token'));

export function thresholdsOf(config = {}) {
  const raw = config.thresholds && typeof config.thresholds === 'object' ? config.thresholds : {};
  const out = { ...THRESHOLDS };
  for (const key of Object.keys(THRESHOLDS)) if (Number.isFinite(raw[key])) out[key] = raw[key];
  return out;
}

// The search queries of a run, built from the configured topics and raw queries.
export function searchQueries(now = Date.now(), config = {}) {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const days = (n) => iso(now - n * DAY);
  const topics = Array.isArray(config.topics) ? config.topics.filter((topic) => typeof topic === 'string' && topic) : TOPICS;
  const extra = Array.isArray(config.queries) ? config.queries.filter((query) => typeof query === 'string' && query) : [];
  const out = [];
  for (const topic of topics) out.push(`topic:${topic} created:>${days(14)} stars:>60`, `topic:${topic} created:>${days(30)} stars:>100`);
  out.push(`topic:llm created:>${days(180)} pushed:>${days(2)} stars:>2000`, `topic:ai-agent created:>${days(180)} pushed:>${days(2)} stars:>2000`);
  out.push(...extra);
  return out;
}
const trendingUrls = (config = {}) => {
  const extra = Array.isArray(config.trending) ? config.trending.filter((lang) => typeof lang === 'string' && lang) : [];
  return ['https://github.com/trending?since=daily', ...extra.map((lang) => `https://github.com/trending/${encodeURIComponent(lang)}?since=daily`)];
};

// ---------- transport (tests swap it through ctx.transport) ----------
async function http(ctx, url, { text = false } = {}) {
  if (typeof ctx.transport === 'function') return ctx.transport(url, { text });
  if (offline()) {
    const { mockHttp } = await import('../fresh/mock.js');
    return mockHttp(url, { text });
  }
  const token = ctx.secret('token');
  if (text) {
    const res = await fetchText(ctx, url, { accept: 'text/html', timeoutMs: 20_000, maxBytes: 3_000_000 });
    return { status: res.status, text: res.text };
  }
  const res = await fetchJson(ctx, url, { timeoutMs: 20_000, headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'hermes-web-fresh', Accept: 'application/vnd.github+json' } });
  return { status: res.status, data: res.data };
}

// ---------- repositories ----------
export function normalize(r) {
  if (!r?.full_name) return null;
  return {
    full: r.full_name, owner: r.owner?.login ?? r.full_name.split('/')[0], name: r.name ?? r.full_name.split('/')[1],
    desc: String(r.description ?? '').replace(/\s+/g, ' ').trim(), topics: Array.isArray(r.topics) ? r.topics.map(String) : [],
    lang: r.language ?? '', license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : '', stars: r.stargazers_count ?? 0, forks: r.forks_count ?? 0,
    created: Date.parse(r.created_at) || 0, pushed: Date.parse(r.pushed_at) || 0, fork: Boolean(r.fork), archived: Boolean(r.archived || r.disabled), issues: r.open_issues_count ?? 0, size: r.size ?? 0,
  };
}

// The Trending page: <article class="Box-row"> per repo, with "N stars today".
export function parseTrending(html) {
  const out = [];
  for (const part of String(html).split(/<article\b[^>]*class="[^"]*Box-row[^"]*"[^>]*>/).slice(1)) {
    const full = part.match(/<h2[\s\S]*?href="\/([\w.-]+\/[\w.-]+)"/)?.[1];
    if (!full) continue;
    const num = (s) => Number(String(s ?? '').replace(/[^\d]/g, '')) || 0;
    const desc = part.match(/<p\b[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
    out.push({
      full, desc: desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), lang: part.match(/itemprop="programmingLanguage">([^<]+)</)?.[1]?.trim() ?? '',
      stars: num(part.match(/href="\/[\w.-]+\/[\w.-]+\/stargazers"[^>]*>(?:\s|<svg[\s\S]*?<\/svg>)*([\d,]+)/)?.[1]), today: num(part.match(/([\d,]+)\s+stars?\s+(?:today|this week)/i)?.[1]),
    });
  }
  return out;
}

// ---------- velocity ----------
export function velocity(snaps, stars, now, created = 0) {
  const ageDays = created ? Math.max(0, (now - created) / DAY) : 999;
  const before = (ms) => snaps.filter((s) => s.at <= now - ms);
  let d24 = null; let basis24 = '';
  const b12 = before(12 * HOUR);
  const nearest = (list, target) => list.reduce((best, s) => (!best || Math.abs(s.at - target) < Math.abs(best.at - target) ? s : best), null);
  if (b12.length) {
    const s = nearest(b12.filter((x) => x.at >= now - 48 * HOUR).length ? b12.filter((x) => x.at >= now - 48 * HOUR) : b12, now - 24 * HOUR);
    d24 = Math.max(0, ((stars - s.stars) * 24 * HOUR) / (now - s.at)); basis24 = 'snapshot';
  } else if (before(5 * HOUR).length) {
    const s = before(5 * HOUR).at(0);
    d24 = Math.max(0, ((stars - s.stars) * 24 * HOUR) / (now - s.at)); basis24 = 'partial';
  } else if (ageDays <= 14) {
    d24 = stars / Math.max(ageDays, 0.5); basis24 = 'age';
  }
  let d7 = null; let basis7 = '';
  const b5 = before(5 * DAY);
  if (b5.length) { const s = nearest(b5, now - 7 * DAY); d7 = Math.max(0, ((stars - s.stars) * 7 * DAY) / (now - s.at)); basis7 = 'snapshot'; }
  else if (ageDays <= 7) { d7 = stars; basis7 = 'age'; }
  return { d24: d24 === null ? null : Math.round(d24), d7: d7 === null ? null : Math.round(d7), basis24, basis7 };
}

// ---------- filters ----------
const AI = /\b(ai|a\.i|llms?|gpts?|agents?|agentic|mcp|rag|claude|codex|openai|anthropic|gemini|deepseek|qwen|llama|ollama|vllm|llama\.cpp|inference|transformers?|diffusion|embeddings?|copilot|machine learning|deep learning|neural|opencode|openclaw|hermes|cursor|coding assistant|reverse[- ]engineer\w*|model context protocol|speech|whisper|tts|vision-language|fine-?tun\w*|quantiz\w*|evals?|benchmarks?|prompt\w*)\b/i;
const LIST = /^awesome[-_ ]|[-_]awesome[-_]|\bawesome[- ]list|\bcurated (?:list|collection)|\ba (?:curated )?(?:list|collection) of\b|\bcollection of\b|\b(?:resources?|links?) (?:list|collection)|\bcheat ?sheets?\b|\broadmap\b|\binterview (?:questions|prep)|\blist of\b|\bhandpicked\b/i;
const COURSE = /\b(?:courses?|tutorials?|lessons?|curriculum|boot ?camp|for beginners|workshops?|cookbooks?|hands-on labs?|study guide|learn(?:ing)? (?:to|how|ai|llms?|python|agents?))\b/i;
const PROMPTS = /\b(?:system[- ]prompts?|prompts?)\b.*\b(?:collection|library|leaks?|list|templates?|pack)\b|\b(?:awesome|best|top|free)[- ]prompts?\b|(?:^|[-_/])prompts?(?:$|[-_])/i;
const TEMPLATE = /\b(?:templates?|boilerplates?|starter(?: kit)?s?|scaffold(?:ing)?)\b/i;
const GIRL = /\b(?:girlfriend|boyfriend|waifu|companion chat|erotic|nsfw|roleplay|role-play|ai (?:partner|lover))\b/i;
const STOCK = /\b(?:idx|ihsg|saham|stocks?|trading|traders?|forex|investing|investment|finance|financial|hedge fund|portfolio|bursa|equity|earnings)\b/i;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g;
const FILTERS = [[LIST, 'list'], [COURSE, 'course'], [PROMPTS, 'prompts'], [TEMPLATE, 'template'], [GIRL, 'companion'], [STOCK, 'finance']];

const AI_TOPIC = /^(?:llms?|mcp(?:-servers?)?|model-context-protocol|ai-agents?|agents?|agentic(?:-ai)?|rag|local-llm|llm-inference|coding-agents?|generative-ai|openai|anthropic|ollama|vllm)$/;
const haystack = (r) => `${r.name.replace(/[-_.]/g, ' ')} ${r.desc} ${r.topics.join(' ')}`;
export function textProblem(r) {
  const text = haystack(r);
  if (!r.desc && !r.topics.length) return 'no description';
  if (CRYPTO.test(text) || hardBan(text)) return 'banned';
  if (NOT_WANTED.test(text)) return 'unwanted';
  const cjk = (r.desc.match(CJK) ?? []).length;
  if (cjk >= 6 && (r.desc.match(/[a-z]/gi) ?? []).length < 24) return 'not english';
  if (/^awesome[-_]/i.test(r.name) || r.topics.some((t) => /^awesome(?:-list)?$/.test(t))) return 'list';
  if (r.topics.some((t) => /^(?:tutorial|tutorials|course|courses|cheatsheet|education|learning|interview)$/.test(t))) return 'course';
  for (const [re, why] of FILTERS) if (re.test(text)) return why;
  if (!AI.test(`${r.name.replace(/[-_.]/g, ' ')} ${r.desc}`) && !r.topics.some((t) => AI_TOPIC.test(t))) return 'not ai';
  return '';
}

export function suspect(r, readme, now = Date.now()) {
  const ageDays = (now - r.created) / DAY;
  if (r.stars >= 800 && ageDays <= 30 && r.forks < r.stars * 0.012) return 'few forks';
  if (r.stars >= 300 && readme !== null && readme.length < 300) return 'no readme';
  if (r.stars >= 500 && r.pushed && r.created && r.pushed - r.created < 30 * 60_000 && r.issues === 0 && r.forks <= 3) return 'one dump';
  return '';
}

// -> { pass, reason, d24, d7, basis, young, needRelease }. today = "stars today" from Trending.
export function assess(r, { snaps = [], today = 0, seen = null, now = Date.now(), release, thresholds = THRESHOLDS } = {}) {
  const no = (reason, extra = {}) => ({ pass: false, reason, ...extra });
  if (r.fork) return no('fork');
  if (r.archived) return no('archived');
  if (r.stars < thresholds.minStars) return no('few stars');
  const problem = textProblem(r);
  if (problem) return no(problem);
  const v = velocity(snaps, r.stars, now, r.created);
  const d24 = Math.max(v.d24 ?? 0, today);
  const young = r.created > now - thresholds.youngDays * DAY;
  const out = { ...v, d24, today, young };
  const T = thresholds;
  if (seen) {
    const again = now - seen.at >= T.againDays * DAY && d24 >= T.again24 && r.stars >= seen.stars * 2;
    if (!again) return no('seen', out);
    out.again = (seen.n ?? 1) + 1;
  }
  if (young) {
    if (d24 >= T.young24 || today >= T.trendingToday || ((v.d7 ?? 0) >= T.young7 && d24 >= T.young7Moving)) return { ...out, pass: true, reason: 'young hype' };
    return no('slow', out);
  }
  if (d24 >= T.oldSpike) return { ...out, pass: true, reason: 'old spike' };
  if (d24 >= T.oldRelease) {
    if (release === undefined) return no('needs release check', { ...out, needRelease: true });
    return release ? { ...out, pass: true, reason: 'old + release' } : no('old, no release', out);
  }
  return no('old and quiet', out);
}

// ---------- README: excerpt for the writer, and a command to try ----------
export function readmeExcerpt(md, max = 1800) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^#{1,6}\s*/gm, '').replace(/[*_`>|]/g, ' ').replace(/^\s*[-=]{3,}\s*$/gm, ' ')
    .replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const RUNNER = /^(?:npx|bunx|pnpm dlx|pnpm add(?: -g| --global)?|npm (?:i|install)|yarn global add|pip3? install|pipx install|uvx|uv tool install|uv pip install|brew install|docker run|cargo install|go install)\b/;
const GENERIC_PKG = /^(?:uv|pip|pipx|poetry|node|nodejs|python3?|git|docker|rust|rustup|go|ffmpeg|cmake|torch|torchvision|torchaudio|numpy|pandas|scipy|pytest|ruff|black|pre-commit|setuptools|wheel|jupyter|notebook|openai|anthropic|transformers|flash-attn|nvidia-\S*|cuda\S*|typescript|ts-node|tsx|vite|next|react|playwright|requests|pydantic|fastapi|uvicorn|gradio|streamlit|langchain\S*|huggingface-hub|accelerate|datasets|tensorflow|opencv-python)$/i;

export function cleanCommand(line) {
  const c = String(line).trim().replace(/^[$>]\s+/, '').replace(/\s+#\s.*$/, '').replace(/\s+/g, ' ');
  if (!RUNNER.test(c) || c.length > 150 || /\s(?:--help|-h|--version|-v|--?help)$/.test(c)) return '';
  if (/[<>]|\.\.\.|\$\(|[|;&`]|\\$|\bsudo\b|(?:^|[ /])(?:your|my)[-_]\w*|\bpath\/to\b|\bxxx+\b|YOUR_|\bTOKEN\b/i.test(c)) return '';
  const run = c.match(RUNNER)[0];
  const args = c.split(' ').slice(run.split(' ').length);
  const pos = args.filter((x) => !x.startsWith('-'));
  if (!pos.length) return '';
  if (/^(?:pip3?|uv pip) install$/.test(run) && (args.some((x) => /^-(?:r|e|U)$|^--(?:requirement|editable|upgrade)$/.test(x)) || pos.some((x) => /^\.\/?$|requirements|^pip$/.test(x)))) return '';
  if (run === 'cargo install' && args.includes('--path')) return '';
  if (run === 'go install' && !pos.some((x) => x.includes('/'))) return '';
  return c;
}
const compact = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
// repo = { owner, name }. -> the command to try, or '' (never invented: a line of the README, or nothing).
export function tryCommandOf(md, repo) {
  const name = compact(repo.name);
  const owner = compact(repo.owner);
  const tokens = String(repo.name).toLowerCase().split(/[-_.]/).filter((t) => t.length >= 4);
  const found = [];
  let heading = '';
  let fence = false;
  let order = 0;
  for (const raw of String(md ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; continue; }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (!fence && h) { heading = h[1]; continue; }
    const cands = fence ? [line] : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const c of cands) {
      const cmd = cleanCommand(c);
      if (!cmd) continue;
      const flat = compact(cmd);
      const related = (name.length >= 3 && flat.includes(name)) || (owner.length >= 4 && flat.includes(owner)) || tokens.some((t) => flat.includes(compact(t)));
      const pkg = cmd.split(' ').filter((a) => !a.startsWith('-')).at(-1) ?? '';
      const installish = /install|quick ?start|getting started|usage|try|run|setup|use it/i.test(heading);
      if (!related && (!installish || GENERIC_PKG.test(pkg.replace(/@.*$/, '').replace(/^.*\//, '')) || GENERIC_PKG.test(pkg.replace(/@.*$/, '')))) continue;
      found.push({ cmd, related, order: order++ });
    }
  }
  found.sort((a, b) => Number(b.related) - Number(a.related) || a.cmd.length - b.cmd.length || a.order - b.order);
  return found[0]?.cmd ?? '';
}

// ---------- gathering ----------
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
export const githubKey = (r) => r.full.toLowerCase();

function cardOf(r, v, { readme, coba, now, again, cat }) {
  const topics = r.topics.slice(0, 5);
  const desc = r.desc || (readme ? readmeExcerpt(readme, 160) : '');
  return {
    name: 'GitHub', cat, title: `${r.full}: ${desc}`.slice(0, 160),
    url: `https://github.com/${r.full}${again ? `?spike=${again}` : ''}`, snippet: `${desc}${topics.length ? ` Topics: ${topics.join(', ')}.` : ''}`.slice(0, 300), ts: now, image: null,
    meta: {
      via: 'github', repo: r.full, readme: readmeExcerpt(readme, 1800),
      gh: { repo: r.full, stars: r.stars, d24: v.d24, d7: v.d7, today: v.today || 0, lang: r.lang, license: r.license, topics, coba, created: r.created, young: v.young },
    },
  };
}

// -> candidates (at most MAX_PER_RUN, the fastest-growing first). Cheap when called again within `everyHours`.
export async function githubCandidates(ctx, { now = Date.now(), force = false } = {}) {
  const state = stateOf(ctx);
  const config = ctx.config ?? {};
  const thresholds = thresholdsOf(config);
  const cat = ctx.config?.cat ?? undefined;
  const everyMs = (Number.isFinite(config.everyHours) ? config.everyHours : 6) * HOUR;
  state.configured = hasGithub(ctx);
  if (!state.configured) return [];
  if (!force && !offline() && now - ctx.state.get('gh-run', 0) < everyMs) return [];
  if (ctx.state.get('gh-pause', 0) > now) { state.paused = ctx.state.get('gh-pause', 0); return []; }
  ctx.state.set('gh-run', now);
  state.paused = 0;
  const repos = new Map();
  const today = new Map();
  let limited = false;
  const note = (err) => { state.errors += 1; state.error = String(err.message).slice(0, 80); if (err.limited) limited = true; };

  for (const q of searchQueries(now, config)) {
    if (limited) break;
    try { for (const r of await search(ctx, q)) repos.set(githubKey(r), r); } catch (err) { note(err); }
    await pause(SEARCH_GAP_MS);
  }
  state.searched = repos.size;
  const trending = [];
  for (const url of trendingUrls(config)) {
    try { const res = await http(ctx, url, { text: true }); if (res.status === 200) trending.push(...parseTrending(res.text)); else note(new Error(`trending ${res.status}`)); } catch (err) { note(err); }
    await pause(600);
  }
  state.trending = trending.length;
  for (const t of trending) today.set(t.full.toLowerCase(), Math.max(today.get(t.full.toLowerCase()) ?? 0, t.today));

  const wanted = new Set();
  for (const t of trending) if (t.today >= thresholds.trendingToday && !repos.has(t.full.toLowerCase()) && AI.test(`${t.full} ${t.desc}`)) wanted.add(t.full);
  for (const t of trending) if (t.today >= thresholds.oldSpike && !repos.has(t.full.toLowerCase())) wanted.add(t.full);
  const tracked = store.starsTracked(now - TRACK_DAYS * DAY, 120);
  state.tracked = tracked.length;
  for (const t of tracked) if (!repos.has(t.repo)) wanted.add(t.repo);
  let looked = 0;
  for (const full of wanted) {
    if (limited || looked >= MAX_DETAILS) break;
    looked += 1;
    try { const r = await repoInfo(ctx, full); if (r) repos.set(githubKey(r), r); } catch (err) { note(err); }
    await pause(150);
  }

  for (const [key, r] of repos) if (now - store.starsLastAt(key) >= 2 * HOUR) store.starAdd(key, now, r.stars);
  const seenMap = ctx.state.get('gh-seen', {}) ?? {};
  const verdicts = [];
  const reasons = {};
  for (const [key, r] of repos) {
    const snaps = store.starsOf(key, now - 10 * DAY).filter((s) => s.at < now);
    let v = assess(r, { snaps, today: today.get(key) ?? 0, seen: seenMap[key] ?? null, now, thresholds });
    if (v.needRelease && !limited) { try { v = assess(r, { snaps, today: today.get(key) ?? 0, seen: seenMap[key] ?? null, now, thresholds, release: await hasRecentRelease(ctx, r.full, now) }); } catch (err) { note(err); } }
    reasons[v.pass ? 'pass' : v.reason] = (reasons[v.pass ? 'pass' : v.reason] ?? 0) + 1;
    if (v.pass) verdicts.push({ key, r, v });
  }
  verdicts.sort((a, b) => Number(b.v.young) - Number(a.v.young) || b.v.d24 - a.v.d24);
  state.passed = verdicts.length;
  state.reasons = reasons;

  const out = [];
  let readmes = 0;
  let olds = 0;
  for (const { key, r, v } of verdicts) {
    if (out.length >= MAX_PER_RUN || readmes >= MAX_READMES || limited) break;
    if (!v.young && olds >= MAX_OLD) continue;
    readmes += 1;
    let readme = null;
    try { readme = await readmeOf(ctx, r.full); } catch (err) { note(err); }
    await pause(150);
    if (suspect(r, readme, now)) { seenMap[key] = { at: now, stars: r.stars, n: 1, dropped: 'suspect' }; continue; }
    if (!v.young) olds += 1;
    out.push(cardOf(r, v, { readme, coba: tryCommandOf(readme, r), now, again: v.again, cat }));
    seenMap[key] = { at: now, stars: r.stars, n: v.again ?? 1 };
  }
  for (const [k, s] of Object.entries(seenMap)) if (now - s.at > 90 * DAY) delete seenMap[k];
  ctx.state.set('gh-seen', seenMap);
  store.starsPurge(now - 30 * DAY);
  if (limited) { ctx.state.set('gh-pause', now + 20 * 60_000); state.paused = now + 20 * 60_000; }
  state.lastRun = now;
  state.lastAdded = out.length;
  if (!limited && !state.errors) state.error = '';
  return out;
}

async function search(ctx, q) {
  const res = await http(ctx, `${API}/search/repositories?${new URLSearchParams({ q, sort: 'stars', order: 'desc', per_page: '30' })}`);
  stateOf(ctx).queries += 1;
  if (res.status === 403 || res.status === 429) { const e = new Error('github rate limited'); e.limited = true; throw e; }
  if (res.status === 401) { const e = new Error('github token rejected'); e.limited = true; throw e; }
  if (res.status !== 200) throw new Error(`github search ${res.status}`);
  return (res.data?.items ?? []).map(normalize).filter(Boolean);
}
async function repoInfo(ctx, full) {
  const res = await http(ctx, `${API}/repos/${full}`);
  if (res.status === 403 || res.status === 429) { const e = new Error('github rate limited'); e.limited = true; throw e; }
  return res.status === 200 ? normalize(res.data) : null;
}
async function readmeOf(ctx, full) {
  const res = await http(ctx, `${API}/repos/${full}/readme`);
  if (res.status === 404) return '';
  if (res.status !== 200 || !res.data?.content) return null;
  try { return Buffer.from(res.data.content, 'base64').toString('utf8').slice(0, 60_000); } catch { return null; }
}
async function hasRecentRelease(ctx, full, now) {
  const res = await http(ctx, `${API}/repos/${full}/releases/latest`);
  const rel = res.status === 200 ? res.data : null;
  return Boolean(rel && !rel.prerelease && !rel.draft && now - Date.parse(rel.published_at) < 3 * DAY);
}

// The generic path: the candidates of this run (none while its own clock says it is too soon).
export async function fetch(ctx) {
  return githubCandidates(ctx, { now: ctx.now ? ctx.now() : Date.now(), force: ctx.force === true });
}

export const test = async (ctx) => {
  if (!offline() && !ctx.secret('token')) return { ok: false, detail: 'no token' };
  try {
    const res = await http(ctx, `${API}/rate_limit`);
    return res.status === 200 ? { ok: true } : { ok: false, detail: `github ${res.status}` };
  } catch (err) {
    return { ok: false, detail: String(err.message).slice(0, 80) };
  }
};

export function statusOf(ctx) {
  const state = stateOf(ctx);
  const configured = hasGithub(ctx);
  return { ...state, configured, ...(configured ? {} : { unavailable: 'no token' }) };
}

// For tests.
export const _internals = { search, repoInfo, readmeOf, hasRecentRelease };

export default {
  type: 'github-hype',
  title: 'GitHub trending AI repos',
  configSchema: {
    type: 'object',
    properties: {
      topics: { type: 'array', items: { type: 'string' } },
      queries: { type: 'array', items: { type: 'string' } },
      thresholds: { type: 'object' },
      trending: { type: 'array', items: { type: 'string' } },
      everyHours: { type: 'number' },
    },
  },
  credentials: [{ key: 'token', label: 'GitHub token', secret: true, required: false }],
  defaultSchedule: { every: '6h' },
  cost: { kind: 'free' },
  fetch,
  test,
  status: statusOf,
};
