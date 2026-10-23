// Fills a Fresh store with made-up cards (no network, no model).
//   in a test:   await seedFresh(dataDir)           (runs in a child process: lib modules read their paths once, at import)
//   by hand:     node test/helpers/seed-fresh.js <dataDir>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SELF = fileURLToPath(import.meta.url);

export function seedFresh(dataDir, count = 40) {
  execFileSync(process.execPath, [SELF, dataDir, String(count)], { stdio: ['ignore', 'ignore', 'inherit'] });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) {
  process.env.HERMES_WEB_DATA_DIR = process.argv[2];
  const count = Number(process.argv[3] || 40);
  const store = await import('../../src/fresh/store.js');
  const { imageFile } = await import('../../src/fresh/enrich.js');
  const { idOf } = await import('../../src/fresh/rank.js');
  const cats = ['ai', 'pcbuild', 'pcgaming', 'security', 'ai', 'console', 'pcgaming'];
  const topics = ['llm', 'patch', 'inference', 'gpu', 'benchmark', 'driver', 'npm', 'cve', 'agent', 'mcp'];
  const now = Date.now();
  for (let i = 0; i < count; i += 1) {
    const url = `https://example.com/story/${i}`;
    const id = idOf(url);
    const published = now - i * 47 * 60_000; // one card every 47 minutes, newest first
    store.insertCandidate({
      id, url, title: `Original title ${i}`, source: `source-${i % 5}`, cat: cats[i % cats.length], published, first_seen: published,
      score: 5 - i / 20, outlets: 1 + (i % 4 === 0 ? 2 : 0), also: JSON.stringify(i % 4 === 0 ? ['hn', 'x'] : []), kind: null, flag: null,
      meta: JSON.stringify({ points: i % 3 ? 0 : 240 }), sig: `sig${i}`, status: 'new',
    });
    // The image route serves these bytes as image/jpeg; browsers sniff the real format, so a 1x1 PNG draws fine and does not break the page.
    const withImage = i % 5 !== 4;
    if (withImage) fs.writeFileSync(imageFile(id), PIXEL);
    store.markReady({
      id, title_local: `Card title ${i}`, summary: `Summary of card ${i}. Two short sentences about the story.`, why: i % 6 === 5 ? '' : 'Matters for how you build and run things.',
      topics: JSON.stringify([topics[i % topics.length], topics[(i * 7 + 3) % topics.length]]), image: withImage ? 1 : 0, llm: 1,
    });
    store.setReader(id, JSON.stringify([{ type: 'p', text: 'Stored article text, so no download is needed.' }]));
    if (i % 9 === 3) store.setFlag('saved', id, true);
    store.setRel(id, 0.35 + ((i * 37) % 60) / 100);
  }
  console.log(`seeded ${JSON.stringify(store.stats())}`);
}
