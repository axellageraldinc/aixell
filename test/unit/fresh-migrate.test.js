// The title column migration (P5d): an old database has `title_id`, the store renames it to
// `title_local` once, keeps the data, copies the file first, and a second open is a no-op.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import '../helpers/env.js';
const { migrateTitleColumn } = await import('../../src/fresh/store.js');

const tempDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-migrate-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'fresh.db');
};

// The items table as it was before P5d, with one row.
const oldDb = (file) => {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, title_id TEXT, summary TEXT)');
  db.prepare('INSERT INTO items (id, url, title, title_id, summary) VALUES (?, ?, ?, ?, ?)').run('a1', 'https://example.com/a', 'Original', 'Card title', 'Summary');
  return db;
};

const columns = (db) => db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);

test('an old database gains title_local, keeps its data and is backed up first', () => {
  const file = tempDb();
  const db = oldDb(file);
  assert.ok(columns(db).includes('title_id'));
  assert.equal(migrateTitleColumn(db, { file }), true);
  assert.ok(columns(db).includes('title_local'));
  assert.ok(!columns(db).includes('title_id'));
  assert.equal(db.prepare('SELECT title_local, title FROM items WHERE id = ?').get('a1').title_local, 'Card title');
  assert.ok(fs.existsSync(`${file}.pre-title-local.bak`), 'the file was copied before the rename');
  db.close();
});

test('a second open is a no-op: no rename, no second backup, the data stays', () => {
  const file = tempDb();
  const first = oldDb(file);
  migrateTitleColumn(first, { file });
  first.close();
  const backup = fs.statSync(`${file}.pre-title-local.bak`).mtimeMs;
  const db = new DatabaseSync(file);
  assert.equal(migrateTitleColumn(db, { file }), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 1);
  assert.equal(fs.statSync(`${file}.pre-title-local.bak`).mtimeMs, backup, 'the backup was not rewritten');
  db.close();
});

test('a database that already has title_local is left alone', () => {
  const file = tempDb();
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, title_local TEXT)');
  assert.equal(migrateTitleColumn(db, { file }), false);
  assert.ok(!fs.existsSync(`${file}.pre-title-local.bak`));
  db.close();
});

test('an in-memory database is migrated without a file copy', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, title_id TEXT)');
  db.prepare('INSERT INTO items (id, title_id) VALUES (?, ?)').run('a1', 'Card');
  assert.equal(migrateTitleColumn(db, { file: ':memory:' }), true);
  assert.equal(db.prepare('SELECT title_local FROM items WHERE id = ?').get('a1').title_local, 'Card');
  db.close();
});
