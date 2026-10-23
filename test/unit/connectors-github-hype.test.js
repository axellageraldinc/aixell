// The GitHub hype connector: thresholds from config, the token comes from ctx.secret, no token means
// unavailable (and no fetch), and the pure assess/velocity helpers keep their behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
const github = await import('../../src/connectors/github-hype.js');
const { stateFor } = await import('../../src/connectors/state.js');

const DAY = 86_400_000;
let n = 0;
const ctxOf = ({ config = {}, secret = { token: 'test-token' }, transport = null } = {}) => {
  const id = `github-test-${process.pid}-${n += 1}`;
  return {
    config: { id, ...config },
    secret: (key) => (secret ? secret[key] ?? null : null),
    state: stateFor(id),
    fetch: async () => { throw new Error('no network'); },
    transport: transport ?? undefined,
    providers: { get: () => null },
    budget: null,
    now: () => Date.now(),
    timezone: 'UTC',
    enabled: true,
    log: { warn: () => {} },
  };
};

const repo = (over = {}) => ({
  full: 'example/agent-tool', owner: 'example', name: 'agent-tool', desc: 'A coding agent with an MCP server for local models',
  topics: ['mcp', 'ai-agent'], lang: 'TypeScript', license: 'MIT', stars: 400, forks: 40,
  created: Date.now() - 10 * DAY, pushed: Date.now() - 3_600_000, fork: false, archived: false, issues: 5, size: 900, ...over,
});

test('thresholds: the shipped numbers are today\'s, and config overrides them key by key', () => {
  assert.deepEqual(github.THRESHOLDS, { young24: 150, young7: 500, young7Moving: 50, trendingToday: 100, oldSpike: 400, oldRelease: 150, youngDays: 180, minStars: 100, again24: 500, againDays: 14 });
  assert.deepEqual(github.thresholdsOf({}), github.THRESHOLDS);
  const custom = github.thresholdsOf({ thresholds: { young24: 10, nonsense: 3 } });
  assert.equal(custom.young24, 10);
  assert.equal(custom.oldSpike, 400);
  assert.equal(custom.nonsense, undefined);
});

test('assess: a young repo passes on 24h velocity, and a custom threshold changes the verdict', () => {
  const young = repo({ created: Date.now() - 5 * DAY });
  const snaps = [{ at: Date.now() - 24 * 3_600_000, stars: young.stars - 200 }];
  const verdict = github.assess(young, { snaps, now: Date.now() });
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, 'young hype');
  const strict = github.assess(young, { snaps, now: Date.now(), thresholds: { ...github.THRESHOLDS, young24: 1000 } });
  assert.equal(strict.pass, false);
});

test('assess: an old repo needs a spike or a release; fork, archived and list repos are out', () => {
  const old = repo({ created: Date.now() - 900 * DAY, stars: 5000 });
  const spike = [{ at: Date.now() - 24 * 3_600_000, stars: old.stars - 500 }];
  assert.equal(github.assess(old, { snaps: spike, now: Date.now() }).reason, 'old spike');
  assert.equal(github.assess(old, { snaps: [{ at: Date.now() - 24 * 3_600_000, stars: old.stars - 200 }], now: Date.now(), release: false }).reason, 'old, no release');
  assert.equal(github.assess(old, { snaps: [{ at: Date.now() - 24 * 3_600_000, stars: old.stars - 200 }], now: Date.now(), release: true }).pass, true);
  assert.equal(github.assess(repo({ fork: true }), { now: Date.now() }).reason, 'fork');
  assert.equal(github.assess(repo({ archived: true }), { now: Date.now() }).reason, 'archived');
  assert.equal(github.assess(repo({ desc: 'A curated list of awesome LLM apps' }), { now: Date.now() }).reason, 'list');
});

test('velocity: a snapshot gives the stars gained per 24 hours', () => {
  const now = Date.now();
  const out = github.velocity([{ at: now - 24 * 3_600_000, stars: 100 }], 400, now, now - 10 * DAY);
  assert.equal(out.d24, 300);
  assert.equal(out.basis24, 'snapshot');
});

test('searchQueries: built from the configured topics and queries, with a neutral default', () => {
  const now = Date.UTC(2026, 0, 10);
  const byDefault = github.searchQueries(now);
  assert.ok(byDefault.some((q) => q.includes('topic:ai-agents')));
  const custom = github.searchQueries(now, { topics: ['mcp'], queries: ['topic:llm stars:>500'] });
  assert.ok(custom.some((q) => q.includes('topic:mcp')));
  assert.ok(custom.includes('topic:llm stars:>500'));
  assert.equal(custom.some((q) => q.includes('topic:ai-agents')), false, 'the default topic is replaced, not merged');
});

test('no token: status says unavailable and fetch makes no request', async () => {
  const before = process.env.HERMES_WEB_FRESH_OFFLINE;
  process.env.HERMES_WEB_FRESH_OFFLINE = '0';
  try {
    let calls = 0;
    const ctx = ctxOf({ secret: null, transport: () => { calls += 1; return { status: 200, data: {} }; } });
    assert.deepEqual(await github.fetch(ctx), []);
    assert.equal(calls, 0);
    assert.equal(github.statusOf(ctx).unavailable, 'no token');
  } finally { process.env.HERMES_WEB_FRESH_OFFLINE = before; }
});

test('fetch: a mocked transport turns a hyped repo into a card with a "try it" command from the README', async () => {
  const now = Date.now();
  const created = now - 5 * DAY;
  const item = { full_name: 'example/agent-tool', name: 'agent-tool', owner: { login: 'example' }, description: 'A coding agent with an MCP server for local models', topics: ['mcp', 'ai-agent'], language: 'TypeScript', license: { spdx_id: 'MIT' }, stargazers_count: 900, forks_count: 90, created_at: new Date(created).toISOString(), pushed_at: new Date(now - 3_600_000).toISOString(), fork: false, archived: false, open_issues_count: 12, size: 900 };
  const body = 'Agent tool is a coding agent with an MCP server for local models. It reads, explains and edits a repository, runs the tests, and keeps everything on your machine. It works with any MCP client and with the common coding agents. '.repeat(3);
  const readme = Buffer.from(`# Agent tool\n\n${body}\n\n## Quick start\n\n\`\`\`bash\nnpx agent-tool@latest\n\`\`\`\n`).toString('base64');
  const transport = (url) => {
    if (String(url).includes('github.com/trending')) return { status: 200, text: '<html></html>' };
    if (String(url).includes('/search/repositories')) return { status: 200, data: { items: [item] } };
    if (String(url).endsWith('/readme')) return { status: 200, data: { content: readme } };
    if (String(url).includes('/releases/latest')) return { status: 404, data: null };
    if (String(url).includes('/repos/')) return { status: 200, data: item };
    return { status: 404, data: null };
  };
  const ctx = ctxOf({ config: { topics: ['ai-agents'], trending: [] }, transport });
  const items = await github.fetch(ctx);
  assert.equal(items.length, 1);
  assert.equal(items[0].meta.via, 'github');
  assert.equal(items[0].meta.gh.repo, 'example/agent-tool');
  assert.equal(items[0].meta.gh.coba, 'npx agent-tool@latest', 'the English "try it" line is a README command');
  assert.equal(github.statusOf(ctx).lastAdded, 1);
});

test('fetch: its own clock skips a second run within everyHours', async () => {
  let searches = 0;
  const transport = (url) => {
    if (String(url).includes('github.com/trending')) return { status: 200, text: '' };
    if (String(url).includes('/search/repositories')) { searches += 1; return { status: 200, data: { items: [] } }; }
    return { status: 404, data: null };
  };
  const before = process.env.HERMES_WEB_FRESH_OFFLINE;
  process.env.HERMES_WEB_FRESH_OFFLINE = '0';
  try {
    const ctx = ctxOf({ config: { topics: ['ai-agents'], trending: [] }, transport });
    await github.fetch(ctx);
    const afterFirst = searches;
    await github.fetch(ctx);
    assert.equal(searches, afterFirst, 'the second run within six hours does no searches');
    const forced = ctxOf({ config: { topics: ['ai-agents'], trending: [] }, transport });
    forced.force = true;
    await github.fetch(forced);
    assert.ok(searches > afterFirst, 'a forced run searches again');
  } finally { process.env.HERMES_WEB_FRESH_OFFLINE = before; }
});

test('tryCommandOf: only a real command from the README, never an invented one', () => {
  assert.equal(github.tryCommandOf('No commands here.', { owner: 'example', name: 'tool' }), '');
  assert.equal(github.tryCommandOf('```\n$ tool --version\n```', { owner: 'example', name: 'tool' }), '', 'a version check is not a way to try it');
});

test('the connector declares its contract fields', () => {
  assert.equal(github.default.type, 'github-hype');
  assert.deepEqual(github.default.defaultSchedule, { every: '6h' });
  assert.deepEqual(github.default.cost, { kind: 'free' });
  assert.deepEqual(github.default.credentials.map((c) => c.key), ['token']);
});
