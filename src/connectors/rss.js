// RSS 2.0 / Atom feeds. Also covers Mastodon (an Atom feed) and YouTube channels (an Atom feed).
//
// This module owns the tiny XML readers that the rest of Fresh still uses (stripTags, parseFeed,
// discoverFeed); feeds.js re-exports them so existing importers and tests keep working.
import { safeFetch } from '../fresh/net.js';

// ---------- tiny XML readers (RSS 2.0 + Atom) ----------
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)));
export const decodeEntities = decode;
const unwrap = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
export const stripTags = (s) => decode(unwrap(String(s)).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const rawInner = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')); return m ? m[1] : null; };
const inner = (xml, tag) => { const raw = rawInner(xml, tag); return raw == null ? null : stripTags(raw); };
const attr = (tag, name) => tag.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'))?.[1];

function linkOf(xml) {
  const alt = xml.match(/<link[^>]*rel=["']alternate["'][^>]*>/i) || xml.match(/<link[^>]*href=["'][^"']+["'][^>]*>/i);
  if (alt) { const href = attr(alt[0], 'href'); if (href) return decode(href); }
  return inner(xml, 'link');
}
function dateOf(xml) {
  for (const tag of ['pubDate', 'published', 'updated', 'dc:date', 'date']) {
    const value = inner(xml, tag);
    const ms = value ? Date.parse(value) : NaN;
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}
function imageOf(xml, base) {
  const candidates = [];
  for (const m of xml.matchAll(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*>/gi)) {
    const type = attr(m[0], 'type') ?? '';
    const medium = attr(m[0], 'medium') ?? '';
    const url = attr(m[0], 'url');
    if (url && (type.startsWith('image') || medium === 'image' || /\.(jpe?g|png|webp)(\?|$)/i.test(url) || m[0].startsWith('<media:thumbnail'))) candidates.push(url);
  }
  const html = decode(unwrap(rawInner(xml, 'content:encoded') ?? rawInner(xml, 'content') ?? rawInner(xml, 'description') ?? rawInner(xml, 'summary') ?? ''));
  const img = html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
  if (img) candidates.push(img);
  for (const c of candidates) {
    try { const url = new URL(decode(c), base); if (/^https?:$/.test(url.protocol) && !/(pixel|spacer|1x1|\.gif(\?|$))/i.test(url.href)) return url.href; } catch { /* next */ }
  }
  return null;
}

// `src` is `{ id, cat }` (the shape the tests have always used). The returned rows still carry
// source/cat for those tests; the connector below strips them and decorates with the instance.
export function parseFeed(xml, src) {
  const atom = /<feed[\s>]/i.test(xml) || /<entry[\s>]/i.test(xml);
  const tag = atom ? 'entry' : 'item';
  return xml.split(new RegExp(`<${tag}[\\s>]`, 'i')).slice(1).map((chunk) => {
    const title = inner(chunk, 'title');
    let url = linkOf(chunk);
    // Techmeme's own link is its archive page; the story it points to is the first outside link in the description.
    if (url && /(^|\.)techmeme\.com$/.test(new URL(url, 'http://x').hostname)) {
      const body = decode(unwrap(rawInner(chunk, 'description') ?? ''));
      const outside = [...body.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)].map((m) => m[1]).find((h) => /^https?:/.test(h) && !/techmeme\.com/.test(h));
      if (outside) url = outside;
    }
    if (!title || !url || url.startsWith('#')) return null;
    const body = inner(chunk, 'summary') || inner(chunk, 'description') || inner(chunk, 'content') || '';
    return { source: src.id, cat: src.cat, title, url, snippet: body.slice(0, 400), bodyLen: body.length, ts: dateOf(chunk), image: imageOf(chunk, url) };
  }).filter(Boolean);
}

// Reads and parses a feed through the context's guarded fetch. `keepBodyLen` keeps the snippet
// length in `meta.bodyLen` (the release connector uses it to decide what is substantial).
export async function fetchFeed(ctx, { limit = ctx.config.limit ?? 15, url = ctx.config.url, keepBodyLen = false } = {}) {
  if (!url) throw new Error('no feed url configured');
  const res = await ctx.fetch(url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*', maxBytes: 3_000_000 });
  if (res.status !== 200) throw new Error(`http ${res.status}`);
  const xml = res.body.toString('utf8');
  if (!/<rss|<feed|<entry|<item/i.test(xml)) throw new Error('not a feed');
  return parseFeed(xml, { id: ctx.config.id ?? '', cat: ctx.config.cat ?? '' })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((item) => {
      const candidate = { url: item.url, title: item.title, ts: item.ts, snippet: item.snippet, image: item.image, cat: ctx.config.cat };
      if (keepBodyLen) candidate.meta = { bodyLen: item.bodyLen };
      return candidate;
    });
}

// Finds the feed behind a web page: the page's own <link rel="alternate"> or the usual paths.
export async function discoverFeed(raw) {
  const page = await safeFetch(raw, { accept: 'text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,*/*' });
  if (page.status !== 200) throw new Error(`http ${page.status}`);
  const text = page.body.toString('utf8');
  if (/<rss|<feed[\s>]/i.test(text.slice(0, 2000))) return { url: page.url, title: inner(text, 'title') || new URL(page.url).hostname };
  const found = [...text.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)].map((m) => attr(m[0], 'href')).filter(Boolean);
  const guesses = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'];
  for (const candidate of [...found, ...guesses]) {
    let url;
    try { url = new URL(decode(candidate), page.url).href; } catch { continue; }
    try {
      const res = await safeFetch(url, { accept: 'application/rss+xml, application/atom+xml, */*', timeoutMs: 8000, maxBytes: 600_000 });
      const xml = res.body.toString('utf8');
      if (res.status === 200 && /<rss|<feed[\s>]/i.test(xml.slice(0, 3000))) return { url, title: inner(xml.split(/<(?:item|entry)[\s>]/i)[0], 'title') || new URL(url).hostname };
    } catch { /* next candidate */ }
  }
  throw new Error('no feed found');
}

export const rss = {
  type: 'rss',
  title: 'RSS / Atom feed',
  configSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri', description: 'Feed URL (RSS 2.0, Atom, or a Mastodon account feed).' },
      label: { type: 'string', description: 'Optional name put in front of a release title.' },
    },
  },
  credentials: [],
  defaultSchedule: { every: '30m' },
  cost: { kind: 'free' },
  fetch: (ctx) => fetchFeed(ctx),
};

export default rss;
