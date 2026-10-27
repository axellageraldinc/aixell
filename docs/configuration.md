# Configuration

The app reads its deployment settings from `config.json` (or `config.jsonc`) in the
repository root, plus a small set of `HERMES_WEB_*` environment variables. No file is
required: with no `config.json`, the neutral defaults below apply.

Start from `config.example.json`, which contains placeholders only.

## Precedence

1. Built-in defaults (this page).
2. `config.json` / `config.jsonc` (path from `HERMES_WEB_CONFIG`, else `<root>/config.json`, else `<root>/config.jsonc`).
3. Environment variables — they win over the file, for the deployment-only keys listed below.

A missing file is fine. When `HERMES_WEB_CONFIG` is set and points at a missing file, the
app refuses to start: an explicit path is a statement of intent, not a suggestion. A
relative `HERMES_WEB_CONFIG` is resolved against the working directory.

`config.jsonc` may contain `//` and `/* */` comments; the markers are removed before
parsing, and markers inside strings are left alone. Both file names are git-ignored: the
file describes one deployment.

## Validation

A small hand-written validator checks the file at startup. Wrong types are errors, and all
of them are reported in one message with a path-qualified line per problem. Unknown keys
only warn and are ignored.

## Keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `appName` | string | *(unset)* | Product name used in notification titles. |
| `server.port` | integer 0–65535 | `8300` | HTTP port. `0` picks a free port (tests). |
| `server.hosts` | string[] | `["127.0.0.1"]` | Interfaces to listen on. |
| `server.allowedHosts` | string[] | `[]` | Extra `Host` header names accepted (anti DNS-rebinding). `localhost` and `server.hosts` are always accepted. |
| `server.trustCloudflare` | boolean | `false` | Honour `CF-Connecting-IP` for requests from a loopback peer (the local cloudflared connector). |
| `server.cookieSecure` | boolean | `false` | Always mark session cookies `Secure`. HTTPS requests get it anyway. |
| `server.sessionDays` | integer > 0 | `30` | Session cookie lifetime. |
| `server.orphanStopMinutes` | number ≥ 0 | `20` | Stop a run nobody watches after this long. `0` disables it. |
| `agents` | string[] | `["default"]` | Hermes profile names this site serves. |
| `hermesRoot` | string | `~/.hermes` | Hermes home; profiles are read from `<hermesRoot>/profiles`. A `~` in a configured value is used literally, so write the absolute path. |
| `timezone` | string | `UTC` | Reporting timezone (IANA name). |
| `push.subject` | string | `mailto:admin@example.invalid` | VAPID contact. Use `mailto:` or an `https:` URL you control. |
| `allowInlineSecrets` | boolean | `false` | Accept literal secrets in provider configs instead of refs. Not recommended. |
| `connectors` | array | `[]` | Feed connector instances; see [connectors.md](connectors.md). Empty means the shipped presets are used. |
| `connectorsDir` | string | `<dataDir>/connectors` | Where drop-in connector files are read from. |

The following top-level keys are accepted as objects and are not validated yet (later
phases fill them in): `providers`, `fresh`, `notifications`, `budgets`,
`capabilities`, `chat`, `covers`, `locale`, `telegramImport`.

## Secret references

A secret is never a value in the config; it is a reference:

| Ref | Resolves to |
|---|---|
| `env:NAME` | the environment variable `NAME` |
| `agentEnv:NAME` | `NAME` from the served Hermes profile's `.env` |
| `file:relative/path` | the trimmed text of a file inside the data directory |
| `file:relative/path#field` | the string `field` of a JSON file inside the data directory |

Rules:

- File paths must stay inside the data directory. Absolute paths and `..` are refused.
- A missing variable or file resolves to "not configured", not to an error.
- A plain literal is refused unless `allowInlineSecrets` is `true`.
- Secret values never appear in error messages or logs.

For example, an existing `data/github.json` holding `{"token": "…"}` is referenced as
`file:github.json#token`, and a key in a profile's `.env` as `agentEnv:LLM_API_KEY`.

## Environment variables

These keep working exactly as before and override the file:

| Variable | Overrides |
|---|---|
| `HERMES_WEB_CONFIG` | path to the config file |
| `HERMES_WEB_PORT` | `server.port` |
| `HERMES_WEB_HOSTS` | `server.hosts` (comma separated) |
| `HERMES_WEB_ALLOWED_HOSTS` | `server.allowedHosts` (comma separated) |
| `HERMES_WEB_DATA_DIR` | data directory (not a config key) |
| `HERMES_WEB_PUBLIC_DIR` | public directory (not a config key) |
| `HERMES_WEB_AGENTS` | `agents` (comma separated) |
| `HERMES_ROOT` | `hermesRoot` |
| `HERMES_WEB_SESSION_DAYS` | `server.sessionDays` |
| `HERMES_WEB_COOKIE_SECURE` | `server.cookieSecure` (`1` = true) |
| `HERMES_WEB_TRUST_CLOUDFLARE` | `server.trustCloudflare` (`1` = true) |
| `HERMES_WEB_ORPHAN_STOP_MIN` | `server.orphanStopMinutes` |
| `HERMES_WEB_PUSH_SUBJECT` | `push.subject` |

## Providers

Providers are read from `data/providers.json` (not from `config.json`): `{ "providers": {...}, "capabilities": {...} }`.
Each provider has an id, a `type` and its own settings; secrets are references (see above). A capability
(`writer`, `classifier`, `images`, `socialSearch`, `transcription`, `models`) names the provider that serves it. Without the file
no capability is available and the Feed falls back to keyword heuristics.

Built-in types: `openai-compatible`, `x-api`, `null` (and `mock-gateway`, a fake used by the offline sandbox and the tests).
More types can be dropped in as `.js` files under `data/providers/`; they load once, at server start, and a file that fails to
load is skipped with a warning. The contract is in `src/providers/dropins.js`.

A `models` capability may add `routed: true` when the endpoint is a gateway that picks the real model per request (a
preset in, a model out): the composer then shows the route instead of a model list. Such a gateway can also answer which
model a conversation is on; declare where with `servedModelPath` (a path under `baseUrl` that accepts `?session=<id>` and
answers `{model, models}`) and the composer names it beside the route:

```json
{ "capabilities": { "models": { "provider": "gateway", "routed": true, "servedModelPath": "/session" } } }
```

### `x-api`: social search through the official X API

Implements `socialSearch` against the recent-search endpoint (`GET https://api.x.com/2/tweets/search/recent`), so the X
connector reads real posts. It needs a bearer token of an X developer app; each call is billed by X, so set the price you pay in
`costMicro` (millionths of `currency`) and keep the connector's `dailyCap` low.

```json
{
  "providers": {
    "x": { "type": "x-api", "bearerToken": "env:X_BEARER_TOKEN", "costMicro": 500000, "currency": "USD", "lang": "en", "maxResults": 30 }
  },
  "capabilities": {
    "socialSearch": { "provider": "x" }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `bearerToken` | none | Secret reference to the bearer token. Without it every call fails with "no key". |
| `costMicro` | `0` | Price of one call, in millionths of `currency`; recorded in the X ledger. |
| `currency` | `USD` | Currency label shown next to the cost. |
| `lang` | none | Default `lang:` operator; a slot's own language wins. |
| `maxResults` | `30` | Posts per call (10 to 100). |

The slot topic becomes `(word OR word ...)` (at most 8 words), always with `-is:retweet has:links`. `allowedHandles` become
`(from:a OR from:b)`, otherwise `excludedHandles` become `-from:a`. Recent search only reaches back seven days, so an older
start date is clamped.
