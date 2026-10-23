import { safeFetch } from './net.js';

// Source adapters. The free feed types now live in src/connectors/ (contract, registry, presets), and
// the account-bound ones (bluesky, x-search, github-hype, steam) are connector types too. This module
// keeps the legacy source list and the single-account Bluesky fetch that a custom source saved by an
// older version still uses. Parsing helpers are re-exported so existing importers and tests keep
// working unchanged.

export { CATEGORIES } from './profile.js';
export { parseFeed, stripTags, discoverFeed } from '../connectors/rss.js';
export { isPrerelease } from '../connectors/github-releases.js';

// Every one of these answered with HTTP 200, parsed, and had items from the last days when they were picked (2026-10).
// `limit` = most stories taken per round; the reader can add more sources in the app.
// The connector presets (src/connectors/presets.js) are the same list in connector-instance form; this
// array stays for the equivalence test and for anything that still reads the old shape.
export const DEFAULT_SOURCES = [
  // PC gaming
  { id: 'pcgamer', name: 'PC Gamer', kind: 'rss', cat: 'pcgaming', url: 'https://www.pcgamer.com/rss/', limit: 14 },
  { id: 'rps', name: 'Rock Paper Shotgun', kind: 'rss', cat: 'pcgaming', url: 'https://www.rockpapershotgun.com/feed', limit: 12 },
  { id: 'pcgamesn', name: 'PCGamesN', kind: 'rss', cat: 'pcgaming', url: 'https://www.pcgamesn.com/feed', limit: 12 },
  { id: 'eurogamer', name: 'Eurogamer', kind: 'rss', cat: 'pcgaming', url: 'https://www.eurogamer.net/feed', limit: 12 },
  { id: 'dfoundry', name: 'Digital Foundry', kind: 'yt', cat: 'pcgaming', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC9PBzalIcEQCsiIkq36PyUA', limit: 6 },
  { id: 'nvidia-blog', name: 'NVIDIA Blog', kind: 'rss', cat: 'pcgaming', url: 'https://blogs.nvidia.com/feed/', limit: 8 },
  // Console, handheld, VR
  { id: 'verge-games', name: 'The Verge Games', kind: 'rss', cat: 'console', url: 'https://www.theverge.com/rss/games/index.xml', limit: 10 },
  { id: 'gamingonlinux', name: 'GamingOnLinux', kind: 'rss', cat: 'console', url: 'https://www.gamingonlinux.com/article_rss.php', limit: 8 },
  { id: 'uploadvr', name: 'UploadVR', kind: 'rss', cat: 'console', url: 'https://www.uploadvr.com/rss/', limit: 8 },
  { id: 'roadtovr', name: 'Road to VR', kind: 'rss', cat: 'console', url: 'https://www.roadtovr.com/feed/', limit: 6 },
  // PC building
  { id: 'toms', name: "Tom's Hardware", kind: 'rss', cat: 'pcbuild', url: 'https://www.tomshardware.com/feeds/all', limit: 14 },
  { id: 'techpowerup', name: 'TechPowerUp', kind: 'rss', cat: 'pcbuild', url: 'https://www.techpowerup.com/rss/news', limit: 14 },
  { id: 'tpu-review', name: 'TechPowerUp Reviews', kind: 'rss', cat: 'pcbuild', url: 'https://www.techpowerup.com/rss/reviews', limit: 6 },
  { id: 'wccftech', name: 'Wccftech', kind: 'rss', cat: 'pcbuild', url: 'https://wccftech.com/feed/', limit: 8 },
  { id: 'gamersnexus', name: 'Gamers Nexus', kind: 'yt', cat: 'pcbuild', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UChIs72whgZI9w6d6FhwGGHA', limit: 5 },
  { id: 'hwunboxed', name: 'Hardware Unboxed', kind: 'yt', cat: 'pcbuild', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCI8iQa1hv7oV_Z8D35vVuSg', limit: 5 },
  // AI
  { id: 'hn', name: 'Hacker News', kind: 'hn', cat: 'ai', url: 'https://hacker-news.firebaseio.com/v0/topstories.json', limit: 30 },
  { id: 'simonwillison', name: 'Simon Willison', kind: 'rss', cat: 'ai', url: 'https://simonwillison.net/atom/everything/', limit: 10 },
  { id: 'huggingface', name: 'Hugging Face', kind: 'rss', cat: 'ai', url: 'https://huggingface.co/blog/feed.xml', limit: 8 },
  { id: 'openai', name: 'OpenAI', kind: 'rss', cat: 'ai', url: 'https://openai.com/news/rss.xml', limit: 8 },
  { id: 'deepmind', name: 'Google DeepMind', kind: 'rss', cat: 'ai', url: 'https://deepmind.google/blog/rss.xml', limit: 6 },
  { id: 'anthropic', name: 'Anthropic', kind: 'rss', cat: 'ai', url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml', limit: 6 },
  { id: 'latentspace', name: 'Latent Space', kind: 'rss', cat: 'ai', url: 'https://www.latent.space/feed', limit: 6 },
  { id: 'interconnects', name: 'Interconnects', kind: 'rss', cat: 'ai', url: 'https://www.interconnects.ai/feed', limit: 5 },
  { id: 'localllama', name: 'r/LocalLLaMA', kind: 'rss', cat: 'ai', url: 'https://www.reddit.com/r/LocalLLaMA/top/.rss?t=day', limit: 12 },
  { id: 'gh-claudecode', name: 'Claude Code', kind: 'github', cat: 'ai', url: 'https://github.com/anthropics/claude-code/releases.atom', limit: 3, label: 'Claude Code' },
  { id: 'gh-codex', name: 'Codex CLI', kind: 'github', cat: 'ai', url: 'https://github.com/openai/codex/releases.atom', limit: 2, label: 'Codex CLI' },
  { id: 'gh-opencode', name: 'OpenCode', kind: 'github', cat: 'ai', url: 'https://github.com/sst/opencode/releases.atom', limit: 3, label: 'OpenCode' },
  { id: 'gh-hermes', name: 'Hermes Agent', kind: 'github', cat: 'ai', url: 'https://github.com/NousResearch/hermes-agent/releases.atom', limit: 3, label: 'Hermes Agent' },
  { id: 'gh-ollama', name: 'Ollama', kind: 'github', cat: 'ai', url: 'https://github.com/ollama/ollama/releases.atom', limit: 3, label: 'Ollama' },
  { id: 'gh-vllm', name: 'vLLM', kind: 'github', cat: 'ai', url: 'https://github.com/vllm-project/vllm/releases.atom', limit: 2, label: 'vLLM' },
  // Security
  { id: 'bleeping', name: 'BleepingComputer', kind: 'rss', cat: 'security', url: 'https://www.bleepingcomputer.com/feed/', limit: 12 },
  { id: 'thehackernews', name: 'The Hacker News', kind: 'rss', cat: 'security', url: 'https://feeds.feedburner.com/TheHackersNews', limit: 12 },
  { id: 'krebs', name: 'Krebs on Security', kind: 'rss', cat: 'security', url: 'https://krebsonsecurity.com/feed/', limit: 5 },
  { id: 'theregister-sec', name: 'The Register Security', kind: 'rss', cat: 'security', url: 'https://www.theregister.com/security/headlines.atom', limit: 8 },
  { id: 'cloudflare', name: 'Cloudflare Blog', kind: 'rss', cat: 'security', url: 'https://blog.cloudflare.com/rss/', limit: 6 },
  { id: 'nodejs-sec', name: 'Node.js Security', kind: 'rss', cat: 'security', url: 'https://nodejs.org/en/feed/vulnerability.xml', limit: 3, stack: true },
  { id: 'ghsa-npm', name: 'GitHub Advisories (npm)', kind: 'ghsa', cat: 'security', url: 'https://api.github.com/advisories?ecosystem=npm&severity=critical&per_page=10', limit: 8, stack: true },
  { id: 'ghsa-pip', name: 'GitHub Advisories (pip)', kind: 'ghsa', cat: 'security', url: 'https://api.github.com/advisories?ecosystem=pip&severity=critical&per_page=10', limit: 8, stack: true },
];

// Bluesky: the public AppView serves an account's posts without a login. A custom Bluesky handle
// saved by an older version (a single account, not the keyword search of the connector) still uses
// this path, exactly as before.
async function fetchBluesky(src) {
  const res = await safeFetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(src.url)}&limit=25&filter=posts_no_replies`, { accept: 'application/json' });
  if (res.status !== 200) throw new Error(`bsky ${res.status}`);
  const feed = JSON.parse(res.body.toString('utf8')).feed ?? [];
  return feed.filter((f) => !f.reason && f.post?.record?.text).map((f) => {
    const p = f.post;
    const text = p.record.text.replace(/\s+/g, ' ').trim();
    const ext = p.embed?.external ?? p.embed?.media?.external;
    return {
      source: src.id, cat: src.cat, title: (ext?.title || text).slice(0, 140), url: ext?.uri || `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split('/').pop()}`,
      snippet: text.slice(0, 400), ts: Date.parse(p.record.createdAt) || Date.now(), image: ext?.thumb ?? p.embed?.images?.[0]?.fullsize ?? null,
      meta: { likes: p.likeCount ?? 0, author: p.author.handle },
    };
  });
}

// Only the legacy kinds that have no connector path. The free feed types and the four
// account-bound types go through the registry.
const DISPATCH = { 'bluesky-account': fetchBluesky };
export const KINDS = ['rss', 'youtube', 'github-releases', 'ghsa', 'hn', 'bluesky', 'x-search', 'github-hype', 'steam'];

export function fetchSource(src) {
  const fn = DISPATCH[src.legacy ?? src.kind];
  if (!fn) throw new Error(`unknown kind ${src.kind}`);
  return fn(src);
}
