// Category guessing and the word-based relevance of the neutral category set (P5d): with no config
// the shipped defaults are technology / AI / security, and the same shapes come back as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const { CAT_IDS, guessCat, keywordRelevance, hardBan, unwanted, bannedIn } = await import('../../src/fresh/profile.js');

test('the neutral set has the three shipped ids', () => {
  assert.deepEqual(CAT_IDS, ['tech', 'ai', 'security']);
});

test('guessCat picks the category the words point at, and keeps the fallback otherwise', () => {
  assert.equal(guessCat('New LLM model release with a larger context window and cheaper inference', null), 'ai');
  assert.equal(guessCat('Critical CVE in a popular npm package lets an attacker run code', null), 'security');
  assert.equal(guessCat('A new browser release changes how the platform handles cookies', null), 'tech');
  assert.equal(guessCat('A quiet day with no particular words', 'tech'), 'tech');
  assert.equal(guessCat('A quiet day with no particular words', null), null);
});

test('guessCat: a vulnerability that names the stack is a security story', () => {
  assert.equal(guessCat('Critical vulnerability in Node.js lets an attacker take over the process', null), 'security');
});

test('keywordRelevance stays inside 0..1 and reacts to positive and negative words', () => {
  const good = keywordRelevance('ai', 'A new model release with a larger context window and cheaper inference');
  const bad = keywordRelevance('ai', 'AGI hype and a funding round with a huge valuation');
  const none = keywordRelevance('unknown-category', 'anything');
  assert.ok(good > 0.5, `a strong match scores high (${good})`);
  assert.ok(bad < good, `a negative match scores lower (${bad})`);
  assert.equal(none, 0.2, 'an unknown category keeps the old neutral value');
  for (const text of ['', 'anything at all', 'CVE in npm', 'model benchmark']) {
    const value = keywordRelevance('security', text);
    assert.ok(value >= 0 && value <= 1);
  }
});

test('the drop rules of the shipped pack still hide deals, crypto and listicles', () => {
  assert.equal(hardBan('Huge discount, best deals of the week, 50% off'), true);
  assert.equal(hardBan('Bitcoin and ethereum memecoins are pumping'), true);
  assert.equal(hardBan('10 ways to speed up your builds'), true);
  assert.equal(hardBan('A new model release with a larger context window'), false);
});

test('the soft rules keep on-topic posts and drop off-topic laptop news', () => {
  assert.equal(unwanted('A new laptop with a mobile cpu for students'), true);
  assert.equal(unwanted('A new AI coding agent runs locally on your machine'), false, 'an AI tool is not homelab news');
  assert.equal(unwanted('My homelab server runs Proxmox and a NAS'), true);
  assert.equal(unwanted('My homelab runs a self-hosted AI agent'), false, 'a self-hosted AI tool is wanted');
});

test('a category rule only applies to its own categories', () => {
  assert.equal(bannedIn('console', 'Console sales figures: 2 million units sold this quarter'), true);
  assert.equal(bannedIn('tech', 'Console sales figures: 2 million units sold this quarter'), false);
});
