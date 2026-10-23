// The shipped connector presets: today's 39 default feed sources plus the four that need a login,
// a key or a paid provider (Bluesky, X search, GitHub hype, Steam), described as connector
// instances. The four keep their legacy ids so health records and the `settings.off` list keep
// working; their config is neutral and empty, so they report `unavailable` until a deployment
// describes its own queries, slots and credentials.
//
// An entry has the shape the registry's `instances()` accepts:
//   { id, type, cat, limit, config: { ... }, name, stack? }
// `stack: true` is the reader's "this matters for my stack" hint (see fresh/rank.js).
//
// `legacyKindToType` maps the old `kind` values. Settings custom sources
// (data/fresh/settings.json, written by an older version) still carry `kind`; they are mapped on
// load and the file is not rewritten.

export const DEFAULT_CONNECTOR_PRESETS = [
  // PC gaming
  { id: 'pcgamer', type: 'rss', cat: 'pcgaming', limit: 14, config: { url: 'https://www.pcgamer.com/rss/' }, name: 'PC Gamer' },
  { id: 'rps', type: 'rss', cat: 'pcgaming', limit: 12, config: { url: 'https://www.rockpapershotgun.com/feed' }, name: 'Rock Paper Shotgun' },
  { id: 'pcgamesn', type: 'rss', cat: 'pcgaming', limit: 12, config: { url: 'https://www.pcgamesn.com/feed' }, name: 'PCGamesN' },
  { id: 'eurogamer', type: 'rss', cat: 'pcgaming', limit: 12, config: { url: 'https://www.eurogamer.net/feed' }, name: 'Eurogamer' },
  { id: 'dfoundry', type: 'youtube', cat: 'pcgaming', limit: 6, config: { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC9PBzalIcEQCsiIkq36PyUA' }, name: 'Digital Foundry' },
  { id: 'nvidia-blog', type: 'rss', cat: 'pcgaming', limit: 8, config: { url: 'https://blogs.nvidia.com/feed/' }, name: 'NVIDIA Blog' },
  // Console, handheld, VR
  { id: 'verge-games', type: 'rss', cat: 'console', limit: 10, config: { url: 'https://www.theverge.com/rss/games/index.xml' }, name: 'The Verge Games' },
  { id: 'gamingonlinux', type: 'rss', cat: 'console', limit: 8, config: { url: 'https://www.gamingonlinux.com/article_rss.php' }, name: 'GamingOnLinux' },
  { id: 'uploadvr', type: 'rss', cat: 'console', limit: 8, config: { url: 'https://www.uploadvr.com/rss/' }, name: 'UploadVR' },
  { id: 'roadtovr', type: 'rss', cat: 'console', limit: 6, config: { url: 'https://www.roadtovr.com/feed/' }, name: 'Road to VR' },
  // PC building
  { id: 'toms', type: 'rss', cat: 'pcbuild', limit: 14, config: { url: 'https://www.tomshardware.com/feeds/all' }, name: "Tom's Hardware" },
  { id: 'techpowerup', type: 'rss', cat: 'pcbuild', limit: 14, config: { url: 'https://www.techpowerup.com/rss/news' }, name: 'TechPowerUp' },
  { id: 'tpu-review', type: 'rss', cat: 'pcbuild', limit: 6, config: { url: 'https://www.techpowerup.com/rss/reviews' }, name: 'TechPowerUp Reviews' },
  { id: 'wccftech', type: 'rss', cat: 'pcbuild', limit: 8, config: { url: 'https://wccftech.com/feed/' }, name: 'Wccftech' },
  { id: 'gamersnexus', type: 'youtube', cat: 'pcbuild', limit: 5, config: { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UChIs72whgZI9w6d6FhwGGHA' }, name: 'Gamers Nexus' },
  { id: 'hwunboxed', type: 'youtube', cat: 'pcbuild', limit: 5, config: { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCI8iQa1hv7oV_Z8D35vVuSg' }, name: 'Hardware Unboxed' },
  // AI
  { id: 'hn', type: 'hn', cat: 'ai', limit: 30, config: { url: 'https://hacker-news.firebaseio.com/v0/topstories.json' }, name: 'Hacker News' },
  { id: 'simonwillison', type: 'rss', cat: 'ai', limit: 10, config: { url: 'https://simonwillison.net/atom/everything/' }, name: 'Simon Willison' },
  { id: 'huggingface', type: 'rss', cat: 'ai', limit: 8, config: { url: 'https://huggingface.co/blog/feed.xml' }, name: 'Hugging Face' },
  { id: 'openai', type: 'rss', cat: 'ai', limit: 8, config: { url: 'https://openai.com/news/rss.xml' }, name: 'OpenAI' },
  { id: 'deepmind', type: 'rss', cat: 'ai', limit: 6, config: { url: 'https://deepmind.google/blog/rss.xml' }, name: 'Google DeepMind' },
  { id: 'anthropic', type: 'rss', cat: 'ai', limit: 6, config: { url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml' }, name: 'Anthropic' },
  { id: 'latentspace', type: 'rss', cat: 'ai', limit: 6, config: { url: 'https://www.latent.space/feed' }, name: 'Latent Space' },
  { id: 'interconnects', type: 'rss', cat: 'ai', limit: 5, config: { url: 'https://www.interconnects.ai/feed' }, name: 'Interconnects' },
  { id: 'localllama', type: 'rss', cat: 'ai', limit: 12, config: { url: 'https://www.reddit.com/r/LocalLLaMA/top/.rss?t=day' }, name: 'r/LocalLLaMA' },
  { id: 'gh-claudecode', type: 'github-releases', cat: 'ai', limit: 3, config: { url: 'https://github.com/anthropics/claude-code/releases.atom', label: 'Claude Code' }, name: 'Claude Code' },
  { id: 'gh-codex', type: 'github-releases', cat: 'ai', limit: 2, config: { url: 'https://github.com/openai/codex/releases.atom', label: 'Codex CLI' }, name: 'Codex CLI' },
  { id: 'gh-opencode', type: 'github-releases', cat: 'ai', limit: 3, config: { url: 'https://github.com/sst/opencode/releases.atom', label: 'OpenCode' }, name: 'OpenCode' },
  { id: 'gh-hermes', type: 'github-releases', cat: 'ai', limit: 3, config: { url: 'https://github.com/NousResearch/hermes-agent/releases.atom', label: 'Hermes Agent' }, name: 'Hermes Agent' },
  { id: 'gh-ollama', type: 'github-releases', cat: 'ai', limit: 3, config: { url: 'https://github.com/ollama/ollama/releases.atom', label: 'Ollama' }, name: 'Ollama' },
  { id: 'gh-vllm', type: 'github-releases', cat: 'ai', limit: 2, config: { url: 'https://github.com/vllm-project/vllm/releases.atom', label: 'vLLM' }, name: 'vLLM' },
  // Security
  { id: 'bleeping', type: 'rss', cat: 'security', limit: 12, config: { url: 'https://www.bleepingcomputer.com/feed/' }, name: 'BleepingComputer' },
  { id: 'thehackernews', type: 'rss', cat: 'security', limit: 12, config: { url: 'https://feeds.feedburner.com/TheHackersNews' }, name: 'The Hacker News' },
  { id: 'krebs', type: 'rss', cat: 'security', limit: 5, config: { url: 'https://krebsonsecurity.com/feed/' }, name: 'Krebs on Security' },
  { id: 'theregister-sec', type: 'rss', cat: 'security', limit: 8, config: { url: 'https://www.theregister.com/security/headlines.atom' }, name: 'The Register Security' },
  { id: 'cloudflare', type: 'rss', cat: 'security', limit: 6, config: { url: 'https://blog.cloudflare.com/rss/' }, name: 'Cloudflare Blog' },
  { id: 'nodejs-sec', type: 'rss', cat: 'security', limit: 3, config: { url: 'https://nodejs.org/en/feed/vulnerability.xml' }, name: 'Node.js Security', stack: true },
  { id: 'ghsa-npm', type: 'ghsa', cat: 'security', limit: 8, config: { url: 'https://api.github.com/advisories?ecosystem=npm&severity=critical&per_page=10' }, name: 'GitHub Advisories (npm)', stack: true },
  { id: 'ghsa-pip', type: 'ghsa', cat: 'security', limit: 8, config: { url: 'https://api.github.com/advisories?ecosystem=pip&severity=critical&per_page=10' }, name: 'GitHub Advisories (pip)', stack: true },
  // The account-bound connectors: listed, switched on and reported, but unavailable until the
  // deployment supplies queries, slots or credentials.
  { id: 'bluesky', type: 'bluesky', cat: 'ai', limit: 12, config: { queries: [] }, name: 'Bluesky (search)' },
  { id: 'x', type: 'x-search', cat: 'ai', limit: 8, config: { dailyCap: 7 }, name: 'X (social search)' },
  { id: 'github', type: 'github-hype', cat: 'ai', limit: 6, config: { topics: ['ai-agents'] }, name: 'GitHub (trending AI repos)' },
  { id: 'steam', type: 'steam', cat: 'pcgaming', limit: 8, config: {}, name: 'Steam (library, patch, sale)' },
];

// The old `kind` values, and the connector type each becomes. Unknown kinds stay unknown (the
// registry lists the instance with an error instead of fetching it).
export const legacyKindToType = {
  rss: 'rss',
  atom: 'rss',
  mastodon: 'rss',
  yt: 'youtube',
  github: 'github-releases',
  ghsa: 'ghsa',
  hn: 'hn',
};

// A custom Bluesky handle saved by the Settings dialog keeps the `bluesky` type. The preset of that
// type is the keyword search connector; a custom handle is a single account's public feed, which
// still goes through the old fetcher (feeds.js), so it is marked as legacy below.
export const LEGACY_BLUESKY = 'bluesky';

export const legacyKindOf = (type) => Object.entries(legacyKindToType).find(([, mapped]) => mapped === type)?.[0] ?? type;

// A custom source saved by an older version: { id, name, kind, cat, url }. `kind` may be a legacy
// value; `bsky-search` (a custom Bluesky handle) maps to the Bluesky type and is fetched as a
// single account feed by the legacy path in fresh/index.js (`legacy: 'bluesky-account'`).
export function fromLegacySource(source) {
  const kind = String(source?.kind ?? 'rss');
  const type = legacyKindToType[kind] ?? (kind === 'bsky-search' || kind === 'bluesky' ? LEGACY_BLUESKY : kind);
  return {
    id: String(source.id),
    type,
    cat: source.cat,
    limit: source.limit,
    name: source.name,
    config: { url: source.url, ...(source.label ? { label: source.label } : {}) },
    ...(kind === 'bsky-search' || kind === 'bluesky' ? { legacy: 'bluesky-account' } : {}),
    ...(source.stack ? { stack: true } : {}),
  };
}
