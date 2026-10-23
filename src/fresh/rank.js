import crypto from 'node:crypto';
import { CATEGORIES, HALF_LIFE_H, LISTICLE, PRIMARY_CAT, SECURITY_CAT, STACK, bannedIn, guessCat, hardBan, keywordRelevance, unwanted } from './profile.js';

// Dedupe, corroboration and the first (word-based) score: the same story told by several outlets becomes one item that says how
// many outlets ran it; newer beats older; what the reader keeps asking for rises. The ranking of the timeline itself is timeline.js.
const flat = (s) => String(s ?? '').toLowerCase();
const norm = (s) => flat(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function canon(url) {
  try {
    const u = new URL(url);
    const track = /^(utm_|fbclid|gclid|ref|source|mc_|cmpid|trkid|feature|app)/i;
    const q = [...u.searchParams.entries()].filter(([k]) => !track.test(k)).map(([k, v]) => `${k}=${v}`).join('&');
    return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${q ? `?${q}` : ''}`.toLowerCase();
  } catch { return flat(url); }
}
export const idOf = (url) => crypto.createHash('sha1').update(canon(url)).digest('hex').slice(0, 16);

const STOP = new Set('the a an of in on for to and or with is are was were be been says said new its this that from by at as it s t re ve ll d m how why what you your'.split(' '));
export function sig(title) {
  return [...new Set(norm(title).split(' ').filter((x) => x.length > 2 && !STOP.has(x)))].sort().join(' ');
}
export function jaccard(a, b) {
  const A = new Set(a.split(' '));
  const B = new Set(b.split(' '));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n += 1;
  return n / Math.max(A.size, B.size);
}

// How many significant words two titles share (a fold needs at least two: "same company" alone is not "same event").
export function sharedWords(a, b) {
  const B = new Set(sig(b).split(' '));
  return sig(a).split(' ').filter((x) => x && B.has(x)).length;
}

// Words a title is "about", for the like / dislike memory (English, lowercase, no filler).
export function tokens(text) {
  return [...new Set(norm(text).split(' ').filter((x) => x.length > 3 && !STOP.has(x)))];
}

// ---------- the first reading (before any model has looked) ----------
// Words alone decide: banned things go straight to -99, the rest get a prior score that only orders the work queue. System One
// (llm.js triage) then gives the real category and taste score.
export const STACK_ALERT = /\b(cve-\d{4}-\d+|vulnerab\w*|exploit\w*|malicious|compromis\w*|leak(?:ed|s)?|backdoor|advisory|zero[- ]day|supply chain|prompt injection)\b/i;

// Does a story concern the owner's own stack and a real problem with it? Those always pass and are flagged.
export const stackFlag = (item) => (STACK.test(`${item.title} ${item.snippet ?? ''}`) && STACK_ALERT.test(`${item.title} ${item.snippet ?? ''}`)) || Boolean(item.stack);

export function categoryOf(item) {
  const guess = guessCat(`${item.title} ${item.snippet ?? ''}`, item.cat);
  if (SECURITY_CAT && stackFlag(item) && item.cat === SECURITY_CAT) return SECURITY_CAT;
  return CATEGORIES[guess] ? guess : CATEGORIES[item.cat] ? item.cat : PRIMARY_CAT;
}

export function scoreOf(item, { outlets = 1, now = Date.now(), boost = 0 } = {}) {
  const text = `${item.title} ${item.snippet ?? ''}`;
  const cat = categoryOf(item);
  const flagged = stackFlag(item);
  // Steam sale summaries are the one deal-like thing that is wanted.
  if (item.kind !== 'steam-sale') {
    if (hardBan(text) || LISTICLE.test(item.title)) return -99;
    if (!flagged && unwanted(text, item.meta?.lang)) return -99;
    if (bannedIn(cat, text)) return -99;
  }
  const ageH = Math.max(0, (now - item.ts) / 3_600_000);
  const fresh = 0.5 ** (ageH / (HALF_LIFE_H[cat] ?? 18));
  const corroboration = Math.min(3, outlets - 1) * 0.8;
  const points = item.meta?.points ? Math.min(2, Math.log10(1 + item.meta.points) / 1.4) : 0;
  const hype = item.meta?.gh ? Math.min(2, Math.log10(1 + (item.meta.gh.d24 ?? 0)) / 1.5) : 0;
  const likes = item.meta?.likes ? Math.min(1, Math.log10(1 + item.meta.likes) / 3) : 0;
  return 3 * fresh + 2 * keywordRelevance(cat, text) + (flagged ? 1.5 : 0) + boost * 3 + corroboration + points + hype + likes;
}

// Merges items about the same story (same canonical URL, or nearly the same title) into the first one; `also` lists the outlets.
export function collapse(items) {
  const out = [];
  const bySig = [];
  const byCanon = new Map();
  for (const item of items.sort((a, b) => b.ts - a.ts)) {
    const c = canon(item.url);
    const s = sig(item.title);
    let host = byCanon.get(c);
    if (!host) host = out.find((o, i) => bySig[i] && s && jaccard(bySig[i], s) >= 0.55);
    if (host) {
      host.outlets.add(item.source);
      if (!host.image && item.image) host.image = item.image;
      if ((item.meta?.points ?? 0) > (host.meta?.points ?? 0)) host.meta = { ...item.meta, ...(host.meta?.gh ? { gh: host.meta.gh, readme: host.meta.readme } : {}) };
      else if (item.meta?.gh && !host.meta?.gh) host.meta = { ...host.meta, gh: item.meta.gh, readme: item.meta.readme };
      continue;
    }
    const entry = { ...item, outlets: new Set([item.source]) };
    out.push(entry);
    bySig.push(s);
    byCanon.set(c, entry);
  }
  return out;
}
