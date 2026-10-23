import { safeFetch } from './net.js';

// X answers (and sometimes Bluesky posts) link through shorteners, sometimes cut off ("https://t.co/"). A card must open the real
// article and be deduped by it, so short links are followed (through the same checked fetch as everything else) BEFORE a candidate
// is stored. Whatever cannot be resolved is dropped, or falls back to the X post it came from.
const SHORTENERS = /^(?:t\.co|bit\.ly|buff\.ly|ow\.ly|lnkd\.in|dlvr\.it|tinyurl\.com|goo\.gl|is\.gd|cutt\.ly|trib\.al|fb\.me|spr\.ly)$/i;
const TIMEOUT_MS = 6000;
const CONCURRENCY = 6;
const cache = new Map(); // short url -> resolved url | '' (a day is long enough; the process restarts often)

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
export const isShort = (url) => SHORTENERS.test(hostOf(url));
// "https://t.co/" or "https://t.co/abc" (t.co ids are 10 characters): cut off by the model, nothing to follow.
export function truncated(url) {
  try {
    const u = new URL(url);
    const id = u.pathname.replace(/^\/+|\/+$/g, '');
    return !id || (/^t\.co$/i.test(u.hostname) && id.length < 8);
  } catch { return true; }
}

let override = null;
export const setResolver = (fn) => { override = fn; }; // tests: (url) => final url | ''

// -> the final URL, or '' when it is cut off, unreachable or ends at another shortener.
export async function resolveUrl(url) {
  if (!isShort(url)) return url;
  if (truncated(url)) return '';
  if (cache.has(url)) return cache.get(url);
  let out = '';
  try {
    if (override) out = await override(url);
    else if (process.env.HERMES_WEB_FRESH_OFFLINE === '1') out = url; // tests never touch the internet
    else {
      let res;
      try { res = await safeFetch(url, { method: 'HEAD', timeoutMs: TIMEOUT_MS, maxBytes: 1 }); } catch { res = null; }
      if (!res || res.status === 405 || res.status === 403 || res.status >= 500) res = await safeFetch(url, { timeoutMs: TIMEOUT_MS, maxBytes: 4096 });
      out = res.status < 400 || res.status === 403 ? res.url : '';
    }
  } catch { out = ''; }
  if (out && isShort(out) && !override && process.env.HERMES_WEB_FRESH_OFFLINE !== '1') out = ''; // a chain that never left the shortener
  if (cache.size > 2000) cache.clear();
  cache.set(url, out ?? '');
  return out ?? '';
}

// items -> the same items with short links replaced by what they lead to. One that cannot be resolved keeps the X post it was
// found in (meta.post) as its link, otherwise it is dropped.
export async function resolveItems(items) {
  const out = new Array(items.length);
  const todo = items.map((item, i) => [item, i]).filter(([item]) => isShort(item.url));
  items.forEach((item, i) => { if (!isShort(item.url)) out[i] = item; });
  for (let n = 0; n < todo.length; n += CONCURRENCY) {
    await Promise.all(todo.slice(n, n + CONCURRENCY).map(async ([item, i]) => {
      const url = await resolveUrl(item.url);
      if (url) out[i] = { ...item, url, meta: { ...item.meta, short: item.url } };
      else if (item.meta?.post) out[i] = { ...item, url: item.meta.post };
    }));
  }
  return out.filter(Boolean);
}
