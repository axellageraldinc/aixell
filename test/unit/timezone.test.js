// One time zone from config (P5d): day keys and quiet-hour minutes come from `config.timezone`, and
// nothing in src/ hard-codes a zone any more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../helpers/env.js';
const { config } = await import('../../src/config.js');
const { timezone, dayKey, minutesOfDay } = await import('../../src/time.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the time zone comes from config and defaults to UTC in the tests', () => {
  assert.equal(timezone(), config.timezone);
  assert.equal(typeof config.timezone, 'string');
});

test('dayKey follows the configured zone, including across midnight', () => {
  const saved = config.timezone;
  try {
    config.timezone = 'UTC';
    assert.equal(dayKey(Date.UTC(2026, 0, 2, 0, 30)), '2026-01-02');
    config.timezone = 'Pacific/Kiritimati'; // UTC+14: the same instant is already the next day there
    assert.equal(dayKey(Date.UTC(2026, 0, 2, 0, 30)), '2026-01-02');
    config.timezone = 'Pacific/Honolulu'; // UTC-10: the same instant is still the day before there
    assert.equal(dayKey(Date.UTC(2026, 0, 2, 0, 30)), '2026-01-01');
  } finally {
    config.timezone = saved;
  }
});

test('minutesOfDay is minutes since midnight in the configured zone', () => {
  const saved = config.timezone;
  try {
    config.timezone = 'UTC';
    assert.equal(minutesOfDay(Date.UTC(2026, 0, 2, 13, 45)), 13 * 60 + 45);
    config.timezone = 'Europe/Berlin';
    assert.equal(minutesOfDay(Date.UTC(2026, 0, 2, 13, 45)), 14 * 60 + 45, 'winter time is UTC+1');
  } finally {
    config.timezone = saved;
  }
});

test('no module under src/ names a time zone of its own', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      const text = fs.readFileSync(full, 'utf8');
      const zone = text.match(/['"`](?:Asia|Europe|America|Africa|Australia|Pacific)\/[A-Z][A-Za-z_]+/);
      if (zone) offenders.push(`${rel}: hard-codes the time zone ${zone[0].slice(1)}`);
      if (/toLocaleDateString\('sv-SE'/.test(text)) offenders.push(`${rel}: hard-codes a day-key locale`);
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(offenders, []);
});

test('quiet hours follow the configured zone', async () => {
  const { inQuiet } = await import('../../src/fresh/notify.js');
  const saved = config.timezone;
  try {
    config.timezone = 'UTC';
    const quiet = { on: true, from: '23:00', to: '07:00' };
    assert.equal(inQuiet(quiet, Date.UTC(2026, 0, 2, 23, 30)), true);
    assert.equal(inQuiet(quiet, Date.UTC(2026, 0, 2, 12, 0)), false);
    assert.equal(inQuiet({ ...quiet, on: false }, Date.UTC(2026, 0, 2, 23, 30)), false);
    // 12:00 UTC is 13:00 in Berlin (UTC+1 in January), so it is outside the same quiet hours there.
    config.timezone = 'Europe/Berlin';
    assert.equal(inQuiet(quiet, Date.UTC(2026, 0, 2, 12, 0)), false);
    assert.equal(inQuiet(quiet, Date.UTC(2026, 0, 2, 23, 30)), true, '23:30 UTC is 00:30 in Berlin, inside the quiet hours');
    assert.equal(inQuiet(quiet, Date.UTC(2026, 0, 2, 21, 30)), false, '21:30 UTC is 22:30 in Berlin, before they start');
    assert.equal(inQuiet(quiet, Date.UTC(2026, 0, 2, 22, 30)), true, '22:30 UTC is 23:30 in Berlin');
  } finally {
    config.timezone = saved;
  }
});
