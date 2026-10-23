// The data loaders of Fresh (P5d): categories, taste, filter packs and the meta-sentence lists.
// Each one prefers config, then a data file in a temp data directory, then its neutral default;
// a broken data file is a warning and the defaults apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/env.js';
const { DEFAULT_CATEGORIES, loadCategories, categorySource } = await import('../../src/fresh/categories.js');
const { DEFAULT_PROFILE, loadTaste, tasteSource } = await import('../../src/fresh/taste.js');
const { loadPacks, loadRules, compilePack } = await import('../../src/fresh/filters.js');
const { metaPatterns, isMeta, resetMetaCache } = await import('../../src/fresh/meta.js');

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-fresh-data-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// console.warn is captured so a test can prove a broken file only warns.
const warnings = (fn) => {
  const seen = [];
  const original = console.warn;
  console.warn = (message) => seen.push(String(message));
  try {
    return { result: fn(), seen };
  } finally {
    console.warn = original;
  }
};

test('categories: the neutral defaults apply when there is no config and no data file', () => {
  const dir = tempDir();
  assert.equal(categorySource({ settings: {}, dataDir: dir }).from, 'defaults');
  const list = loadCategories({ settings: {}, dataDir: dir });
  assert.deepEqual(list.map((category) => category.id), DEFAULT_CATEGORIES.map((category) => category.id));
  assert.ok(list.every((category) => category.posRe instanceof RegExp));
});

test('categories: config wins over a data file, and the data file wins over the defaults', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'categories.json'), JSON.stringify([{ id: 'gaming', label: 'Gaming', halfLifeHours: 12, keywords: { pos: 'game' } }]));
  assert.deepEqual(loadCategories({ settings: {}, dataDir: dir }).map((category) => category.id), ['gaming']);
  const fromConfig = loadCategories({ settings: { categories: [{ id: 'news', label: 'News', halfLifeHours: 6 }] }, dataDir: dir });
  assert.deepEqual(fromConfig.map((category) => category.id), ['news']);
  assert.equal(fromConfig[0].posRe.test('anything'), false, 'a category without keywords matches nothing');
});

test('categories: a broken data file warns and the defaults apply', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'categories.json'), '{not json');
  const { result, seen } = warnings(() => loadCategories({ settings: {}, dataDir: dir }));
  assert.deepEqual(result.map((category) => category.id), DEFAULT_CATEGORIES.map((category) => category.id));
  assert.ok(seen.some((message) => /categories\.json/.test(message)));
});

test('categories: an entry with a bad regular expression is skipped, the rest stays', () => {
  const { result, seen } = warnings(() => loadCategories({ settings: { categories: [
    { id: 'bad', label: 'Bad', halfLifeHours: 10, keywords: { pos: '(' } },
    { id: 'good', label: 'Good', halfLifeHours: 10, keywords: { pos: 'ok' } },
  ] }, dataDir: tempDir() }));
  assert.deepEqual(result.map((category) => category.id), ['good']);
  assert.ok(seen.some((message) => /bad/.test(message)));
});

test('taste: the neutral profile applies when there is no config and no data file', () => {
  const dir = tempDir();
  assert.equal(tasteSource({ settings: {}, dataDir: dir }).from, 'defaults');
  assert.equal(loadTaste({ settings: {}, dataDir: dir }), DEFAULT_PROFILE);
});

test('taste: a data file is read, a config string wins, and a file: reference inside the data dir is read', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'taste.md'), '  Likes databases.\n');
  assert.equal(loadTaste({ settings: {}, dataDir: dir }), 'Likes databases.');
  assert.equal(loadTaste({ settings: { taste: { profile: 'Likes compilers.' } }, dataDir: dir }), 'Likes compilers.');
  fs.writeFileSync(path.join(dir, 'profile.md'), 'From a file.\n');
  assert.equal(loadTaste({ settings: { taste: { profile: 'file:profile.md' } }, dataDir: dir }), 'From a file.');
});

test('taste: a file: reference outside the data dir is refused and the next source applies', () => {
  const dir = tempDir();
  const { result, seen } = warnings(() => loadTaste({ settings: { taste: { profile: 'file:../outside.md' } }, dataDir: dir }));
  assert.equal(result, DEFAULT_PROFILE);
  assert.ok(seen.some((message) => /not allowed/.test(message)));
});

test('filters: the shipped English pack loads and its rules compile', () => {
  const packs = loadPacks({ settings: {}, dataDir: tempDir() });
  assert.deepEqual(packs.map((pack) => pack.id), ['en']);
  const rules = loadRules({ settings: {}, dataDir: tempDir() });
  assert.ok(rules.length >= 8);
  assert.ok(rules.every((rule) => rule.re instanceof RegExp));
  assert.ok(rules.some((rule) => rule.name === 'affiliate' && rule.action === 'drop'));
});

test('filters: a data file replaces the shipped pack of the same id, and an extra pack is added', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'filters'));
  fs.writeFileSync(path.join(dir, 'filters', 'en.json'), JSON.stringify({ id: 'en', lang: 'en', rules: [{ name: 'own', action: 'drop', test: 'sponsored' }] }));
  fs.writeFileSync(path.join(dir, 'filters', 'xx.json'), JSON.stringify({ id: 'xx', lang: 'xx', rules: [{ name: 'xx-own', action: 'drop', test: 'iklan' }] }));
  const rules = loadRules({ settings: { filters: { packs: ['en', 'xx'] } }, dataDir: dir });
  assert.deepEqual(rules.map((rule) => rule.name), ['own', 'xx-own']);
});

test('filters: a missing pack and a broken pack only warn', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'filters'));
  fs.writeFileSync(path.join(dir, 'filters', 'broken.json'), JSON.stringify({ id: 'broken', rules: [{ name: 'x', action: 'drop', test: '(' }] }));
  const { result, seen } = warnings(() => loadRules({ settings: { filters: { packs: ['nope', 'broken', 'en'] } }, dataDir: dir }));
  assert.deepEqual(result.map((rule) => rule.name).includes('affiliate'), true, 'the shipped pack still loads');
  assert.ok(seen.some((message) => /"nope" not found/.test(message)));
  assert.ok(seen.some((message) => /not a valid regular expression/.test(message)));
});

test('filters: compilePack rejects an unknown action and a category rule without categories', () => {
  const unknown = compilePack({ id: 'x', rules: [{ name: 'a', action: 'nope', test: 'a' }] });
  assert.equal(unknown.pack, null);
  assert.match(unknown.errors[0], /action/);
  const noCats = compilePack({ id: 'x', rules: [{ name: 'a', action: 'category', test: 'a' }] });
  assert.match(noCats.errors[0], /cats/);
});

test('meta: the shipped English list is loaded and matches a sentence about the text', () => {
  resetMetaCache();
  const dir = tempDir();
  const patterns = metaPatterns('en', { dataDir: dir });
  assert.ok(patterns.length > 0);
  assert.equal(isMeta('The article only mentions the title.', 'en'), true);
  assert.equal(isMeta('A new model was released with a larger context window.', 'en'), false);
});

test('meta: a language with no list is not checked, and a data file replaces the shipped one', () => {
  resetMetaCache();
  const dir = tempDir();
  assert.deepEqual(metaPatterns('zz', { dataDir: dir }), []);
  fs.mkdirSync(path.join(dir, 'filters'));
  fs.writeFileSync(path.join(dir, 'filters', 'meta.en.json'), JSON.stringify({ id: 'en', patterns: ['\\bonly a headline\\b'] }));
  resetMetaCache();
  assert.equal(metaPatterns('en', { dataDir: dir }).some((re) => re.test('The article only mentions the title.')), false, 'the custom list replaced the shipped one');
  assert.equal(metaPatterns('en', { dataDir: dir }).some((re) => re.test('This is only a headline.')), true);
});
