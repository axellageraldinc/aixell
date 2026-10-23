// Prompt templates and the language-agnostic check (P5d): the writer prompt is a template whose
// {{language}} slot is filled from config, and no shipped prompt hard-codes one language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import '../helpers/env.js';
import { COUNTRY_RE, REPO_WORDS_RE } from '../helpers/indonesian.js';
const { render, template, PROMPT_DIR } = await import('../../src/fresh/prompts.js');


test('render fills every slot', () => {
  const text = render('writer', {
    language: 'German',
    profile: 'A reader.',
    categories: 'ai: AI',
    schema: '{"id":"..."}',
    titleMax: 90,
    summaryMaxWords: 55,
    whyMaxWords: 18,
  });
  assert.match(text, /German/);
  assert.match(text, /A reader\./);
  assert.match(text, /ai: AI/);
  assert.doesNotMatch(text, /\{\{\w+\}\}/);
});

test('render: an unknown slot is an error, a missing value is an error', () => {
  assert.throws(() => render('dedupe', { language: 'German' }), /has no slot/);
  assert.throws(() => render('writer', { language: 'German', profile: 'x', categories: 'y', schema: 'z', titleMax: 1, summaryMaxWords: 1 }), /needs a value for \{\{whyMaxWords\}\}/);
  assert.throws(() => render('no-such-template'), /is missing/);
});

test('every shipped prompt is English and language-neutral', () => {
  const files = fs.readdirSync(PROMPT_DIR).filter((name) => name.endsWith('.md'));
  assert.deepEqual(files.sort(), ['dedupe.md', 'quality.md', 'terms.md', 'threads.md', 'writer.md']);
  for (const name of files) {
    const text = template(name.replace(/\.md$/, ''));
    assert.doesNotMatch(text, COUNTRY_RE, `${name} must not name a country or another language`);
    assert.doesNotMatch(text, REPO_WORDS_RE, `${name} must not use the words of another language`);
  }
});

test('the writer template asks for the language it is given, in every slot it uses', () => {
  const text = render('writer', { language: 'Brazilian Portuguese', profile: 'p', categories: 'c', schema: 's', titleMax: 80, summaryMaxWords: 40, whyMaxWords: 12 });
  assert.match(text, /Brazilian Portuguese/);
  assert.match(text, /80 characters/);
  assert.match(text, /40 words/);
  assert.match(text, /12 words/);
});
