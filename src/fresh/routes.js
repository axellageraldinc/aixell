import fs from 'node:fs';
import crypto from 'node:crypto';
import { HttpError, SECURITY_HEADERS, readJson, sendJson } from '../http.js';
import { CATEGORIES } from './feeds.js';
import { ingest as ingestConnector } from '../connectors/ingest.js';
import * as glossary from './glossary.js';
import { actOn, addSource, bootstrapProgress, runBootstrap, feedbackOn, forgetTopic, freshStatus, getFreshSettings, hasImage, imageFile, ingest, ingestToken, listFresh, localeInfo, markSeen, pollFresh, readerOf, refreshNow, removeSource, setFreshSettings, signalOn, sourcesView, toggleSource, topicsView } from './index.js';

const ID = /^[a-f0-9]{16}$/;
const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Items are sent with a weak ETag of their body: an app that is only checking for news gets a 304 and nothing else.
function sendTagged(req, res, payload) {
  const body = JSON.stringify(payload);
  const etag = `W/"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 20)}"`;
  const headers = { ...SECURITY_HEADERS, ETag: etag, 'Cache-Control': 'private, no-cache' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  return res.end(body);
}

// A Hermes worker posts what it found with the ingest token (not a browser session): POST /api/fresh/ingest
export async function freshIngest(req, res) {
  const header = String(req.headers.authorization ?? '');
  if (!header.startsWith('Bearer ') || !same(header.slice(7), ingestToken())) throw new HttpError(401, 'Invalid ingest token.', 'unauthorized');
  const body = await readJson(req, 512 * 1024);
  return sendJson(res, 200, await ingest(ingestConnector.normalize(ingestConnector.itemsOf(body))));
}

// One-off "run everything now" with the same bearer token (no browser session): POST starts it and answers 202 at once with the job,
// GET returns its progress. ?force=1 skips the once-per-24-hours guard. It runs inside this process (see bootstrap.js).
export async function freshBootstrap(req, res, url) {
  const header = String(req.headers.authorization ?? '');
  if (!header.startsWith('Bearer ') || !same(header.slice(7), ingestToken())) throw new HttpError(401, 'Invalid ingest token.', 'unauthorized');
  if (req.method === 'GET') {
    const job = bootstrapProgress();
    if (!job) throw new HttpError(404, 'No bootstrap has run yet.', 'no_job');
    return sendJson(res, 200, { job });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.', 'bad_method');
  const out = runBootstrap({ force: url.searchParams.get('force') === '1' });
  if (out.busy) throw new HttpError(409, 'A bootstrap is already running.', 'bootstrap_running', { job: out.busy });
  if (out.recent) throw new HttpError(429, 'A bootstrap already ran in the last 24 hours. Use ?force=1 to run it again.', 'bootstrap_recent', { nextAt: out.recent });
  return sendJson(res, 202, { job: out.job });
}

// Every other /api/fresh/... route (the caller has already checked the session and, for writes, the CSRF token).
export async function freshRoute(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'fresh', a, b]
  const [, , a, b] = parts;
  const method = req.method;

  if (!a && method === 'GET') {
    const cat = url.searchParams.get('cat') ?? '';
    const mode = url.searchParams.get('mode') === 'latest' ? 'latest' : 'foryou';
    return sendTagged(req, res, listFresh({ cat, mode, saved: url.searchParams.get('saved') === '1', cursor: (url.searchParams.get('cursor') ?? '').slice(0, 60), limit: Number(url.searchParams.get('limit')) || 12 }));
  }
  if (a === 'poll' && method === 'GET') return sendJson(res, 200, pollFresh(Number(url.searchParams.get('since')) || 0));
  if (a === 'status' && method === 'GET') return sendJson(res, 200, freshStatus());
  // Never waits for gathering: wakes the worker and answers at once (X is never called from here).
  if (a === 'refresh' && method === 'POST') return sendJson(res, 200, refreshNow());
  if (a === 'seen' && method === 'POST') {
    const body = await readJson(req, 8192);
    return sendJson(res, 200, markSeen(body.ids));
  }
  if (a === 'img' && method === 'GET' && ID.test(b ?? '')) {
    if (!hasImage(b)) throw new HttpError(404, 'No picture.', 'no_image');
    const file = imageFile(b);
    if (!fs.existsSync(file)) throw new HttpError(404, 'No picture.', 'no_image');
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/jpeg', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'private, max-age=604800, immutable' });
    return fs.createReadStream(file).pipe(res);
  }
  if (a === 'settings' && method === 'GET') return sendJson(res, 200, { ...getFreshSettings(), sources: sourcesView(), categories: CATEGORIES, topics: topicsView(), ingest: { url: '/api/fresh/ingest' }, ...localeInfo() });
  if (a === 'settings' && method === 'PUT') {
    const body = await readJson(req, 4096);
    if (body.catOrder !== undefined && !Array.isArray(body.catOrder)) throw new HttpError(400, 'catOrder must be a list.', 'bad_order');
    setFreshSettings({ enabled: body.enabled, intervalMin: Number(body.intervalMin), x: body.x, catOrder: body.catOrder, notify: body.notify, llmPerMin: Number(body.llmPerMin) });
    return sendJson(res, 200, getFreshSettings());
  }
  if (a === 'glossary' && !b && method === 'GET') return sendJson(res, 200, { entries: glossary.entries() });
  if (a === 'glossary' && b && method === 'PUT') {
    const body = await readJson(req, 2048);
    try { return sendJson(res, 200, glossary.setDecision(decodeURIComponent(b), body.decision, { form: typeof body.form === 'string' ? body.form : '', bad: body.bad })); }
    catch (err) { throw new HttpError(400, err.message, 'bad_term'); }
  }
  if (a === 'ingest-token' && method === 'GET') return sendJson(res, 200, { token: ingestToken() });
  if (a === 'sources' && method === 'POST') {
    const body = await readJson(req, 4096);
    if (typeof body.url !== 'string' || body.url.trim().length < 3) throw new HttpError(400, 'A feed address is required.', 'bad_source');
    try { return sendJson(res, 200, await addSource({ url: body.url, cat: body.cat, name: typeof body.name === 'string' ? body.name : '' })); }
    catch (err) { throw new HttpError(400, `Could not add the source: ${err.message}`, 'bad_source'); }
  }
  if (a === 'sources' && method === 'PATCH' && b) {
    const body = await readJson(req, 1024);
    if (!toggleSource(b, Boolean(body.on))) throw new HttpError(404, 'Source not found.', 'no_source');
    return sendJson(res, 200, { ok: true });
  }
  if (a === 'sources' && method === 'DELETE' && b) {
    if (!removeSource(b)) throw new HttpError(404, 'Only sources you added yourself can be removed.', 'no_source');
    return sendJson(res, 200, { ok: true });
  }
  if (a === 'topics' && method === 'DELETE' && b) { forgetTopic(decodeURIComponent(b)); return sendJson(res, 200, { ok: true }); }

  if (ID.test(a ?? '')) {
    if (b === 'reader' && method === 'GET') {
      const out = await readerOf(a);
      if (!out) throw new HttpError(404, 'Item not found.', 'no_item');
      return sendJson(res, 200, out);
    }
    if (b === 'feedback' && method === 'POST') {
      const body = await readJson(req, 1024);
      const out = feedbackOn(a, body.kind);
      if (!out) throw new HttpError(404, 'Item not found.', 'no_item');
      return sendJson(res, 200, out);
    }
    if (b === 'signal' && method === 'POST') {
      const body = await readJson(req, 1024);
      const out = signalOn(a, body.kind, body.ms);
      if (!out) throw new HttpError(400, 'Unknown signal, or the item does not exist.', 'bad_signal');
      if (out.limited) throw new HttpError(429, 'Too many signals.', 'rate_limited');
      return sendJson(res, 200, out);
    }
    if (['save', 'unsave', 'hide', 'read'].includes(b) && method === 'POST') {
      const out = actOn(a, b);
      if (!out) throw new HttpError(404, 'Item not found.', 'no_item');
      return sendJson(res, 200, out);
    }
  }
  throw new HttpError(404, 'Not found.', 'not_found');
}
