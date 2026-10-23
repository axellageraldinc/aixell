// For unit tests that import lib modules directly: points the app's data directory at a fresh temp dir and turns the
// Fresh network paths off. Import this file before any lib module (src/config.js reads the environment once, at import).
import './fetch-guard.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-web-unit-'));
process.env.HERMES_WEB_DATA_DIR = dataDir;
process.env.HERMES_WEB_FRESH_OFFLINE = '1';
process.env.HERMES_ROOT = path.join(dataDir, 'hermes-root');
// An empty config file: a developer's own config.json in the repo root must not change what the unit tests see.
process.env.HERMES_WEB_CONFIG = path.join(dataDir, 'config.json');
fs.writeFileSync(process.env.HERMES_WEB_CONFIG, '{}\n');
process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));
