# Connectors

A **connector** is a small module that turns one source into candidates for the Fresh feed.
The feed no longer knows how each source works: it asks the connector registry for the
connector of every configured source and calls `fetch(ctx)`.

This page covers the contract, the `connectors` config entry, the drop-in mechanism and the
built-in types: the five free feed types and the four that need a login, a key or a paid provider
(`bluesky`, `x-search`, `github-hype`, `steam`).

## The contract

`src/connectors/contract.js` documents three shapes (JSDoc only; it is not a dependency).

**Candidate** — what a connector returns:

| Field | Type | Meaning |
|---|---|---|
| `url`, `title`, `ts` | string, string, number | required; `ts` is the epoch-ms published time |
| `snippet`, `text`, `image` | string (optional) | short teaser, full text, picture URL |
| `author`, `lang` | string (optional) | author handle, ISO language code |
| `cat` | string (optional) | category hint; the classifier may override it |
| `meta` | object (optional) | extra data kept with the story (`via`, `handle`, `gh`, `release`, ...) |
| `hints` | object (optional) | `{ source?, stack?, readyCard? }`; `readyCard` skips the writer |

**ConnectorContext** — what a connector receives:

| Field | Meaning |
|---|---|
| `config` | this instance's validated config (`{ url, label?, id, cat, limit, name, ... }`) |
| `secret(ref)` | resolves `env:` / `agentEnv:` / `file:` references to a value or `null` |
| `state` | per-instance key/value store (`get(key, fallback)`, `set(key, value)`, `key(name)`) |
| `fetch` | the SSRF-guarded `safeFetch` from `src/fresh/net.js` (never a second HTTP client) |
| `providers` | `{ get(capability) }` over the provider registry; `get` returns `null` when none is configured |
| `budget` | shared cost ledger: `reserve(costMicro, { cap })`, `settle`, `refund`, `spentToday()`, `markSlot`, `read` |
| `log`, `signal`, `now()`, `timezone` | logging, a 30 s `AbortSignal`, the clock, the configured timezone |
| `enabled`, `force` | the kill switch (`settings.off` / `settings.x.enabled`) and "ignore my own clock" (the bootstrap) |

**`state` — per-instance KV.** It is the Fresh kv table (`src/fresh/store.js`), with the instance
id as the key prefix: `stateFor('bluesky').set('bluesky-since', t)` writes `bluesky:bluesky-since`.
The unprefixed key is read as a fallback, so a deployment that ran the pre-connector code keeps its
cursors (`bluesky-since`, the learned X handles, ...); writes always go to the prefixed key.

**`providers` — capability lookup.** `ctx.providers.get('socialSearch')` returns the provider
implementation bound to that capability, or `null`. A connector that needs one says so in `cost`
(`requires: ['socialSearch']`) and reports `unavailable` in `status()` when it is missing; it must
not spend anything in that case.

**`budget` — the shared cost ledger.** One file, `<dataDir>/fresh-x.json`, in the format the X search
code kept before connectors:

```json
{ "days": { "2026-01-02": { "calls": 1, "costMicro": 100000000, "slots": { "1": { "state": "done" } } } },
  "last": { "models": "2026-01-02" }, "blockedUntil": 0 }
```

Day boundaries are computed in `ctx.timezone`. A call is **reserved before it is made** (`reserve`
writes the call count, so a crash cannot overspend); the answer's real price is added with `settle`,
and a refused call (402/429/5xx/no key) gives its reservation back with `refund`. Writes are atomic
(a temporary file and a rename, mode 0600) and only the last 70 days are kept.

**Connector** — what a module exports:

| Field | Meaning |
|---|---|
| `type` | unique type name (`rss`, `youtube`, ...) |
| `title` | English display name |
| `configSchema` | JSON-schema subset for the instance `config`; drives the Settings form later |
| `credentials` | `[{ key, label, secret, required }]`; Settings only shows set/unset |
| `defaultSchedule` | `{ every: '30m' }` or `{ at: ['21:00'] }` or `{ cron: '...' }` (optional) |
| `cost` | `{ kind: 'free' | 'metered', costPerRunMicro?, requires?: string[] }` |
| `fetch(ctx)` | returns `Promise<Candidate[]>` |
| `test(ctx)` | optional "Test connection" hook |
| `status(ctx)` | optional connector-specific status |
| `boost(text)` | optional scoring hook (Steam's taste boost) |
| `push` | `true` for connectors that receive items instead of fetching (`ingest`) |

`validateConnector(obj)` returns a list of problems (empty means valid). The registry uses it
for every built-in and every drop-in.

## Config entries

Connectors are configured as a top-level array in `config.json`:

```json
{
  "connectors": [
    {
      "id": "pcgamer",
      "type": "rss",
      "enabled": true,
      "cat": "pcgaming",
      "limit": 14,
      "name": "PC Gamer",
      "config": { "url": "https://www.pcgamer.com/rss/" },
      "credentials": {}
    }
  ]
}
```

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | unique instance id (also the health-record key and the `source` of its stories) |
| `type` | yes | a built-in or drop-in connector type |
| `enabled` | no | `false` keeps it listed but never fetches it (default `true`) |
| `cat` | yes | one of the feed categories (`pcgaming`, `console`, `pcbuild`, `ai`, `security`) |
| `limit` | yes | most candidates taken per round |
| `config` | yes | connector-specific object; `url` for every built-in type |
| `credentials` | no | map of credential key to a secret *reference* (`env:NAME`, `agentEnv:NAME`, `file:path`) |
| `name` | no | display name (defaults to the connector title) |
| `schedule` | no | overrides the connector's `defaultSchedule`: `{ every: '30m' }`, `{ at: ['07:30','21:00'], days: [1,2,3,4,5] }` or `{ cron: '*/15 8-18 * * 1-5' }` (times in the configured `timezone`; validated at load) |
| `stack` | no | the reader's "this matters for my stack" flag |

The four account-bound instances keep the legacy ids `bluesky`, `x`, `github` and `steam`, so health
records, the `settings.off` list and the Settings panel (which still reports them as `virtual: true`)
keep working. Their presets ship with a neutral, empty config; a deployment fills in its own
queries, slots and handle lists.

**Resolution:** when `connectors` is non-empty it *is* the instance list, plus the four
account-bound presets (`bluesky`, `x`, `github`, `steam`) unless the list already describes an
instance with that id. When `connectors` is absent or empty, the shipped presets
(`src/connectors/presets.js`) are used, so an existing deployment needs no config change. Sources
added through Settings are appended to either list and are still stored in
`data/fresh/settings.json` with the old `kind`; they are mapped on load and the file is not
rewritten.

Credential values are never copied into an instance, a log line or the Settings view.
`credentials` only holds references; the connector context resolves them when a connector
asks for one: `ctx.secret('token')` looks up that instance's `credentials.token`, and
`ctx.secret('env:NAME')` resolves a reference directly.

`connectorsDir` sets where drop-in files are read from (default `<dataDir>/connectors`; a
relative path is resolved against the data directory).

## Writing a drop-in connector

Put a `.js` file in the connector directory (default `data/connectors/`). It must default-export
a Connector. The registry loads it at start-up; a file that throws on import or fails
validation is skipped with a warning and never stops the app. A drop-in cannot reuse a
built-in type.

```js
// data/connectors/example.js
export default {
  type: 'example',
  title: 'Example feed',
  configSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
  credentials: [{ key: 'token', label: 'API token', secret: true, required: false }],
  defaultSchedule: { every: '30m' },
  cost: { kind: 'free' },
  async fetch(ctx) {
    const res = await ctx.fetch(ctx.config.url, { accept: 'application/json' });
    if (res.status !== 200) throw new Error(`example ${res.status}`);
    const key = ctx.secret('token'); // this instance's credentials.token, resolved lazily
    const cursor = ctx.state.get('cursor', 0); // per instance: written as example:cursor
    ctx.state.set('cursor', ctx.now());
    return JSON.parse(res.body.toString('utf8')).filter((row) => Date.parse(row.published) > cursor).map((row) => ({
      url: row.link, title: row.title, ts: Date.parse(row.published) || ctx.now(),
      snippet: String(row.summary ?? '').slice(0, 400), cat: ctx.config.cat,
      meta: key ? { via: 'example' } : {},
    }));
  },
};
```

Then add an instance that uses it:

```json
{ "id": "example", "type": "example", "cat": "ai", "limit": 10, "config": { "url": "https://example.com/feed.json" } }
```

Always use `ctx.fetch` (it checks every hop for private addresses), never `globalThis.fetch`.

## Built-in types

| Type | `config` keys | What it reads |
|---|---|---|
| `rss` | `url` | RSS 2.0 or Atom; also Mastodon account feeds and any other XML feed |
| `youtube` | `url` | the channel's Atom feed (`https://www.youtube.com/feeds/videos.xml?channel_id=...`) |
| `github-releases` | `url`, `label` | a repository's `releases.atom`; stable releases only, `label` goes in front of the version |
| `ghsa` | `url` | the GitHub advisories API (`/advisories?ecosystem=...`) |
| `hn` | `url`, `itemUrl` | the Hacker News story list; `itemUrl` is an optional item template with `{id}` |
| `bluesky` | `queries`, `languages`, `maxQueries`, `botHandlePattern`, `sinceMinutes`, `retryDelayMs` | Bluesky keyword search through a login |
| `x-search` | `slots`, `dailyCap`, `handles`, `learned`, `windowHours`, `minItems` | X search through a `socialSearch` provider (paid) |
| `github-hype` | `topics`, `queries`, `thresholds`, `trending`, `everyHours` | GitHub search, Trending and star velocity |
| `steam` | `events`, `everyHours` | the reader's Steam library, wishlist, patch notes and sale events |

`ingest` is a `push: true` connector: it does not fetch. The ingest route validates and
normalises a posted batch with it and hands the items to the store. Its token and route are
unchanged for now.

## The account-bound types

These four keep their legacy instance ids (`bluesky`, `x`, `github`, `steam`) so health records and
the `settings.off` list keep working, and the Settings panel still groups them as virtual sources.
All four ship with a neutral, empty default config: they are listed, they report `unavailable` until
a deployment describes its own queries, slots or credentials, and a fresh instance makes zero paid
calls and zero login attempts.

### `bluesky`

```json
{
  "id": "bluesky", "type": "bluesky", "cat": "ai", "limit": 12,
  "config": {
    "queries": [{ "q": "open weights model", "cat": "ai", "minEngagement": 12 }],
    "languages": ["en"],
    "maxQueries": 12,
    "botHandlePattern": "(?:^|[._-])(?:bot|news|feed)(?:[._-]|$)",
    "sinceMinutes": 360
  },
  "credentials": { "handle": "file:bluesky.json#handle", "appPassword": "file:bluesky.json#app_password" }
}
```

| Key | Default | Meaning |
|---|---|---|
| `queries` | `[]` | `[{ q, cat, minEngagement }]`; empty means `unavailable: no queries configured` |
| `languages` | `['en']` | accepted post languages (the first is sent to the search API) |
| `maxQueries` | `12` | most searches per run |
| `botHandlePattern` | a generic English pattern | a regex for bot-like handles |
| `sinceMinutes` | `360` | how far back the first run looks |
| `retryDelayMs` | `350` | pause between searches (skipped offline) |

Credentials: `handle` and `appPassword`, as references (`file:bluesky.json#handle`,
`file:bluesky.json#app_password`). `test()` logs in and returns `{ ok }`, never the secret.
`status()` reports `configured`, `loggedIn`, `lastRun`, `lastAdded`, `queries`, `errors` and, when
applicable, `unavailable`. The schedule is hourly.

### `x-search`

```json
{
  "id": "x", "type": "x-search", "cat": "ai", "limit": 8,
  "config": {
    "dailyCap": 7,
    "slots": [
      { "at": "19:00", "topic": "New model releases and API pricing changes from the last day", "cats": ["ai"], "handles": "labs" },
      { "at": "23:00", "topic": "New tools and agentic projects people are talking about", "cats": ["ai"], "excludeLearned": true },
      { "at": "12:00", "topic": "Local model write-ups with real numbers", "cats": ["ai", "security"], "lang": "en", "days": 2 }
    ],
    "handles": { "labs": ["OpenAI", "AnthropicAI", "huggingface"] },
    "learned": { "pass": 4, "fail": 4, "passRatio": 3, "failRatio": 2, "max": 20, "lang": { "pass": 2, "fail": 3, "passRatio": 2, "failRatio": 2, "max": 20, "min": 8 } }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `slots` | one slot at `12:00` | `[{ at: 'HH:MM', topic, lang?, days?, cats, handles?, excludeLearned?, type? }]` |
| `dailyCap` | `7` | most paid calls per day (in `ctx.timezone`) |
| `handles` | `{}` | named handle lists a slot may follow (`handles: 'labs'` or an inline list) |
| `learned` | the numbers above | when a handle is allowed or excluded, globally and per language |
| `windowHours` | `4` | a slot that could not run within this many hours is lost for the day |
| `minItems` | `3` | a handle-restricted call below this makes the slot's next turn an open search |

The default slot's topic is built from the configured `fresh.categories` labels, so it is neutral
and English. Slot times are read in `config.timezone`. `cost` is
`{ kind: 'metered', requires: ['socialSearch'] }`: with no `socialSearch` provider `status()` says
`unavailable: needs a socialSearch provider` and `fetch` returns `[]` without writing the ledger.
The call price comes from `providers.get('socialSearch').pricing.perCallMicro` (or the answer's
`costMicro`); the ledger keeps `calls`, `costMicro` and `slots` per day, and the last raw answer of
every slot is kept for diagnosis.

A slot always runs when its hour comes; the only limit is `dailyCap` (a slot that cannot run is recorded as `skipped: cap`). A slot with a `lang` gets its own learned-handle list (which
alternates days between an open search and only those handles once `learned.lang.min` are learned)
and that language's filter pack (`data/filters/<lang>.json`): only its `drop` rules apply, and
there is no cross-language fallback. The word lists themselves are data, never code.

### `github-hype`

```json
{
  "id": "github", "type": "github-hype", "cat": "ai", "limit": 6,
  "config": {
    "topics": ["ai-agents"],
    "queries": ["topic:mcp created:>2026-01-01 stars:>60"],
    "thresholds": { "young24": 150, "young7": 500, "oldSpike": 400 },
    "trending": ["python", "typescript"],
    "everyHours": 6
  },
  "credentials": { "token": "file:github.json#token" }
}
```

| Key | Default | Meaning |
|---|---|---|
| `topics` | `['ai-agents']` | GitHub topics searched for young repositories |
| `queries` | `[]` | extra raw GitHub search queries |
| `thresholds` | the tuned defaults | star-velocity thresholds (see `src/connectors/github-hype.js`) |
| `trending` | `[]` | extra Trending languages (`python`, `typescript`, ...) |
| `everyHours` | `6` | its own clock (four runs a day) |

The token is a credential reference (`file:github.json#token`). The "how to try it" line is an
English command copied from the README, or nothing. `status()` reports the last run, the counters and
`unavailable: no token` when the token is missing.

### `steam`

```json
{
  "id": "steam", "type": "steam", "cat": "pcgaming", "limit": 8,
  "config": { "events": ["\\bnext fest\\b", "\\bsteam\\b.*\\bsale\\b"], "everyHours": 3 },
  "credentials": { "steam_id": "file:steam.json#steam_id", "api_key": "file:steam.json#api_key" }
}
```

| Key | Default | Meaning |
|---|---|---|
| `events` | neutral English patterns | regex strings of the sale/Next Fest event titles |
| `everyHours` | `3` | its own clock |

Credentials: `steam_id` and `api_key` (`file:steam.json#steam_id`, `file:steam.json#api_key`).
The connector also exposes `boost(text)` (0..0.3) for the scoring path: the registry returns it as
`registry.get('steam').boost(text)`, and it is `0` when Steam is not configured.

## Tests

`test/unit/connectors-*.test.js` cover the contract, the registry (including drop-ins and
warnings), each built-in against fixtures with a stubbed `ctx.fetch`, the per-instance `state`, the
budget ledger, the four account-bound connectors (Bluesky, X search, GitHub hype, Steam), the
presets and the legacy `kind` mapping, the schema, and the Settings sources view. The X search
tests use a fake `socialSearch` that counts calls; no test touches the network.
