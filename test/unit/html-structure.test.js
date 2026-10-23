// The HTML structure the client expects: every element id that app.js (and the modules it imports) looks up must exist
// in index.html, so a renamed or deleted node fails here instead of at runtime.
//
// Ids are collected from `$('#id')`, `document.getElementById('id')` and `querySelector('#id')`. An id that a module
// creates itself is accepted too, because it is found in a `id: '...'` / `id="..."` assignment somewhere in public/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = path.join(root, 'public');
const entry = path.join(publicDir, 'app.js');

const read = (file) => fs.readFileSync(file, 'utf8');

// The static import graph of app.js: relative specifiers only, no dynamic import().
function moduleGraph(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const match of read(file).matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (fs.existsSync(target)) moduleGraph(target, seen);
  }
  return seen;
}

const modules = moduleGraph(entry);

// Ids that a module looks up in the document.
function lookedUpIds() {
  const wanted = new Map();
  for (const file of modules) {
    const source = read(file);
    for (const match of source.matchAll(/\$\(\s*'#([\w-]+)'/g)) wanted.set(match[1], path.relative(root, file));
    for (const match of source.matchAll(/getElementById\(\s*'([\w-]+)'/g)) wanted.set(match[1], path.relative(root, file));
    for (const match of source.matchAll(/querySelector(?:All)?\(\s*'#([\w-]+)'/g)) wanted.set(match[1], path.relative(root, file));
  }
  return wanted;
}

// Ids declared in the markup, and ids a module creates before it looks them up.
function knownIds() {
  const ids = new Set();
  const html = read(path.join(publicDir, 'index.html'));
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) ids.add(match[1]);
  for (const file of modules) {
    const source = read(file);
    for (const match of source.matchAll(/\bid:\s*'([\w-]+)'/g)) ids.add(match[1]);
    for (const match of source.matchAll(/\bid="([\w-]+)"/g)) ids.add(match[1]);
  }
  return ids;
}

test('app.js imports resolve inside public/', () => {
  assert.ok(modules.size > 5, `only ${modules.size} modules found`);
  assert.ok(modules.has(path.join(publicDir, 'lib', 'feed-shell.js')));
});

test('every id app.js looks up exists in index.html', () => {
  const known = knownIds();
  const missing = [...lookedUpIds()].filter(([id]) => !known.has(id)).map(([id, file]) => `${id} (looked up in ${file})`);
  assert.deepEqual(missing, [], `ids missing from index.html:\n${missing.join('\n')}`);
});

test('index.html has the elements the Feed shell and the composer need', () => {
  const html = read(path.join(publicDir, 'index.html'));
  for (const id of ['main', 'sidebar', 'scrim', 'session-list', 'session-search', 'composer-input', 'message-list', 'toaster', 'telegram-open']) {
    assert.match(html, new RegExp(`\\sid="${id}"`), `#${id} is missing from index.html`);
  }
});
