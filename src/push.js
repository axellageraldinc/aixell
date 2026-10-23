import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, settings } from './config/instance.js';
import { HttpError } from './http.js';

// Web Push without a library. The push carries no body (so no payload encryption is needed); the service worker, when
// woken, asks /api/push/last what finished. Subscriptions (one per device) live in data/push-subscriptions.json and
// the VAPID key pair that identifies this server to the push services in data/push-vapid.json (mode 600).
const keyFile = path.join(config.dataDir, 'push-vapid.json');
const subFile = path.join(config.dataDir, 'push-subscriptions.json');
const SUBJECT = settings.push.subject;
// Mirrors APP_NAME in public/lib/brand.js: notification titles shown by the service worker.
const APP_NAME = settings.appName || 'aixell';
// Only the real push services: the endpoint is a URL we will call, so an arbitrary one would be a way to make the
// server send requests anywhere.
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[\w.-]+\.push\.apple\.com|[\w.-]+\.notify\.windows\.com)$/;
export const MIN_SECONDS = [0, 30, 120];

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');

function loadKeys() {
  try {
    const saved = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    return { publicKey: saved.publicKey, privateKey: crypto.createPrivateKey({ key: saved.privateJwk, format: 'jwk' }) };
  } catch { /* first run */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  fs.writeFileSync(keyFile, JSON.stringify({ publicKey: b64u(raw), privateJwk: privateKey.export({ format: 'jwk' }) }), { mode: 0o600 });
  return { publicKey: b64u(raw), privateKey };
}
const keys = loadKeys();
export const publicKey = () => keys.publicKey;

let subs = [];
try { subs = JSON.parse(fs.readFileSync(subFile, 'utf8')).subs ?? []; } catch { /* none yet */ }
function persist() {
  const temporary = `${subFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ subs }), { mode: 0o600 });
  fs.renameSync(temporary, subFile);
}

function checkEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new HttpError(400, 'Bad push endpoint.', 'bad_endpoint'); }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.test(url.hostname)) throw new HttpError(400, 'That push service is not supported.', 'bad_endpoint');
  return url;
}

export function saveSubscription(endpoint, minSeconds) {
  checkEndpoint(endpoint);
  if (!MIN_SECONDS.includes(minSeconds)) throw new HttpError(400, 'Bad threshold.', 'bad_threshold');
  const existing = subs.find((s) => s.endpoint === endpoint);
  if (existing) existing.minSeconds = minSeconds;
  else subs.push({ endpoint, minSeconds, createdAt: Date.now() });
  persist();
}

export function removeSubscription(endpoint) {
  const before = subs.length;
  subs = subs.filter((s) => s.endpoint !== endpoint);
  if (subs.length !== before) persist();
}

export const subscriptionCount = () => subs.length;
export const hasSubscription = (endpoint) => subs.some((s) => s.endpoint === endpoint);

function vapidHeader(url) {
  const claims = { aud: url.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT };
  const input = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify(claims))}`;
  const signature = crypto.sign('sha256', Buffer.from(input), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(signature)}, k=${keys.publicKey}`;
}

async function send(sub) {
  const url = checkEndpoint(sub.endpoint);
  try {
    const res = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: vapidHeader(url), TTL: '300', Urgency: 'high', 'Content-Length': '0' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404 || res.status === 410) removeSubscription(sub.endpoint);
    // The push service answers 201 for "accepted": delivery to the device is its business after that. Logged because a
    // notification that never shows has to be traceable from here (accepted vs. expired subscription vs. rejected key).
    console.log(`[push] ${url.host} ${res.status}${res.ok ? '' : ` ${(await res.text().catch(() => '')).slice(0, 200)}`}`);
    return res.ok;
  } catch (error) {
    console.log(`[push] ${url.host} failed: ${error.name} ${error.message}`);
    return false;
  }
}

// What the service worker shows. Kept in memory: it only has to survive until the push that announces it is read.
// Persisted because a restart of this process between "reply finished" and "device asked what it was" used to answer
// `{}` and the service worker then showed the generic text — or, with no payload at all, nothing.
let last = null;
const lastFile = path.join(config.dataDir, 'push-last.json');
try { last = JSON.parse(fs.readFileSync(lastFile, 'utf8')); } catch { /* nothing announced yet */ }
function remember(entry) {
  last = entry;
  try {
    const temporary = `${lastFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(last), { mode: 0o600 });
    fs.renameSync(temporary, lastFile);
  } catch { /* the in-memory copy still serves this process */ }
}
export const lastFinished = () => last;

// seconds: how long the reply took. Only devices whose threshold it reaches are pushed.
export async function notifyRunDone({ agentName, sessionId, title, seconds }) {
  remember({ heading: `${APP_NAME}: reply finished`, body: title || 'Open to see the answer.', url: `/#/${agentName}/${sessionId}`, at: Date.now() });
  const targets = subs.filter((s) => seconds >= s.minSeconds);
  await Promise.all(targets.map(send));
  return targets.length;
}

export async function sendTest(endpoint) {
  const sub = subs.find((s) => s.endpoint === endpoint);
  if (!sub) throw new HttpError(404, 'This device is not subscribed.', 'not_subscribed');
  // `test` tells the service worker to show this one even while the app is open in front of the user.
  remember({ heading: `${APP_NAME}: test notification`, body: 'If you can see this, reply-finished notifications are on.', url: '/', test: true, at: Date.now() });
  return send(sub);
}

// "Fresh: N new stories ready". Goes to every subscribed device (the reply threshold does not apply); `tag` makes a new one replace
// the previous Fresh banner. -> number of devices pushed.
export async function notifyFresh({ heading, body, url = '/#/home', tag = 'hermes-web-fresh' }) {
  if (!subs.length) return 0;
  remember({ heading, body, url, tag, at: Date.now() });
  await Promise.all(subs.map(send));
  return subs.length;
}
