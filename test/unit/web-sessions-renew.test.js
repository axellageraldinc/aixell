import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSessionStore } from '../../src/web-sessions.js';

const DAY = 86_400_000;
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-sessions-'));
  const clock = { t: 1_700_000_000_000 };
  const store = createSessionStore({ file: path.join(dir, 's.json'), days: 90, maxAgeDays: 365, now: () => clock.t });
  return { dir, clock, store };
};

test('a session is renewed at most hourly, and the caller is told so the cookie can follow', () => {
  const { dir, clock, store } = fixture();
  try {
    const { token } = store.create({ ip: '1.1.1.1', userAgent: 'x' });
    assert.equal(store.get(token).renewed, false, 'fresh session: nothing to renew yet');
    clock.t += 2 * 3_600_000;
    const renewed = store.get(token);
    assert.equal(renewed.renewed, true);
    assert.equal(renewed.expiresAt, clock.t + 90 * DAY);
    assert.equal(store.get(token).renewed, false, 'not again within the hour');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unused session ends after the sliding window; a used one lasts up to the absolute limit', () => {
  const { dir, clock, store } = fixture();
  try {
    const idle = store.create({ ip: '1.1.1.1', userAgent: 'x' }).token;
    const used = store.create({ ip: '1.1.1.1', userAgent: 'y' }).token;
    for (let day = 0; day < 300; day += 30) { clock.t += 30 * DAY; assert.ok(store.get(used), `day ${day + 30}`); }
    assert.equal(store.get(idle), null, 'idle for over 90 days');
    clock.t += 90 * DAY;
    assert.equal(store.get(used), null, 'past the 365-day absolute limit');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
