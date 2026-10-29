import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveItems, setProbe } from '../../src/fresh/links.js';

const xItem = (url, post = '') => ({ url, title: 't', meta: { via: 'x', post } });

test('resolveItems: a dead link written by the search model is dropped, or falls back to the X post', async () => {
  setProbe(async (url) => url.includes('/gone'));
  try {
    const out = await resolveItems([
      xItem('https://github.com/a/gone'),
      xItem('https://github.com/b/gone', 'https://x.com/b/status/1'),
      xItem('https://github.com/c/alive'),
      { url: 'https://example.com/gone', title: 'feed', meta: { via: 'rss' } },
    ]);
    assert.deepEqual(out.map((i) => i.url), ['https://x.com/b/status/1', 'https://github.com/c/alive', 'https://example.com/gone']);
  } finally { setProbe(null); }
});
