// RSS 2.0 and Atom parsing (src/fresh/feeds.js) against small fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../helpers/env.js';
const { parseFeed, stripTags } = await import('../../src/fresh/feeds.js');

const fixture = (name) => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const SRC = { id: 'example', cat: 'ai' };

test('RSS: reads title, link, date, snippet and picture; drops items without a link or title', () => {
  const items = parseFeed(fixture('rss.xml'), SRC);
  assert.equal(items.length, 3);
  const [driver, entities, tracker] = items;
  assert.equal(driver.title, 'New GPU driver fixes stutter & crashes');
  assert.equal(driver.url, 'https://example.com/news/gpu-driver');
  assert.equal(driver.ts, Date.UTC(2026, 9, 20, 8, 30));
  assert.equal(driver.snippet, 'The latest driver fixes "stutter" in three games.');
  assert.equal(driver.image, 'https://example.com/img/driver.jpg');
  assert.equal(driver.source, 'example');
  assert.equal(driver.cat, 'ai');
  assert.equal(entities.title, "Escaped & entity 'title' <ok>");
  assert.equal(entities.ts, Date.UTC(2026, 9, 19, 12, 0), 'dc:date is understood');
  assert.equal(entities.image, 'https://example.com/pics/inline.png', 'an inline <img> is resolved against the article URL');
  assert.equal(tracker.image, null, 'tracking pixels and gifs are not pictures');
});

test('Atom: prefers the alternate link, accepts published or updated, decodes escaped HTML', () => {
  const items = parseFeed(fixture('atom.xml'), SRC);
  assert.equal(items.length, 2, 'the entry whose link is only an anchor is dropped');
  assert.equal(items[0].title, 'v2.4.0');
  assert.equal(items[0].url, 'https://example.org/releases/tag/v2.4.0');
  assert.equal(items[0].ts, Date.UTC(2026, 9, 21, 9, 15), 'published wins over updated');
  // TODO: the snippet of an Atom <summary type="html"> still contains its (escaped) markup; plain text would be better.
  assert.match(items[0].snippet, /Adds streaming/);
  assert.equal(items[1].title, 'Security advisory & fix');
  assert.equal(items[1].ts, Date.UTC(2026, 9, 20, 18, 0));
  assert.equal(items[1].image, 'https://example.org/a.jpg');
});

test('a feed with no entries parses to an empty list', () => {
  assert.deepEqual(parseFeed('<?xml version="1.0"?><rss><channel><title>x</title></channel></rss>', SRC), []);
  assert.deepEqual(parseFeed('', SRC), []);
});

test('stripTags removes markup, scripts and CDATA wrappers', () => {
  assert.equal(stripTags('<![CDATA[<p>Hello <b>world</b></p><script>alert(1)</script>]]>'), 'Hello world');
  assert.equal(stripTags('a &amp; b&nbsp;c'), 'a & b c');
});
