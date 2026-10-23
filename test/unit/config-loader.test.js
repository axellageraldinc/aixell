// The loader: comment stripping, file discovery, precedence (default < file < env), and
// validation errors reported together. Every case uses a temp root and an injected env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments, findConfigFile, loadConfig, defaults } from '../../src/config/loader.js';

const tempRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-config-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('comment stripper: // and /* */ go, markers inside strings stay', () => {
  const source = [
    '{',
    '  // a line comment',
    '  "url": "https://example.com/a//b", // trailing',
    '  "glob": "/* not a comment */",',
    '  /* block',
    '     comment */',
    '  "escaped": "quote \\" // still a string"',
    '}',
  ].join('\n');
  const parsed = JSON.parse(stripComments(source));
  assert.equal(parsed.url, 'https://example.com/a//b');
  assert.equal(parsed.glob, '/* not a comment */');
  assert.equal(parsed.escaped, 'quote " // still a string');
});

test('comment stripper: a comment at the very end and an unterminated block do not throw', () => {
  assert.equal(JSON.parse(stripComments('{"a":1} // done')).a, 1);
  assert.equal(JSON.parse(stripComments('{"a":1} /* open')).a, 1);
});

test('no file: neutral defaults apply', () => {
  const root = tempRoot();
  const { file, config, settings } = loadConfig({ root, env: {} });
  assert.equal(file, null);
  assert.deepEqual(config.hosts, ['127.0.0.1']);
  assert.deepEqual(config.agentNames, ['default']);
  assert.equal(config.port, 8300);
  assert.equal(settings.push.subject, 'mailto:admin@example.invalid');
  assert.equal(config.appName, undefined, 'no appName key unless configured');
});

test('config.json is found and read; config.jsonc is the fallback', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'config.jsonc'), '{ "server": { "port": 8401 } // comment\n}');
  assert.equal(findConfigFile({ root, env: {} }), path.join(root, 'config.jsonc'));
  assert.equal(loadConfig({ root, env: {} }).config.port, 8401);
  fs.writeFileSync(path.join(root, 'config.json'), '{ "server": { "port": 8402 } }');
  assert.equal(loadConfig({ root, env: {} }).config.port, 8402, 'config.json wins over config.jsonc');
});

test('HERMES_WEB_CONFIG overrides discovery and must exist', () => {
  const root = tempRoot();
  const other = path.join(root, 'elsewhere.json');
  fs.writeFileSync(other, '{ "server": { "port": 8500 } }');
  assert.equal(loadConfig({ root, env: { HERMES_WEB_CONFIG: other } }).config.port, 8500);
  assert.throws(() => findConfigFile({ root, env: { HERMES_WEB_CONFIG: path.join(root, 'nope.json') } }), /does not exist/);
});

test('precedence: default < file < env', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    server: { port: 8400, hosts: ['127.0.0.1', '10.0.0.5'], allowedHosts: ['file.example.com'], sessionDays: 14, cookieSecure: true },
    agents: ['from-file'],
    hermesRoot: '/tmp/from-file',
    push: { subject: 'mailto:file@example.invalid' },
  }));
  const { config } = loadConfig({ root, env: {} });
  assert.equal(config.port, 8400);
  assert.deepEqual(config.hosts, ['127.0.0.1', '10.0.0.5']);
  assert.ok(config.allowedHostnames.has('file.example.com'));
  assert.equal(config.sessionDays, 14);
  assert.equal(config.cookieSecure, true);
  assert.deepEqual(config.agentNames, ['from-file']);
  assert.equal(config.hermesRoot, '/tmp/from-file');

  const env = {
    HERMES_WEB_PORT: '8600',
    HERMES_WEB_HOSTS: '127.0.0.1,10.0.0.9',
    HERMES_WEB_ALLOWED_HOSTS: 'env.example.com',
    HERMES_WEB_AGENTS: 'a,b',
    HERMES_ROOT: '/tmp/from-env',
    HERMES_WEB_SESSION_DAYS: '3',
    HERMES_WEB_COOKIE_SECURE: '0',
    HERMES_WEB_TRUST_CLOUDFLARE: '1',
    HERMES_WEB_ORPHAN_STOP_MIN: '0',
    HERMES_WEB_PUSH_SUBJECT: 'mailto:env@example.invalid',
  };
  const overridden = loadConfig({ root, env });
  assert.equal(overridden.config.port, 8600);
  assert.deepEqual(overridden.config.hosts, ['127.0.0.1', '10.0.0.9']);
  assert.ok(overridden.config.allowedHostnames.has('env.example.com'));
  assert.ok(!overridden.config.allowedHostnames.has('file.example.com'), 'the environment replaces the file list');
  assert.deepEqual(overridden.config.agentNames, ['a', 'b']);
  assert.equal(overridden.config.hermesRoot, '/tmp/from-env');
  assert.equal(overridden.config.sessionDays, 3);
  assert.equal(overridden.config.cookieSecure, false);
  assert.equal(overridden.config.trustCloudflare, true);
  assert.equal(overridden.config.orphanStopMinutes, 0);
  assert.equal(overridden.settings.push.subject, 'mailto:env@example.invalid');
});

test('env-only behaviour matches the old src/config.js exactly', () => {
  const root = tempRoot();
  const env = { HERMES_WEB_PORT: '8300', HERMES_WEB_HOSTS: '10.1.2.3,127.0.0.1', HERMES_WEB_AGENTS: 'main' };
  const { config } = loadConfig({ root, env });
  assert.equal(config.port, 8300);
  assert.deepEqual(config.hosts, ['10.1.2.3', '127.0.0.1']);
  assert.deepEqual([...config.allowedHostnames], ['localhost', '10.1.2.3', '127.0.0.1']);
  assert.deepEqual(config.agentNames, ['main']);
  assert.equal(config.sessionDays, 30);
  assert.equal(config.sessionMaxAgeDays, 90);
  assert.equal(config.uploadMaxBytes, 25 * 1024 * 1024);
  assert.equal(config.textInlineMaxBytes, 100 * 1024);
  assert.equal(config.jsonBodyMaxBytes, 2 * 1024 * 1024);
  assert.equal(config.dataDir, path.join(root, 'data'));
  assert.equal(config.publicDir, path.join(root, 'public'));
});

test('dataDir and publicDir still come from the environment only', () => {
  const root = tempRoot();
  const env = { HERMES_WEB_DATA_DIR: '/tmp/data-x', HERMES_WEB_PUBLIC_DIR: '/tmp/public-x' };
  const { config } = loadConfig({ root, env });
  assert.equal(config.dataDir, '/tmp/data-x');
  assert.equal(config.publicDir, '/tmp/public-x');
});

test('appName is exposed only when set', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'config.json'), '{ "appName": "Example" }');
  assert.equal(loadConfig({ root, env: {} }).config.appName, 'Example');
});

test('validation errors are thrown together, with paths', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'config.json'), '{ "server": { "port": "x", "hosts": 3 }, "agents": 7 }');
  assert.throws(() => loadConfig({ root, env: {} }), (error) => {
    assert.match(error.message, /server\.port/);
    assert.match(error.message, /server\.hosts/);
    assert.match(error.message, /agents/);
    return true;
  });
});

test('unknown keys warn but do not stop loading', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'config.json'), '{ "appNam": "typo" }');
  const result = loadConfig({ root, env: {} });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^appNam: unknown key/);
});

test('defaults() is fresh on every call', () => {
  const a = defaults();
  a.server.hosts.push('10.9.9.9');
  assert.deepEqual(defaults().server.hosts, ['127.0.0.1']);
});
