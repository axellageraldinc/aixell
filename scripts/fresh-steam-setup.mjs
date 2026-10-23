#!/usr/bin/env node
// Copies STEAM_ID / STEAM_API_KEY from Aurora's .env into data/steam.json ({ steam_id, api_key }, mode 600) for Fresh.
// Prints only whether it worked and the lengths, never the values. Respects HERMES_WEB_DATA_DIR; AURORA_ENV overrides the source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.HERMES_WEB_DATA_DIR || path.join(root, 'data');
const source = process.env.AURORA_ENV || path.join(os.homedir(), '.hermes', 'profiles', 'aurora', '.env');

const env = {};
for (const line of fs.readFileSync(source, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
if (!env.STEAM_ID || !env.STEAM_API_KEY) { console.error('STEAM_ID / STEAM_API_KEY not found in the source .env'); process.exit(1); }
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const file = path.join(dataDir, 'steam.json');
fs.writeFileSync(file, JSON.stringify({ steam_id: env.STEAM_ID, api_key: env.STEAM_API_KEY }, null, 2), { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log(`ok: wrote ${file} (steam_id ${env.STEAM_ID.length} chars, api_key ${env.STEAM_API_KEY.length} chars)`);
