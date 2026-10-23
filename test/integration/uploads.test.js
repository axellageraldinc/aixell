// Uploads: type detection by magic bytes, name sanitising, size limit, download headers, and use in a chat message.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, AGENT_NAME } from '../helpers/boot.js';

let app, me;
before(async () => { app = await boot(); me = await app.login(); });
after(async () => { await app.stop(); });

const UP = `/api/agents/${AGENT_NAME}/uploads`;
// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const upload = (buffer, { name = 'file.txt', type = 'text/plain', client = me } = {}) => client.call('POST', UP, { body: buffer, headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent(name) } });

test('a text file is stored in the agent profile and can be downloaded as an attachment', async () => {
  const r = await upload(Buffer.from('hello attachment'), { name: 'notes.txt' });
  assert.equal(r.status, 200);
  assert.deepEqual({ ...r.data, id: 'x' }, { id: 'x', name: 'notes.txt', size: 16, mime: 'text/plain', kind: 'file' });
  assert.match(r.data.id, /^[a-f0-9]{24}$/);
  const stored = fs.readdirSync(path.join(app.profileDir, 'cache', 'documents'));
  assert.ok(stored.some((f) => f === `webup_${r.data.id}_notes.txt`));

  const download = await me.raw('GET', `/api/uploads/${r.data.id}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''notes\.txt/);
  assert.equal(await download.text(), 'hello attachment');
});

test('an image is recognised by its bytes and shown inline', async () => {
  const r = await upload(PNG, { name: 'dot.png', type: 'image/png' });
  assert.equal(r.data.kind, 'image');
  assert.equal(r.data.mime, 'image/png');
  const download = await me.raw('GET', `/api/uploads/${r.data.id}`);
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.equal(download.headers.get('content-disposition'), 'inline');
});

test('a file that claims to be an image but is not one is stored as a plain file', async () => {
  const r = await upload(Buffer.from('<script>alert(1)</script>'), { name: 'evil.png', type: 'image/png' });
  assert.equal(r.data.kind, 'file');
  const download = await me.raw('GET', `/api/uploads/${r.data.id}`);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment/);
});

test('audio is detected by type or extension', async () => {
  assert.equal((await upload(Buffer.from('ID3....'), { name: 'memo.m4a', type: 'application/octet-stream' })).data.kind, 'audio');
  assert.equal((await upload(Buffer.from('....'), { name: 'memo.bin', type: 'audio/ogg' })).data.kind, 'audio');
});

test('file names are sanitised and cannot escape the documents folder', async () => {
  const r = await upload(Buffer.from('x'), { name: '../../etc/pass wd?.txt' });
  assert.equal(r.status, 200);
  assert.match(r.data.name, /^[\w.\- ]+$/);
  assert.ok(!r.data.name.includes('/'));
  const dir = path.join(app.profileDir, 'cache', 'documents');
  for (const f of fs.readdirSync(dir)) assert.ok(!f.includes('..'));
  assert.deepEqual(fs.readdirSync(app.profileDir).filter((f) => f === 'etc'), []);
});

test('an empty upload is refused', async () => {
  const r = await upload(Buffer.alloc(0));
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'empty_file');
});

test('an upload over the size limit is refused with 413', async () => {
  const r = await upload(Buffer.alloc(26 * 1024 * 1024, 1), { name: 'big.bin', type: 'application/octet-stream' }).catch((error) => ({ status: 'reset', error }));
  // The server may answer before reading everything, which a client can see as a reset; either way nothing is stored.
  assert.ok(r.status === 413 || r.status === 'reset', `status ${r.status}`);
  if (r.status === 413) assert.equal(r.data.error.code, 'too_large');
});

test('downloads need a session, and ids are validated', async () => {
  const r = await upload(Buffer.from('private'), { name: 'p.txt' });
  assert.equal((await app.client().raw('GET', `/api/uploads/${r.data.id}`)).status, 401);
  assert.equal((await me.get('/api/uploads/not-an-id')).status, 404);
  assert.equal((await me.get(`/api/uploads/${'0'.repeat(24)}`)).status, 404);
});

test('uploads need the CSRF token', async () => {
  const r = await me.call('POST', UP, { body: Buffer.from('x'), csrf: '', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 403);
});

test('a text attachment is inlined into the message the agent receives, and an image goes as an image part', async () => {
  const text = await upload(Buffer.from('the secret word is pineapple'), { name: 'word.txt' });
  const image = await upload(PNG, { name: 'dot.png', type: 'image/png' });
  const reply = await me.raw('POST', `/api/agents/${AGENT_NAME}/chat`, { json: { text: 'what does the file say?', attachments: [text.data.id, image.data.id] } });
  assert.equal(reply.status, 200);
  await reply.text();
  const input = app.fake.chatBodies.at(-1).body.input;
  assert.ok(Array.isArray(input), 'with an image the input is a list of parts');
  assert.match(input[0].text, /what does the file say\?/);
  assert.match(input[0].text, /pineapple/);
  assert.ok(input.some((part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/')));
});
