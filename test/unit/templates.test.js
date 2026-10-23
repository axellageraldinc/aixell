// P7a: generic templates must exist and must not carry owner-specific values.
// The owner originals in deploy/ are out of scope here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const templates = [
  'docs/license-policy.md',
  'deploy/examples/aixell.service',
  'deploy/examples/hermes-gateway.service',
  'deploy/examples/cloudflared.service',
  'deploy/examples/cloudflared.yml.example',
  'deploy/examples/Caddyfile.example',
  'deploy/examples/nginx.conf.example',
  'deploy/examples/README.md',
  'hermes-profile.example/profile.yaml',
  'hermes-profile.example/SOUL.md',
  'hermes-profile.example/env.example',
  'hermes-profile.example/config.yaml',
  'hermes-profile.example/README.md',
];

const services = templates.filter((file) => file.startsWith('deploy/examples/') && file.endsWith('.service'));

// Built from fragments so this test file does not itself contain the strings it
// forbids: the scan must stay clean when it is run over every new file.
const ownerScan = new RegExp([
  'wong' + 'java',
  'wong' + 'jvm',
  'ax' + 'ell',
  'ba' + 'bu',
  '192' + '\\.168\\.',
  '\\/home\\/',
  'jaka' + 'rta',
  '\\bW' + 'IB\\b',
  'R' + 'p ',
].join('|'), 'i');


test('every P7a template file exists', () => {
  const missing = templates.filter((file) => !fs.existsSync(path.join(root, file)));
  assert.deepEqual(missing, []);
});

test('template files contain no owner-specific strings', () => {
  const hits = [];
  for (const file of templates) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (ownerScan.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('deploy/examples service units define ExecStart', () => {
  assert.ok(services.length >= 3);
  for (const file of services) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /^ExecStart=\S/m, `${file} needs an ExecStart line`);
  }
});

test('the example profile env file holds no real secret', () => {
  const text = fs.readFileSync(path.join(root, 'hermes-profile.example/env.example'), 'utf8');
  const entries = text.split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]);
  assert.ok(entries.length > 0);

  const placeholder = (value) => value === '' || value === 'changeme' || /^<[^<>]+>$/.test(value);
  const secretKey = /(KEY|TOKEN|SECRET|PASSWORD)/;
  for (const [name, value] of entries) {
    if (secretKey.test(name)) {
      assert.ok(placeholder(value), `${name} must be empty, changeme, or a <...> placeholder`);
    }
    // Nothing may look like a real credential even under a non-secret key name.
    assert.doesNotMatch(value, /^(?:sk-|ghp_|xox[bp]-|AKIA)/, `${name} looks like a real credential`);
    assert.ok(value.length < 40, `${name} value is too long to be a placeholder`);
  }
});
