// i18n checks for the P3 pilot: every t() key used in public/ exists in the English locale, every locale key is used,
// placeholders line up with the params passed, and the migrated files carry no common non-English UI words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_WORDS_RE } from '../helpers/indonesian.js';
import en from '../../public/locales/en.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = path.join(root, 'public');

// Lines that match the scan but are not non-English UI text. Each entry names the file, a fragment of the
// line and why the match is a false positive.
const ALLOW = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : walk(full);
    return /\.(?:js|html)$/.test(entry.name) ? [full] : [];
  });
}

const files = walk(publicDir);
const read = (file) => fs.readFileSync(file, 'utf8');

// The non-English word scan covers every client file (P3 rest): all of public/**/*.js and the HTML pages.
const SCANNED = files.map((file) => path.relative(root, file)).sort();

// Every literal key passed to t('...') anywhere in public/.
function usedKeys() {
  const found = new Map();
  for (const file of files) {
    for (const match of read(file).matchAll(/\bt\(\s*'([^']+)'/g)) {
      const rel = path.relative(root, file);
      if (!found.has(match[1])) found.set(match[1], rel);
    }
  }
  return found;
}

test('every t() key used in public/ exists in the English locale', () => {
  const missing = [...usedKeys()].filter(([key]) => !Object.hasOwn(en, key)).map(([key, file]) => `${key} (${file})`);
  assert.deepEqual(missing, [], `missing keys: ${missing.join(', ')}`);
});

test('no key in the English locale is unused', () => {
  const used = usedKeys();
  const unused = Object.keys(en).filter((key) => !used.has(key));
  assert.deepEqual(unused, [], `unused keys: ${unused.join(', ')}`);
});

// Splits an argument list on commas that are not nested inside braces, brackets or parentheses.
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

// The text between the parentheses of the call whose "(" sits at `open`, or null when the call is not balanced.
function callArgs(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

// Param names from the object literal passed as the second argument (both `{ a, b: x }` and `{ a }` shorthand).
function paramNames(args) {
  const parts = splitTop(args);
  if (parts.length < 2) return [];
  const object = parts.slice(1).join(', ').trim();
  if (!object.startsWith('{') || !object.endsWith('}')) return [];
  return splitTop(object.slice(1, -1)).map((part) => {
    const first = part.split(':')[0].trim();
    return /^[A-Za-z_$][\w$]*$/.test(first) ? first : null;
  }).filter(Boolean).sort();
}

test('placeholder names in a message match the ones passed at the call site', () => {
  const problems = [];
  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) {
      const key = match[1];
      const message = en[key];
      if (typeof message !== 'string') continue;
      const open = source.indexOf('(', match.index);
      const args = callArgs(source, open);
      if (args === null) continue;
      const wanted = [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const passed = paramNames(args);
      if (wanted.join() !== passed.join()) problems.push(`${path.relative(root, file)}: ${key} wants [${wanted}] but got [${passed}]`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the migrated files contain no common non-English UI words', () => {
  const words = UI_WORDS_RE;
  const hits = [];
  for (const rel of SCANNED) {
    const text = read(path.join(root, rel));
    text.split('\n').forEach((line, index) => {
      if (!words.test(line)) return;
      const allowed = ALLOW.find((entry) => entry.file === rel && line.includes(entry.text));
      if (!allowed) hits.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], `Non-English words left:\n${hits.join('\n')}`);
});

test('the layer reports English and fills placeholders', async () => {
  const { t, locale, setMessages } = await import('../../public/lib/i18n.js');
  assert.equal(locale(), 'en');
  assert.equal(t('approval.countdown', { remaining: 5 }), 'Auto-denied in 5s');
  setMessages({ 'x.y.z': 'Hi {name}' });
  assert.equal(t('x.y.z', { name: 'Ada' }), 'Hi Ada');
  setMessages(en);

  // A missing key comes back unchanged and warns once, not on every call.
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(t('no.such.key'), 'no.such.key');
    assert.equal(t('no.such.key'), 'no.such.key');
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
});
