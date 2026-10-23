// Dependency rules for server code. Imports are read from the source text (static and dynamic, relative specifiers).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

// Every relative import target of a file, as a repo-relative path.
function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const targets = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;
  let m;
  while ((m = re.exec(text))) targets.push(rel(path.resolve(path.dirname(file), m[2])));
  return targets;
}

const files = walk(SRC);

test('server code in src/ does not import from public/', () => {
  const offenders = [];
  for (const file of files) for (const t of importsOf(file)) if (t === 'public' || t.startsWith('public/')) offenders.push(`${rel(file)} -> ${t}`);
  assert.deepEqual(offenders, []);
});

test('no file in src/ imports server.js', () => {
  const offenders = [];
  for (const file of files) for (const t of importsOf(file)) if (t === 'server.js') offenders.push(rel(file));
  assert.deepEqual(offenders, []);
});

// Known violations of the connector rule when this test was written (P6). They are listed in docs/dev/P6-REPORT.md and
// belong to a later refactor. The list may only shrink: a new import of src/fresh/ from a connector fails the test.
const KNOWN_CONNECTOR_IMPORTS = new Set([
  'src/connectors/github-hype.js -> src/fresh/profile.js',
  'src/connectors/github-hype.js -> src/fresh/store.js',
  'src/connectors/github-hype.js -> src/fresh/mock.js',
  'src/connectors/bluesky.js -> src/fresh/profile.js',
  'src/connectors/ingest.js -> src/fresh/profile.js',
  'src/connectors/x-search.js -> src/fresh/offline.js',
  'src/connectors/state.js -> src/fresh/store.js',
  'src/connectors/steam.js -> src/fresh/store.js',
  'src/connectors/rss.js -> src/fresh/net.js',
  'src/connectors/x-search.js -> src/fresh/profile.js',
  'src/connectors/x-search.js -> src/fresh/filters.js',
  'src/connectors/x-search.js -> src/fresh/rank.js',
  'src/connectors/x-search.js -> src/fresh/store.js',
]);

function connectorViolations() {
  const found = [];
  for (const file of files) {
    if (!rel(file).startsWith('src/connectors/')) continue;
    for (const t of importsOf(file)) {
      if (!t.startsWith('src/fresh/')) continue;
      found.push(`${rel(file)} -> ${t}`);
    }
  }
  return found;
}

test('src/connectors/ does not import src/fresh/ beyond the known list', () => {
  const fresh = connectorViolations().filter((v) => !KNOWN_CONNECTOR_IMPORTS.has(v));
  assert.deepEqual(fresh, [], 'new import of src/fresh/ from a connector');
});

test('the known connector violations are still real (shrink the list when one is fixed)', () => {
  const found = new Set(connectorViolations());
  const stale = [...KNOWN_CONNECTOR_IMPORTS].filter((v) => !found.has(v));
  assert.deepEqual(stale, []);
});
