// The real model(s) behind a reply on a routed gateway: attributed from the server's trail of pin changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { turnModels } = await import('../../public/lib/reply-models.js');

test('a turn names the model in effect at its start, then each change until it ends', () => {
  const trail = [{ ts: 10, model: 'a' }, { ts: 105, model: 'b' }, { ts: 110, model: 'c' }, { ts: 300, model: 'd' }];
  assert.deepEqual(turnModels(trail, 100, 120), ['a', 'b', 'c']);
  assert.deepEqual(turnModels(trail, 200, 250), ['c']);
  assert.deepEqual(turnModels(trail, 5, 9), []);
  assert.deepEqual(turnModels([], 100, 120), []);
  assert.deepEqual(turnModels(trail, null, 120), []);
});

test('the trail keeps only changes and survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-'));
  process.env.HERMES_WEB_DATA_DIR = dir;
  const { getTrail, noteModel, forgetTrail } = await import('../../src/model-trail.js');
  assert.equal(noteModel('x', 's1', 'a', 1), true);
  assert.equal(noteModel('x', 's1', 'a', 2), false);
  assert.equal(noteModel('x', 's1', 'b', 3), true);
  assert.equal(noteModel('x', 's1', '', 4), false);
  assert.deepEqual(getTrail('x', 's1').map((e) => e.model), ['a', 'b']);
  forgetTrail('x', 's1');
  assert.deepEqual(getTrail('x', 's1'), []);
});
