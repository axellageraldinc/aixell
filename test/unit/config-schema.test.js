// The hand-written config schema: types, unknown keys and path-qualified errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validate } from '../../src/config/schema.js';

test('schema: a complete valid object passes unchanged and reports nothing', () => {
  const input = {
    appName: 'Example',
    server: { port: 9000, hosts: ['127.0.0.1'], allowedHosts: ['app.example.com'], trustCloudflare: true, cookieSecure: true, sessionDays: 7, orphanStopMinutes: 5 },
    agents: ['default', 'other'],
    hermesRoot: '/tmp/hermes',
    timezone: 'UTC',
    push: { subject: 'mailto:admin@example.invalid' },
    allowInlineSecrets: false,
  };
  const result = validate(input);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.value, input);
});

test('schema: an empty object is valid', () => {
  const result = validate({});
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value, {});
});

test('schema: wrong types are path-qualified errors, and the bad key is left out', () => {
  const result = validate({ server: { port: '8300', hosts: '127.0.0.1' }, agents: 'default', allowInlineSecrets: 'yes' });
  assert.equal(result.errors.length, 4);
  assert.ok(result.errors.some((message) => message.startsWith('server.port: ')));
  assert.ok(result.errors.some((message) => message.startsWith('server.hosts: ')));
  assert.ok(result.errors.some((message) => message.startsWith('agents: ')));
  assert.ok(result.errors.some((message) => message.startsWith('allowInlineSecrets: ')));
  assert.deepEqual(result.value.server, {});
});

test('schema: an unknown top-level or nested key warns and is dropped', () => {
  const result = validate({ port: 1, server: { port: 8300, nonsense: true } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((message) => message.startsWith('port: ')));
  assert.ok(result.warnings.some((message) => message.startsWith('server.nonsense: ')));
  assert.deepEqual(result.value, { server: { port: 8300 } });
});

test('schema: later-phase sections are accepted as opaque objects, other types rejected', () => {
  const opaque = { providers: { p: { type: 'null' } }, fresh: {}, locale: { ui: 'en' } };
  assert.deepEqual(validate(opaque).errors, []);
  assert.deepEqual(validate(opaque).value, opaque);
  assert.ok(validate({ providers: [] }).errors[0].startsWith('providers: '));
});

test('schema: numbers must be sane', () => {
  assert.ok(validate({ server: { port: 70000 } }).errors[0].startsWith('server.port: '));
  assert.ok(validate({ server: { port: 1.5 } }).errors[0].startsWith('server.port: '));
  assert.ok(validate({ server: { sessionDays: 0 } }).errors[0].startsWith('server.sessionDays: '));
  assert.ok(validate({ server: { orphanStopMinutes: -1 } }).errors[0].startsWith('server.orphanStopMinutes: '));
  assert.deepEqual(validate({ server: { orphanStopMinutes: 0 } }).errors, []);
});

test('schema: a non-object is one error', () => {
  assert.deepEqual(validate(null), { value: {}, errors: ['config: must be an object'], warnings: [] });
  assert.deepEqual(validate([]).errors, ['config: must be an object']);
});

test('config.example.json is valid and uses only known keys', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../../config.example.json', import.meta.url), 'utf8'));
  const result = validate(example);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('schema: a connector instance schedule override is validated', () => {
  const entry = (schedule) => ({ connectors: [{ id: 'a', type: 'rss', cat: 'ai', limit: 5, config: { url: 'https://example.com/feed' }, schedule }] });
  const ok = validate(entry({ at: ['07:30'], days: [1, 2] }));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.value.connectors[0].schedule, { at: ['07:30'], days: [1, 2] });
  const bad = validate(entry({ every: 'soon' }));
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /schedule.*invalid interval/);
});
