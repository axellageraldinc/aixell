import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

const DIR = path.join(config.dataDir, 'fresh');
export const IMAGE_DIR = path.join(DIR, 'img');
fs.mkdirSync(IMAGE_DIR, { recursive: true, mode: 0o700 });
const DB_FILE = path.join(DIR, 'fresh.db');
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, title_local TEXT, summary TEXT, why TEXT, topics TEXT,
    source TEXT NOT NULL, cat TEXT NOT NULL, published INTEGER NOT NULL, first_seen INTEGER NOT NULL, score REAL NOT NULL DEFAULT 0,
    outlets INTEGER NOT NULL DEFAULT 1, also TEXT, image INTEGER NOT NULL DEFAULT 0, meta TEXT, sig TEXT,
    status TEXT NOT NULL DEFAULT 'new', llm INTEGER NOT NULL DEFAULT 0,
    saved INTEGER NOT NULL DEFAULT 0, saved_at INTEGER, hidden INTEGER NOT NULL DEFAULT 0, read_at INTEGER, reader TEXT, ready_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS items_ready ON items (status, hidden, published DESC);
  CREATE INDEX IF NOT EXISTS items_saved ON items (saved, saved_at DESC);
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS signals (id TEXT NOT NULL, kind TEXT NOT NULL, ms INTEGER, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS signals_at ON signals (at);
  CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, created INTEGER NOT NULL, cat TEXT, ids TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS repo_stars (repo TEXT NOT NULL, at INTEGER NOT NULL, stars INTEGER NOT NULL, PRIMARY KEY (repo, at));
  CREATE TABLE IF NOT EXISTS glossary (term TEXT PRIMARY KEY, decision TEXT NOT NULL, source TEXT NOT NULL, bad TEXT, form TEXT, hits INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS health (source TEXT PRIMARY KEY, ok INTEGER, last_ok INTEGER, fails INTEGER NOT NULL DEFAULT 0, error TEXT, count INTEGER NOT NULL DEFAULT 0);
`);

// The taught-taste store (topic and source weights learned from "more / less" and from the reader's
// clicks) is gone: an older database loses those tables here, so no learned preference survives.
db.exec('DROP TABLE IF EXISTS topics; DROP TABLE IF EXISTS weights;');

// Columns added after the first version (an old database gains them in place).
const have = new Set(db.prepare('PRAGMA table_info(items)').all().map((c) => c.name));
for (const [name, type] of [['rel', 'REAL'], ['seen_at', 'INTEGER'], ['kind', 'TEXT'], ['triaged', 'INTEGER NOT NULL DEFAULT 0'], ['writer', 'TEXT'], ['flag', 'TEXT'], ['ban', 'REAL'], ['thread', 'TEXT']]) {
  if (!have.has(name)) db.exec(`ALTER TABLE items ADD COLUMN ${name} ${type}`);
}

// P5d: the card's own-language title is `title_local` (it was `title_id`). The rename happens once,
// in a transaction, after a copy of the database file; an in-memory database is not copied.
export function migrateTitleColumn(database, { file = DB_FILE } = {}) {
  const columns = new Set(database.prepare('PRAGMA table_info(items)').all().map((c) => c.name));
  if (!columns.has('title_id') || columns.has('title_local')) return false;
  if (file !== ':memory:') {
    try {
      fs.copyFileSync(file, `${file}.pre-title-local.bak`);
    } catch (error) {
      console.warn(`[fresh] could not back up the database before the title column rename: ${error.code ?? 'copy failed'}`);
    }
  }
  database.exec('BEGIN');
  try {
    database.exec('ALTER TABLE items RENAME COLUMN title_id TO title_local');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return true;
}
migrateTitleColumn(db);

db.exec('CREATE INDEX IF NOT EXISTS items_triage ON items (status, triaged)');

const q = (sql) => db.prepare(sql);
const stmts = {
  get: q('SELECT * FROM items WHERE id = ?'),
  exists: q('SELECT id FROM items WHERE id = ?'),
  insert: q(`INSERT OR IGNORE INTO items (id, url, title, source, cat, published, first_seen, score, outlets, also, meta, sig, status, kind, flag)
             VALUES (@id, @url, @title, @source, @cat, @published, @first_seen, @score, @outlets, @also, @meta, @sig, @status, @kind, @flag)`),
  recent: q('SELECT id, title, sig, source, outlets, also FROM items WHERE first_seen > ?'),
  corroborate: q('UPDATE items SET outlets = ?, also = ?, score = score + 0.4 WHERE id = ?'),
  window: q("SELECT id, title, source, cat, status, score, outlets, also, image, llm, ready_at, read_at, seen_at, saved, topics FROM items WHERE status IN ('new','ready') AND hidden = 0 AND first_seen > ?"),
  dup: q("UPDATE items SET status = 'dup' WHERE id = ? AND saved = 0 AND seen_at IS NULL"), // a card the reader has seen or saved is never folded away
  pending: q("SELECT * FROM items WHERE status = 'new' AND triaged = 1 ORDER BY (source IN ('x', 'w-x')) DESC, score DESC LIMIT ?"),
  ready: q(`UPDATE items SET status = 'ready', title_local = @title_local, summary = @summary, why = @why, topics = @topics, image = @image, llm = @llm, ready_at = @ready_at, writer = @writer WHERE id = @id`),
  drop: q("UPDATE items SET status = 'skip' WHERE id = ?"),
  setFlag: { saved: q('UPDATE items SET saved = ?, saved_at = ? WHERE id = ?'), hidden: q('UPDATE items SET hidden = ? WHERE id = ?'), read: q('UPDATE items SET read_at = ? WHERE id = ?') },
  setReader: q('UPDATE items SET reader = ? WHERE id = ?'),
  health: q(`INSERT INTO health (source, ok, last_ok, fails, error, count) VALUES (@source, @ok, @last_ok, @fails, @error, @count)
             ON CONFLICT(source) DO UPDATE SET ok = @ok, last_ok = coalesce(@last_ok, last_ok), fails = CASE WHEN @ok = 1 THEN 0 ELSE fails + 1 END, error = @error, count = @count`),
  healthAll: q('SELECT * FROM health'),
  purge: q('DELETE FROM items WHERE first_seen < ? AND saved = 0'),
};

export const getItem = (id) => stmts.get.get(id);
export const hasItem = (id) => Boolean(stmts.exists.get(id));
export const insertCandidate = (row) => stmts.insert.run({ kind: null, flag: null, ...row });
export const recentSigs = (since) => stmts.recent.all(since);
export const corroborate = (id, outlets, also) => stmts.corroborate.run(outlets, JSON.stringify(also), id);
export const windowItems = (since) => stmts.window.all(since);
export const markDup = (id) => stmts.dup.run(id);
export const pendingItems = (limit) => stmts.pending.all(limit);
export const markReady = (row) => stmts.ready.run({ writer: null, ...row, ready_at: Date.now() });
export const markSkipped = (id) => stmts.drop.run(id);
export const setReader = (id, text) => stmts.setReader.run(text, id);
export const recordHealth = (source, ok, error, count) => stmts.health.run({ source, ok: ok ? 1 : 0, fails: ok ? 0 : 1, last_ok: ok ? Date.now() : null, error: error ? String(error).slice(0, 160) : null, count });
export const healthAll = () => stmts.healthAll.all();
export const purge = (before) => stmts.purge.run(before);
export function setFlag(kind, id, value) {
  if (kind === 'saved') stmts.setFlag.saved.run(value ? 1 : 0, value ? Date.now() : null, id);
  else if (kind === 'hidden') stmts.setFlag.hidden.run(value ? 1 : 0, id);
  else stmts.setFlag.read.run(Date.now(), id);
}

// A page of the timeline, newest first. cursor = "published:id" of the last item seen.
export function page({ cat = '', saved = false, cursor = '', limit = 12 } = {}) {
  const where = ["status = 'ready'", 'hidden = 0'];
  const args = [];
  if (saved) where.push('saved = 1');
  if (cat) { where.push('cat = ?'); args.push(cat); }
  const order = saved ? 'saved_at DESC, id DESC' : 'published DESC, id DESC';
  if (cursor) {
    const [ts, id] = cursor.split(':');
    if (saved) { where.push('(saved_at < ? OR (saved_at = ? AND id < ?))'); args.push(Number(ts), Number(ts), id); }
    else { where.push('(published < ? OR (published = ? AND id < ?))'); args.push(Number(ts), Number(ts), id); }
  }
  const rows = db.prepare(`SELECT id, url, title, title_local, summary, why, topics, source, cat, published, outlets, also, image, meta, llm, saved, saved_at, read_at, seen_at, flag, kind FROM items WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...args, limit + 1);
  const more = rows.length > limit;
  return { rows: rows.slice(0, limit), more };
}
export const countSince = (since) => db.prepare("SELECT count(*) AS n FROM items WHERE status = 'ready' AND hidden = 0 AND ready_at > ?").get(since).n;
// New ready cards since a time, by category (for the "new feed ready" notification), and the candidates of a gathering cycle still waiting.
export const readyByCat = (since) => db.prepare("SELECT cat, count(*) AS n FROM items WHERE status = 'ready' AND hidden = 0 AND ready_at > ? GROUP BY cat ORDER BY n DESC").all(since);
export const cycleQueue = (since) => db.prepare("SELECT count(*) AS n FROM items WHERE status = 'new' AND first_seen >= ?").get(since).n;
export const newestReady = () => db.prepare("SELECT max(ready_at) AS t, count(*) AS n FROM items WHERE status = 'ready' AND hidden = 0").get();
export const dailyCount = (since) => db.prepare("SELECT count(*) AS n FROM items WHERE status = 'ready' AND first_seen > ?").get(since).n;
export const stats = () => db.prepare("SELECT count(*) AS total, sum(status = 'ready') AS ready, sum(saved) AS saved FROM items").get();

// ---------- v2: triage, seen, signals, snapshots, small state ----------
export const kvGet = (k, fallback = null) => { try { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? JSON.parse(r.v) : fallback; } catch { return fallback; } };
export const kvSet = (k, v) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));

// Stories waiting for a model to look at them (category, taste, deals/spam), best prior first.
export const untriaged = (limit) => db.prepare("SELECT id, title, source, cat, score, meta, kind FROM items WHERE status = 'new' AND triaged = 0 ORDER BY score DESC LIMIT ?").all(limit);
export function setTriage(id, { cat, rel, ban, status, flag }) {
  db.prepare('UPDATE items SET cat = coalesce(?, cat), rel = ?, ban = ?, triaged = 1, status = ?, flag = coalesce(?, flag) WHERE id = ?').run(cat ?? null, rel, ban, status, flag ?? null, id);
}
export const setRel = (id, rel) => db.prepare('UPDATE items SET rel = ? WHERE id = ?').run(rel, id);
export const setScore = (id, score) => db.prepare('UPDATE items SET score = ? WHERE id = ?').run(score, id);
export const markSeen = (ids) => { const s = db.prepare('UPDATE items SET seen_at = coalesce(seen_at, ?) WHERE id = ?'); const now = Date.now(); for (const id of ids) s.run(now, id); };
export const sourceOf = (id) => db.prepare('SELECT source, meta FROM items WHERE id = ?').get(id);

// What ranking looks at: every ready, visible story from the last few days.
export const rankPool = (since, cat = '') => db.prepare(`SELECT id, cat, source, published, ready_at, score, rel, outlets, topics, seen_at, read_at, saved, meta, flag, kind, thread FROM items WHERE status = 'ready' AND hidden = 0 AND published > ? ${cat ? 'AND cat = ?' : ''}`).all(...(cat ? [since, cat] : [since]));
export function rowsByIds(ids) {
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT id, url, title, title_local, summary, why, topics, source, cat, published, outlets, also, image, meta, llm, saved, saved_at, read_at, seen_at, flag, kind, hidden, status FROM items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r) => r && r.status === 'ready' && !r.hidden);
}
export const savedPage = (cursor, limit) => page({ saved: true, cursor, limit });
// Ready, unseen stories per category (the X scheduler pays only when the pool is running low).
export const unseenReady = (cats, since) => db.prepare(`SELECT count(*) AS n FROM items WHERE status = 'ready' AND hidden = 0 AND seen_at IS NULL AND published > ? AND cat IN (${cats.map(() => '?').join(',')})`).get(since, ...cats).n;
// Ready, unseen cards of one language (a language-restricted source's own stock).
export const unseenLang = (lang, since) => db.prepare("SELECT count(*) AS n FROM items WHERE status = 'ready' AND hidden = 0 AND seen_at IS NULL AND published > ? AND json_extract(meta, '$.lang') = ?").get(since, lang).n;
export const statusCounts = () => Object.fromEntries(db.prepare('SELECT status, count(*) AS n FROM items GROUP BY status').all().map((r) => [r.status, r.n]));
export const recentTitles = (cats, since, limit = 20) => db.prepare(`SELECT coalesce(title_local, title) AS t FROM items WHERE status IN ('ready','new') AND first_seen > ? AND cat IN (${cats.map(() => '?').join(',')}) ORDER BY first_seen DESC LIMIT ?`).all(since, ...cats, limit).map((r) => r.t);
export const sourceStats = (source, since) => db.prepare("SELECT sum(status = 'ready') AS ready, sum(status = 'skip') AS skipped FROM items WHERE source = ? AND first_seen > ?").get(source, since);

export function addSignal(id, kind, ms) { db.prepare('INSERT INTO signals (id, kind, ms, at) VALUES (?, ?, ?, ?)').run(id, kind, ms ?? null, Date.now()); }
export const signalCount = (since) => db.prepare('SELECT count(*) AS n FROM signals WHERE at > ?').get(since).n;
export const signalSeen = (id, kind, since) => Boolean(db.prepare('SELECT 1 FROM signals WHERE id = ? AND kind = ? AND at > ?').get(id, kind, since));
export const signalTotals = (since) => db.prepare('SELECT kind, count(*) AS n FROM signals WHERE at > ? GROUP BY kind').all(since);

export function saveSnapshot(id, cat, ids) {
  db.prepare('INSERT OR REPLACE INTO snapshots (id, created, cat, ids) VALUES (?, ?, ?, ?)').run(id, Date.now(), cat, JSON.stringify(ids));
  db.prepare('DELETE FROM snapshots WHERE created < ?').run(Date.now() - 6 * 3_600_000);
}
export const loadSnapshot = (id) => { const r = db.prepare('SELECT ids FROM snapshots WHERE id = ?').get(id); return r ? JSON.parse(r.ids) : null; };
export const readyBetween = (from, to) => db.prepare("SELECT count(*) AS n FROM items WHERE status = 'ready' AND hidden = 0 AND ready_at > ? AND ready_at <= ?").get(from, to).n;
export const bumpTries = (id) => db.prepare("UPDATE items SET meta = json_set(coalesce(meta, '{}'), '$.tries', coalesce(json_extract(meta, '$.tries'), 0) + 1) WHERE id = ?").run(id);
export const queueSizes = () => db.prepare("SELECT sum(status = 'new' AND triaged = 0) AS untriaged, sum(status = 'new' AND triaged = 1) AS pending FROM items").get();
export const trimSignals = (before) => db.prepare('DELETE FROM signals WHERE at < ?').run(before);

// ---------- story threads (threads.js) ----------
// items.thread: NULL = not looked at yet, '' = a story of its own, otherwise the id of the first card of the ongoing story.
export const threadCandidates = (since, limit) => db.prepare("SELECT id, title, source, cat, status, thread, published, also, outlets, meta, kind FROM items WHERE thread IS NULL AND hidden = 0 AND saved = 0 AND published > ? AND ((status = 'new' AND triaged = 1) OR (status = 'ready' AND seen_at IS NULL AND read_at IS NULL)) ORDER BY published ASC LIMIT ?").all(since, limit);
export const threadKnown = (since, limit) => db.prepare("SELECT id, title, source, cat, status, thread FROM items WHERE status = 'ready' AND hidden = 0 AND (thread IS NOT NULL AND thread != '' OR seen_at IS NOT NULL OR read_at IS NOT NULL OR saved = 1) AND published > ? ORDER BY published DESC LIMIT ?").all(since, limit);
export const setThread = (id, thread) => db.prepare('UPDATE items SET thread = ? WHERE id = ?').run(thread, id);
export const threadSize = (tid) => db.prepare("SELECT count(*) AS n FROM items WHERE (id = ? OR thread = ?) AND status IN ('ready', 'new')").get(tid, tid).n;
export const recentFromSource = (source, since) => db.prepare("SELECT count(*) AS n FROM items WHERE source = ? AND first_seen > ? AND status != 'skip'").get(source, since).n;

// ---------- GitHub star snapshots (github.js): star velocity is the hype signal ----------
export const starAdd = (repo, at, stars) => db.prepare('INSERT OR REPLACE INTO repo_stars (repo, at, stars) VALUES (?, ?, ?)').run(repo, at, stars);
export const starsOf = (repo, since) => db.prepare('SELECT at, stars FROM repo_stars WHERE repo = ? AND at > ? ORDER BY at ASC').all(repo, since);
export const starsLastAt = (repo) => db.prepare('SELECT max(at) AS t FROM repo_stars WHERE repo = ?').get(repo).t ?? 0;
export const starsTracked = (since, limit) => db.prepare('SELECT repo, max(at) AS last, max(stars) AS stars FROM repo_stars GROUP BY repo HAVING last > ? ORDER BY stars DESC LIMIT ?').all(since, limit);
export const starsPurge = (before) => db.prepare('DELETE FROM repo_stars WHERE at < ?').run(before);
// Cards about the same repository, whatever the URL looks like (/tree/main, .git, www, other case).
export function itemsByRepo(repo) {
  const r = repo.toLowerCase();
  return db.prepare("SELECT id, status, also, outlets, source FROM items WHERE lower(url) IN (?, ?, ?) OR lower(url) LIKE ? OR lower(url) LIKE ? OR lower(url) LIKE ?")
    .all(`https://github.com/${r}`, `https://www.github.com/${r}`, `https://github.com/${r}.git`, `https://github.com/${r}/%`, `https://github.com/${r}?%`, `https://www.github.com/${r}/%`);
}
// Adds fields to a card's meta (the GitHub numbers of a repo that another outlet already carded).
export function mergeMeta(id, fields) {
  const row = db.prepare('SELECT meta FROM items WHERE id = ?').get(id);
  if (!row) return;
  let meta = {};
  try { meta = JSON.parse(row.meta ?? '{}'); } catch { /* start over */ }
  db.prepare('UPDATE items SET meta = ? WHERE id = ?').run(JSON.stringify({ ...meta, ...fields }), id);
}

// ---------- glossary (term -> keep in English | <code>:<rendering>; source jev | owner | seed) ----------
export const glossaryAll = () => db.prepare('SELECT term, decision, source, bad, form, hits, updated_at FROM glossary ORDER BY term').all();
export const glossaryGet = (term) => db.prepare('SELECT term, decision, source, bad, form, hits, updated_at FROM glossary WHERE term = ?').get(term) ?? null;
// replace: false leaves an existing row alone (seed and System One never overwrite what is already decided)
export function glossaryPut({ term, decision, source, bad = null, form = null }, replace = true) {
  const now = Date.now();
  const sql = replace
    ? 'INSERT INTO glossary (term, decision, source, bad, form, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(term) DO UPDATE SET decision = excluded.decision, source = excluded.source, bad = coalesce(excluded.bad, bad), form = coalesce(excluded.form, form), updated_at = excluded.updated_at'
    : 'INSERT OR IGNORE INTO glossary (term, decision, source, bad, form, updated_at) VALUES (?, ?, ?, ?, ?, ?)';
  return db.prepare(sql).run(term, decision, source, bad ? JSON.stringify(bad) : null, form, now);
}
export const glossaryHit = (terms) => { const s = db.prepare('UPDATE glossary SET hits = hits + 1 WHERE term = ?'); for (const t of terms) s.run(t); };
