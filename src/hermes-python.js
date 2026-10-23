import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { HttpError } from './http.js';

// Runs one of src/*.py with Hermes' own Python, so it can use Hermes' code (session database, memory plugin) instead of
// poking at its SQLite files. The script gets the profile home as argv[1]; JSON goes in on stdin and comes out on stdout.
const AGENT_DIR = path.join(config.hermesRoot, 'hermes-agent');
const TIMEOUT_MS = 45_000;
const here = path.dirname(new URL(import.meta.url).pathname);

function hermesPython() {
  const dir = path.join(config.hermesRoot, 'tools');
  const found = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^python-/.test(n)).sort().reverse() : [];
  for (const name of found) {
    const candidate = path.join(dir, name, 'bin', 'python3');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function runHermesScript(script, args, input = null) {
  const python = hermesPython();
  if (!python) throw new HttpError(501, 'Hermes Python was not found.', 'no_python');
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: os.homedir(), HERMES_AGENT_DIR: AGENT_DIR, HERMES_PLUGINS_DIR: path.join(config.hermesRoot, 'plugins') };
    const child = spawn(python, ['-I', path.join(here, script), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new HttpError(504, 'The Hermes helper timed out.', 'helper_timeout')); }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { reject(new HttpError(502, `Hermes helper failed: ${err.trim().split('\n').pop() || 'no output'}`.slice(0, 300), 'helper_failed')); }
    });
    child.stdin.end(input == null ? '' : JSON.stringify(input));
  });
}
