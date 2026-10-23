import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/env.js';
const { loadProviderDropins } = await import('../../src/providers/dropins.js');
const { buildRegistry } = await import('../../src/providers/registry.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dropins-'));

test('provider drop-ins: object form, factory form (kit), and bad files are skipped', async () => {
  const dir = tmp();
  const warnings = [];
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), `export default { type: 'fake-a', create: (id) => ({ id, type: 'fake-a', text: { chat: async () => ({ text: 'a' }) } }) };\n`);
    fs.writeFileSync(path.join(dir, 'b.js'), `export default (kit) => ({ type: 'fake-b', create: (id, c, h) => new kit.OpenAICompatible({ id, baseUrl: c.baseUrl, apiKey: h.secret(c.apiKey) }) });\n`);
    fs.writeFileSync(path.join(dir, 'broken.js'), 'this is not javascript (\n');
    fs.writeFileSync(path.join(dir, 'empty.js'), 'export default 42;\n');
    fs.writeFileSync(path.join(dir, 'dup.js'), `export default { type: 'null', create: () => ({}) };\n`);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const types = await loadProviderDropins(dir, { builtin: ['null'], warn: (m) => warnings.push(m) });
    assert.deepEqual(Object.keys(types).sort(), ['fake-a', 'fake-b']);
    assert.equal(warnings.length, 3);
    const reg = buildRegistry({ providers: { x: { type: 'fake-a' }, y: { type: 'fake-b', baseUrl: 'http://127.0.0.1:1/v1' } }, capabilities: { writer: { provider: 'x' } } }, { dataDir: dir }, types);
    assert.equal((await reg.get('writer').chat({})).text, 'a');
    assert.equal(reg.instances.get('y').type, 'openai-compatible');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('provider drop-ins: a missing directory is fine', async () => {
  assert.deepEqual(await loadProviderDropins(path.join(tmp(), 'nope')), {});
});
