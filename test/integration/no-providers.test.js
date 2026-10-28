// With no providers configured the app still boots and Fresh still makes cards: the classifier falls back to the keyword
// heuristic, the writer has nothing to call, and after its tries a story goes out in the source's own words, untranslated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, waitFor } from '../helpers/boot.js';

const NO_PROVIDERS = JSON.stringify({ providers: {}, capabilities: {} });

const items = [
  { source: 'worker', name: 'Worker', cat: 'ai', title: 'A new open-weight model lands with a larger context window', url: 'https://example.com/one', text: 'The model is free to download and runs on a 12GB GPU with quantization.', ts: Date.now() },
  { source: 'worker', name: 'Worker', cat: 'security', title: 'Malicious npm package steals API keys from environment files', url: 'https://example.com/two', text: 'The package was removed after 400 downloads.', ts: Date.now() - 60_000 },
];

test('no providers: the app boots, capabilities are all false, and Fresh makes heuristic untranslated cards without throwing', async () => {
  const app = await boot({ seed: 0, env: { HERMES_WEB_FRESH_OFF: '0', HERMES_WEB_FRESH_OFFLINE: '1' }, files: { 'providers.json': NO_PROVIDERS } });
  try {
    const me = await app.login();
    const caps = await me.get('/api/capabilities');
    assert.equal(caps.status, 200);
    assert.deepEqual(caps.data, { writer: false, classifier: false, images: false, socialSearch: false, transcription: false, speech: false, models: false, usage: false });

    const { token } = (await me.get('/api/fresh/ingest-token')).data;
    const ingest = await fetch(`${app.base}/api/fresh/ingest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ items }),
    });
    assert.equal(ingest.status, 200);
    assert.equal((await ingest.json()).received, 2);

    // The first rounds count the tries; the third puts the stories out in their own words.
    const cards = await waitFor(async () => {
      const page = await me.get('/api/fresh?mode=latest&limit=30');
      const mine = page.data.items.filter((i) => i.url.startsWith('https://example.com/'));
      return mine.length >= 2 ? mine : null;
    }, { timeoutMs: 20_000, what: 'two untranslated cards' });
    for (const card of cards) {
      assert.equal(card.translated, false, 'no writer, so the card is not a translation');
      assert.ok(card.title, 'the card keeps the source title');
      assert.equal(card.summary.length > 0, true, 'the card keeps the source snippet as its summary');
      assert.equal(typeof card.cat, 'string');
    }
    assert.ok(cards.some((c) => c.original.includes('open-weight')), 'the source title is kept');
    // The heuristic still judged the stories: the AI one is not hidden and nothing threw.
    const status = await me.get('/api/fresh/status');
    assert.equal(status.status, 200);
    assert.equal(status.data.llm.paid, 0);
    assert.equal(status.data.llm.free, 0);
    assert.equal(/Error|error:/.test(app.log()) && /fresh\] .*failed/.test(app.log()), false, `no Fresh failure in the log:\n${app.log()}`);
  } finally { await app.stop(); }
});
