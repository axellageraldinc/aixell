// Per-instance key/value state for a connector.
//
//   const state = stateFor('bluesky')
//   state.get('bluesky-since', 0)   // reads 'bluesky:bluesky-since', else the legacy 'bluesky-since'
//   state.set('bluesky-since', now) // writes 'bluesky:bluesky-since'
//
// The store is the Fresh kv table (src/fresh/store.js). The prefix keeps two instances of the
// same connector apart. The unprefixed key is read as a fallback so a deployment that ran the
// pre-connector code keeps its cursors (the Bluesky `since` key, the learned X handles, ...);
// writes always go to the prefixed key.
import * as store from '../fresh/store.js';

const PREFIX_SEPARATOR = ':';
const MISSING = Symbol('missing');

export function stateFor(instanceId) {
  const id = String(instanceId ?? '');
  const prefix = `${id}${PREFIX_SEPARATOR}`;
  return {
    id,
    get(key, fallback = null) {
      const name = String(key);
      const prefixed = store.kvGet(`${prefix}${name}`, MISSING);
      if (prefixed !== MISSING) return prefixed;
      return store.kvGet(name, fallback);
    },
    set(key, value) {
      store.kvSet(`${prefix}${String(key)}`, value);
      return value;
    },
    // The raw prefixed name, for diagnostics and tests.
    key: (key) => `${prefix}${String(key)}`,
  };
}
