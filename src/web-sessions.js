import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86_400_000;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Login sessions live server-side (revocable). Only the sha256 of the cookie token is stored.
export function createSessionStore({ file, days, maxAgeDays, now = Date.now }) {
  let sessions = {};
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved.sessions === 'object') sessions = saved.sessions;
  }

  function persist() {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ sessions }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  function prune() {
    const at = now();
    let changed = false;
    for (const [key, entry] of Object.entries(sessions)) {
      if (entry.expiresAt <= at || entry.createdAt + maxAgeDays * DAY <= at) { delete sessions[key]; changed = true; }
    }
    if (changed) persist();
  }
  prune();

  return {
    create({ ip, userAgent }) {
      prune();
      const token = crypto.randomBytes(32).toString('base64url');
      const entry = {
        csrf: crypto.randomBytes(24).toString('base64url'),
        createdAt: now(), expiresAt: now() + days * DAY, lastRefresh: now(),
        ip: String(ip || '').slice(0, 64), userAgent: String(userAgent || '').slice(0, 200),
      };
      sessions[sha(token)] = entry;
      persist();
      return { token, ...entry };
    },
    // Sliding window: each use pushes expiry out to `days`, capped by the absolute max age.
    get(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const key = sha(token);
      const entry = sessions[key];
      if (!entry) return null;
      const at = now();
      if (entry.expiresAt <= at || entry.createdAt + maxAgeDays * DAY <= at) { delete sessions[key]; persist(); return null; }
      if (at - entry.lastRefresh > 3_600_000) {
        entry.lastRefresh = at;
        entry.expiresAt = Math.min(at + days * DAY, entry.createdAt + maxAgeDays * DAY);
        persist();
      }
      return entry;
    },
    destroy(token) {
      if (typeof token === 'string' && delete sessions[sha(token)]) persist();
    },
    destroyAll() {
      sessions = {};
      persist();
    },
  };
}

export const sessionFile = (dataDir) => path.join(dataDir, 'web-sessions.json');
