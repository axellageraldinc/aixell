import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/fetch-guard.js';
import { networkViolations } from '../helpers/fetch-guard.js';

test('fetch to a non-local host fails before any connection is made', async () => {
  await assert.rejects(() => fetch('https://example.com/'), /network guard/);
  await assert.rejects(() => fetch(new URL('http://192.0.2.1/')), /network guard/);
  assert.equal(networkViolations().length, 2);
});

test('fetch to localhost is allowed through (connection refused is fine)', async () => {
  await assert.rejects(() => fetch('http://127.0.0.1:1/'), (error) => !/network guard/.test(error.message));
});
