// Provider contract tests: one suite, run against each implementation with a fake server on localhost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
import { startFakeGateway, GW_KEY } from '../helpers/fake-gateway.js';
const { OpenAICompatible } = await import('../../src/providers/openai-compatible.js');
const { MockGateway } = await import('../../src/providers/mock-gateway.js');
const { NullProvider } = await import('../../src/providers/null.js');
const { ProviderError } = await import('../../src/providers/errors.js');

// The shared suite: what every provider that offers a capability must do the same way.
function contract(name, make, { extras }) {
  test(`${name}: text.chat returns the reply and maps refusals to ProviderError`, async () => {
    const gw = await startFakeGateway({ extras });
    try {
      const p = make(gw);
      const { text } = await p.text.chat({ model: 'chat-a', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, temperature: 0.2 });
      assert.equal(text, 'echo:chat-a');
      const sent = gw.requests.find((r) => r.path === '/chat/completions').body;
      assert.equal(sent.model, 'chat-a');
      assert.equal(sent.max_tokens, 50);
      gw.handlers['POST /chat/completions'] = () => ({ status: 429, body: { error: { message: 'slow down' } }, headers: { 'Retry-After': '7' } });
      await assert.rejects(p.text.chat({ model: 'chat-a', messages: [] }), (e) => e instanceof ProviderError && e.status === 429 && e.retryAfter === 7 && e.message === 'chat-a 429');
    } finally { await gw.close(); }
  });

  test(`${name}: without a key every call fails with kind "nokey" and sends nothing`, async () => {
    const gw = await startFakeGateway({ extras });
    try {
      const p = make(gw, { key: null });
      await assert.rejects(p.text.chat({ model: 'm', messages: [] }), (e) => e.kind === 'nokey' && e.message === 'no key');
      await assert.rejects(p.image.generate({ prompt: 'x', model: 'm' }), (e) => e.kind === 'nokey');
      await assert.rejects(p.transcribe.transcribe({ audio: Buffer.from('a'), model: 'm' }), (e) => e.kind === 'nokey');
      await assert.rejects(p.speech.synthesize({ text: 'a', model: 'm' }), (e) => e.kind === 'nokey');
      assert.equal(gw.requests.length, 0);
    } finally { await gw.close(); }
  });

  test(`${name}: image.generate returns the picture bytes`, async () => {
    const gw = await startFakeGateway({ extras });
    try {
      const { bytes } = await make(gw).image.generate({ prompt: 'a cat', model: 'draw-1' });
      assert.ok(bytes.length > 2000);
      assert.deepEqual(gw.requests.find((r) => r.path === '/images/generations').body, { model: 'draw-1', prompt: 'a cat', n: 1, size: '1024x1024' });
      gw.handlers['POST /images/generations'] = () => ({ status: 429, body: { error: { message: 'too many requests' } } });
      await assert.rejects(make(gw).image.generate({ prompt: 'x', model: 'draw-1' }), (e) => e.status === 429 && /too many/.test(e.detail) && e.message === 'draw-1 answered 429.');
    } finally { await gw.close(); }
  });

  test(`${name}: speech posts the text, model and voice and returns the audio with its type`, async () => {
    const gw = await startFakeGateway({ extras });
    try {
      const out = await make(gw).speech.synthesize({ text: 'Halo dunia', model: 'tts-x', voice: 'v1', format: 'mp3' });
      assert.equal(out.audio.toString(), 'ID3 fake mp3');
      assert.equal(out.mime, 'audio/mpeg');
      assert.deepEqual(gw.requests.find((r) => r.path === '/audio/speech').body, { model: 'tts-x', input: 'Halo dunia', voice: 'v1', response_format: 'mp3' });
      gw.handlers['POST /audio/speech'] = () => ({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, raw: Buffer.alloc(0) });
      await assert.rejects(make(gw).speech.synthesize({ text: 'a', model: 'm' }), (e) => e.kind === 'empty');
      gw.handlers['POST /audio/speech'] = () => ({ status: 503, body: {} });
      await assert.rejects(make(gw).speech.synthesize({ text: 'a', model: 'm' }), (e) => e.status === 503 && e.message === 'Speech failed (503).');
    } finally { await gw.close(); }
  });

  test(`${name}: transcribe sends a multipart upload and trims the text`, async () => {
    const gw = await startFakeGateway({ extras });
    try {
      const out = await make(gw).transcribe.transcribe({ audio: Buffer.from('fake mp3'), model: 'whisper-x', hint: 'English talk' });
      assert.deepEqual(out, { text: 'hello world' });
      const raw = gw.requests.find((r) => r.path === '/audio/transcriptions').raw.toString('latin1');
      assert.match(raw, /name="model"\r\n\r\nwhisper-x/);
      assert.match(raw, /name="prompt"\r\n\r\nEnglish talk/);
      gw.handlers['POST /audio/transcriptions'] = () => ({ status: 200, body: { text: '  ' } });
      await assert.rejects(make(gw).transcribe.transcribe({ audio: Buffer.from('a'), model: 'w' }), (e) => e.kind === 'empty');
      gw.handlers['POST /audio/transcriptions'] = () => ({ status: 500, body: {} });
      await assert.rejects(make(gw).transcribe.transcribe({ audio: Buffer.from('a'), model: 'w' }), (e) => e.status === 500 && e.message === 'Transcription failed (500).');
    } finally { await gw.close(); }
  });

  test(`${name}: catalog lists models with prices and answers priceOf from the last fetch`, async () => {
    const gw = await startFakeGateway({ extras });
    try {
      const c = make(gw).catalog;
      assert.equal(c.priceOf('chat-a'), null, 'nothing is known before the first fetch');
      await c.load();
      const list = await c.listModels({ currentModel: 'chat-a' });
      const a = list.find((m) => m.id === 'chat-a');
      assert.ok(a && a.price.inputPerM > 0 && a.price.outputPerM > a.price.inputPerM);
      assert.equal(a.contextWindow, 32000);
      assert.equal(c.priceOf('chat-a').currency, c.currency());
      assert.equal(c.priceOf('nope'), null);
      assert.equal(gw.count('GET /models') <= 2, true, 'the catalogue is cached');
    } finally { await gw.close(); }
  });
}

const openai = (gw, { key = GW_KEY } = {}) => new OpenAICompatible({ id: 'local', baseUrl: gw.url, apiKey: () => key });
const gateway = (gw, { key = GW_KEY } = {}) => new MockGateway({ id: 'gw', baseUrl: gw.url, apiKey: () => key });

contract('openai-compatible', openai, { extras: false });
contract('mock-gateway', gateway, { extras: true });

test('openai-compatible: reads OpenRouter style prices (USD per token) into per-million prices', async () => {
  const gw = await startFakeGateway();
  try {
    const c = openai(gw).catalog;
    await c.load();
    assert.equal(c.currency(), 'USD');
    assert.ok(Math.abs(c.priceOf('chat-a').inputPerM - 1.5) < 1e-9);
    assert.ok(Math.abs(c.priceOf('chat-a').outputPerM - 6) < 1e-9);
    assert.equal(c.usage, undefined, 'a plain server has no usage endpoint');
    assert.equal(openai(gw).search, undefined);
    assert.equal(openai(gw).classify, undefined);
  } finally { await gw.close(); }
});

test('openai-compatible: reasoning_effort is only sent when the config asks for it', async () => {
  const gw = await startFakeGateway();
  try {
    await openai(gw).text.chat({ model: 'm', messages: [], reasoningEffort: 'none' });
    assert.equal('reasoning_effort' in gw.requests.at(-1).body, false);
    await new OpenAICompatible({ baseUrl: gw.url, apiKey: () => GW_KEY, sendReasoningEffort: true }).text.chat({ model: 'm', messages: [], reasoningEffort: 'none' });
    assert.equal(gw.requests.at(-1).body.reasoning_effort, 'none');
  } finally { await gw.close(); }
});

test('mock-gateway: classify turns typed tasks into /classify questions and normalises the answers', async () => {
  const gw = await startFakeGateway({ extras: true });
  try {
    const p = gateway(gw);
    const tasks = [
      { id: 'c:1', type: 'choice', item: 'GPU news', question: 'Which?', options: { pc: 'PC stuff', ai: 'AI stuff' } },
      { id: 'r:1', type: 'score', item: 'GPU news', question: 'Match?', scale: ['no', 'maybe', 'yes'] },
      { id: 'b:1', type: 'bool', item: 'GPU news', question: 'Deal?', true: 'a deal', false: 'not a deal' },
    ];
    const answers = await p.classify.classify({ state: 'a reader', tasks, model: 'jev', timeoutMs: 5000 });
    assert.deepEqual(answers, { 'c:1': { choice: 'pc' }, 'r:1': { score: 2 }, 'b:1': { p: 0.25 } });
    assert.deepEqual(gw.requests.find((r) => r.path === '/classify').body, {
      model: 'jev', state: 'a reader',
      questions: {
        'c:1': { type: 'choice', instructions: { item: 'GPU news', question: 'Which?' }, criteria: { pc: 'PC stuff', ai: 'AI stuff' } },
        'r:1': { type: 'score', instructions: { item: 'GPU news', question: 'Match?' }, criteria: ['no', 'maybe', 'yes'] },
        'b:1': { type: 'bool', instructions: { item: 'GPU news', question: 'Deal?' }, criteria: { true: 'a deal', false: 'not a deal' } },
      },
    });
    gw.handlers['POST /classify'] = () => ({ status: 429, body: {}, headers: { 'Retry-After': '3' } });
    await assert.rejects(p.classify.classify({ state: '', tasks, model: 'jev' }), (e) => e.status === 429 && e.retryAfter === 3 && e.message === 'jev 429');
    gw.handlers['POST /classify'] = () => ({ status: 200, body: { nothing: 1 } });
    await assert.rejects(p.classify.classify({ state: '', tasks, model: 'jev' }), /jev no answers/);
  } finally { await gw.close(); }
});

test('mock-gateway: search sends the filter in the gateway format and returns answer, citations and cost', async () => {
  const gw = await startFakeGateway({ extras: true });
  try {
    const p = gateway(gw);
    assert.equal(p.search.endpoint, new URL(gw.url).host + '/v1/search');
    const out = await p.search.search({ query: 'new models', filter: { from: '2026-10-01', allowedHandles: ['a', 'b'] } });
    assert.equal(out.costMicro, 100_000_000);
    assert.equal(out.citations[0].url, 'https://example.com/a');
    assert.match(out.answer, /new models/);
    assert.equal(out.raw.id, 'x1');
    assert.deepEqual(gw.requests.find((r) => r.path === '/search').body, { query: 'new models', filter: { from: '2026-10-01', allowed_handles: ['a', 'b'] } });
    await p.search.search({ query: 'q', filter: { from: '2026-10-02', excludedHandles: ['z'] } });
    assert.deepEqual(gw.requests.filter((r) => r.path === '/search').at(-1).body.filter, { from: '2026-10-02', excluded_handles: ['z'] });
    gw.handlers['POST /search'] = () => ({ status: 402, body: {} });
    await assert.rejects(p.search.search({ query: 'q' }), (e) => e.status === 402);
  } finally { await gw.close(); }
});

test('null: implements no capability', () => {
  const p = new NullProvider({ id: 'none' });
  assert.equal(p.type, 'null');
  for (const cap of ['text', 'classify', 'image', 'search', 'transcribe', 'speech', 'catalog']) assert.equal(p[cap], undefined);
});

test('llm-classifier over the openai-compatible provider: one JSON-mode call answers typed tasks', async () => {
  const { llmClassifier } = await import('../../src/providers/llm-classifier.js');
  const gw = await startFakeGateway();
  try {
    const p = openai(gw);
    const classifier = llmClassifier(p.text, { model: 'chat-a' });
    const tasks = [
      { id: 'c:1', type: 'choice', item: 'New GPU', question: 'Which?', options: { pcbuild: 'PC parts', ai: 'AI' } },
      { id: 'b:1', type: 'bool', item: 'New GPU', question: 'A deal?', true: 'yes', false: 'no' },
    ];
    gw.handlers.classifierAnswer = { 'c:1': 'pcbuild', 'b:1': 0.25 };
    assert.deepEqual(await classifier.classify({ state: 'a reader', tasks }), { 'c:1': { choice: 'pcbuild' }, 'b:1': { p: 0.25 } });
    const sent = gw.requests.find((r) => r.path === '/chat/completions').body;
    assert.equal(sent.model, 'chat-a');
    assert.equal(sent.temperature, 0);
    assert.match(sent.messages[0].content, /careful classifier/);
    assert.match(sent.messages[0].content, /Context: a reader/);
    assert.deepEqual(JSON.parse(sent.messages[1].content).map((t) => t.id), ['c:1', 'b:1']);
    assert.equal(classifier.maxTasksPerCall < 150, true);
  } finally { await gw.close(); }
});

test('null: bound to every capability, the registry resolves them all to null', async () => {
  const { buildRegistry } = await import('../../src/providers/registry.js');
  const reg = buildRegistry({
    providers: { none: { type: 'null' } },
    capabilities: { writer: { provider: 'none' }, classifier: { provider: 'none' }, images: { provider: 'none' }, socialSearch: { provider: 'none' }, transcription: { provider: 'none' }, speech: { provider: 'none' }, models: { provider: 'none' } },
  }, {}, { null: (id) => new NullProvider({ id }) });
  for (const cap of ['writer', 'classifier', 'images', 'socialSearch', 'transcription', 'models']) assert.equal(reg.get(cap), null, cap);
  assert.equal(reg.flags().usage, false);
});
