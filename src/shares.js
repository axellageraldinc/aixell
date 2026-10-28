import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { resolveSecret } from './config/secrets.js';
import { HttpError } from './http.js';
import { safeFetch } from './fresh/net.js';

// Public chat links. A share is a frozen, script-free HTML copy of a chat that is pushed to a Cloudflare Worker's KV store
// and served from the Worker's own hostname (see deploy/cloudflare-share/). The app itself is never reachable from the link,
// and the page holds no address of the app. Settings live in data/share.json; the index of live links in data/shares.json.
const SETTINGS_FILE = path.join(config.dataDir, 'share.json');
const INDEX_FILE = path.join(config.dataDir, 'shares.json');
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const API = 'https://api.cloudflare.com/client/v4';

// What the page looks like: the app's own stylesheets, minus anything that loads from a URL (fonts, images).
const SHELL_STYLE = `
html, body { height: auto; overflow: visible; }
.app { display: block; height: auto; overflow: visible; }
.main, .thread-wrap, .thread { display: block; height: auto; overflow: visible; }
.message-list { margin: 0 auto; }
.share-head { padding: 24px 0 8px; }
.share-head h1 { font-size: 20px; margin: 0 0 4px; }
.share-head p { margin: 0; opacity: .65; font-size: 13px; }
.meta { display: none; }
.share-att { display: inline-block; margin: 0 0 6px; padding: 2px 8px; border-radius: 8px; font-size: 12px; opacity: .7; border: 1px solid currentColor; }
`;

let transport = (url, options) => safeFetch(url, options);
// Tests swap the network out.
export const setTransport = (fn) => { transport = fn; };

export function readSettings() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return null; }
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.replace(/\/+$/, '') : '';
  const apiToken = typeof raw.apiToken === 'string' ? resolveSecret(raw.apiToken, { dataDir: config.dataDir }) : null;
  if (!/^https:\/\/[^/\s]+$/.test(baseUrl) || !raw.accountId || !raw.namespaceId || !apiToken) return null;
  const ttlDays = Number.isFinite(raw.ttlDays) && raw.ttlDays >= 0 ? Math.min(raw.ttlDays, 3650) : 30;
  return { baseUrl, accountId: String(raw.accountId), namespaceId: String(raw.namespaceId), apiToken, ttlDays };
}

const requireSettings = () => {
  const settings = readSettings();
  if (!settings) throw new HttpError(409, 'Public sharing is not set up. See "Share a chat" in docs/configuration.md.', 'share_not_configured');
  return settings;
};

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(parsed.shares) ? parsed.shares : [];
  } catch {
    return [];
  }
}

function writeIndex(shares) {
  const temporary = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ shares }), { mode: 0o600 });
  fs.renameSync(temporary, INDEX_FILE);
}

const publicView = (settings, share) => ({ token: share.token, agent: share.agent, sessionId: share.sessionId, title: share.title, createdAt: share.createdAt, updatedAt: share.updatedAt, expiresAt: share.expiresAt, url: settings ? `${settings.baseUrl}/${share.token}` : null });

export function listShares() {
  const settings = readSettings();
  const now = Date.now();
  return readIndex().filter((s) => !s.expiresAt || s.expiresAt > now).map((s) => publicView(settings, s));
}

// The app's own addresses never appear on a public page: they are replaced wherever a chat happens to mention one.
function redactOwnHosts(html) {
  const own = [...config.allowedHostnames].filter((name) => /[a-z]/i.test(name) && name.includes('.'));
  return own.reduce((text, name) => text.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '•••'), html);
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const readCss = (name) => {
  try { return fs.readFileSync(path.join(config.publicDir, name), 'utf8').replace(/@import[^;]*;/g, '').replace(/url\((?!["']?data:)[^)]*\)/g, 'none'); } catch { return ''; }
};

// body: the thread markup the browser already cleaned (scripts, forms, remote media and handlers removed). This is the
// second line of defence: a last check that refuses anything that could run, and the page's CSP forbids it anyway.
export function buildPage({ title, body }) {
  if (/<\s*(script|iframe|object|embed|form|link|meta|base)\b|<[^>]*\son[a-z]+\s*=|<[^>]*\s(href|src)\s*=\s*["']?\s*javascript:/i.test(body)) throw new HttpError(400, 'The chat contains markup that cannot be shared.', 'unsafe_html');
  const heading = escapeHtml(title).slice(0, 300);
  return redactOwnHosts(`<!doctype html>
<html lang="en" data-color-mode="auto"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><title>${heading}</title><style>${readCss('ui.css')}${readCss('app.css')}${SHELL_STYLE}</style></head><body><div class="app"><main class="main"><div class="thread-wrap"><div class="thread"><div class="message-list"><div class="share-head"><h1>${heading}</h1></div>${body}</div></div></div></main></div></body></html>
`);
}

async function kv(settings, method, token, { body, ttlSeconds } = {}) {
  const query = ttlSeconds ? `?expiration_ttl=${ttlSeconds}` : '';
  const res = await transport(`${API}/accounts/${encodeURIComponent(settings.accountId)}/storage/kv/namespaces/${encodeURIComponent(settings.namespaceId)}/values/${token}${query}`, {
    method,
    body,
    maxBytes: 64 * 1024,
    timeoutMs: 30_000,
    headers: { Authorization: `Bearer ${settings.apiToken}`, ...(body ? { 'Content-Type': 'text/html; charset=utf-8' } : {}) },
  });
  if (res.status === 404 && method === 'DELETE') return;
  if (res.status < 200 || res.status >= 300) throw new HttpError(502, `The share host refused the request (${res.status}).`, 'share_upstream');
}

// Publishes a chat, or refreshes the snapshot of one that is already shared (same link).
// ttlHours: a number of hours, or null for a link that never expires (undefined falls back to ttlDays in share.json).
export async function publishShare({ agent, sessionId, title, body, ttlHours }) {
  const settings = requireSettings();
  const page = buildPage({ title, body });
  if (Buffer.byteLength(page) > MAX_HTML_BYTES) throw new HttpError(413, 'This chat is too large to share.', 'too_large');
  const index = readIndex();
  const now = Date.now();
  const existing = index.find((s) => s.agent === agent && s.sessionId === sessionId && (!s.expiresAt || s.expiresAt > now));
  const token = existing?.token ?? crypto.randomBytes(32).toString('base64url');
  const hours = ttlHours === undefined ? settings.ttlDays * 24 : ttlHours;
  if (hours !== null && !(Number.isFinite(hours) && hours >= 1 && hours <= 87_600)) throw new HttpError(400, 'The expiry must be 1 to 87600 hours, or none.', 'bad_ttl');
  const ttlSeconds = hours === null || hours === 0 ? 0 : Math.round(hours * 3600);
  const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null;
  await kv(settings, 'PUT', token, { body: page, ttlSeconds });
  const share = { token, agent, sessionId, title: String(title).slice(0, 300), createdAt: existing?.createdAt ?? now, updatedAt: now, expiresAt };
  writeIndex([...index.filter((s) => s.token !== token && (!s.expiresAt || s.expiresAt > now)), share]);
  return publicView(settings, share);
}

export async function revokeShare(token) {
  if (!TOKEN_RE.test(token)) throw new HttpError(404, 'Not found.', 'not_found');
  const index = readIndex();
  if (!index.some((s) => s.token === token)) throw new HttpError(404, 'Not found.', 'not_found');
  await kv(requireSettings(), 'DELETE', token);
  writeIndex(index.filter((s) => s.token !== token));
}
