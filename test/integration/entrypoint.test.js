// `node server.js` is what systemd runs: it must start, bind, and exit cleanly on SIGTERM; without credentials it must exit 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, boot } from '../helpers/boot.js';

test('without a login record it prints how to create one and exits with 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-web-empty-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, '{}\n');
  try {
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, HERMES_WEB_CONFIG: configFile, HERMES_WEB_DATA_DIR: dir, HERMES_WEB_PORT: '0', HERMES_WEB_HOSTS: '127.0.0.1', HERMES_ROOT: dir, HERMES_WEB_FRESH_OFF: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 1);
    assert.match(out, /npm run set-password/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('it logs the address it listens on and stops on SIGTERM', async () => {
  const app = await boot();
  try {
    assert.match(app.log(), /\[hermes-web\] http:\/\/127\.0\.0\.1:\d+/);
    assert.equal((await app.client().raw('GET', '/login.html')).status, 200);
  } finally { await app.stop(); }
  assert.equal(app.exited(), true, 'the process ended after SIGTERM');
});
