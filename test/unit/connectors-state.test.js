// The per-instance KV of a connector context: `<instanceId>:` prefixed keys, with the unprefixed key
// read as a legacy fallback (a deployment that ran the pre-connector code keeps its cursors).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const { stateFor } = await import('../../src/connectors/state.js');
const store = await import('../../src/fresh/store.js');

// Each test uses its own instance ids, so the shared kv table of the test process cannot leak
// between them (the store has no delete).
let n = 0;
const freshId = (prefix) => `${prefix}-${process.pid}-${n += 1}`;

test('state: a write goes to the prefixed key, and only that instance sees it', () => {
  const a = stateFor(freshId('a'));
  const b = stateFor(freshId('b'));
  a.set('value', 42);
  assert.equal(a.get('value'), 42);
  assert.equal(b.get('value'), null, 'another instance does not see it');
  assert.equal(store.kvGet(a.key('value')), 42);
  assert.equal(store.kvGet(b.key('value')), null);
});

test('state: the legacy unprefixed key is read when the prefixed one is missing', () => {
  const id = freshId('bluesky');
  store.kvSet('bluesky-since', 1234);
  const state = stateFor(id);
  assert.equal(state.get('bluesky-since'), 1234, 'the pre-connector cursor still works');
  state.set('bluesky-since', 5678);
  assert.equal(state.get('bluesky-since'), 5678);
  assert.equal(store.kvGet(state.key('bluesky-since')), 5678);
  assert.equal(store.kvGet('bluesky-since'), 1234, 'the legacy key is left alone');
});

test('state: the fallback is per key, and the prefix helper shows the raw name', () => {
  store.kvSet('x-handles', { allowed: ['legacy'] });
  const id = freshId('x');
  const state = stateFor(id);
  assert.deepEqual(state.get('x-handles'), { allowed: ['legacy'] });
  assert.equal(state.get('missing', 'fallback'), 'fallback');
  assert.equal(state.key('x-handles'), `${id}:x-handles`);
  const other = stateFor(freshId('x'));
  other.set('x-handles', { allowed: ['other'] });
  assert.deepEqual(other.get('x-handles'), { allowed: ['other'] });
  assert.deepEqual(state.get('x-handles'), { allowed: ['legacy'] }, 'the two instances do not share the key');
});

test('state: a stored null is a value, not a miss', () => {
  const state = stateFor(freshId('a'));
  store.kvSet('bluesky-since', 1);
  state.set('bluesky-since', null);
  assert.equal(state.get('bluesky-since'), null, 'an explicit null wins over the legacy key');
});
