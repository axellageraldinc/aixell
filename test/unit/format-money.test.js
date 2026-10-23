import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsd, fmtMoney } from '../../public/lib/format.js';

test('fmtUsd and fmtMoney accept zero fraction digits', () => {
  assert.equal(fmtUsd(0, 0), '$0');
  assert.equal(fmtMoney(1234.5, undefined, 0), '$1,235');
  assert.equal(fmtUsd(1.5), '$1.50');
});
