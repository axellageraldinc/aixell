// The voice chat's pure helpers: cutting a streamed reply into speakable chunks, plain text, and word timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChunker, plainText, wordTimings, wordAt, SENTENCE_GAP } from '../../public/lib/voice-speech.js';

test('plainText drops code, links, markup and emoji and turns list items into sentences', () => {
  assert.equal(plainText('**Bold** and _soft_ and `code` here'), 'Bold and soft and code here');
  assert.equal(plainText('See [the docs](https://example.com/x) now https://example.com/y'), 'See the docs now');
  assert.equal(plainText('Before\n```js\nconst a = 1;\n```\nAfter'), 'Before. After');
  assert.equal(plainText('Nice 😀 job'), 'Nice job');
  assert.equal(plainText('Steps:\n- one\n- two\n1. three'), 'Steps: one. two. three');
  assert.equal(plainText('# Title\n\nBody text'), 'Title. Body text');
});

test('the first chunk is short so the voice starts early, later chunks join short sentences', () => {
  const c = createChunker({ firstMin: 10, min: 40, max: 200 });
  assert.deepEqual(c.push('Hello the'), []);
  assert.deepEqual(c.push('re friend. How are'), ['Hello there friend.']);
  assert.deepEqual(c.push(' you? Fine. '), []);
  assert.deepEqual(c.push('Thanks for asking me about it. Bye'), ['How are you? Fine. Thanks for asking me about it.']);
  assert.deepEqual(c.end(), ['Bye']);
});

test('a decimal point or a missing space does not end a sentence', () => {
  const c = createChunker({ firstMin: 5, min: 5, max: 200 });
  assert.deepEqual(c.push('Pi is 3.14 roughly'), []);
  assert.deepEqual(c.push(' and e is 2.7. '), ['Pi is 3.14 roughly and e is 2.7.']);
  assert.deepEqual(c.end(), []);
});

test('a line break ends a chunk and a very long run is cut at a comma or a space', () => {
  const c = createChunker({ firstMin: 5, min: 5, max: 40 });
  assert.deepEqual(c.push('First item\nSecond'), ['First item.']);
  assert.deepEqual(c.end(), ['Second']);
  const long = createChunker({ firstMin: 5, min: 5, max: 40 });
  const out = long.push('one two three four five six seven eight nine ten eleven twelve');
  assert.ok(out.length >= 1 && out.every((s) => s.length <= 40), JSON.stringify(out));
});

test('chunks without any words (code only) are skipped', () => {
  const c = createChunker();
  assert.deepEqual(c.push('```\ncode only\n```\n'), []);
  assert.deepEqual(c.end(), []);
});

test('wordTimings spreads the words over the audio, leaves the sentence gap and never overlaps', () => {
  const timings = wordTimings('Halo dunia. Apa kabar kamu', 4);
  assert.deepEqual(timings.map((x) => x.word), ['Halo', 'dunia.', 'Apa', 'kabar', 'kamu']);
  for (let i = 1; i < timings.length; i += 1) assert.ok(timings[i].start >= timings[i - 1].end - 1e-9);
  assert.ok(Math.abs(timings[2].start - (timings[1].end + SENTENCE_GAP)) < 1e-9);
  assert.ok(timings[4].end <= 4);
  assert.equal(timings[0].start, 0);
  assert.deepEqual(wordTimings('', 3), []);
});

test('a number takes longer to say than a short word', () => {
  const [a, b] = wordTimings('di 2025', 2);
  assert.ok(b.end - b.start > a.end - a.start);
});

test('wordAt finds the word being spoken', () => {
  const timings = wordTimings('one two three', 3);
  assert.equal(wordAt(timings, -0.5), -1);
  assert.equal(wordAt(timings, 0), 0);
  assert.equal(wordAt(timings, timings[1].start + 0.01), 1);
  assert.equal(wordAt(timings, 99), 3);
});
