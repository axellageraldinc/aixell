// A second instance that has only a local OpenAI-compatible server: the classifier is derived from the chat model
// (llm-classifier), the writer is that same model, and Fresh makes translated cards end-to-end. The server is the local fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, waitFor } from '../helpers/boot.js';
import { startFakeGateway, GW_KEY } from '../helpers/fake-gateway.js';

// The fake answers the classifier's JSON task list (it is the llm-classifier prompt) and writes one card per source item.
function wire(gw) {
  gw.handlers['POST /chat/completions'] = (req) => {
    const system = String(req.body.messages?.[0]?.content ?? '');
    if (/careful classifier/.test(system)) {
      const tasks = JSON.parse(req.body.messages[1].content);
      const answers = {};
      for (const t of tasks) {
        if (t.type === 'choice') answers[t.id] = 'ai';
        else if (t.type === 'score') answers[t.id] = t.scale.length - 1;
        else if (t.id.startsWith('b:')) answers[t.id] = 0.1; // not an unwanted kind
        else answers[t.id] = 0.9; // concrete, real news, a good card
      }
      return { status: 200, body: { choices: [{ message: { content: JSON.stringify(answers) } }] } };
    }
    // Dedupe and thread questions: one valid but empty answer (nothing is a duplicate, nothing is one story).
    if (!/You write short news cards/.test(system)) return { status: 200, body: { choices: [{ message: { content: '[]' } }] } };
    const list = JSON.parse(req.body.messages[1].content);
    const cards = list.map((b) => ({
      id: b.id, title: `Card: ${String(b.title).slice(0, 70)}`,
      summary: 'A summary from the local model that explains this story and is long enough to pass the summary length check.',
      why: 'Important for a reader who follows this topic.', topics: ['local', 'model'], substance: true,
    }));
    return { status: 200, body: { choices: [{ message: { content: JSON.stringify(cards) } }] } };
  };
}

test('a local openai-compatible server alone runs the whole Fresh path: derived classifier, writer, translated cards', async () => {
  const gw = await startFakeGateway();
  wire(gw);
  const providers = {
    providers: { local: { type: 'openai-compatible', baseUrl: gw.url, apiKey: 'env:HW_LOCAL_KEY' } },
    capabilities: { writer: { provider: 'local', chain: [{ model: 'chat-a' }] } },
  };
  const app = await boot({
    seed: 0,
    // The offline switch only keeps the feeds out of the test; an explicit providers.json never uses the offline mock.
    env: { HERMES_WEB_FRESH_OFF: '0', HERMES_WEB_FRESH_OFFLINE: '1', HW_LOCAL_KEY: GW_KEY },
    files: { 'providers.json': JSON.stringify(providers) },
  });
  try {
    const me = await app.login();
    const caps = (await me.get('/api/capabilities')).data;
    assert.equal(caps.writer, true);
    assert.equal(caps.classifier, true, 'derived from the writer provider');
    assert.equal(caps.images, false);
    assert.equal(caps.socialSearch, false);
    assert.equal(caps.transcription, false);

    const { token } = (await me.get('/api/fresh/ingest-token')).data;
    const item = { source: 'worker', name: 'Worker', cat: 'ai', title: 'A local model answers with a bigger context window', url: 'https://example.com/local-one', text: 'It runs on one GPU.', ts: Date.now() };
    const ingest = await fetch(`${app.base}/api/fresh/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ items: [item] }) });
    assert.equal(ingest.status, 200);

    const card = await waitFor(async () => {
      const page = await me.get('/api/fresh?mode=latest&limit=30');
      return page.data.items.find((i) => i.url === 'https://example.com/local-one' && i.translated) ?? null;
    }, { timeoutMs: 20_000, what: 'a translated card' });
    assert.match(card.title, /^Card: /);
    assert.match(card.summary, /local model/);
    assert.equal(card.translated, true);
    assert.equal(card.cat, 'ai');
    assert.deepEqual(card.topics, ['local', 'model']);

    const chat = gw.requests.filter((r) => r.path === '/chat/completions');
    assert.ok(chat.some((r) => /careful classifier/.test(r.body.messages[0].content)), 'the derived classifier was used');
    assert.ok(chat.some((r) => r.body.model === 'chat-a' && /Answer ONLY with a JSON array/.test(r.body.messages[0].content)), 'the writer was used');
    assert.equal(gw.requests.some((r) => r.path.startsWith('/x/')), false, 'no social search was configured, so none was called');
  } finally {
    await app.stop();
    await gw.close();
  }
});
