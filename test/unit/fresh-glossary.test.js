// Glossary post-check (src/fresh/glossary.js): after a card is written, a forbidden rendering of a kept term is swapped back.
// The shipped seed only says which English terms stay English; the renderings below are test fixtures that stand for the
// data file of a deployment in another language, which is exactly how that deployment supplies them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const glossary = await import('../../src/fresh/glossary.js');
const { content } = await import('../../src/fresh/content.js');

const used = (...terms) => terms.map((t) => glossary.entryOf(t));
const code = content().languageCode;

test('the seed is in place and every kept term has a normalised, valid name', () => {
  const all = glossary.entries();
  assert.ok(all.length > 30);
  assert.ok(all.every((e) => glossary.validTerm(e.term)), 'seed terms are valid');
  assert.equal(glossary.entryOf('Agent').keep, true, 'lookups are case-insensitive');
  assert.deepEqual(glossary.entryOf('agent').bad, [], 'the shipped English seed forbids no rendering');
});

test('extract finds the decided terms a source text uses, including plurals and -ing forms', () => {
  const out = glossary.extract('The new coding agent adds prompt caching; agents love patches and fine-tuning.');
  const terms = out.entries.map((e) => e.term);
  for (const expected of ['coding agent', 'agent', 'prompt caching', 'patch', 'fine-tune']) assert.ok(terms.includes(expected), `missing ${expected}: ${terms}`);
});

test('extract reports undecided candidate terms and CamelCase names', () => {
  const out = glossary.extract('A data leak hit FooBar and the CDN after a memory leak.');
  assert.ok(out.unknown.includes('memory leak'));
  assert.ok(out.names.includes('FooBar'));
  assert.ok(out.names.includes('CDN'));
});

test('fixText swaps a forbidden rendering back to the kept term, whole words only', () => {
  glossary.setDecision('agent', 'keep', { bad: ['ajen'] });
  const result = glossary.fixText('Ajen new release. Ajen-ajen follow, ajennya fast. Ajenda is full today.', used('agent'));
  assert.equal(result.text, 'Agent new release. Agent follow, agent-nya fast. Ajenda is full today.');
  assert.equal(result.unsafe, false);
  assert.ok(result.fixes.length >= 3);
});

test('fixText flags derived words it cannot safely rewrite', () => {
  glossary.setDecision('quantization', 'keep', { bad: ['quanz'] });
  const result = glossary.fixText('This model is diquanz to 4 bit.', used('quantization'));
  assert.equal(result.unsafe, true);
  assert.equal(result.text, 'This model is diquanz to 4 bit.', 'the text is left alone when unsure');
});

test('fixText keeps the capitalisation of what it replaces', () => {
  assert.equal(glossary.fixText('AJEN', used('agent')).text, 'AGENT');
  assert.equal(glossary.fixText('ajen', used('agent')).text, 'agent');
});

test('fixCard checks title, summary and why', () => {
  const out = glossary.fixCard({ title_local: 'Ajen new', summary: 'A ajen.', why: '', other: 'ajen' }, used('agent'));
  assert.equal(out.card.title_local, 'Agent new');
  assert.equal(out.card.summary, 'A agent.');
  assert.equal(out.card.other, 'ajen', 'other fields are untouched');
});

test('rulesText lists kept terms, translations and names for the writer', () => {
  glossary.setDecision('privacy', `translate`, { form: 'privasi' });
  const text = glossary.rulesText(used('agent', 'privacy'), ['FooBar']);
  assert.match(text, /agent/);
  assert.match(text, /privacy → privasi/);
  assert.match(text, /FooBar/);
  assert.equal(glossary.rulesText([], []), '');
});

test('setDecision validates input and an owner decision is never replaced by a model decision', () => {
  assert.throws(() => glossary.setDecision('!!bad term!!', 'keep'));
  assert.throws(() => glossary.setDecision('overclocking', 'maybe'));
  assert.throws(() => glossary.setDecision('overclocking', 'translate'), 'a translation needs a rendering');
  const owner = glossary.setDecision('overclocking', 'keep', { bad: ['overclockish'] });
  assert.equal(owner.keep, true);
  assert.equal(owner.source, 'owner');
  glossary.cacheDecision('overclocking', `${code}:overclockish hour`);
  assert.equal(glossary.entryOf('overclocking').keep, true, 'cacheDecision does not overwrite');
  const changed = glossary.setDecision('overclocking', `${code}:overclockish`);
  assert.equal(changed.form, 'overclockish');
});

test('a translation decision is stored with the content language code', () => {
  const entry = glossary.setDecision('outage', 'translate', { form: 'gangguan' });
  assert.equal(entry.decision, `${code}:gangguan`);
  assert.equal(entry.keep, false);
  assert.equal(entry.form, 'gangguan');
});
