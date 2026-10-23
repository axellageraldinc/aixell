#!/usr/bin/env node
// Gives back the Fresh cards that thread folding (threads.js) or duplicate merging (dedupe.js) set aside by mistake, from the time
// before both were tightened: a card is "folded wrongly" when it was written (has a summary) and its first card (the thread head,
// or for a plain merge the best matching ready card) is in another category, is not on the timeline, or shares fewer than two
// significant words with it. Cards that no ready card explains at all are restored too. Those restored become 'ready' again, with
// thread '' (a story of its own).
//
//   node scripts/fresh-unfold.mjs                    dry run: lists what would come back, changes nothing
//   node scripts/fresh-unfold.mjs --apply            makes a copy of the database first (fresh.db.bak-unfold-<stamp>), then restores
//   node scripts/fresh-unfold.mjs --apply --include-unwritten   also sets wrongly folded cards WITHOUT a summary back to 'new' (written again by the queue)
//
// Respects HERMES_WEB_DATA_DIR (default: data/ next to this repo). Opens only the database file, never the lib modules.
// Cards the reader saved or hid are never touched. Safe to run twice.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sharedWords } from '../src/fresh/rank.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const stamp = (d = new Date()) => d.toISOString().replace(/[-:T]/g, '').slice(0, 12);

// -> { restored: [{ id, title, cat, why, to }], kept: number, db }
export function unfold({ dbFile = path.join(process.env.HERMES_WEB_DATA_DIR || path.join(root, 'data'), 'fresh', 'fresh.db'), apply = false, includeUnwritten = false, days = 7, now = Date.now() } = {}) {
  const db = new DatabaseSync(dbFile, { readOnly: !apply });
  const since = now - days * DAY;
  const dups = db.prepare("SELECT id, title, cat, summary, thread, published, seen_at FROM items WHERE status = 'dup' AND hidden = 0 AND saved = 0 AND published > ?").all(since);
  const ready = db.prepare("SELECT id, title, cat, published FROM items WHERE status = 'ready' AND hidden = 0").all();
  const byId = new Map(db.prepare('SELECT id, title, cat, status FROM items WHERE published > ?').all(since - 5 * DAY).map((r) => [r.id, r]));
  const restored = [];
  let kept = 0;
  for (const d of dups) {
    const written = Boolean(d.summary && d.summary.trim());
    let why = '';
    const head = d.thread && d.thread !== d.id ? byId.get(d.thread) : null;
    if (head) {
      if (head.status !== 'ready') why = `first card is ${head.status ?? 'gone'}`;
      else if (head.cat !== d.cat) why = `other category than its first card (${head.cat})`;
      else if (sharedWords(d.title, head.title) < 2) why = 'different event than its first card';
    } else if (d.thread && d.thread !== d.id) why = 'first card is gone';
    else if (written) {
      // A plain merge (no thread): some ready card of the same category and time must share a significant word with it (the merge itself was a model call, so only orphans are given back).
      const match = ready.some((r) => r.id !== d.id && r.cat === d.cat && Math.abs(r.published - d.published) < 4 * DAY && sharedWords(d.title, r.title) >= 1);
      if (!match) why = 'no ready card of the same event';
    }
    if (!why) { kept += 1; continue; }
    if (!written && !includeUnwritten) continue;
    restored.push({ id: d.id, title: d.title, cat: d.cat, why, to: written ? 'ready' : 'new', seen: Boolean(d.seen_at) });
  }
  let backup = '';
  if (apply && restored.length) {
    backup = `${dbFile}.bak-unfold-${stamp(new Date(now))}`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    const up = db.prepare("UPDATE items SET status = ?, thread = '' WHERE id = ? AND status = 'dup' AND saved = 0");
    for (const r of restored) up.run(r.to, r.id);
  }
  db.close();
  return { restored, kept, backup, dups: dups.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes('--apply');
  const r = unfold({ apply, includeUnwritten: process.argv.includes('--include-unwritten') });
  console.log(`${apply ? '' : '[dry run] '}${r.dups} dup cards in the last 7 days; ${r.kept} explained by a ready card; ${r.restored.length} ${apply ? 'restored' : 'would be restored'}`);
  for (const x of r.restored) console.log(`  -> ${x.to.padEnd(5)} [${x.cat}]${x.seen ? ' (seen)' : ''} ${x.title.slice(0, 80)}  | ${x.why}`);
  if (r.backup) console.log(`backup: ${r.backup}`);
  if (!apply && r.restored.length) console.log('Run again with --apply to restore them.');
}
