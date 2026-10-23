import dns from 'node:dns/promises';
import net from 'node:net';

// Everything the "Fresh" feed downloads comes from addresses found inside feeds, so each hop is checked: only http(s), and
// never a loopback / private / link-local address (this server sits on a home network).
const UA = 'Mozilla/5.0 (compatible; aixell-fresh/1.0)';

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:') && net.isIPv4(v6.slice(7))) return privateAddress(v6.slice(7));
  // URL parsing rewrites ::ffff:127.0.0.1 as ::ffff:7f00:1 (and IPv4-compatible ::a.b.c.d likewise): check the embedded IPv4 address.
  const embedded = v6.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (embedded) {
    const hi = parseInt(embedded[1], 16);
    const lo = parseInt(embedded[2], 16);
    return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

export async function assertPublic(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('bad url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (privateAddress(host)) throw new Error('private address'); return url; }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('private address');
  const found = await dns.lookup(host, { all: true });
  if (!found.length || found.some((a) => privateAddress(a.address))) throw new Error('private address');
  return url;
}

// -> { status, url, type, body: Buffer }. Follows up to 4 redirects (each one checked), reads at most maxBytes.
export async function safeFetch(raw, { timeoutMs = 15_000, maxBytes = 2_000_000, accept = '*/*', headers = {}, method = 'GET', body } = {}) {
  let current = raw;
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop < 5; hop += 1) {
    await assertPublic(current);
    const response = await fetch(current, { method, redirect: 'manual', signal, body, headers: { 'User-Agent': UA, Accept: accept, ...headers } });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = new URL(response.headers.get('location'), current).href;
      continue;
    }
    const chunks = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) { chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes))); break; }
        chunks.push(chunk);
      }
    }
    return { status: response.status, url: current, type: response.headers.get('content-type') ?? '', body: Buffer.concat(chunks) };
  }
  throw new Error('too many redirects');
}

// JSON over safeFetch -> { status, data } (data is null when the body is not JSON). Tests and the offline mode swap the transport.
let override = null;
export const setHttp = (fn) => { override = fn; };
export async function getJson(url, { method = 'GET', headers = {}, json, timeoutMs = 15_000 } = {}) {
  const fake = override ?? (process.env.HERMES_WEB_FRESH_OFFLINE === '1' ? (await import('./mock.js')).mockHttp : null);
  if (fake) return fake(url, { method, headers, json });
  const res = await safeFetch(url, { method, accept: 'application/json', timeoutMs, maxBytes: 4_000_000, headers: { ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: json === undefined ? undefined : JSON.stringify(json) });
  let data = null;
  try { data = JSON.parse(res.body.toString('utf8')); } catch { /* not JSON */ }
  return { status: res.status, data };
}
