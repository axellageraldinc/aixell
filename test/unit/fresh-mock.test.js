// The offline switch (HERMES_WEB_FRESH_OFFLINE=1) and src/fresh/mock.js: stand-ins that answer in the shapes of the real services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const { mockGateway, mockHttp } = await import('../../src/fresh/mock.js');
const compat = await import('../../src/providers/compat.js');
const { getJson, setHttp } = await import('../../src/fresh/net.js');
const { parseAnswer } = await import('../../src/connectors/x-search.js');
test('/classify answers every question in its own type', async () => {
  const body = {
    model: 'fake-model',
    questions: {
      a: { type: 'choice', instructions: { item: 'New GPU driver improves benchmark results on RTX cards' }, choices: [] },
      b: { type: 'score', instructions: { item: 'Model release with new context window' }, criteria: ['no', 'low', 'high'] },
      c: { type: 'bool', instructions: { item: 'Huge discount on a shopping deal today', question: 'Is this a shopping deal or unwanted?' } },
      d: { type: 'bool', instructions: { item: 'Calm engineering write-up about a database migration plan', question: 'Is this real news?' } },
    },
  };
  const response = await mockGateway({}, '/classify', { body });
  assert.equal(response.status, 200);
  const { answers, model } = await response.json();
  assert.equal(model, 'fake-model');
  assert.equal(answers.a.type, 'choice');
  assert.equal(answers.b.type, 'score');
  assert.ok(answers.b.score >= 0);
  assert.equal(answers.c.type, 'bool');
  assert.ok(answers.d.p > 0.5);
});

test('/chat/completions writes one card per input item and returns [] for the duplicate judge', async () => {
  const list = [{ id: 'aaaa', title: 'First story title', text: 'Some text here.' }, { id: 'bbbb', title: 'Second', text: '' }];
  const out = await (await mockGateway({}, '/chat/completions', { body: { messages: [{ content: 'writer' }, { content: JSON.stringify(list) }] } })).json();
  const cards = JSON.parse(out.choices[0].message.content);
  assert.deepEqual(cards.map((c) => c.id), ['aaaa', 'bbbb']);
  assert.ok(cards.every((c) => c.title && c.summary && c.why && Array.isArray(c.topics)), 'the writer keys the pipeline parses');
  const dup = await (await mockGateway({}, '/chat/completions', { body: { messages: [{ content: 'You find duplicate news.' }, { content: '[]' }] } })).json();
  assert.equal(dup.choices[0].message.content, '[]');
  const threads = await (await mockGateway({}, '/chat/completions', { body: { messages: [{ content: 'You group news into ongoing "storylines".' }, { content: '{}' }] } })).json();
  assert.equal(threads.choices[0].message.content, '[]');
});

test('an unknown path is a 404 in the same JSON shape', async () => {
  const response = await mockGateway({}, '/nope', {});
  assert.equal(response.status, 404);
  assert.ok((await response.json()).error.message);
});

test('X search: the general answer parses into cards', async () => {
  const data = await (await mockGateway({}, '/search', { body: { query: 'new AI models' } })).json();
  assert.ok(data.cost_micro > 0);
  const items = parseAnswer(data, { n: 1, cats: ['ai'] });
  assert.ok(items.length >= 2);
  assert.ok(items.every((i) => i.title && /^https?:/.test(i.url) && i.source === 'x'));
});

test('X search: a language slot is cleaned by its own filter pack (and by nothing when it has none)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { dataDir } = await import('../helpers/env.js');
  const { clearFilterCache } = await import('../../src/connectors/x-search.js');
  const data = await (await mockGateway({}, '/search', { body: { query: 'topic lang:xx' } })).json();
  const all = parseAnswer(data, { n: 2, cats: ['ai'] });
  const unfiltered = parseAnswer(data, { n: 2, cats: ['ai'], lang: 'xx' });
  assert.equal(all.length, 7, 'without a language filter every line is an item');
  assert.equal(unfiltered.length, 7, 'with no pack for that language nothing is dropped: cards link to posts, so there is no affiliate link to catch');

  fs.mkdirSync(path.join(dataDir, 'filters'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'filters', 'xx.json'), JSON.stringify({
    id: 'xx', lang: 'xx', rules: [
      { name: 'course', action: 'drop', test: '\\bpaid course\\b' },
      { name: 'giveaway', action: 'drop', test: '\\bgiveaway\\b' },
    ],
  }));
  clearFilterCache();
  try {
    const filtered = parseAnswer(data, { n: 2, cats: ['ai'], lang: 'xx' });
    assert.equal(filtered.length, 5, 'the course and the giveaway lines are dropped by the pack');
    assert.ok(filtered.every((i) => i.meta.lang === 'xx'));
    assert.ok(!filtered.some((i) => /paid course|giveaway/i.test(i.snippet)));
  } finally {
    fs.rmSync(path.join(dataDir, 'filters', 'xx.json'), { force: true });
    clearFilterCache();
  }
});

test('mockHttp answers GitHub, Bluesky and Steam in their real shapes, and 404 for anything else', async () => {
  const search = mockHttp('https://api.github.com/search/repositories?q=x');
  assert.equal(search.status, 200);
  assert.ok(search.data.items.length >= 4 && search.data.items[0].full_name.includes('/'));
  const repo = mockHttp(`https://api.github.com/repos/${search.data.items[0].full_name}`);
  assert.equal(repo.data.full_name, search.data.items[0].full_name);
  const readme = mockHttp(`https://api.github.com/repos/${search.data.items[0].full_name}/readme`);
  assert.match(Buffer.from(readme.data.content, 'base64').toString(), /^# /);
  assert.equal(mockHttp('https://api.github.com/repos/nobody/nothing').status, 404);
  assert.match(mockHttp('https://github.com/trending').text, /Box-row/);

  assert.ok(mockHttp('https://bsky.social/xrpc/com.atproto.server.createSession').data.accessJwt);
  const posts = mockHttp('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=llm').data.posts;
  assert.ok(posts.length >= 2 && posts[0].record.text && posts[0].author.handle);

  assert.ok(mockHttp('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=k').data.response.games.length > 0);
  assert.equal(mockHttp('https://unknown.example/').status, 404);
});

test('getJson uses the mocks while the offline flag is set, and never touches the network', async () => {
  assert.equal(process.env.HERMES_WEB_FRESH_OFFLINE, '1');
  const { status, data } = await getJson('https://api.github.com/search/repositories?q=anything');
  assert.equal(status, 200);
  assert.ok(data.items.length > 0);
  assert.equal((await getJson('https://not-mocked.example/x')).status, 404);
});

test('setHttp and the provider transport replace the offline mocks (the seams used by tests)', async () => {
  setHttp(() => ({ status: 200, data: { custom: true } }));
  assert.deepEqual((await getJson('https://api.github.com/x')).data, { custom: true });
  setHttp(null);
  const seen = [];
  compat.setTransport(async (agent, path) => { seen.push(path); return new Response(JSON.stringify({ path }), { status: 200 }); });
  const agent = { name: 'mock-seam', provider: 'gateway', baseUrl: 'http://127.0.0.1:1/v1', home: '/nonexistent' };
  try {
    const response = await compat.providersFor(agent).provider('writer').call('/anything', {});
    assert.deepEqual(await response.json(), { path: '/anything' });
    assert.deepEqual(seen, ['/anything']);
  } finally { compat.setTransport(null); }
  // Without a test transport the offline mock answers again (installed by src/fresh/offline.js).
  const back = await compat.providersFor(agent).provider('writer').call('/nope', {});
  assert.equal(back.status, 404, 'back to the offline mock');
});
