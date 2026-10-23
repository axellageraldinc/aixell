// P3 server + P5d: the static labels Fresh serves to the app are English and keep their ids, and the
// neutral category set is what a fresh install starts from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const { DEFAULT_CONNECTOR_PRESETS } = await import('../../src/connectors/presets.js');
const { CATEGORIES, CAT_IDS, HALF_LIFE_H, KEYWORDS } = await import('../../src/fresh/profile.js');
const { DEFAULT_CATEGORIES } = await import('../../src/fresh/categories.js');

test('the account-bound source names are English and keep their ids', () => {
  const names = Object.fromEntries(DEFAULT_CONNECTOR_PRESETS.filter((p) => ['bluesky', 'x', 'github', 'steam'].includes(p.id)).map((p) => [p.id, p.name]));
  assert.deepEqual(names, {
    bluesky: 'Bluesky (search)',
    x: 'X (social search)',
    github: 'GitHub (trending AI repos)',
    steam: 'Steam (library, patch, sale)',
  });
});

test('the neutral category defaults are English, generic and complete', () => {
  assert.deepEqual(CATEGORIES, { tech: 'Technology', ai: 'AI', security: 'Security' });
  assert.deepEqual(CAT_IDS, ['tech', 'ai', 'security']);
  assert.deepEqual(DEFAULT_CATEGORIES.map((category) => category.id), CAT_IDS);
  for (const category of DEFAULT_CATEGORIES) {
    assert.ok(category.label.length > 0, `${category.id} has a label`);
    assert.ok(category.halfLifeHours > 0, `${category.id} has a half-life`);
    assert.equal(typeof category.keywords.pos, 'string');
    assert.equal(typeof category.keywords.neg, 'string');
    assert.ok(HALF_LIFE_H[category.id] > 0);
    assert.ok(KEYWORDS[category.id].pos instanceof RegExp);
    assert.ok(KEYWORDS[category.id].neg instanceof RegExp);
  }
});
