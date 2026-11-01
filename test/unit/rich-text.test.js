// The story card's inline formatting: markers become styled runs, a lone marker stays as typed, markers nest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, visibleText } from '../../public/lib/rich-text.js';

const flags = (r) => `${r.b ? 'b' : ''}${r.i ? 'i' : ''}${r.u ? 'u' : ''}${r.s ? 's' : ''}`;

test('each marker styles its words, the rest stays plain', () => {
  const runs = parseInline('a **bold** b *it* c __under__ d ~~gone~~');
  assert.deepEqual(runs.map((r) => [r.text, flags(r)]), [['a ', ''], ['bold', 'b'], [' b ', ''], ['it', 'i'], [' c ', ''], ['under', 'u'], [' d ', ''], ['gone', 's']]);
});

test('markers nest', () => {
  assert.deepEqual(parseInline('**a __b__ c**').map((r) => [r.text, flags(r)]), [['a ', 'b'], ['b', 'bu'], [' c', 'b']]);
});

test('a marker without its twin is shown as typed', () => {
  assert.equal(visibleText('5 * 3 and 4 * 5, snake_case and __open and a ** b'), '5 * 3 and 4 * 5, snake_case and __open and a ** b');
});

test('the visible text drops only the markers that pair up', () => {
  assert.equal(visibleText('**x** __y__ ~~z~~ *w*'), 'x y z w');
});
