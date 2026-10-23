import crypto from 'node:crypto';
import { HttpError, SECURITY_HEADERS } from './http.js';

// "Pratinjau" of an HTML / SVG block from a reply. The markup is kept in memory for a while and served on its own URL with a
// CSP that sandboxes it: its own scripts and styles run, but it has no access to the app (opaque origin, no cookies, no
// network). Not written to disk.
const MAX_ITEMS = 30;
const MAX_BYTES = 512 * 1024;
const TTL_MS = 2 * 60 * 60 * 1000;
const items = new Map();

const WRAP_SVG = (svg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100vh}</style>${svg}`;

export function putArtifact(code, kind) {
  if (typeof code !== 'string' || !code.trim()) throw new HttpError(400, 'The code is empty.', 'bad_artifact');
  if (Buffer.byteLength(code) > MAX_BYTES) throw new HttpError(413, 'The code is too large to preview.', 'too_large');
  const now = Date.now();
  for (const [id, item] of items) if (now - item.at > TTL_MS) items.delete(id);
  while (items.size >= MAX_ITEMS) items.delete(items.keys().next().value);
  const id = crypto.randomBytes(12).toString('hex');
  const html = kind === 'svg' ? WRAP_SVG(code) : /<html[\s>]|<!doctype/i.test(code) ? code : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${code}`;
  items.set(id, { html, at: now });
  return id;
}

export function serveArtifact(res, id) {
  const item = items.get(id);
  if (!item) throw new HttpError(404, 'This preview has expired. Open it again from the message.', 'not_found');
  const body = Buffer.from(item.html);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; sandbox allow-scripts allow-forms allow-modals; frame-ancestors 'self'",
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}
