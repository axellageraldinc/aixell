// Bridge between the agent and the owner's browser. The aixell extension signs in with the same session cookie as the web
// app, keeps one event stream open, and runs the commands it receives; the agent's side calls `call()` through a
// loopback-only endpoint. This module only moves messages: every permission decision is made by the extension, in the browser.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_TOOL_NAMES } from './browser-tools.js';
import { HttpError } from './http.js';

const CALL_TIMEOUT_MS = 150_000; // the user may take up to two minutes to answer a confirmation
const MAX_PENDING = 4;
const HEARTBEAT_MS = 15_000;
const MAX_ARGS_BYTES = 100_000;

const sameConstant = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createBridge({ extensionIds = [], dataDir, isSessionValid = () => true, onLog = () => {} }) {
  const allowed = new Set(extensionIds.map((id) => `chrome-extension://${id}`));
  let conn = null; // { res, token, user, since }
  const pending = new Map(); // id -> { resolve, reject, timer }
  const tokenFile = path.join(dataDir, 'browser-bridge-token');
  let token = null;

  function bridgeToken() {
    if (token) return token;
    try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { token = null; }
    if (!token || token.length < 32) {
      token = crypto.randomBytes(32).toString('base64url');
      fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    }
    return token;
  }

  const enabled = () => allowed.size > 0;

  // The extension's requests come from its own origin. Only the exact origins in the settings are accepted.
  function assertExtensionOrigin(req) {
    if (!enabled()) throw new HttpError(404, 'Not found.', 'not_found');
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) throw new HttpError(403, 'This extension is not allowed.', 'bad_extension');
  }

  function failAll(code, message) {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new HttpError(502, message, code)); pending.delete(id); }
  }

  function openStream(req, res, { sessionToken, user }) {
    assertExtensionOrigin(req);
    if (conn) { try { conn.res.end(); } catch { /* already closed */ } failAll('browser_replaced', 'Another browser connected.'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    res.write(`event: hello\ndata: ${JSON.stringify({ user })}\n\n`);
    const me = { res, sessionToken, user, since: Date.now() };
    conn = me;
    onLog('browser connected');
    const beat = setInterval(() => {
      if (!isSessionValid(sessionToken)) { res.end(); return; } // signed out or revoked: the stream ends
      res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    beat.unref?.();
    const gone = () => {
      clearInterval(beat);
      if (conn === me) { conn = null; failAll('browser_disconnected', 'The browser disconnected.'); onLog('browser disconnected'); }
    };
    res.on('close', gone); // not req: since Node 16 the request emits 'close' as soon as it has been read
  }

  function receive(req, body) {
    assertExtensionOrigin(req);
    if (!conn) throw new HttpError(409, 'Not connected.', 'not_connected');
    const p = pending.get(String(body.id));
    if (!p) throw new HttpError(404, 'Unknown or expired command.', 'unknown_command');
    clearTimeout(p.timer);
    pending.delete(String(body.id));
    if (body.ok === true) p.resolve({ ok: true, result: body.result });
    else p.resolve({ ok: false, error: { code: String(body.error?.code ?? 'failed').slice(0, 40), message: String(body.error?.message ?? 'The browser could not do that.').slice(0, 500) } });
    return { ok: true };
  }

  // Agent side. Resolves with { ok, result | error }.
  function call(tool, args = {}) {
    if (!enabled()) throw new HttpError(404, 'The browser bridge is not enabled.', 'bridge_disabled');
    if (typeof tool !== 'string' || !BROWSER_TOOL_NAMES.has(tool)) throw new HttpError(400, 'Unknown browser tool.', 'unknown_tool');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS_BYTES) throw new HttpError(400, 'Arguments must be a small JSON object.', 'bad_args');
    if (!conn) throw new HttpError(503, 'The browser is not connected. The user must open Chrome with the aixell extension and be signed in.', 'browser_not_connected');
    if (pending.size >= MAX_PENDING) throw new HttpError(429, 'Too many browser commands are waiting.', 'too_many');
    const id = crypto.randomBytes(12).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new HttpError(504, 'The browser did not answer in time (the user may not have answered a question).', 'browser_timeout')); }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      conn.res.write(`event: cmd\ndata: ${JSON.stringify({ id, tool, args })}\n\n`);
    });
  }

  // Loopback only, and never through the public tunnel: the tunnel also connects from loopback, but it always adds these headers.
  function authorizeCall(req) {
    if (!enabled()) throw new HttpError(404, 'Not found.', 'not_found');
    const addr = req.socket.remoteAddress;
    const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    const proxied = req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for'] || req.headers.forwarded;
    if (!local || proxied) throw new HttpError(403, 'Local callers only.', 'not_local');
    const header = String(req.headers.authorization ?? '');
    if (!header.startsWith('Bearer ') || !sameConstant(header.slice(7), bridgeToken())) throw new HttpError(401, 'Invalid token.', 'unauthorized');
  }

  const status = () => ({ enabled: enabled(), connected: Boolean(conn), user: conn?.user ?? null, since: conn?.since ?? null, pending: pending.size });
  return { openStream, receive, call, authorizeCall, status, enabled, bridgeToken, close() { try { conn?.res.end(); } catch { /* closed */ } failAll('closed', 'The server is stopping.'); } };
}
