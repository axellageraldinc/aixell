import fs from 'node:fs';
import path from 'node:path';
import { logFfmpeg, runFfmpeg } from '../ffmpeg.js';
import { safeFetch } from './net.js';
import { stripTags } from './feeds.js';
import { IMAGE_DIR } from './store.js';

const EDGE = 720;
export const imageFile = (id) => path.join(IMAGE_DIR, `${id}.jpg`);

const metaOf = (html, ...names) => {
  for (const name of names) {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i'));
    if (m) return stripTags(m[1]);
  }
  return '';
};

// -> { image, description, text } from the article page (best effort; every part may be empty).
export async function pageInfo(url) {
  try {
    const res = await safeFetch(url, { accept: 'text/html,application/xhtml+xml', maxBytes: 1_500_000, timeoutMs: 12_000 });
    if (res.status !== 200 || !/html/i.test(res.type)) return { image: '', description: '', text: '' };
    const html = res.body.toString('utf8');
    let image = metaOf(html, 'og:image', 'twitter:image', 'og:image:url');
    try { if (image) image = new URL(image, res.url).href; } catch { image = ''; }
    return { image, description: metaOf(html, 'og:description', 'description', 'twitter:description'), text: articleText(html, 2500) };
  } catch {
    return { image: '', description: '', text: '' };
  }
}

// ---------- readable text ----------
const DROP = /<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|figure|button|select|template)\b[\s\S]*?<\/\1>/gi;
function blocksOf(html) {
  let body = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(DROP, ' ');
  const pick = (tag) => { let best = ''; for (const m of body.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))) if (m[1].length > best.length) best = m[1]; return best; };
  body = pick('article') || pick('main') || body;
  const out = [];
  for (const m of body.matchAll(/<(h[1-4]|p|li|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = stripTags(m[2]);
    const tag = m[1].toLowerCase();
    if (!text) continue;
    if (tag.startsWith('h')) { if (text.length > 3) out.push({ k: 'h', t: text.slice(0, 200) }); continue; }
    if (text.length < 40 && tag !== 'li') continue;
    out.push({ k: tag === 'li' ? 'li' : tag === 'blockquote' ? 'q' : tag === 'pre' ? 'code' : 'p', t: text.slice(0, 1800) });
  }
  return out;
}
function articleText(html, max) {
  let total = 0;
  const parts = [];
  for (const b of blocksOf(html)) { if (b.k === 'h' || total > max) continue; parts.push(b.t); total += b.t.length; }
  return parts.join(' ').slice(0, max);
}

// Whole article as blocks [{k, t}] for the in-app reader; [] when the page has nothing readable.
export async function readerBlocks(url) {
  const res = await safeFetch(url, { accept: 'text/html,application/xhtml+xml', maxBytes: 2_500_000, timeoutMs: 15_000 });
  if (res.status !== 200 || !/html/i.test(res.type)) throw new Error('not a page');
  const blocks = blocksOf(res.body.toString('utf8'));
  const out = [];
  let total = 0;
  for (const b of blocks) { if (total > 24_000 || out.length > 80) break; out.push(b); total += b.t.length; }
  return out.filter((b, i) => b.k !== 'h' || out[i + 1]?.k !== 'h');
}

// ---------- picture ----------
// A card picture must be worth showing: stock site art, logos, avatars and upscaled thumbnails make a card look broken.
const MIN_W = 600;
const MIN_H = 300;
const MAX_RATIO = 3.2; // wider than this (banners) or taller than 1/2 (posters, screenshots of phones) is cropped into nonsense
const MIN_RATIO = 0.5;
const BLURRY = 10; // ffmpeg blurdetect "blur mean" on the 720px version: sharp photos measured 3.5-8.8, a 4x upscale 6.5-12.3 (see README)
const GENERIC = /opengraph\.githubassets\.com|github\.githubassets\.com|avatars\.githubusercontent\.com|gravatar\.com|youtube\.com\/img\/|s\.ytimg\.com\/yts|favicon|apple-touch-icon|\/logos?[-_./]|[-_/]logo[-_.]|og[-_]?default|default[-_]?og|default[-_]?(?:social|share|image|thumb)|placeholder|sprite|site[-_]?icon|\.(?:ico|svg)(?:\?|$)/i;
export const genericImage = (src) => GENERIC.test(String(src));

// Width and height from the file header (PNG, JPEG, WebP, GIF); null when unknown.
export function imageSize(b) {
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return [b.readUInt32BE(16), b.readUInt32BE(20)];
    if (b.toString('ascii', 0, 3) === 'GIF') return [b.readUInt16LE(6), b.readUInt16LE(8)];
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i += 1; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const t = b.toString('ascii', 12, 16);
      if (t === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
      if (t === 'VP8L') { const v = b.readUInt32LE(21); return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1]; }
      if (t === 'VP8X') return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
    }
  } catch { /* unreadable header */ }
  return null;
}

// -> '' when the picture is fine, else why not (for tests and logs).
export function imageProblem(src, body) {
  if (genericImage(src)) return 'generic';
  const size = imageSize(body);
  if (!size) return 'unknown size';
  const [w, h] = size;
  if (w < MIN_W || h < MIN_H) return 'small';
  if (w / h > MAX_RATIO || w / h < MIN_RATIO) return 'ratio';
  return '';
}

export async function saveImage(id, src) {
  try {
    const res = await safeFetch(src, { accept: 'image/*', maxBytes: 6_000_000, timeoutMs: 15_000 });
    if (res.status !== 200 || res.body.length < 1500 || !/image/i.test(res.type)) return false;
    if (imageProblem(res.url, res.body) || imageProblem(src, res.body)) return false;
    const log = await logFfmpeg(['-v', 'info', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale='min(${EDGE},iw)':-2,blurdetect`, '-f', 'null', '-'], res.body);
    const blur = Number(log?.match(/blur mean: ([\d.]+)/)?.[1]);
    if (blur >= BLURRY) return false;
    const small = await runFfmpeg(['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale='min(${EDGE},iw)':-2`, '-q:v', '5', '-f', 'mjpeg', 'pipe:1'], res.body);
    if (!small?.length) return false;
    fs.writeFileSync(`${imageFile(id)}.tmp`, small, { mode: 0o600 });
    fs.renameSync(`${imageFile(id)}.tmp`, imageFile(id));
    return true;
  } catch { return false; }
}
