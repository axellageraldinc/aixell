// Small JSON/text helpers over `ctx.fetch`.
//
// A connector never opens its own HTTP client: `ctx.fetch` is the SSRF-guarded fetch from
// src/fresh/net.js (or, under HERMES_WEB_FRESH_OFFLINE=1, the local mock). Both return the same
// minimal `{ status, body: Buffer, headers }` shape.

const bodyText = (res) => (res?.body ? res.body.toString('utf8') : '');

export async function fetchText(ctx, url, { method = 'GET', headers = {}, timeoutMs = 20_000, maxBytes = 3_000_000, accept = 'text/html' } = {}) {
  const res = await ctx.fetch(url, { method, headers, timeoutMs, maxBytes, accept });
  return { status: res.status, text: bodyText(res), headers: res.headers ?? null };
}

export async function fetchJson(ctx, url, { method = 'GET', headers = {}, json, timeoutMs = 20_000, maxBytes = 4_000_000 } = {}) {
  const res = await ctx.fetch(url, {
    method,
    timeoutMs,
    maxBytes,
    accept: 'application/json',
    headers: { ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = bodyText(res);
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, text, headers: res.headers ?? null };
}
