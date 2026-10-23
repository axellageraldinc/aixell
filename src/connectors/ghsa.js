// GitHub security advisories for the ecosystems the reader's stack uses (public API, no key needed for a few calls a day).
export const ghsa = {
  type: 'ghsa',
  title: 'GitHub security advisories',
  configSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri', description: 'The advisories API URL, e.g. https://api.github.com/advisories?ecosystem=npm&severity=critical&per_page=10' },
    },
  },
  credentials: [],
  defaultSchedule: { every: '30m' },
  cost: { kind: 'free' },
  async fetch(ctx) {
    const res = await ctx.fetch(ctx.config.url, { accept: 'application/vnd.github+json' });
    if (res.status !== 200) throw new Error(`ghsa ${res.status}`);
    return JSON.parse(res.body.toString('utf8')).slice(0, ctx.config.limit ?? 8).map((a) => {
      const pkgs = [...new Set((a.vulnerabilities ?? []).map((v) => v.package?.name).filter(Boolean))].slice(0, 3);
      return {
        url: a.html_url,
        title: `${a.summary}${pkgs.length ? ` (${pkgs.join(', ')})` : ''}`.slice(0, 200),
        snippet: String(a.description ?? '').replace(/[#*`>\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400),
        ts: Date.parse(a.published_at) || Date.now(),
        cat: ctx.config.cat,
        meta: { cve: a.cve_id ?? '', severity: a.severity ?? '', packages: pkgs },
      };
    });
  },
};

export default ghsa;
