import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, EFFORT_LEVELS, SERVICE_TIERS } from './src/config.js';
import { HttpError, SECURITY_HEADERS, parseCookies, readBody, readJson, requireId, sendError, sendJson } from './src/http.js';
import { createAuthenticator, readAuthRecord } from './src/auth.js';
import { createSessionStore, sessionFile } from './src/web-sessions.js';
import { agentFetch, agentJson, getAgent, isOnline, listAgentDefinitions, publicAgent } from './src/agents.js';
import { getModels, getServedModel } from './src/models.js';
import { coverFile, listCovers, makeCover, removeCover, thumbFile } from './src/covers.js';
import { setModelHidden } from './src/hidden-models.js';
import { getProviderUsage } from './src/provider-usage.js';
import { getPersonality, setPersonality, getSttLanguage, setSttLanguage, sharedWithDefault, getDefaultModel, setDefaultModel, applyDefaultModel, getCoversEnabled, setCoversEnabled } from './src/agent-settings.js';
import { getUsage } from './src/usage.js';
import { serveMedia } from './src/media.js';
import { buildAttachments, findUpload, storeUpload } from './src/uploads.js';
import { transcribeUpload } from './src/transcribe.js';
import { synthesizeSpeech } from './src/speech.js';
import { loadFillers } from './src/voice-fillers.js';
import { rewindLastTurn } from './src/rewind.js';
import { publicKey as pushKey, saveSubscription, removeSubscription, hasSubscription, lastFinished, notifyRunDone, sendTest } from './src/push.js';
import { listFacts, updateFact, removeFact, readNotes, writeNotes, listSkills, readSkill, trashSkill } from './src/knowledge.js';
import { startRun, findRun, runInfo, publish, attach, endRun, sseFrame } from './src/runs.js';
import { getSettings, saveSettings, forgetSettings, getContext, saveContext } from './src/session-settings.js';
import { priceOf, estimateCost, averagePrompt, loadPrices } from './src/pricing.js';
import { getTemplates, setTemplates } from './src/templates.js';
import { getBudget, setBudget } from './src/budget.js';
import { putArtifact, serveArtifact } from './src/artifacts.js';
import { listShares, publishShare, readSettings as shareSettings, revokeShare } from './src/shares.js';
import { listTelegramSessions, telegramMessages, transcriptOf } from './src/telegram.js';
import { lastPromptTokens, searchMessages } from './src/state-db.js';
import { OPENUI_PROMPT } from './src/openui-prompt.js';
import { freshBootstrap, freshIngest, freshRoute } from './src/fresh/routes.js';
import { startFresh } from './src/fresh/index.js';
import { providersFor } from './src/providers/compat.js';
import { buildRegistry } from './src/providers/registry.js';

const COOKIE = 'hw_session';
// Set by start(): the login record and the server-side sessions are only read when the app actually starts.
let auth;
let sessions;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.mjs': 'text/javascript; charset=utf-8' };
const PUBLIC_UNAUTHENTICATED = /^\/(login[\w.-]*\.(html|js|css)|theme\.js|app\.css|ui\.css|favicon\.[a-z]+|manifest\.webmanifest|sw\.js|(icon-[\w-]+|apple-touch-icon)\.png|vendor\/fonts\/[\w.-]+\.(css|woff2)|lib\/[\w./-]+\.js|locales\/[\w.-]+\.js)$/;
const SESSION_ID_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const RUN_ID_RE = /^run_[a-f0-9]{32}$/;
const MODEL_RE = /^[\w.\-:/]{1,100}$/;

const sameConstant = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const clamp = (value, min, max, fallback) => { const n = Number.parseInt(value, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const fromLocalConnector = (req) => config.trustCloudflare && LOOPBACK.has(req.socket.remoteAddress);

// Real client address: the tunnel connects from loopback, so without this every visitor would share one login rate-limit bucket.
function clientIp(req) {
  const forwarded = fromLocalConnector(req) ? String(req.headers['cf-connecting-ip'] || '').trim() : '';
  return net.isIP(forwarded) ? forwarded : req.socket.remoteAddress || 'unknown';
}

const isHttps = (req) => fromLocalConnector(req)
  && (req.headers['x-forwarded-proto'] === 'https' || /"scheme"\s*:\s*"https"/.test(String(req.headers['cf-visitor'] || '')));

function checkHost(req) {
  const hostname = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!config.allowedHostnames.has(hostname)) throw new HttpError(421, 'Host not allowed.', 'bad_host');
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost;
  try { originHost = new URL(origin).host; } catch { throw new HttpError(403, 'Invalid origin.', 'bad_origin'); }
  if (originHost !== req.headers.host) throw new HttpError(403, 'Origin not allowed.', 'bad_origin');
}

function cookieHeader(req, value, maxAgeSeconds) {
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${config.cookieSecure || isHttps(req) ? '; Secure' : ''}`;
}

function currentSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const session = sessions.get(token);
  return session ? { token, ...session } : null;
}

// ---------- static files ----------
function serveStatic(req, res, pathname, session) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.', 'method');
  const wanted = pathname === '/' ? '/index.html' : pathname;
  if (!session && !PUBLIC_UNAUTHENTICATED.test(wanted)) {
    if (wanted.endsWith('.html')) { res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' }); return res.end(); }
    throw new HttpError(401, 'Authentication required.', 'unauthorized');
  }
  if (session && wanted === '/login.html') { res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }); return res.end(); }
  let decoded;
  try { decoded = decodeURIComponent(wanted); } catch { throw new HttpError(400, 'Invalid path.', 'bad_path'); }
  if (decoded.includes('\0')) throw new HttpError(400, 'Invalid path.', 'bad_path');
  const file = path.resolve(config.publicDir, `.${decoded}`);
  if (!file.startsWith(config.publicDir + path.sep)) throw new HttpError(404, 'Not found.', 'not_found');
  let stat;
  try { stat = fs.statSync(file); } catch { throw new HttpError(404, 'Not found.', 'not_found'); }
  if (!stat.isFile()) throw new HttpError(404, 'Not found.', 'not_found');
  const ext = path.extname(file);
  const rewritten = !/^\/vendor\//.test(decoded) && (ext === '.js' || ext === '.html');
  const id = rewritten ? buildId() : '';
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${id ? `-${id}` : ''}"`;
  // Vendored libraries and fonts never change under the same name; app code is revalidated with the ETag (a 304 costs nothing).
  // A script/style requested under the current build id can never change (a new build is a new URL), so it is kept for good:
  // reopening the app costs no request at all for it. Anything else is revalidated with the ETag.
  const asked = new URL(req.url, 'http://x').searchParams.get('v');
  const pinned = (ext === '.js' || ext === '.css') && asked && asked === buildId();
  // Icons and the logo hardly ever change: a day is plenty.
  const cacheControl = /^\/vendor\//.test(decoded) || pinned ? 'public, max-age=31536000, immutable' : ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache';
  const headers = { ...SECURITY_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl, ETag: etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  const encoding = COMPRESSIBLE.has(ext) && stat.size > 1024 ? pickEncoding(req.headers['accept-encoding']) : null;
  if (rewritten) {
    // The tunnel's CDN overrides Cache-Control on .js/.css with a 4-hour browser cache, so a phone could mix old and new
    // modules after a deploy. Every local script/style/module URL therefore carries the build id: a new build is a new URL.
    const body = versioned(file, etag, encoding, id, ext);
    res.writeHead(200, { ...headers, ...(encoding ? { 'Content-Encoding': encoding } : {}), 'Content-Length': body.length });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  if (!encoding) {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    return void fs.createReadStream(file).pipe(res);
  }
  const body = compressed(file, etag, encoding);
  res.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Build id: changes whenever any app file (not the vendored libraries) changes.
const SRC_DIR = fileURLToPath(new URL('./src', import.meta.url));
let buildCache = { at: 0, id: '' };
function buildId() {
  if (Date.now() - buildCache.at < 1000) return buildCache.id;
  let hash = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'vendor') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else { const st = fs.statSync(full); hash = (hash * 31 + Math.floor(st.mtimeMs) + st.size) % 0xffffffff; }
    }
  };
  walk(config.publicDir);
  walk(SRC_DIR);
  buildCache = { at: Date.now(), id: hash.toString(36) };
  return buildCache.id;
}

// Every module reachable from `entry` through static imports (dynamic import() stays lazy), as served paths.
const graphCache = new Map();
function moduleGraph(entry) {
  const key = `${entry}|${buildId()}`;
  if (graphCache.has(key)) return graphCache.get(key);
  const seen = new Set();
  const visit = (spec) => {
    if (seen.has(spec)) return;
    const file = path.join(config.publicDir, spec);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    seen.add(spec);
    for (const m of text.matchAll(/\b(?:from|import)\s*(['"])(\.{1,2}\/[^'"?]+\.js)\1/g)) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(spec), m[2]));
      if (next.startsWith('/')) visit(next);
    }
  };
  visit(entry);
  graphCache.clear();
  const list = [...seen].filter((m) => m !== entry);
  graphCache.set(key, list);
  return list;
}

const versionedCache = new Map();
function versioned(file, etag, encoding, id, ext) {
  const key = `${file}|${encoding}`;
  const hit = versionedCache.get(key);
  if (hit?.etag === etag) return hit.body;
  let text = fs.readFileSync(file, 'utf8');
  text = ext === '.js'
    ? text.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"?]+\.js)\2/g, `$1$2$3?v=${id}$2`)
    : text.replace(/\b(src|href)="(\/(?!vendor\/)[^"?]+\.(?:js|css))"/g, `$1="$2?v=${id}"`);
  // The browser only learns about a module once its parent has arrived, which makes ~70 modules a long chain of round trips
  // over a mobile connection. Listing them all up front lets it fetch them side by side.
  if (ext === '.html' && /<script[^>]+type="module"[^>]+src="\/app\.js/.test(text)) {
    const links = moduleGraph('/app.js').map((m) => `<link rel="modulepreload" href="${m}?v=${id}">`).join('\n  ');
    text = text.replace('</head>', `  ${links}\n</head>`);
  }
  const raw = Buffer.from(text);
  const body = encoding === 'br' ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
    : encoding === 'gzip' ? zlib.gzipSync(raw, { level: 6 }) : raw;
  versionedCache.set(key, { etag, body });
  return body;
}

const COMPRESSIBLE = new Set(['.css', '.js', '.mjs', '.html', '.svg', '.json', '.txt']);
const compressedCache = new Map();
function pickEncoding(header) {
  const accepted = String(header || '');
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}
// Static files are compressed once per version (the ETag changes with the file) and kept in memory.
function compressed(file, etag, encoding) {
  const key = `${file}|${encoding}`;
  const hit = compressedCache.get(key);
  if (hit?.etag === etag) return hit.body;
  const raw = fs.readFileSync(file);
  const body = encoding === 'br'
    ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
    : zlib.gzipSync(raw, { level: 6 });
  compressedCache.set(key, { etag, body });
  return body;
}

// ---------- auth routes ----------
async function login(req, res) {
  checkOrigin(req);
  const body = await readJson(req, 4096);
  const client = clientIp(req);
  const result = await auth.verify(body.username, body.password, client);
  if (result.retryAfter) {
    return sendJson(res, 429, { error: { message: 'Too many attempts.', code: 'rate_limited' }, retryAfter: result.retryAfter }, { 'Retry-After': result.retryAfter });
  }
  // One generic message for both factors: never reveal which one failed.
  if (!result.ok || (auth.totpRequired && !auth.verifySecondFactor(String(body.code ?? '')))) {
    throw new HttpError(401, 'Sign-in failed. Check your username, password and code.', 'login_failed');
  }
  auth.clearAttempts(client);
  const created = sessions.create({ ip: client, userAgent: req.headers['user-agent'] });
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, created.token, config.sessionDays * 86400) });
}

// ---------- agent helpers ----------
async function webSession(agent, id) {
  requireId(id, 'session id');
  const data = await agentJson(agent, `/api/sessions/${encodeURIComponent(id)}`);
  const session = data?.session ?? data;
  if (!session || session.source !== 'api_server') throw new HttpError(403, 'Only web sessions can be changed here.', 'not_web_session');
  return session;
}

function sourceFilter(value) {
  if (value === 'telegram') return '&source=telegram';
  if (value === 'all') return '';
  return '&source=api_server';
}

// Tool dumps and reasoning can be hundreds of KB each: the browser only needs a readable head.
const CONTENT_CAP = { tool: 12_000, assistant: 200_000, user: 200_000 };
const REASONING_CAP = 20_000;
function trimMessages(page) {
  const cut = (text, cap) => (typeof text === 'string' && text.length > cap ? `${text.slice(0, cap)}\n… [truncated, ${text.length - cap} more characters]` : text);
  for (const m of page?.data ?? []) {
    m.content = cut(m.content, CONTENT_CAP[m.role] ?? 20_000);
    m.reasoning = cut(m.reasoning, REASONING_CAP);
    delete m.reasoning_content;
    for (const call of m.tool_calls ?? []) if (call?.function) call.function.arguments = cut(call.function.arguments, 8000);
  }
  return page;
}

// What the Feed home shows for a chat (its first question, newest reply and newest question), worked out here so the phone
// does not download dozens of tool messages for it. A chat busy with tools ends in many messages without words, so the newest
// reply is looked for in the last 40 messages first and in 250 only when that finds nothing.
const previews = new Map();
const textRows = (page) => (page?.data ?? page?.messages ?? []).filter((m) => typeof m.content === 'string' && m.content.trim() && (m.role === 'assistant' || m.role === 'user'));
async function sessionPreview(agent, sessionPath, full) {
  const key = `${agent.name}|${sessionPath}|${full}`;
  const hit = previews.get(key);
  if (!full && hit && Date.now() - hit.at < 15_000) return hit.value; // the story viewer always wants what is there now
  const get = (limit, order) => agentJson(agent, `${sessionPath}/messages?limit=${limit}&offset=0&order=${order}&inline_images=false`).catch(() => null);
  const oldestPage = get(6, 'oldest');
  let reply = null;
  let ask = null;
  for (const limit of [40, 250]) {
    const rows = textRows(await get(limit, 'latest')).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    reply = rows.find((m) => m.role === 'assistant') ?? null;
    ask = rows.find((m) => m.role === 'user') ?? null;
    if (reply) break;
  }
  const first = textRows(await oldestPage).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).find((m) => m.role === 'user');
  const cap = (text, n) => (typeof text === 'string' && text.length > n ? text.slice(0, n) : text ?? '');
  const value = { first: cap(first?.content, 800), reply: cap(reply?.content, full ? 60_000 : 800), ask: cap(ask?.content, 800) };
  previews.set(key, { at: Date.now(), value });
  if (previews.size > 200) previews.delete(previews.keys().next().value);
  return value;
}

// This chat is a web page, not a plain terminal: it can show what the agent makes, as long as the reply says where it is.
const WEB_HINT = 'You are chatting through the web. The web can show images, audio (TTS, music), video and PDFs right in the chat. '
  + 'Whenever you make or find a media file for the user, write its absolute path on a line of its own with the MEDIA: prefix, '
  + 'for example: MEDIA:/home/user/.hermes/profiles/agent/audio_out/voice.mp3 . Never say audio or video cannot be shown, '
  + 'and never write a bare path. Keep the file in the agent profile folder (or /tmp) so it can be shown.';

// Added to a turn that comes from the voice chat: the answer is read aloud, so it has to work as speech.
const VOICE_HINT = 'This turn is a spoken conversation and your answer will be read aloud. Reply in the user\'s language, in short, natural, '
  + 'conversational sentences (usually one to three), with no markdown, lists, tables, code, emoji or web addresses. '
  + 'Answer from what you already know about the user and this conversation. Do not search the web or run tools unless the request truly needs it; '
  + 'if you are missing one detail, ask one short question.';

function spokenTitle(transcript) {
  const line = transcript.replace(/\s+/g, ' ').trim();
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  const space = cut.lastIndexOf(' ');
  return `${(space > 24 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

async function streamChat(req, res, agent) {
  const requestedAt = Date.now();
  const body = await readJson(req);
  const text = typeof body.text === 'string' ? body.text : '';
  const attachmentIds = Array.isArray(body.attachments) ? body.attachments : [];
  if (attachmentIds.length > 10) throw new HttpError(400, 'At most 10 attachments.', 'too_many_attachments');
  if (text.length > 200_000) throw new HttpError(413, 'Message is too long.', 'too_large');
  if (!text.trim() && !attachmentIds.length) throw new HttpError(400, 'Message is empty.', 'empty_message');

  const attachments = await buildAttachments(agent, attachmentIds);
  const message = [text, attachments.text].filter(Boolean).join('\n\n');
  const input = attachments.imageParts.length ? [{ type: 'text', text: message || 'See the attached image.' }, ...attachments.imageParts] : message;

  // A chat that starts with a voice note and no typed text is named after what was said, never after the audio file.
  const spoken = text.trim() ? '' : attachments.transcripts.find((t) => t?.trim()) ?? '';
  const payload = { input };
  for (const key of ['model', 'provider']) {
    if (body[key] != null) {
      if (typeof body[key] !== 'string' || !MODEL_RE.test(body[key])) throw new HttpError(400, `Invalid ${key}.`, 'bad_model');
      payload[key] = body[key];
    }
  }
  const options = {};
  if (body.reasoningEffort != null) {
    if (!EFFORT_LEVELS.includes(body.reasoningEffort)) throw new HttpError(400, 'Invalid effort.', 'bad_effort');
    options.reasoning_effort = body.reasoningEffort;
  }
  if (body.serviceTier != null) {
    if (!SERVICE_TIERS.includes(body.serviceTier)) throw new HttpError(400, 'Invalid service tier.', 'bad_tier');
    if (body.serviceTier !== 'default') options.service_tier = body.serviceTier;
  }
  if (Object.keys(options).length) payload.model_options = options;

  let sessionId = body.sessionId;
  let created = false;
  let callsBefore = 0;
  if (sessionId) {
    callsBefore = (await webSession(agent, sessionId)).api_call_count || 0;
    if (findRun(agent.name, sessionId)) throw new HttpError(409, 'This chat already has a reply in progress.', 'run_in_progress');
  } else {
    const data = await agentJson(agent, '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spoken ? { title: spokenTitle(spoken) } : {}) });
    sessionId = (data?.session ?? data)?.id;
    created = true;
    if (!sessionId) throw new HttpError(502, 'The agent did not create a session.', 'session_create_failed');
    // The picture for the feed is drawn now, alongside the reply, so it is ready by the time the feed is opened.
    if (getCoversEnabled(agent.name)) makeCover(agent, sessionId, text || spoken).catch(() => {});
  }

  const personality = getPersonality(agent.name);
  // Visualize is opt-in per chat: the model only learns the openui-lang grammar when the user asked for it, so the
  // ~1.3k tokens of instructions never ride along on a normal turn.
  const visualize = body.visualize === true;
  payload.system_message = [personality, WEB_HINT, visualize ? OPENUI_PROMPT : null, body.spoken === true ? VOICE_HINT : null].filter(Boolean).join('\n\n');

  const upstream = await agentFetch(agent, `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 3_600_000,
  });
  if (!upstream.ok) {
    let detail = null;
    try { detail = (await upstream.json())?.error; } catch { /* non-JSON body */ }
    throw new HttpError(upstream.status >= 500 ? 502 : upstream.status, detail?.message || 'The agent rejected the request.', detail?.code || 'agent_error');
  }
  saveSettings(agent.name, sessionId, body);

  res.writeHead(200, SSE_HEADERS);
  const run = startRun(agent.name, sessionId, requestedAt, (stale) => {
    console.warn(`[hermes-web] stopping unattended run ${stale.runId} (${agent.name}) after ${config.orphanStopMinutes} min without a viewer`);
    if (stale.runId) agentJson(agent, `/v1/runs/${stale.runId}/stop`, { method: 'POST' }).catch(() => {});
  });
  if (created) publish(run, sseFrame('web.session', { session_id: sessionId }));
  // The run is pumped here, not by this response: it survives a closed tab and can be re-attached.
  pump(run, upstream, agent, sessionId, callsBefore);
  await attach(run, res);
}

const SSE_HEADERS = { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };

async function pump(run, upstream, agent, sessionId, callsBefore) {
  try {
    for await (const chunk of upstream.body) publish(run, chunk);
  } catch (error) {
    publish(run, sseFrame('error', { message: 'Connection to the agent was lost.', code: error.name }));
  }
  endRun(run);
  // A reply that finished on its own: tell the devices that asked to hear about long ones (the service worker stays
  // silent when the app is open in front of you).
  if (run.usageInput != null) announceDone(agent, sessionId, run).catch(() => {});
  // The run reports prompt tokens summed over all its model calls; dividing by the calls it made gives the
  // typical prompt size (exact when it made one call). Stored so the context meter survives a reload.
  if (run.usageInput) {
    try {
      const after = (await webSession(agent, sessionId)).api_call_count || 0;
      const calls = Math.max(1, after - callsBefore);
      saveContext(agent.name, sessionId, { tokens: Math.round(run.usageInput / calls), approx: calls > 1 });
    } catch { /* the meter falls back to an average */ }
  }
}

async function announceDone(agent, sessionId, run) {
  let title = '';
  try { title = (await webSession(agent, sessionId)).title || ''; } catch { /* a generic body is fine */ }
  await notifyRunDone({ agentName: agent.name, sessionId, title, seconds: (Date.now() - run.startedAt) / 1000 });
}

async function apiRoute(req, res, url, session) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'agents', ':a', ...]
  const [, root, agentName, section, idOrRun, tail] = parts;

  if (parts[0] !== 'api') throw new HttpError(404, 'Not found.', 'not_found');

  if (root === 'fresh') return freshRoute(req, res, url);

  // What this instance can do (the client hides or labels features with it): the capabilities the first agent's providers bind.
  // With no agent at all nothing is available, which is the same answer an empty provider config gives.
  if (root === 'capabilities' && !agentName && method === 'GET') {
    let agent = null;
    try { agent = getAgent(config.agentNames[0]); } catch { /* no agent configured */ }
    const flags = agent ? providersFor(agent).flags() : buildRegistry({ providers: {}, capabilities: {} }, {}, {}).flags();
    return sendJson(res, 200, flags);
  }

  if (root === 'me' && method === 'GET') return sendJson(res, 200, { username: auth.username, csrf: session.csrf, expiresAt: session.expiresAt });
  if (root === 'logout' && method === 'POST') { sessions.destroy(session.token); return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) }); }
  if (root === 'logout-all' && method === 'POST') { sessions.destroyAll(); return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) }); }

  if (root === 'artifacts' && method === 'POST') {
    const body = await readJson(req, 600 * 1024);
    return sendJson(res, 200, { id: putArtifact(body.code, body.kind === 'svg' ? 'svg' : 'html') });
  }

  if (root === 'shares') {
    if (!agentName && method === 'GET') return sendJson(res, 200, { configured: Boolean(shareSettings()), data: listShares() });
    if (!agentName && method === 'POST') {
      const body = await readJson(req, 5 * 1024 * 1024);
      if (!SESSION_ID_RE.test(String(body.sessionId)) || typeof body.body !== 'string' || !body.body.trim()) throw new HttpError(400, 'A chat id and its content are required.', 'bad_request');
      const agent = getAgent(String(body.agent ?? config.agentNames[0]));
      return sendJson(res, 200, await publishShare({ agent: agent.name, sessionId: body.sessionId, title: String(body.title ?? '').slice(0, 300) || 'Chat', body: body.body, ttlHours: body.ttlHours === null ? null : body.ttlHours === undefined ? undefined : Number(body.ttlHours) }));
    }
    if (agentName && method === 'DELETE') { await revokeShare(agentName); return sendJson(res, 200, { ok: true }); }
  }

  if (root === 'telegram' && agentName === 'sessions' && method === 'GET') {
    if (!section) return sendJson(res, 200, { data: listTelegramSessions(clamp(url.searchParams.get('limit'), 1, 50, 12)) });
    const chat = telegramMessages(section);
    return sendJson(res, 200, { ...chat, transcript: transcriptOf(chat.messages) });
  }

  if (root === 'uploads' && method === 'GET' && agentName) {
    const meta = findUpload(agentName);
    const image = meta.kind === 'image';
    res.writeHead(200, {
      ...SECURITY_HEADERS, 'Content-Type': image ? meta.mime : 'application/octet-stream', 'Content-Length': meta.size,
      'Content-Disposition': image ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`, 'Cache-Control': 'private, max-age=3600',
    });
    return fs.createReadStream(meta.path).pipe(res);
  }

  if (root === 'push') {
    if (agentName === 'key' && method === 'GET') return sendJson(res, 200, { key: pushKey() });
    if (agentName === 'last' && method === 'GET') return sendJson(res, 200, lastFinished() ?? {});
    if (agentName === 'status' && method === 'POST') return sendJson(res, 200, { subscribed: hasSubscription(String((await readJson(req, 4096)).endpoint)) });
    if (agentName === 'subscribe' && method === 'POST') { const body = await readJson(req, 4096); saveSubscription(String(body.endpoint), Number(body.minSeconds)); return sendJson(res, 200, { ok: true }); }
    if (agentName === 'unsubscribe' && method === 'POST') { removeSubscription(String((await readJson(req, 4096)).endpoint)); return sendJson(res, 200, { ok: true }); }
    if (agentName === 'test' && method === 'POST') return sendJson(res, 200, { sent: await sendTest(String((await readJson(req, 4096)).endpoint)) });
    if (agentName === 'ack' && method === 'POST') {
      // The service worker reporting what it did with a push (shown / suppressed). It exists to make a missing banner
      // traceable in the journal; the payload is only logged, never trusted for state.
      const body = await readJson(req, 4096);
      console.log(`[push] device ${String(body.action).slice(0, 20)} ${String(body.heading ?? '').slice(0, 80)}`);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found.', 'not_found');
  }

  if (root !== 'agents') throw new HttpError(404, 'Not found.', 'not_found');

  if (!agentName) {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed.', 'method');
    const agents = listAgentDefinitions();
    const online = await Promise.all(agents.map(isOnline));
    return sendJson(res, 200, { agents: agents.map((agent, index) => publicAgent(agent, online[index])) });
  }

  const agent = getAgent(agentName);
  const json = { 'Content-Type': 'application/json' };

  // The real model behind a routed gateway for one conversation (xellter's /v1/session and the like).
  if (section === 'models' && idOrRun === 'served' && !tail && method === 'GET') {
    const sessionId = url.searchParams.get('session') ?? '';
    if (!SESSION_ID_RE.test(sessionId)) throw new HttpError(400, 'Invalid session id.', 'bad_id');
    return sendJson(res, 200, await getServedModel(agent, sessionId));
  }
  if (section === 'models' && method === 'GET') return sendJson(res, 200, applyDefaultModel(agent.name, await getModels(agent)));
  if (section === 'models' && idOrRun && tail === 'hidden' && method === 'PUT') {
    if (!MODEL_RE.test(idOrRun)) throw new HttpError(400, 'Invalid model.', 'bad_model');
    const body = await readJson(req, 1024);
    setModelHidden(agent.provider, idOrRun, body.hidden === true);
    return sendJson(res, 200, { ok: true });
  }
  if (section === 'settings' && !idOrRun && method === 'GET') {
    return sendJson(res, 200, { agent: agent.name, personality: getPersonality(agent.name), sttLanguage: getSttLanguage(agent.name), model: agent.model, provider: agent.provider, defaults: getDefaultModel(agent.name), coversEnabled: getCoversEnabled(agent.name), ...sharedWithDefault(agent) });
  }
  if (section === 'settings' && !idOrRun && method === 'PUT') {
    const body = await readJson(req, 16 * 1024);
    if (body.personality !== undefined) setPersonality(agent.name, body.personality);
    if (body.sttLanguage !== undefined) setSttLanguage(agent.name, body.sttLanguage);
    if (body.coversEnabled !== undefined) setCoversEnabled(agent.name, body.coversEnabled);
    if (body.defaultModel !== undefined || body.defaultEffort !== undefined) {
      const now = getDefaultModel(agent.name);
      setDefaultModel(agent.name, { model: body.defaultModel ?? now.model, provider: body.defaultProvider ?? now.provider, effort: body.defaultEffort ?? now.effort });
    }
    return sendJson(res, 200, { ok: true, personality: getPersonality(agent.name), sttLanguage: getSttLanguage(agent.name), defaults: getDefaultModel(agent.name), coversEnabled: getCoversEnabled(agent.name) });
  }
  if (section === 'covers' && !idOrRun && method === 'GET') return sendJson(res, 200, { enabled: getCoversEnabled(agent.name), ids: getCoversEnabled(agent.name) ? listCovers(agent) : [] });
  if (section === 'templates' && !idOrRun && method === 'GET') return sendJson(res, 200, { templates: getTemplates(agent.name) });
  if (section === 'templates' && !idOrRun && method === 'PUT') return sendJson(res, 200, { templates: setTemplates(agent.name, (await readJson(req, 256 * 1024)).templates) });
  if (section === 'budget' && !idOrRun && method === 'GET') return sendJson(res, 200, getBudget(agent.name));
  if (section === 'budget' && !idOrRun && method === 'PUT') return sendJson(res, 200, setBudget(agent.name, await readJson(req, 1024)));
  if (section === 'knowledge') {
    const factId = () => { const id = Number(tail); if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Bad fact id.', 'bad_fact'); return id; };
    if (idOrRun === 'facts' && !tail && method === 'GET') return sendJson(res, 200, { facts: await listFacts(agent) });
    if (idOrRun === 'facts' && tail && method === 'PATCH') { await updateFact(agent, factId(), (await readJson(req, 8 * 1024)).content); return sendJson(res, 200, { ok: true }); }
    if (idOrRun === 'facts' && tail && method === 'DELETE') { await removeFact(agent, factId()); return sendJson(res, 200, { ok: true }); }
    if (idOrRun === 'notes' && !tail && method === 'GET') return sendJson(res, 200, readNotes(agent));
    if (idOrRun === 'notes' && tail && method === 'PUT') return sendJson(res, 200, writeNotes(agent, tail, (await readJson(req, 64 * 1024)).entries));
    if (idOrRun === 'skills' && !tail && method === 'GET') return sendJson(res, 200, { skills: listSkills(agent) });
    if (idOrRun === 'skills' && tail === 'read' && method === 'GET') return sendJson(res, 200, readSkill(agent, url.searchParams.get('path')));
    if (idOrRun === 'skills' && tail === 'item' && method === 'DELETE') return sendJson(res, 200, trashSkill(agent, url.searchParams.get('path')));
    throw new HttpError(404, 'Not found.', 'not_found');
  }
  if (section === 'media' && method === 'GET') return serveMedia(req, res, agent, url.searchParams.get('path'));
  if (section === 'provider-usage' && method === 'GET') return sendJson(res, 200, await getProviderUsage(agent, { fresh: url.searchParams.get('fresh') === '1' }));
  if (section === 'search' && method === 'GET') return sendJson(res, 200, { results: searchMessages(agent, (url.searchParams.get('q') ?? '').slice(0, 200), { source: url.searchParams.get('source') ?? 'all' }) });
  if (section === 'usage' && method === 'GET') return sendJson(res, 200, await getUsage(agent, clamp(url.searchParams.get('days'), 1, 90, 30)));
  if (section === 'chat' && method === 'POST') return streamChat(req, res, agent);

  if (section === 'speech' && !idOrRun && method === 'POST') {
    const body = await readJson(req, 16 * 1024);
    const { audio, mime } = await synthesizeSpeech(agent, body.text, { speed: body.speed ?? undefined });
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
    return res.end(audio);
  }
  if (section === 'voice-fillers' && !idOrRun && method === 'GET') return sendJson(res, 200, loadFillers());
  if (section === 'uploads' && idOrRun && tail === 'transcribe' && method === 'POST') {
    return sendJson(res, 200, { text: await transcribeUpload(agent, idOrRun) });
  }
  if (section === 'uploads' && method === 'POST') {
    const buffer = await readBody(req, config.uploadMaxBytes);
    let filename = 'file';
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'file')); } catch { /* keep default */ }
    return sendJson(res, 200, storeUpload(agent, { filename, mime: req.headers['content-type'], buffer }));
  }

  if (section === 'runs' && tail && method === 'POST') {
    if (!RUN_ID_RE.test(idOrRun || '')) throw new HttpError(400, 'Invalid run id.', 'bad_id');
    if (tail === 'stop') {
      await agentJson(agent, `/v1/runs/${idOrRun}/stop`, { method: 'POST' });
      return sendJson(res, 200, { ok: true });
    }
    if (tail === 'steer') {
      const body = await readJson(req, 16 * 1024);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 8000) throw new HttpError(400, 'Steer text must be 1-8000 characters.', 'bad_steer');
      // Delivered to the agent after its current tool batch, as its own user message. 409 = the run cannot take it now.
      await agentJson(agent, `/v1/runs/${idOrRun}/steer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: text }) });
      return sendJson(res, 200, { ok: true });
    }
    if (tail === 'approval') {
      const body = await readJson(req, 4096);
      const choice = body.choice ?? body.decision;
      // "session"/"always" would grant standing permission from a browser: deliberately not offered.
      if (choice !== 'once' && choice !== 'deny') throw new HttpError(400, 'Choice must be "once" or "deny".', 'bad_choice');
      const forward = { choice };
      if (typeof body.requestId === 'string' && body.requestId.length <= 100) forward.request_id = body.requestId;
      await agentJson(agent, `/v1/runs/${idOrRun}/approval`, { method: 'POST', headers: json, body: JSON.stringify(forward) });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (section === 'sessions') {
    if (!idOrRun) {
      if (method === 'GET') {
        const limit = clamp(url.searchParams.get('limit'), 1, 100, 30);
        const offset = clamp(url.searchParams.get('offset'), 0, 100_000, 0);
        return sendJson(res, 200, await agentJson(agent, `/api/sessions?limit=${limit}&offset=${offset}${sourceFilter(url.searchParams.get('source'))}`));
      }
      if (method === 'POST') {
        const body = await readJson(req, 4096);
        const title = typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim().slice(0, 200) } : {};
        return sendJson(res, 200, await agentJson(agent, '/api/sessions', { method: 'POST', headers: json, body: JSON.stringify(title) }));
      }
    } else {
      requireId(idOrRun, 'session id');
      const sessionPath = `/api/sessions/${encodeURIComponent(idOrRun)}`;
      if (tail === 'cover' && method === 'GET') {
        const file = url.searchParams.get('s') === 'thumb' ? await thumbFile(agent, idOrRun) : coverFile(agent, idOrRun);
        if (!file) throw new HttpError(404, 'This chat has no cover yet.', 'no_cover');
        const head = fs.readFileSync(file).subarray(0, 4);
        const png = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': png ? 'image/png' : 'image/jpeg', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'private, max-age=86400' });
        return fs.createReadStream(file).pipe(res);
      }
      if (tail === 'cover' && method === 'POST') {
        if (!getCoversEnabled(agent.name)) throw new HttpError(403, 'Cover images are turned off in Settings.', 'covers_off');
        if (coverFile(agent, idOrRun)) return sendJson(res, 200, { ok: true });
        const first = await agentJson(agent, `${sessionPath}/messages?limit=6&offset=0&order=oldest&inline_images=false`);
        const message = (first?.data ?? first?.messages ?? []).find((m) => m.role === 'user' && typeof m.content === 'string');
        return sendJson(res, 200, { ok: await makeCover(agent, idOrRun, message?.content) });
      }
      if (tail === 'preview' && method === 'GET') return sendJson(res, 200, await sessionPreview(agent, sessionPath, url.searchParams.get('full') === '1'));
      if (tail === 'messages' && method === 'GET') {
        const limit = clamp(url.searchParams.get('limit'), 1, 500, 200);
        const offset = clamp(url.searchParams.get('offset'), 0, 1_000_000, 0);
        const order = url.searchParams.get('order') === 'desc' ? 'latest' : 'oldest';
        return sendJson(res, 200, trimMessages(await agentJson(agent, `${sessionPath}/messages?limit=${limit}&offset=${offset}&order=${order}&inline_images=false`)));
      }
      if (tail === 'stream' && method === 'GET') {
        const run = findRun(agent.name, idOrRun);
        if (!run) throw new HttpError(404, 'No reply in progress.', 'no_run');
        res.writeHead(200, SSE_HEADERS);
        return attach(run, res);
      }
      if (!tail && method === 'GET') {
        const data = await agentJson(agent, sessionPath);
        const session = data?.session ?? data;
        const exact = lastPromptTokens(agent, idOrRun);
        const context = exact ? { tokens: exact, approx: false } : (getContext(agent.name, idOrRun) ?? (averagePrompt(session) ? { tokens: averagePrompt(session), approx: true } : null));
        await loadPrices(agent);
        const web_cost = estimateCost(session, priceOf(agent, session.model));
        return sendJson(res, 200, { ...data, session: { ...session, web_run: runInfo(agent.name, idOrRun), web_settings: getSettings(agent.name, idOrRun), web_context: context, web_cost } });
      }
      if (tail === 'rewind' && method === 'POST') {
        await webSession(agent, idOrRun);
        if (findRun(agent.name, idOrRun)) throw new HttpError(409, 'This chat already has a reply in progress.', 'run_in_progress');
        return sendJson(res, 200, await rewindLastTurn(agent, idOrRun));
      }
      if (!tail && method === 'PATCH') {
        await webSession(agent, idOrRun);
        const body = await readJson(req, 4096);
        if (typeof body.title !== 'string' || !body.title.trim()) throw new HttpError(400, 'Title is required.', 'bad_title');
        return sendJson(res, 200, await agentJson(agent, sessionPath, { method: 'PATCH', headers: json, body: JSON.stringify({ title: body.title.trim().slice(0, 200) }) }));
      }
      if (!tail && method === 'DELETE') {
        await webSession(agent, idOrRun);
        removeCover(agent, idOrRun);
        const remove = () => agentJson(agent, sessionPath, { method: 'DELETE' });
        const busy = new HttpError(409, 'A reply in this chat is still running or stuck. Press Stop first, or try again in a moment.', 'chat_busy');
        try {
          await remove();
        } catch (err) {
          if (err.code !== 'session_active_turn') throw err;
          // A turn still holds the chat (often one stuck retrying a failing provider): stop it, give it a moment to
          // let go, and try once more.
          const run = findRun(agent.name, idOrRun);
          if (!run?.runId) throw busy;
          await agentJson(agent, `/v1/runs/${run.runId}/stop`, { method: 'POST' }).catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 2500));
          try { await remove(); } catch (retry) { throw retry.code === 'session_active_turn' ? busy : retry; }
        }
        forgetSettings(agent.name, idOrRun);
        return sendJson(res, 200, { ok: true });
      }
    }
  }
  throw new HttpError(404, 'Not found.', 'not_found');
}

async function handle(req, res) {
  const started = Date.now();
  const url = new URL(req.url, 'http://local');
  try {
    checkHost(req);
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/login' && req.method === 'POST') return await login(req, res);
      // A Hermes worker pushes stories with its own bearer token (no browser session, no cookie).
      if (url.pathname === '/api/fresh/ingest' && req.method === 'POST') return await freshIngest(req, res);
      if (url.pathname === '/api/fresh/bootstrap' && ['GET', 'POST'].includes(req.method)) return await freshBootstrap(req, res, url);
      const session = currentSession(req);
      if (!session) throw new HttpError(401, 'Authentication required.', 'unauthorized');
      if (!['GET', 'HEAD'].includes(req.method)) {
        checkOrigin(req);
        // The service worker has no CSRF token (it never reads the page) and /api/push/ack only writes a log line, so it
        // is exempt. Origin is still checked above.
        if (url.pathname !== '/api/push/ack' && !sameConstant(req.headers['x-csrf-token'], session.csrf)) throw new HttpError(403, 'Invalid CSRF token.', 'bad_csrf');
      }
      return await apiRoute(req, res, url, session);
    }
    const artifact = /^\/artifact\/([a-f0-9]{24})$/.exec(url.pathname);
    if (artifact) {
      if (!currentSession(req)) throw new HttpError(401, 'Authentication required.', 'unauthorized');
      return serveArtifact(res, artifact[1]);
    }
    return serveStatic(req, res, url.pathname, currentSession(req));
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    sendError(res, error);
  } finally {
    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
  }
}

const servers = [];
function listen(host, port, onListening) {
  const server = http.createServer(handle);
  server.on('error', (error) => {
    console.error(`[hermes-web] failed to listen on ${host}:${port} (${error.code}); retrying in 10s`);
    setTimeout(() => listen(host, port, onListening), 10_000).unref();
  });
  server.listen(port, host, () => {
    servers.push(server);
    const bound = server.address().port;
    console.log(`[hermes-web] http://${host}:${bound}`);
    onListening(server, bound);
  });
}

// Starts the app. Used by `node server.js` (see the main guard below) and by tests, which can start it in-process.
// Options: port (default config.port; 0 = any free port), hosts (default config.hosts), fresh (default: unless HERMES_WEB_FRESH_OFF=1).
// Resolves with { servers, port, close } once every host is listening.
export async function start(options = {}) {
  const authFile = path.join(config.dataDir, 'auth-record.json');
  if (!fs.existsSync(authFile)) throw new Error('No login credentials yet. Run first: npm run set-password');
  auth = createAuthenticator({
    record: readAuthRecord(authFile),
    stateFile: path.join(config.dataDir, 'login-state.json'),
    recoveryFile: path.join(config.dataDir, 'recovery-codes.json'),
  });
  sessions = createSessionStore({ file: sessionFile(config.dataDir), days: config.sessionDays, maxAgeDays: config.sessionMaxAgeDays });
  const hosts = options.hosts ?? config.hosts;
  const wanted = options.port ?? config.port;
  const ports = await Promise.all(hosts.map((host) => new Promise((resolve) => listen(host, wanted, (_server, bound) => resolve(bound)))));
  const runFresh = options.fresh ?? process.env.HERMES_WEB_FRESH_OFF !== '1';
  if (runFresh) try { startFresh(getAgent(config.agentNames[0])); } catch (err) { console.warn(`[hermes-web] Fresh feed not started: ${err.message}`); }
  return {
    servers: [...servers], port: ports[0],
    close: () => Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }))),
  };
}

// Main guard: only `node server.js` starts the app on import; tests import `start` and call it themselves.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { await start(); } catch (error) { console.error(error.message); process.exit(1); }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
}
