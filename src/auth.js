import fs from 'node:fs';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
export const PASSWORD_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
export const constantEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function hashPassword(username, password) {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username) || typeof password !== 'string' || Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 256) throw new Error('Use a valid username and a password of 12–256 bytes.');
  const salt = crypto.randomBytes(32);
  const derived = await scrypt(password, salt, 32, PASSWORD_OPTIONS);
  return { version: 1, username, algorithm: 'scrypt', N: 131072, r: 8, p: 1, salt: salt.toString('hex'), hash: derived.toString('hex') };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(value) {
  const clean = String(value).toUpperCase().replace(/[\s=]/g, '');
  if (!clean.length || /[^A-Z2-7]/.test(clean)) throw new Error('Invalid base32');
  let bits = 0, current = 0;
  const out = [];
  for (const character of clean) {
    current = (current << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((current >> bits) & 0xff); }
  }
  return Buffer.from(out);
}

// RFC 6238 TOTP (SHA1 / 6 digits / 30s, ±1 step) for a pre-provisioned secret.
export function verifyTotp(secret, code, at = Date.now(), { step = 30, digits = 6, skew = 1 } = {}) {
  if (typeof secret !== 'string' || !new RegExp(`^\\d{${digits}}$`).test(code || '')) return false;
  let key;
  try { key = base32Decode(secret); } catch { return false; }
  const counter = Math.floor(at / 1000 / step);
  for (let drift = -skew; drift <= skew; drift++) {
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(counter + drift));
    const mac = crypto.createHmac('sha1', key).update(message).digest();
    const offset = mac[mac.length - 1] & 0x0f;
    const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
    if (constantEqual(String(value).padStart(digits, '0'), code)) return true;
  }
  return false;
}

export function readAuthRecord(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o027)) throw new Error('Login credentials require a regular file with restricted permissions (0600 or 0640).');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.version !== 1 || record.algorithm !== 'scrypt' || record.N !== 131072 || record.r !== 8 || record.p !== 1 || !/^[a-zA-Z0-9._-]{1,64}$/.test(record.username) || !/^[a-f0-9]{64}$/.test(record.salt) || !/^[a-f0-9]{64}$/.test(record.hash)) throw new Error('Invalid dashboard login configuration.');
  if (record.totpSecret !== undefined) {
    if (typeof record.totpSecret !== 'string' || !/^[A-Z2-7]{16,64}$/.test(record.totpSecret)) throw new Error('Invalid dashboard TOTP secret.');
    if (record.recoveryHashes !== undefined && (!Array.isArray(record.recoveryHashes) || !record.recoveryHashes.every(entry => /^[a-f0-9]{64}$/.test(entry)))) throw new Error('Invalid dashboard recovery hashes.');
  }
  return record;
}

export function createAuthenticator({ record, stateFile, recoveryFile, now = Date.now, derive = scrypt }) {
  const windowMs = 15 * 60 * 1000;
  const attempts = new Map();
  let global = { start: now(), count: 0 }, hashing = false;
  if (stateFile && fs.existsSync(stateFile)) {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); // Corrupt rate state fails startup closed.
    if (saved.global && Number.isFinite(saved.global.start) && Number.isInteger(saved.global.count)) global = saved.global;
    for (const [key, value] of (Array.isArray(saved.clients) ? saved.clients : []).slice(-512)) if (typeof key === 'string' && Number.isFinite(value?.start) && Number.isInteger(value?.count)) attempts.set(key, value);
  }
  function persist() {
    if (!stateFile) return;
    const temporary = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ global, clients: [...attempts] }), { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  }
  const clientKey = client => crypto.createHash('sha256').update(client).digest('hex');
  return {
    username: record.username,
    totpRequired: !!record.totpSecret,
    // Only call after every required factor has been verified.
    clearAttempts(client) {
      if (attempts.delete(clientKey(client))) persist();
    },
    // Second factor: pre-provisioned authenticator code, or a single-use recovery code.
    verifySecondFactor(code) {
      const raw = typeof code === 'string' ? code.trim() : '';
      if (verifyTotp(record.totpSecret, raw.replace(/\D/g, ''), now())) return true;
      const normalized = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (normalized.length < 10 || !Array.isArray(record.recoveryHashes) || !record.recoveryHashes.length || !recoveryFile) return false;
      const digest = crypto.createHash('sha256').update(normalized).digest('hex');
      if (!record.recoveryHashes.includes(digest)) return false;
      let used = [];
      try { const parsed = JSON.parse(fs.readFileSync(recoveryFile, 'utf8')); if (Array.isArray(parsed.used)) used = parsed.used.filter(entry => /^[a-f0-9]{64}$/.test(entry)); } catch { used = []; }
      if (used.includes(digest)) return false;
      used.push(digest);
      const temporary = `${recoveryFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ used }), { mode: 0o600 });
      fs.renameSync(temporary, recoveryFile);
      return true;
    },
    async verify(username, password, client) {
      const timestamp = now();
      if (timestamp - global.start >= windowMs || global.start > timestamp) global = { start: timestamp, count: 0 };
      for (const [key, value] of attempts) if (timestamp - value.start >= windowMs || value.start > timestamp) attempts.delete(key);
      const key = clientKey(client);
      const entry = attempts.get(key) || { start: timestamp, count: 0 };
      const wait = Math.max(entry.count >= 5 ? windowMs - (timestamp - entry.start) : 0, global.count >= 30 ? windowMs - (timestamp - global.start) : 0);
      if (wait > 0) return { ok: false, retryAfter: Math.ceil(wait / 1000) };
      if (hashing) return { ok: false, retryAfter: 2 };
      entry.count++; global.count++;
      if (attempts.size >= 512 && !attempts.has(key)) attempts.delete(attempts.keys().next().value);
      attempts.set(key, entry); persist();
      hashing = true;
      try {
        const validInput = typeof username === 'string' && Buffer.byteLength(username) <= 64 && typeof password === 'string' && Buffer.byteLength(password) <= 256;
        // Unknown usernames do the same expensive password calculation.
        const hash = await derive(validInput ? password : '', Buffer.from(record.salt, 'hex'), 32, PASSWORD_OPTIONS);
        const ok = validInput && constantEqual(hash.toString('hex'), record.hash) && constantEqual(username, record.username);
        return { ok };
      } finally { hashing = false; }
    },
  };
}
