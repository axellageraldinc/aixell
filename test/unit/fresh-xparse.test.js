// parseAnswer (src/connectors/x-search.js): turns the free-text answer of an X search into candidate items. Fixtures are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const { parseAnswer } = await import('../../src/connectors/x-search.js');

const slot = { n: 3, cats: ['ai'] };
const BOLD_ANSWER = `**Here are the most discussed AI tools from the last 24 hours** (based on posts, sorted by engagement):

- **Agent Duet** (Example Lab): A proactive agent app that completes tasks on its own and connects to thousands of tools.
  Post link: https://x.com/examplelab/status/2000000000000000001 (quoted in a high-engagement thread)

- **Model-9B** (open model): MIT-licensed, strong on coding tasks, runnable locally.
  Post link: https://x.com/someone/status/2000000000000000002

- **Devkit** (open-source IDE extension): Free tool for building projects with existing coding agents.
  Post link: https://x.com/another/status/2000000000000000003
`;
const CITATIONS = [
  { url: 'https://x.com/i/status/2000000000000000009', title: 'https://x.com/i/status/2000000000000000009' },
  { url: 'https://x.com/examplelab/status/2000000000000000001', title: 'https://x.com/examplelab/status/2000000000000000001' },
  { url: 'https://x.com/i/status/2000000000000000001', title: 'Same post again, with a real title' },
  { url: 'https://example.com/real', title: 'A real article title' },
];

test('bold-name format: name plus a short description, no markdown or URL in the title', () => {
  const items = parseAnswer({ answer: BOLD_ANSWER, citations: CITATIONS }, slot);
  assert.equal(items.length, 4, 'three from the answer and one uncovered citation with a real title');
  assert.ok(items[0].title.startsWith('Agent Duet (Example Lab): A proactive agent app'), items[0].title);
  assert.ok(items[1].title.startsWith('Model-9B (open model): MIT-licensed'));
  assert.ok(items.every((item) => !/\*\*|https?:/.test(item.title)));
  assert.deepEqual(items.slice(0, 3).map((item) => item.meta.handle), ['examplelab', 'someone', 'another']);
  assert.equal(items[0].url, 'https://x.com/examplelab/status/2000000000000000001', 'the post link is the URL when there is no other');
  assert.ok(!items.some((item) => /most discussed/.test(item.title)), 'the intro line is not an item');
  assert.ok(items[1].snippet.startsWith('MIT-licensed') && !/Post link/.test(items[1].snippet));
});

test('citations: URL-only titles are dropped, posts already in the answer are dropped, real titles are kept', () => {
  const items = parseAnswer({ answer: BOLD_ANSWER, citations: CITATIONS }, slot);
  assert.ok(!items.some((item) => item.url.includes('2000000000000000009')));
  assert.equal(items.filter((item) => item.url.includes('2000000000000000001')).length, 1);
  assert.equal(items[3].title, 'A real article title');
  assert.equal(parseAnswer({ answer: '', citations: CITATIONS.slice(0, 2) }, slot).length, 0);
});

test('one-line format: "- @handle: summary. URL"', () => {
  const answer = `- @LabOne: New model gpt-9 with 1M context. https://example.com/a
- @dev2: llama.cpp q4 test on a 12GB card. https://github.com/example/llama.cpp/pull/1
- @dev3: See [the post](https://x.com/dev3/status/123) about a new CLI tool`;
  const items = parseAnswer({ answer }, slot);
  assert.equal(items.length, 3);
  assert.equal(items[0].meta.handle, 'LabOne');
  assert.equal(items[0].title, 'New model gpt-9 with 1M context.');
  assert.equal(items[0].url, 'https://example.com/a');
  assert.equal(items[0].name, 'X · @LabOne');
  assert.equal(items[2].url, 'https://x.com/dev3/status/123');
  assert.match(items[2].title, /the post/);
});

test('numbered format: a non-X link wins, the handle comes from the post link, markdown link text is the title', () => {
  const answer = `Top stories:
1. **Foo 2** by @foo: A new coding agent CLI with MCP support.
   Source: [repo](https://github.com/foo/foo2)
   Post: https://x.com/foo/status/9
2) [Bar release](https://bar.example/r): Bar adds local quantization support for 12GB cards.`;
  const items = parseAnswer({ answer }, slot);
  assert.equal(items.length, 2, 'the intro line is skipped');
  assert.equal(items[0].url, 'https://github.com/foo/foo2');
  assert.equal(items[0].meta.handle, 'foo');
  assert.equal(items[0].meta.post, 'https://x.com/foo/status/9');
  assert.equal(items[1].url, 'https://bar.example/r');
  assert.match(items[1].title, /^Bar release/);
});

test('empty and malformed answers produce no items', () => {
  assert.deepEqual(parseAnswer({}, slot), []);
  assert.deepEqual(parseAnswer({ answer: 'Nothing notable happened.' }, slot), []);
  assert.deepEqual(parseAnswer({ answer: null, citations: [null, { url: 'ftp://x' }, {}] }, slot), []);
});
