// Secret references: env, agentEnv, file (plain and JSON with #field), refusals, and no
// secret value in any error message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '../helpers/env.js';
import { resolveSecret } from '../../src/config/secrets.js';

const env = { TEST_TOKEN: 'from-env' };
const agentEnv = (name) => (name === 'GATEWAY_API_KEY' ? 'from-agent' : null);

test('env: reads the injected environment', () => {
  assert.equal(resolveSecret('env:TEST_TOKEN', { dataDir, env }), 'from-env');
  assert.equal(resolveSecret('env:MISSING', { dataDir, env }), null);
});

test('agentEnv: delegates to the profile reader', () => {
  assert.equal(resolveSecret('agentEnv:GATEWAY_API_KEY', { dataDir, env, agentEnv }), 'from-agent');
  assert.equal(resolveSecret('agentEnv:MISSING', { dataDir, env, agentEnv }), null);
  assert.equal(resolveSecret('agentEnv:MISSING', { dataDir, env }), null);
});

test('file: reads trimmed plain text, and a JSON field with #field', () => {
  fs.writeFileSync(path.join(dataDir, 'plain-key'), '  plain-secret \n');
  fs.writeFileSync(path.join(dataDir, 'github.json'), JSON.stringify({ token: ' json-secret ', other: 1 }));
  assert.equal(resolveSecret('file:plain-key', { dataDir }), 'plain-secret');
  assert.equal(resolveSecret('file:github.json#token', { dataDir }), 'json-secret');
  assert.equal(resolveSecret('file:github.json#other', { dataDir }), null, 'only string fields resolve');
  assert.equal(resolveSecret('file:missing', { dataDir }), null);
  assert.equal(resolveSecret('file:missing.json#token', { dataDir }), null);
});

test('file: paths must stay inside the data directory', () => {
  assert.throws(() => resolveSecret('file:../outside', { dataDir }), /not allowed/);
  assert.throws(() => resolveSecret('file:a/../../outside', { dataDir }), /not allowed/);
  assert.throws(() => resolveSecret('file:/etc/passwd', { dataDir }), /not allowed/);
  assert.throws(() => resolveSecret('file:..\\outside', { dataDir }), /not allowed/);
  fs.mkdirSync(path.join(dataDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'nested', 'key'), 'nested-secret');
  assert.equal(resolveSecret('file:nested/key', { dataDir }), 'nested-secret');
});

test('file: a symlink may not point outside the data directory', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-outside-'));
  process.on('exit', () => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret'), 'outside-secret');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(dataDir, 'link-to-outside'));
  assert.throws(() => resolveSecret('file:link-to-outside', { dataDir }), /outside the data directory/);
});

test('a literal is refused unless allowInline is true', () => {
  assert.throws(() => resolveSecret('sk-literal', { dataDir }), /literal secret is not allowed/);
  assert.equal(resolveSecret('sk-literal', { dataDir, allowInline: true }), 'sk-literal');
  assert.throws(() => resolveSecret('', { dataDir }), /non-empty/);
  assert.throws(() => resolveSecret(null, { dataDir }), /non-empty/);
});

test('an error never contains the secret value', () => {
  const secret = 'super-secret-value-do-not-leak';
  fs.writeFileSync(path.join(dataDir, 'broken.json'), `{"token": "${secret}",`);
  const messages = [];
  for (const ref of [secret, `file:../${secret}`, 'file:broken.json#token']) {
    try {
      resolveSecret(ref, { dataDir });
    } catch (error) {
      messages.push(error.message);
    }
  }
  assert.equal(messages.length, 3);
  for (const message of messages) assert.ok(!message.includes(secret), `leaked in: ${message}`);
});
