// Provider-specific code lives in drop-ins under data/providers, never in the application: no module under src/ names a
// particular hosted gateway. The compat default is the offline sandbox only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
test('the compat config is the only default: an explicit providers.json replaces it', () => {
  const compat = fs.readFileSync(path.join(ROOT, 'src', 'providers', 'compat.js'), 'utf8');
  assert.match(compat, /compatDefault/, 'the compat default still exists');
  assert.match(compat, /providers\.json/, 'a providers.json replaces it');
});
