// Documentation checks: README links resolve, documented config keys exist, no owner strings in public files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from '../../src/config/schema.js';
import { COUNTRY_RE, REPO_WORDS_RE } from '../helpers/indonesian.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IN_GIT = (() => {
  try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'ignore' }); return true; } catch { return false; }
})();
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('every relative link in README.md resolves to a file or directory', () => {
  const text = read('README.md');
  const broken = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    const file = target.split('#')[0];
    if (file && !fs.existsSync(path.join(ROOT, file))) broken.push(target);
  }
  assert.deepEqual(broken, []);
});

test('config keys named in docs/configuration.md are known to the loader schema', () => {
  const text = read('docs/configuration.md');
  const section = text.split(/^## Keys$/m)[1]?.split(/^## /m)[0] ?? '';
  const keys = [...section.matchAll(/^\|\s*`([A-Za-z][\w.]*)`\s*\|/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 10, 'expected the Keys table to list the config keys');
  for (const key of keys) {
    const nested = key.split('.').reduceRight((inner, part) => ({ [part]: inner }), true);
    const { warnings } = validate(nested);
    const unknown = warnings.filter((w) => /unknown key/.test(w));
    assert.deepEqual(unknown, [], `documented key "${key}" is not in the schema`);
  }
});

test('config keys in config.example.json are known to the loader schema', () => {
  const example = JSON.parse(read('config.example.json'));
  const { errors, warnings } = validate(example);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.filter((w) => /unknown key/.test(w)), []);
});

// Owner-specific strings must not appear in tracked public files.
const NAME_RE = /wongjava|wongjvm|axell|babu|192\.168/i;
const HOME_RE = /\/home\//;
const EXCLUDED = [/^docs\/dev\//, /^\.claude\//, /^data\//, /^config\.json$/, /^hermes-profile\//, /^public\/vendor\//, /^ui-build\/package-lock\.json$/, /^test\/unit\/docs\.test\.js$/];
// Allowed generic hits: the file and the exact substring.
const ALLOWED = [
  { file: 'README.md', text: 'github.com/axellageraldinc/aixell' }, // the public repository URL
  { file: 'README.md', text: 'Copyright (C) 2026 Axell.' }, // the copyright holder, decided by the owner
  { file: 'package.json', text: '"author": "Axell"' },
  { file: 'server.js', text: '/home/user/.hermes/profiles/agent/audio_out/voice.mp3' },
];

test('tracked public files contain no owner-specific strings', { skip: !IN_GIT && 'not a git checkout' }, () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = [];
  for (const file of files) {
    if (EXCLUDED.some((re) => re.test(file))) continue;
    if (/\.(png|woff2?|ico|jpg|jpeg|gif|webp|mp3|mp4)$/i.test(file)) continue;
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) continue; // staged for deletion
    let text = fs.readFileSync(abs, 'utf8');
    for (const a of ALLOWED) if (a.file === file) text = text.split(a.text).join('');
    text.split('\n').forEach((line, i) => {
      if (NAME_RE.test(line) || HOME_RE.test(line)) hits.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

// The repository is English only: no Indonesian words and no country-specific names in tracked public files. It also
// names no particular hosted gateway: provider-specific code lives in drop-ins under data/providers.
// The only file allowed to hold the word lists themselves is the helper that defines them.
const NON_ENGLISH_ALLOWED = [
  /^test\/helpers\/indonesian\.js$/, // the word lists themselves
];
const GATEWAY_RE = /kenari/i;

test('tracked public files are English only', { skip: !IN_GIT && 'not a git checkout' }, () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = [];
  for (const file of files) {
    if (EXCLUDED.some((re) => re.test(file)) || NON_ENGLISH_ALLOWED.some((re) => re.test(file))) continue;
    if (/\.(png|woff2?|ico|jpg|jpeg|gif|webp|mp3|mp4)$/i.test(file)) continue;
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) continue; // staged for deletion
    fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
      if (COUNTRY_RE.test(line) || REPO_WORDS_RE.test(line) || GATEWAY_RE.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, []);
});
