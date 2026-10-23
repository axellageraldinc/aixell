// set-password script: non-interactive mode into a temp data dir (offline, no TTY).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'set-password.js');
const run = (args, input, dataDir) => spawnSync(process.execPath, [SCRIPT, ...args], {
  input, encoding: 'utf8', env: { ...process.env, HERMES_WEB_DATA_DIR: dataDir },
});

test('--password-stdin creates the data dir, record and recovery codes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setpw-'));
  const dataDir = path.join(tmp, 'nested', 'data');
  const out = run(['--password-stdin'], 'correct horse battery\n', dataDir);
  assert.equal(out.status, 0, out.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth-record.json'), 'utf8'));
  assert.equal(record.username, 'admin');
  assert.match(record.totpSecret, /^[A-Z2-7]{32}$/);
  assert.equal(record.recoveryHashes.length, 5);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'recovery-codes.json'), 'utf8')), { used: [] });
  assert.match(out.stdout, /otpauth:\/\/totp\//);
  assert.match(out.stdout, /Username: admin/);
  assert.ok(!out.stdout.includes('correct horse'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('--user and --file are honoured; recovery codes sit next to the record', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setpw-'));
  const file = path.join(tmp, 'sub', 'rec.json');
  const out = run(['--password-stdin', '--user', 'reader', '--file', file], 'pw-1234567890-long', path.join(tmp, 'unused'));
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).username, 'reader');
  assert.ok(fs.existsSync(path.join(tmp, 'sub', 'recovery-codes.json')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('without a TTY and without --password-stdin it fails clearly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setpw-'));
  const out = run([], '', tmp);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /--password-stdin/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
