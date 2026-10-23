// The category editor: validation, the data file, and the live reload of the shared tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/env.js';
const profile = await import('../../src/fresh/profile.js');
const { CATEGORIES, CAT_IDS, reloadCategories } = profile;
const { saveCategories, categoryEditorView } = await import('../../src/fresh/categories.js');

const entry = (id, label, extra = {}) => ({ id, label, halfLifeHours: 12, keywords: { pos: '\\bgpu\\b', neg: '' }, ...extra });

test('a saved list is written to the data file and reloads the shared tables in place', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cats-'));
  const opts = { dataDir, settings: {} };
  saveCategories([entry('gpus', 'GPUs'), entry('news', 'News')], opts);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'categories.json'), 'utf8')).categories.map((c) => c.id), ['gpus', 'news']);
  const before = CATEGORIES;
  reloadCategories(opts);
  assert.equal(CATEGORIES, before, 'same object, so importers see the change');
  assert.deepEqual(CAT_IDS, ['gpus', 'news']);
  assert.equal(CATEGORIES.gpus, 'GPUs');
  assert.equal(profile.PRIMARY_CAT, 'gpus');
  assert.equal(categoryEditorView(opts).editable, true);
  reloadCategories({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cats-')), settings: {} });
  assert.deepEqual(CAT_IDS, ['tech', 'ai', 'security']);
});

test('bad lists are refused with a message', () => {
  const opts = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cats-')), settings: {} };
  assert.throws(() => saveCategories([], opts), /at least one/);
  assert.throws(() => saveCategories([entry('a', 'A'), entry('a', 'B')], opts), /twice/);
  assert.throws(() => saveCategories([entry('saved', 'Saved')], opts), /not a usable id/);
  assert.throws(() => saveCategories([entry('Bad Id', 'X')], opts), /not a usable id/);
  assert.throws(() => saveCategories([entry('a', '')], opts), /needs a name/);
  assert.throws(() => saveCategories([entry('a', 'A', { keywords: { pos: '(', neg: '' } })], opts), /regular expression/);
});

test('categories owned by config.json are read-only', () => {
  const opts = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cats-')), settings: { categories: [entry('x', 'X')] } };
  assert.equal(categoryEditorView(opts).editable, false);
  assert.throws(() => saveCategories([entry('a', 'A')], opts), /config\.json/);
});
