// The push connector: the validation and normalisation the ingest route applies to a posted batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const { ingest, normalizeItems, itemsOf } = await import('../../src/connectors/ingest.js');
const { validateConnector } = await import('../../src/connectors/contract.js');
const { PRIMARY_CAT } = await import('../../src/fresh/profile.js');

test('ingest: the connector is valid and marked push', () => {
  assert.deepEqual(validateConnector(ingest), []);
  assert.equal(ingest.push, true);
  assert.equal(ingest.type, 'ingest');
  assert.equal(typeof ingest.fetch, 'undefined');
});

test('ingest: itemsOf accepts only an array', () => {
  assert.deepEqual(itemsOf({ items: [1, 2] }), [1, 2]);
  assert.deepEqual(itemsOf({ items: 'nope' }), []);
  assert.deepEqual(itemsOf({}), []);
  assert.deepEqual(itemsOf(null), []);
});

test('ingest: a posted batch is normalised and filtered like before', () => {
  const out = normalizeItems([
    { source: 'my worker!', name: 'A worker', cat: 'security', title: '  A   spaced\n title ', url: 'https://example.com/a', text: 'snippet', ts: 1793000000, image: 'https://example.com/a.jpg', likes: 4 },
    { title: 'No url', url: 'not-a-url' },
    { title: 'No category', url: 'https://example.com/b', cat: 'nonsense', image: 'javascript:alert(1)' },
    'not an object',
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    source: 'w-myworker', name: 'A worker', cat: 'security', title: 'A spaced title', url: 'https://example.com/a',
    snippet: 'snippet', ts: 1793000000, image: 'https://example.com/a.jpg', meta: { likes: 4 },
  });
  assert.equal(out[1].cat, PRIMARY_CAT, 'an unknown category falls back to the primary category');
  assert.equal(out[1].source, 'w-worker', 'a missing source becomes the generic worker id');
  assert.equal(out[1].image, null, 'a non-http image is dropped');
});

test('ingest: at most 60 items are taken', () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ title: `T${i}`, url: `https://example.com/${i}` }));
  assert.equal(normalizeItems(many).length, 60);
});
