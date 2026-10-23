// src/config.js still exports exactly what it did before P5a (plus appName only when set),
// and its values still come from the environment when no config file exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '../helpers/env.js';
import { config, EFFORT_LEVELS, SERVICE_TIERS } from '../../src/config.js';
import { loadConfig } from '../../src/config/loader.js';

const shape = (object) => Object.fromEntries(Object.entries(object).map(([key, value]) => {
  if (value instanceof Set) return [key, 'Set'];
  if (Array.isArray(value)) return [key, 'array'];
  return [key, typeof value];
}));

test('config shape snapshot', () => {
  assert.deepEqual(shape(config), {
    root: 'string',
    dataDir: 'string',
    publicDir: 'string',
    port: 'number',
    hosts: 'array',
    allowedHostnames: 'Set',
    hermesRoot: 'string',
    agentNames: 'array',
    sessionDays: 'number',
    sessionMaxAgeDays: 'number',
    cookieSecure: 'boolean',
    trustCloudflare: 'boolean',
    orphanStopMinutes: 'number',
    timezone: 'string',
    fresh: 'object',
    uploadMaxBytes: 'number',
    textInlineMaxBytes: 'number',
    jsonBodyMaxBytes: 'number',
  });
});

test('EFFORT_LEVELS and SERVICE_TIERS are unchanged', () => {
  assert.deepEqual(EFFORT_LEVELS, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(SERVICE_TIERS, ['default', 'priority']);
});

test('the test environment is reflected in config', () => {
  assert.equal(config.dataDir, dataDir);
  assert.equal(config.hermesRoot, path.join(dataDir, 'hermes-root'));
  assert.deepEqual(config.hosts, ['127.0.0.1']);
  assert.equal(config.port, 8300, 'an empty config file in the temp dir, not the repo one');
});

test('the same environment without a config file gives the same values as the old reader', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-shape-'));
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    HERMES_WEB_PORT: '8300',
    HERMES_WEB_HOSTS: '127.0.0.1',
    HERMES_WEB_AGENTS: 'test-agent',
    HERMES_ROOT: path.join(root, 'hermes'),
    HERMES_WEB_DATA_DIR: path.join(root, 'data'),
  };
  const { config: loaded } = loadConfig({ root, env });
  // The pre-P5a expressions, evaluated with the same environment.
  assert.equal(loaded.port, Number(env.HERMES_WEB_PORT || 8300));
  assert.deepEqual(loaded.hosts, env.HERMES_WEB_HOSTS.split(',').map((item) => item.trim()).filter(Boolean));
  assert.deepEqual(loaded.agentNames, env.HERMES_WEB_AGENTS.split(',').map((item) => item.trim()).filter(Boolean));
  assert.equal(loaded.hermesRoot, env.HERMES_ROOT);
  assert.equal(loaded.dataDir, env.HERMES_WEB_DATA_DIR);
  assert.equal(loaded.cookieSecure, false);
  assert.equal(loaded.trustCloudflare, false);
  assert.equal(loaded.sessionDays, 30);
  assert.equal(loaded.orphanStopMinutes, 20);
});
