// Hacker News top stories: the list of ids first, then the items in small batches.
export const hn = {
  type: 'hn',
  title: 'Hacker News',
  configSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri', description: 'The story-list endpoint, e.g. https://hacker-news.firebaseio.com/v0/topstories.json' },
      itemUrl: { type: 'string', format: 'uri', description: 'Optional item template; {id} is replaced. Defaults to the official item endpoint.' },
    },
  },
  credentials: [],
  defaultSchedule: { every: '30m' },
  cost: { kind: 'free' },
  async fetch(ctx) {
    const res = await ctx.fetch(ctx.config.url, { accept: 'application/json' });
    if (res.status !== 200) throw new Error(`hn ${res.status}`);
    const ids = JSON.parse(res.body.toString('utf8')).slice(0, ctx.config.limit ?? 30);
    const itemUrl = ctx.config.itemUrl ?? 'https://hacker-news.firebaseio.com/v0/item/{id}.json';
    const items = [];
    for (let i = 0; i < ids.length; i += 8) {
      const got = await Promise.all(ids.slice(i, i + 8).map((id) => ctx.fetch(itemUrl.replace('{id}', id), { accept: 'application/json', timeoutMs: 10_000 }).then((r) => (r.status === 200 ? JSON.parse(r.body.toString('utf8')) : null)).catch(() => null)));
      for (const it of got) {
        if (!it || it.type === 'job' || !it.title) continue;
        items.push({
          url: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
          title: it.title,
          snippet: '',
          ts: (it.time ?? Math.floor(ctx.now() / 1000)) * 1000,
          cat: ctx.config.cat,
          meta: { points: it.score ?? 0, comments: it.descendants ?? 0 },
        });
      }
    }
    return items;
  },
};

export default hn;
