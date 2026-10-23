// src/auth.js: TOTP, password record, and the login rate limiter (with a fast fake key derivation and a controllable clock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/fetch-guard.js';
import { createAuthenticator, hashPassword, readAuthRecord, verifyTotp } from '../../src/auth.js';
import { totp } from '../helpers/totp.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

test('verifyTotp matches the independent implementation and tolerates one step of drift', () => {
  const at = Date.UTC(2026, 9, 22, 12, 0, 0);
  assert.equal(verifyTotp(SECRET, totp(SECRET, at), at), true);
  assert.equal(verifyTotp(SECRET, totp(SECRET, at - 30_000), at), true);
  assert.equal(verifyTotp(SECRET, totp(SECRET, at + 30_000), at), true);
  assert.equal(verifyTotp(SECRET, totp(SECRET, at - 90_000), at), false);
});

test('verifyTotp rejects malformed input', () => {
  const at = Date.now();
  for (const code of ['', '12345', '1234567', 'abcdef', undefined, null]) assert.equal(verifyTotp(SECRET, code, at), false);
  assert.equal(verifyTotp('not base32 !!', '123456', at), false);
  assert.equal(verifyTotp(undefined, '123456', at), false);
});

test('verifyTotp RFC 6238 vector (SHA-1, T=59 s, 8 digits)', () => {
  const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  assert.equal(verifyTotp(rfcSecret, '94287082', 59_000, { digits: 8, skew: 0 }), true);
});

test('hashPassword validates the username and password length', async () => {
  await assert.rejects(() => hashPassword('bad name!', 'long enough password'));
  await assert.rejects(() => hashPassword('user', 'short'));
  const record = await hashPassword('user', 'long enough password');
  assert.match(record.salt, /^[a-f0-9]{64}$/);
  assert.match(record.hash, /^[a-f0-9]{64}$/);
});

test('readAuthRecord insists on a regular file with restricted permissions and a valid shape', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-web-auth-'));
  try {
    const record = { ...(await hashPassword('user', 'long enough password')), totpSecret: SECRET };
    const file = path.join(dir, 'auth-record.json');
    fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    assert.equal(readAuthRecord(file).username, 'user');
    fs.chmodSync(file, 0o666);
    assert.throws(() => readAuthRecord(file), /restricted permissions/);
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify({ ...record, totpSecret: 'lowercase-not-base32' }), { mode: 0o600 });
    assert.throws(() => readAuthRecord(file), /TOTP/);
    fs.writeFileSync(file, JSON.stringify({ ...record, N: 1024 }), { mode: 0o600 });
    assert.throws(() => readAuthRecord(file), /Invalid/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A cheap stand-in for scrypt so the rate-limit tests do not spend a second per attempt.
const derive = async (password, salt) => crypto.createHash('sha256').update(password).update(salt).digest();
function fixture() {
  const salt = crypto.randomBytes(32);
  const record = { username: 'user', salt: salt.toString('hex'), hash: crypto.createHash('sha256').update('right password').update(salt).digest('hex'), totpSecret: SECRET };
  const clock = { t: 1_000_000 };
  return { clock, auth: createAuthenticator({ record, derive, now: () => clock.t }) };
}

test('verify: right password passes, wrong password or username fails', async () => {
  const { auth } = fixture();
  assert.deepEqual(await auth.verify('user', 'right password', 'client-a'), { ok: true });
  assert.deepEqual(await auth.verify('user', 'wrong', 'client-a'), { ok: false });
  assert.deepEqual(await auth.verify('other', 'right password', 'client-a'), { ok: false });
});

test('verify: a client is locked out after 5 attempts for 15 minutes, other clients are not', async () => {
  const { auth, clock } = fixture();
  for (let i = 0; i < 5; i += 1) assert.equal((await auth.verify('user', 'wrong', 'client-a')).retryAfter, undefined);
  const locked = await auth.verify('user', 'right password', 'client-a');
  assert.equal(locked.ok, false);
  assert.ok(locked.retryAfter > 800 && locked.retryAfter <= 900, `retryAfter ${locked.retryAfter}`);
  assert.equal((await auth.verify('user', 'right password', 'client-b')).ok, true);
  clock.t += 15 * 60_000 + 1;
  assert.equal((await auth.verify('user', 'right password', 'client-a')).ok, true);
});

test('verify: a successful login clears that client\'s counter', async () => {
  const { auth } = fixture();
  for (let i = 0; i < 4; i += 1) await auth.verify('user', 'wrong', 'c');
  auth.clearAttempts('c');
  for (let i = 0; i < 4; i += 1) assert.equal((await auth.verify('user', 'wrong', 'c')).retryAfter, undefined);
});

test('verify: 30 attempts from many clients lock everyone out', async () => {
  const { auth } = fixture();
  for (let i = 0; i < 30; i += 1) await auth.verify('user', 'wrong', `client-${i}`);
  const result = await auth.verify('user', 'right password', 'brand-new-client');
  assert.equal(result.ok, false);
  assert.ok(result.retryAfter > 0);
});

test('verifySecondFactor accepts a TOTP code, and a recovery code only once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-web-auth-'));
  try {
    const recoveryFile = path.join(dir, 'recovery.json');
    const code = 'ABCDEF123456';
    const record = { username: 'user', salt: 'a'.repeat(64), hash: 'b'.repeat(64), totpSecret: SECRET, recoveryHashes: [crypto.createHash('sha256').update(code).digest('hex')] };
    const auth = createAuthenticator({ record, recoveryFile, derive });
    assert.equal(auth.verifySecondFactor(totp(SECRET)), true);
    assert.equal(auth.verifySecondFactor('000000'), false);
    assert.equal(auth.verifySecondFactor('abcdef-123456'), true, 'case and dashes do not matter');
    assert.equal(auth.verifySecondFactor(code), false, 'second use is refused');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the fixture record used by the test apps matches the documented test credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-web-auth-'));
  const file = path.join(dir, 'auth-record.json');
  fs.copyFileSync(new URL('../fixtures/auth-record.json', import.meta.url), file);
  fs.chmodSync(file, 0o600);
  const record = readAuthRecord(file);
  fs.rmSync(dir, { recursive: true, force: true });
  const auth = createAuthenticator({ record });
  assert.deepEqual(await auth.verify('tester', 'correct horse battery staple', 'fixture-check'), { ok: true });
  assert.equal(record.totpSecret, SECRET);
});
