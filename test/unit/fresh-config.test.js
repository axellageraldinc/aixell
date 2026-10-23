// The fresh section of the config schema (P5d): content language, categories, taste, filter packs,
// writer limits and the time zone. A bad regular expression or a bad time zone is a config error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../src/config/schema.js';

const FRESH = {
  content: { language: 'English', languageCode: 'en', locale: 'en-US' },
  categories: [{ id: 'ai', label: 'AI', halfLifeHours: 18, keywords: { pos: '\\bmodel\\b', neg: '\\bhype\\b' } }],
  taste: { profile: 'A reader who likes facts.' },
  filters: { packs: ['en'] },
  writer: { titleMax: 90, summaryMaxWords: 55, whyMaxWords: 18 },
};

test('schema: a complete fresh section passes unchanged', () => {
  const result = validate({ fresh: FRESH });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.value.fresh, FRESH);
});

test('schema: an empty fresh section is valid and stays empty', () => {
  assert.deepEqual(validate({ fresh: {} }).value, { fresh: {} });
  assert.deepEqual(validate({ fresh: {} }).errors, []);
});

test('schema: a bad category regular expression is an error', () => {
  const result = validate({ fresh: { categories: [{ id: 'ai', label: 'AI', halfLifeHours: 18, keywords: { pos: '(' } }] } });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^fresh\.categories\[0\]\.keywords\.pos: /);
});

test('schema: a bad time zone is an error, a real one is accepted', () => {
  const bad = validate({ timezone: 'Mars/Olympus' });
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /^timezone: /);
  assert.deepEqual(validate({ timezone: 'UTC' }).errors, []);
  assert.deepEqual(validate({ timezone: 'Europe/Berlin' }).errors, []);
});

test('schema: duplicate category ids, bad half-lives and bad writer limits are errors', () => {
  const result = validate({
    fresh: {
      categories: [
        { id: 'ai', label: 'AI', halfLifeHours: 18 },
        { id: 'ai', label: 'AI again', halfLifeHours: 0 },
      ],
      writer: { titleMax: 0 },
    },
  });
  assert.ok(result.errors.some((message) => /duplicate category id/.test(message)));
  assert.ok(result.errors.some((message) => /halfLifeHours/.test(message)));
  assert.ok(result.errors.some((message) => /^fresh\.writer\.titleMax: /.test(message)));
});

test('schema: unknown fresh keys warn and are dropped', () => {
  const result = validate({ fresh: { content: { language: 'English', colour: 'blue' }, mood: 'happy' } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 2);
  assert.deepEqual(result.value.fresh, { content: { language: 'English' } });
});

test('schema: the wrong type for a fresh section is one path-qualified error', () => {
  assert.match(validate({ fresh: [] }).errors[0], /^fresh: /);
  assert.match(validate({ fresh: { content: 'English' } }).errors[0], /^fresh\.content: /);
  assert.match(validate({ fresh: { filters: { packs: 'en' } } }).errors[0], /^fresh\.filters\.packs: /);
  assert.match(validate({ fresh: { taste: { profile: 3 } } }).errors[0], /^fresh\.taste\.profile: /);
});
