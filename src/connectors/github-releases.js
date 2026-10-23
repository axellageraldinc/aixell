// GitHub releases (the releases.atom feed of a repository).
//
// "v2.1.307" alone says nothing, so the product name goes in front. Only STABLE releases are news: a tag or
// title with alpha / beta / rc / preview / nightly / canary / dev / pre, or a "1.2.3-something" version, is
// dropped (the title of an ollama pre-release can read "v0.40.9" while its tag says "-rc1", so the tag counts too).
import { decodeEntities as decode, fetchFeed } from './rss.js';

const PRE = /(?:^|[^a-z])(?:alpha|beta|rc\d*|preview|nightly|canary|dev|pre|snapshot|insiders?|experimental)(?:[^a-z]|$)|\d+\.\d+\.\d+-[\w.]+/i;
const BIG_NOTES = /\b(breaking|new model|security|deprecat\w*|migration)\b/i;
const versionOf = (s) => s.match(/(\d+)\.(\d+)(?:\.(\d+))?/)?.slice(1, 3).map(Number) ?? null;
export const isPrerelease = (title, url = '') => PRE.test(title) || PRE.test(decodeURIComponent(String(url).split('/releases/tag/')[1] ?? ''));

export const githubReleases = {
  type: 'github-releases',
  title: 'GitHub releases',
  configSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri', description: 'The repository release feed, e.g. https://github.com/owner/repo/releases.atom' },
      label: { type: 'string', description: 'Product name put in front of the version (defaults to the instance name).' },
    },
  },
  credentials: [],
  defaultSchedule: { every: '30m' },
  cost: { kind: 'free' },
  async fetch(ctx) {
    const label = ctx.config.label ?? ctx.config.name ?? 'Release';
    const items = await fetchFeed(ctx, { url: ctx.config.url, limit: 40, keepBodyLen: true });
    const stable = items.filter((i) => /\d+\.\d+/.test(i.title) && !isPrerelease(i.title, i.url)).sort((a, b) => b.ts - a.ts);
    const seen = new Set();
    return stable.filter((i) => { const base = i.title.match(/\d+\.\d+\.\d+/)?.[0] ?? i.title; return !seen.has(base) && seen.add(base); })
      .slice(0, ctx.config.limit ?? 3)
      .map((i) => {
        // A step in major / minor, or long or weighty notes, is worth a card even right after another; a plain patch is not.
        const [maj, min] = versionOf(i.title) ?? [0, 0];
        const prev = versionOf(stable[stable.indexOf(i) + 1]?.title ?? '') ?? [maj, min];
        const bodyLen = i.meta?.bodyLen ?? 0;
        const substantial = maj !== prev[0] || min !== prev[1] || bodyLen > 3000 || BIG_NOTES.test(i.snippet ?? '');
        return { ...i, title: `${label} ${i.title.match(/v?\d+(?:\.\d+)+\S*/)[0]} released`, snippet: (i.snippet ?? '').slice(0, 300), meta: { release: true, repo: true, substantial } };
      });
  },
};

export default githubReleases;
