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
  assert.equal(items.length, 3, 'three from the answer; a citation that is not an X post is not a card');
  assert.ok(items[0].title.startsWith('Agent Duet (Example Lab): A proactive agent app'), items[0].title);
  assert.ok(items[1].title.startsWith('Model-9B (open model): MIT-licensed'));
  assert.ok(items.every((item) => !/\*\*|https?:/.test(item.title)));
  assert.deepEqual(items.slice(0, 3).map((item) => item.meta.handle), ['examplelab', 'someone', 'another']);
  assert.equal(items[0].url, 'https://x.com/examplelab/status/2000000000000000001', 'the post link is the URL');
  assert.ok(!items.some((item) => /most discussed/.test(item.title)), 'the intro line is not an item');
  assert.ok(items[1].snippet.startsWith('MIT-licensed') && !/Post link/.test(items[1].snippet));
});

test('citations: URL-only titles are dropped, posts already in the answer are dropped, and only X posts become cards', () => {
  const items = parseAnswer({ answer: BOLD_ANSWER, citations: CITATIONS }, slot);
  assert.ok(!items.some((item) => item.url.includes('2000000000000000009')));
  assert.equal(items.filter((item) => item.url.includes('2000000000000000001')).length, 1);
  assert.ok(!items.some((item) => item.title === 'A real article title'), 'an article citation is not a card');
  const extra = parseAnswer({ answer: '', citations: [{ url: 'https://x.com/zed/status/77', title: 'Zed ships a thing' }] }, slot);
  assert.deepEqual(extra.map((item) => item.url), ['https://x.com/zed/status/77']);
  assert.equal(parseAnswer({ answer: '', citations: CITATIONS.slice(0, 2) }, slot).length, 0);
});

test('one-line format: "- @handle: summary. POST_URL"; a line without a post link is not a card', () => {
  const answer = `- @LabOne: New model gpt-9 with 1M context. https://x.com/LabOne/status/1
- @dev2: llama.cpp q4 test on a 12GB card. https://x.com/dev2/status/2
- @dev3: See [the post](https://x.com/dev3/status/123) about a new CLI tool
- @dev4: An invented repo link. https://github.com/dev4/made-up`;
  const items = parseAnswer({ answer }, slot);
  assert.equal(items.length, 3);
  assert.equal(items[0].meta.handle, 'LabOne');
  assert.equal(items[0].title, 'New model gpt-9 with 1M context.');
  assert.equal(items[0].url, 'https://x.com/LabOne/status/1');
  assert.equal(items[0].name, 'X · @LabOne');
  assert.equal(items[2].url, 'https://x.com/dev3/status/123');
  assert.match(items[2].title, /the post/);
});

test('numbered format: the card links to the post, the handle comes from the post link, a line with no post is dropped', () => {
  const answer = `Top stories:
1. **Foo 2** by @foo: A new coding agent CLI with MCP support.
   Source: [repo](https://github.com/foo/foo2)
   Post: https://x.com/foo/status/9
2) [Bar release](https://bar.example/r): Bar adds local quantization support for 12GB cards.`;
  const items = parseAnswer({ answer }, slot);
  assert.equal(items.length, 1, 'the intro line and the line without a post link are skipped');
  assert.equal(items[0].url, 'https://x.com/foo/status/9');
  assert.equal(items[0].meta.handle, 'foo');
  assert.equal(items[0].meta.post, 'https://x.com/foo/status/9');
});

test('empty and malformed answers produce no items', () => {
  assert.deepEqual(parseAnswer({}, slot), []);
  assert.deepEqual(parseAnswer({ answer: 'Nothing notable happened.' }, slot), []);
  assert.deepEqual(parseAnswer({ answer: null, citations: [null, { url: 'ftp://x' }, {}] }, slot), []);
});

test('a viral slot keeps only lines whose like count reaches minLikes, and ignores citations', async () => {
  const { likesOf, buildQuery } = await import('../../src/connectors/x-search.js');
  assert.equal(likesOf('[likes: 2.4k]'), 2400);
  assert.equal(likesOf('likes: 1,250'), 1250);
  assert.equal(likesOf('[Likes=1.5M]'), 1500000);
  assert.equal(likesOf('no count here'), null);
  const viral = { n: 8, cats: ['tech'], minLikes: 1000 };
  const answer = [
    '- @a: A solo developer shipped a tool that took off. https://x.com/a/status/11 [likes: 4.2k]',
    '- @b: A small announcement from a niche project. https://x.com/b/status/12 [likes: 120]',
    '- @c: A launch with no count given at all. https://x.com/c/status/13',
  ].join('\n');
  const items = parseAnswer({ answer, citations: CITATIONS }, viral);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://x.com/a/status/11');
  assert.equal(items[0].meta.likes, 4200);
  assert.ok(!/likes/i.test(items[0].title) && !/likes/i.test(items[0].snippet), 'the count tag is not part of the card text');
  assert.ok(buildQuery(viral).includes('at least 1000 likes'));
  assert.ok(!buildQuery({ n: 1, cats: ['ai'] }).includes('[likes:'), 'ordinary slots are unchanged');
});
