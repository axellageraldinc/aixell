// Cloudflare Worker that serves shared chats from a KV namespace bound as SHARES.
// URL shape: https://<worker-host>/<43-character token>. Anything else is a plain 404.
// The page is static: the CSP forbids scripts and network access, so a shared chat cannot run code or call home.
const TOKEN = /^\/([A-Za-z0-9_-]{43})$/;

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  // Never cached by browsers or Cloudflare, so "Stop sharing" takes effect as fast as KV allows (up to about a minute).
  'Cache-Control': 'no-store',
};

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const match = TOKEN.exec(new URL(request.url).pathname);
    const html = match ? await env.SHARES.get(match[1]) : null;
    if (html === null) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
    return new Response(request.method === 'HEAD' ? null : html, { headers: HEADERS });
  },
};
