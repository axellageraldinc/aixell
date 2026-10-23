import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './http.js';

// Spending limits in the provider's billing currency (0 = off): per chat and per day. The web app asks before sending when a limit is reached.
const file = path.join(config.dataDir, 'budget.json');
const MAX = 100_000_000;
let store = {};
try { store = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run */ }

const clean = (agentName) => ({ perChat: store[agentName]?.perChat ?? 0, perDay: store[agentName]?.perDay ?? 0 });

export const getBudget = clean;

export function setBudget(agentName, body) {
  const next = {};
  for (const key of ['perChat', 'perDay']) {
    const value = Number(body?.[key] ?? 0);
    if (!Number.isFinite(value) || value < 0 || value > MAX) throw new HttpError(400, 'The limit must be 0 or more (0 = off).', 'bad_budget');
    next[key] = Math.round(value);
  }
  store[agentName] = next;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(temporary, file);
  return next;
}
