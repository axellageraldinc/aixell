// Custom sources saved by an older version keep working: they are stored with the old `kind`, mapped
// to a connector type on load, and the settings file is not rewritten for the mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../helpers/env.js';

const settingsFile = path.join(dataDir, 'fresh', 'settings.json');
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
const saved = {
  enabled: true,
  intervalMin: 30,
  off: [],
  custom: [
    { id: 'c-aaaaaaaa', name: 'An old feed', kind: 'rss', cat: 'ai', url: 'https://example.com/old.xml' },
    { id: 'c-bbbbbbbb', name: 'An old channel', kind: 'yt', cat: 'pcgaming', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=X' },
    { id: 'c-cccccccc', name: '@someone', kind: 'bluesky', cat: 'ai', url: 'someone.example' },
    { id: 'c-dddddddd', name: 'Old releases', kind: 'github', cat: 'ai', url: 'https://github.com/example/app/releases.atom', label: 'App' },
  ],
};
fs.writeFileSync(settingsFile, JSON.stringify(saved, null, 2));
const before = fs.readFileSync(settingsFile, 'utf8');

const fresh = await import('../../src/fresh/index.js');

test('legacy custom sources: kinds are mapped to connector types on load', () => {
  const view = fresh.sourcesView();
  const byId = new Map(view.map((s) => [s.id, s]));
  assert.equal(byId.get('c-aaaaaaaa').type, 'rss');
  assert.equal(byId.get('c-aaaaaaaa').kind, 'rss');
  assert.equal(byId.get('c-bbbbbbbb').type, 'youtube');
  assert.equal(byId.get('c-bbbbbbbb').kind, 'yt', 'the UI still gets the old kind');
  assert.equal(byId.get('c-cccccccc').type, 'bluesky');
  assert.equal(byId.get('c-cccccccc').kind, 'bluesky');
  assert.equal(byId.get('c-dddddddd').type, 'github-releases');
  assert.equal(byId.get('c-dddddddd').kind, 'github');
  assert.ok(view.filter((s) => s.id.startsWith('c-')).every((s) => s.custom));
  assert.equal(byId.get('c-cccccccc').error, '', 'the custom Bluesky handle is not an unknown type');
});

test('legacy custom sources: the settings file is not rewritten by the mapping', () => {
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), before);
});

test('legacy custom sources: they come after the presets, as before', () => {
  const ids = fresh.sourcesView().map((s) => s.id);
  const firstCustom = ids.indexOf('c-aaaaaaaa');
  assert.ok(firstCustom > 0);
  assert.ok(ids.slice(firstCustom, firstCustom + 4).every((id) => id.startsWith('c-')));
});
