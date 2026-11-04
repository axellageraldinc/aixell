// Chats that belong to the aixell browser extension. A chat started from the extension panel is tied to one extension session and gets a
// private key; the agent has to send that key with every browser tool call, and the key only opens that session. Chats without a key
// cannot use the browser at all. Keys live in data/ext-chats.json (0600), never in the repository or in a reply.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = () => path.join(config.dataDir, 'ext-chats.json');
let cache = null;
const sameConstant = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { cache = { chats: {} }; }
  if (!cache.chats || typeof cache.chats !== 'object') cache = { chats: {} };
  return cache;
}
function persist() {
  const temporary = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 });
  fs.renameSync(temporary, file());
}

export const newKey = () => `aixk_${crypto.randomBytes(32).toString('base64url')}`;
export const KEY_PATTERN = /aixk_[A-Za-z0-9_-]{20,}/g;

const SESSION_REF = /^[A-Za-z0-9_-]{1,40}$/;
const cleanName = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

// The extension tells the page which of its sessions is selected; the page sends it with every request.
export function extSessionOf(headers) {
  const ref = String(headers['x-aixell-ext-session'] ?? '');
  if (!SESSION_REF.test(ref)) return null;
  let name = '';
  try { name = cleanName(decodeURIComponent(String(headers['x-aixell-ext-session-name'] ?? ''))); } catch { name = ''; }
  return { ref, name: name || ref };
}

export const bindingOf = (agent, sessionId) => load().chats[`${agent}:${sessionId}`] ?? null;

// Ties a chat to an extension session the first time it is used from the extension. Never changes an existing binding.
export function bind(agent, sessionId, ext) {
  const existing = bindingOf(agent, sessionId);
  if (existing) return existing;
  const entry = { key: newKey(), sessionRef: ext.ref, sessionName: ext.name, createdAt: Date.now() };
  load().chats[`${agent}:${sessionId}`] = entry;
  persist();
  return entry;
}

export function byKey(key) {
  if (typeof key !== 'string' || !key.startsWith('aixk_') || key.length > 100) return null;
  for (const [id, entry] of Object.entries(load().chats)) if (sameConstant(entry.key, key)) return { id, ...entry };
  return null;
}

export function forget(agent, sessionId) {
  if (delete load().chats[`${agent}:${sessionId}`]) persist();
}
export const _reset = () => { cache = null; };
