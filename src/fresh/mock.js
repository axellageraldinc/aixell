import { guessCat, hardBan, keywordRelevance, unwanted } from './profile.js';
import { content } from './content.js';

// HERMES_WEB_FRESH_OFFLINE=1 (sandbox and tests): stand-ins for everything Fresh would pay for or reach over the internet.
// They answer in the same shapes as the real services, so the whole pipeline runs without a network and without a bill.
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function answerOne(q) {
  const item = String(q.instructions?.item ?? '');
  const question = String(q.instructions?.question ?? '');
  if (q.type === 'choice') return { type: 'choice', choice: guessCat(item, null) ?? 'none', confidence: 0.7, probabilities: {} };
  if (q.type === 'score') {
    const cat = guessCat(item, 'ai');
    return { type: 'score', score: keywordRelevance(cat, item) * (q.criteria.length - 1), confidence: 0.6, probabilities: {} };
  }
  if (/instead of the English word/i.test(question)) return { type: 'bool', p: 0.1 };
  if (/shopping deal|unwanted/i.test(question)) return { type: 'bool', p: hardBan(item) || unwanted(item) ? 0.95 : 0.05 };
  if (/real news/i.test(question)) return { type: 'bool', p: item.length > 30 ? 0.9 : 0.2 };
  return { type: 'bool', p: 0.8 }; // writing quality and anything else: fine
}

function classify(body) {
  const answers = {};
  for (const [id, q] of Object.entries(body.questions ?? {})) answers[id] = answerOne(q);
  return json({ answers, model: body.model, usage: { input_tokens: 0, output_tokens: 0 } });
}

function chat(body) {
  const system = String(body.messages?.[0]?.content ?? '');
  const user = String(body.messages?.[1]?.content ?? '[]');
  if (/find duplicate news/i.test(system)) return json({ choices: [{ message: { content: '[]' } }] });
  if (/group news into ongoing/i.test(system)) return json({ choices: [{ message: { content: '[]' } }] });
  if (/term translator/i.test(system)) return json({ choices: [{ message: { content: '{}' } }] });
  let list = [];
  try { list = JSON.parse(user); } catch { /* none */ }
  const cards = list.map((b) => ({
    id: b.id, title: String(b.title).slice(0, 88),
    summary: `${String(b.text || b.title).replace(/\s+/g, ' ').slice(0, 150)}. This summary was written by the offline mock model for testing.`,
    why: `Relevant to a reader who follows this topic.`, topics: ['mock', 'offline'],
  }));
  return json({ choices: [{ message: { content: JSON.stringify(cards) } }] });
}

// Two canned X answers (one with an article, one with only a post). Costs the same as a real call in the ledger, nothing for real.
// The language slot (lang:xx): good shares mixed with what a language's filter pack must drop (affiliate link,
// course for sale, giveaway). A test that wants the per-language filter writes its own pack.
const LANG_ANSWER = [
  '- @dev_notes: A practical write-up on cutting token cost with prompt caching, with real numbers. https://mock-lang.example.com/token-cost',
  '- @local_ai: Testing a quantized model on a 12GB GPU through llama.cpp, around 38 tokens per second. https://github.com/mock-lang/quantized-12gb',
  '- @promo_ai: A paid course on AI coding agents, enrol now for half price. https://mock-lang.example.com/paid-course',
  '- @affil_king: The best cheap AI tool, use this link. https://mock-lang.example.com/tool?ref=abc123',
  '- @giveaway_bot: Giveaway: premium AI accounts for ten people. https://mock-lang.example.com/giveaway-ai',
  '- @release_notes: A new open model release with a longer context window and lower API prices. https://mock-lang.example.com/model-release',
  '- @sec_notes: A malicious npm package disguised as an AI SDK stole API keys from env files. https://mock-lang.example.com/npm-sdk',
].join('\n');

function xSearch(body) {
  const q = String(body.query ?? '');
  if (/lang:[a-z]{2}/.test(q)) return json({ id: 'mock-x-lang', answer: LANG_ANSWER, citations: [], cost_micro: 100_000_000 });
  return json({
    id: 'mock-x', answer: `1. @OpenAI announces a new model update with a longer context window and lower prices. https://openai.com/index/mock-update\n2. @simonw tests a small local model with llama.cpp on a 12GB GPU: 40 tokens/s with Q4. https://x.com/simonw/status/1000000000000000001\n(query: ${q.slice(0, 40)})`,
    citations: [{ url: 'https://openai.com/index/mock-update', title: 'Mock model update' }, { url: 'https://x.com/simonw/status/1000000000000000001', title: 'simonw on X' }],
    cost_micro: 100_000_000,
  });
}

// The fake gateway: the same paths and answer shapes as the real services, for the offline switch and the tests.
export async function mockGateway(agent, path, { body } = {}) {
  if (path === '/classify') return classify(body);
  if (path === '/chat/completions') return chat(body);
  if (path === '/search') return xSearch(body);
  return json({ error: { message: 'mock: unknown path' } }, 404);
}

// ---------- Bluesky and Steam: { status, data } like net.js getJson ----------
const ok = (data, status = 200) => ({ status, data });

function mockBluesky(url) {
  const u = new URL(url);
  if (u.pathname.endsWith('createSession')) return ok({ accessJwt: 'mock', refreshJwt: 'mock', handle: 'mock.bsky.social', didDoc: {} });
  if (u.pathname.endsWith('refreshSession')) return ok({ accessJwt: 'mock', refreshJwt: 'mock' });
  if (u.pathname.endsWith('searchPosts')) {
    const q = u.searchParams.get('q');
    const post = (n, text, link, likes) => ({
      uri: `at://did:plc:mock${n}/app.bsky.feed.post/${n}aaaaaaaa`, author: { handle: `person${n}-${[...q].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7)}.bsky.social`, displayName: `Person ${n}` }, likeCount: likes, repostCount: 3, replyCount: 1,
      record: { text, langs: [content().languageCode], createdAt: new Date(Date.now() - n * 3_600_000).toISOString() },
      embed: link ? { $type: 'app.bsky.embed.external#view', external: { uri: link, title: `Article about ${q} ${n}`, description: text, thumb: '' } } : undefined,
    });
    return ok({ posts: [post(1, `Interesting write-up on ${q}: benchmarks and a local setup`, `https://example.com/mock/${encodeURIComponent(q)}/1`, 40), post(2, `${q} deals bot`, 'https://example.com/mock/deal', 1)] });
  }
  return ok({}, 404);
}

function mockSteam(url) {
  const u = new URL(url);
  if (u.pathname.includes('GetOwnedGames')) return ok({ response: { game_count: 3, games: [{ appid: 1, name: 'Mock Souls', playtime_forever: 3000 }, { appid: 2, name: 'Mock Horror', playtime_forever: 900 }, { appid: 3, name: 'Mock Idle', playtime_forever: 0 }] } });
  if (u.pathname.includes('GetRecentlyPlayedGames')) return ok({ response: { total_count: 1, games: [{ appid: 2, name: 'Mock Horror', playtime_2weeks: 300 }] } });
  if (u.pathname.includes('GetWishlist')) return ok({ response: { items: [{ appid: 10, priority: 1, date_added: 1 }, { appid: 11, priority: 2, date_added: 2 }] } });
  if (u.pathname.includes('GetNewsForApp')) return ok({ appnews: { newsitems: [{ gid: 'g1', title: 'Mock Souls patch 1.2 notes', url: 'https://steamcommunity.com/games/1/announcements/detail/1', contents: 'Fixes crashes and stutter.', date: Math.floor(Date.now() / 1000) - 3600, feedlabel: 'Community Announcements' }] } });
  if (u.pathname.includes('appdetails')) {
    const ids = (u.searchParams.get('appids') ?? '').split(',');
    return ok(Object.fromEntries(ids.map((id) => [id, { success: true, data: { name: `Mock Wish ${id}`, steam_appid: Number(id), price_overview: { discount_percent: id === '10' ? 40 : 0, final_formatted: '$10.00' } } }])));
  }
  return ok({}, 404);
}

// ---------- GitHub: a few repos of every kind the filters must handle ----------
const gh = (full, desc, extra = {}) => ({
  full_name: full, name: full.split('/')[1], owner: { login: full.split('/')[0] }, description: desc, topics: ['llm', 'ai-agent'], language: 'TypeScript', license: { spdx_id: 'MIT' },
  stargazers_count: 900, forks_count: 90, created_at: new Date(Date.now() - 4 * 86_400_000).toISOString(), pushed_at: new Date(Date.now() - 3_600_000).toISOString(), fork: false, archived: false, open_issues_count: 12, size: 900, ...extra,
});
const GH_REPOS = [
  gh('mock-dev/rea-mcp', 'REA: reverse engineer anything with an MCP server for coding agents', { topics: ['mcp', 'reverse-engineering'], stargazers_count: 2400, forks_count: 210 }),
  gh('mock-dev/shellpilot', 'A coding agent for your terminal that edits files and runs tests', { topics: ['coding-agent', 'cli'], stargazers_count: 1500, forks_count: 130, language: 'Rust' }),
  gh('mock-dev/awesome-llm-apps', 'A curated list of awesome LLM apps', { stargazers_count: 5000, forks_count: 400 }),
  gh('mock-dev/degen-agent', 'AI agent that trades memecoins on solana', { stargazers_count: 1200, forks_count: 100 }),
  gh('mock-dev/stock-ai', 'AI for stock market analysis and trading signals', { stargazers_count: 800, forks_count: 70 }),
];
const GH_README = '# REA\n\nReverse Engineer Anything: give your agent a binary, get back readable code. It exposes disassembly, decompilation and symbol recovery to any MCP client, so a coding agent can read, explain and annotate programs it did not write. It runs locally, keeps everything on your machine, and works with Claude Code, Codex and OpenCode.\n\n## Quick start\n\n```bash\nnpx rea-mcp@latest\n```\n';
const TRENDING_HTML = `<html><body>${[['mock-dev/rea-mcp', 'REA: reverse engineer anything', 'TypeScript', '2,400', '640'], ['mock-dev/unrelated-ui', 'A pretty button kit', 'CSS', '300', '120']]
  .map(([r, d, l, s, t]) => `<article class="Box-row"><h2 class="h3"><a href="/${r}"><span>${r.split('/')[0]} /</span> ${r.split('/')[1]}</a></h2><p class="col-9">${d}</p><div><span itemprop="programmingLanguage">${l}</span><a href="/${r}/stargazers">\n ${s}</a><a href="/${r}/forks">12</a><span>\n ${t} stars today</span></div></article>`).join('')}</body></html>`;

function mockGithub(url, opts) {
  const u = new URL(url);
  if (u.hostname === 'github.com') return { status: 200, text: TRENDING_HTML };
  if (u.pathname === '/search/repositories') return ok({ items: GH_REPOS });
  const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/readme|\/releases\/latest)?$/);
  if (!m) return ok({}, 404);
  if (m[2] === '/readme') return ok({ content: Buffer.from(GH_README).toString('base64'), encoding: 'base64' });
  if (m[2]) return ok({}, 404);
  const repo = GH_REPOS.find((r) => r.full_name === m[1]);
  return repo ? ok(repo) : ok({}, 404);
}

export function mockHttp(url, opts) {
  const host = new URL(url).hostname;
  if (host === 'api.github.com' || host === 'github.com') return mockGithub(url, opts);
  if (host.endsWith('bsky.social') || host.endsWith('bsky.app')) return mockBluesky(url);
  if (host.endsWith('steampowered.com')) return mockSteam(url);
  return ok({}, 404);
}
