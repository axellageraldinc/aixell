// P2: the "Standard" interface style is gone. Feed is the only look, so no file in public/ may gate on it.
//
// The retired localStorage key is removed once on boot by the shim in theme.js; that one line is the only place the
// key may still appear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = path.join(root, 'public');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : walk(full);
    return /\.(?:js|html|css)$/.test(entry.name) ? [full] : [];
  });
}

const files = walk(publicDir);
const rel = (file) => path.relative(root, file);

// Finds `needle` in every file and returns "path:line" for each hit.
function hits(needle) {
  const found = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.includes(needle)) found.push(`${rel(file)}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

test('public/ has no data-ui attribute or dataset.ui lookup', () => {
  assert.deepEqual(hits('data-ui'), []);
  assert.deepEqual(hits('dataset.ui'), []);
  assert.deepEqual(hits("dataset['ui']"), []);
});

test('public/ has no UI_STYLES, setUi or currentUi leftovers', () => {
  for (const name of ['UI_STYLES', 'setUi', 'currentUi', 'hermes:ui']) {
    assert.deepEqual(hits(name), [], `${name} is still used`);
  }
});

test('hermes.ui is only touched by the boot shim that removes it', () => {
  const found = hits('hermes.ui');
  assert.equal(found.length, 1, `expected one shim line, got:\n${found.join('\n')}`);
  const [location] = found;
  assert.match(location, /^public\/theme\.js:\d+: /);
  assert.match(location, /localStorage\.removeItem\(/);
});

test('the interface style setting is gone from the settings dialog', () => {
  const settings = fs.readFileSync(path.join(publicDir, 'lib', 'agent-settings.js'), 'utf8');
  assert.doesNotMatch(settings, /Interface style/);
  assert.doesNotMatch(settings, /Feed style/);
  assert.doesNotMatch(settings, /Standard/);
});
