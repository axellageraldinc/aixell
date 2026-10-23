#!/usr/bin/env node
// Starts Fresh from zero: copies data/fresh/ to data/fresh-backup-<YYYYMMDD-HHMM>/ (once), then deletes the feed database,
// pictures, settings (custom sources, switched-off sources, X switch), topics and weights, saved stories and every other bit of
// learned state. Kept: the ingest token, data/steam.json, data/bluesky.json, data/threads.json and the X ledger (data/fresh-x.json,
// so the day's paid-call budget survives a reset).
//
//   node scripts/fresh-reset.mjs [--dry-run]       (stop the service first: systemctl --user stop aixell)
//
// Respects HERMES_WEB_DATA_DIR. Safe to run twice: an existing backup of the same minute is not overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
const KEEP = new Set(['ingest-token']);

export function resetFresh({ dataDir = process.env.HERMES_WEB_DATA_DIR || path.join(root, 'data'), dryRun = false, now = new Date() } = {}) {
  const fresh = path.join(dataDir, 'fresh');
  const backup = path.join(dataDir, `fresh-backup-${stamp(now)}`);
  const report = { fresh, backup, copied: false, removed: [], kept: [], dryRun };
  if (!fs.existsSync(fresh)) return report;
  if (!fs.existsSync(backup)) {
    if (!dryRun) fs.cpSync(fresh, backup, { recursive: true, errorOnExist: true, preserveTimestamps: true });
    report.copied = true;
  }
  // Never delete anything unless a backup exists.
  if (!dryRun && !fs.existsSync(backup)) throw new Error('backup missing, nothing deleted');
  for (const name of fs.readdirSync(fresh)) {
    if (KEEP.has(name)) { report.kept.push(name); continue; }
    if (!dryRun) fs.rmSync(path.join(fresh, name), { recursive: true, force: true });
    report.removed.push(name);
  }
  if (!dryRun) fs.mkdirSync(path.join(fresh, 'img'), { recursive: true, mode: 0o700 });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = resetFresh({ dryRun: process.argv.includes('--dry-run') });
  console.log(`${r.dryRun ? '[dry run] ' : ''}Fresh reset in ${r.fresh}`);
  console.log(`backup: ${r.copied ? 'made' : 'already there'} -> ${r.backup}`);
  console.log(`removed: ${r.removed.join(', ') || '(nothing)'}`);
  console.log(`kept: ${r.kept.join(', ') || '(nothing)'}`);
  console.log("Start the service again; the first gather fills the pool with ~30 cards within a few minutes.");
}
