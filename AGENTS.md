# AGENTS.md

Guide for people and coding agents working on this repository. `CLAUDE.md` only points here.

## What this is

aixell: a self-hosted, single-user web app with a personal news Feed (and optional chat with a Hermes agent). Node.js 22.5 or
newer, plain ES modules, no runtime dependencies, no build step for the app. Licence AGPL-3.0-only.

## Commands

```bash
npm start                 # node server.js
npm run set-password      # interactive: writes data/auth-record.json and recovery codes
npm test                  # offline unit + integration tests (node --test)
npm run check             # scripts/check-syntax.js (node --check on every source file), then npm test
npm run test:ui           # optional headless-browser smoke test (test/ui/)
cd ui-build && npm ci && npm run build   # rebuild public/ui.css (only when changing styles)
```

`npm run check` (syntax plus `npm test`) must be green before every commit.

This repository is public and is the only copy. Whatever is pushed is public forever, so before every push: no secrets, no owner or host names, no private paths or session links (no `Claude-Session:` trailers), nothing from `data/` or `config.json`, and no internal planning notes. Keep those outside the repository.

## Structure

```
server.js           HTTP server: routing, auth, SSE, static files
src/config/         config.json loader, schema validator, secret references
src/providers/      provider contract, registry, adapters (openai-compatible, x-api, null)
src/connectors/     connector contract, registry, built-in types, presets, ingest
src/fresh/          the Feed pipeline: store, rank, timeline, filters, glossary, routes
src/scheduler/      job scheduler
src/*.js            other server modules (auth, web-sessions, push, agents, runs, ...)
public/             client, plain ES modules; public/lib/*.js; served from disk
ui-build/           Tailwind + daisyUI source for public/ui.css
scripts/            set-password, check-syntax, fresh-* helpers
deploy/             systemd, Cloudflare Tunnel, Caddy and nginx templates
hermes-profile.example/   generic Hermes profile for the optional chat
docs/               configuration.md, connectors.md, content.md, API-CONTRACT.md, license-policy.md
test/               unit/, integration/, ui/, fake-hermes/, helpers/, fixtures/
```

## Dependency rules (enforced by `test/unit/architecture.test.js`)

- Code in `src/` never imports from `public/`.
- No file in `src/` imports `server.js`.
- Code in `src/connectors/` must not import `src/fresh/`. A short list of known exceptions exists in the test; it may only
  shrink. A new such import fails the test.
- Server modules stay free of DOM assumptions; client modules in `public/` stay DOM-only.

## Conventions

- Plain ES modules, 2-space indent, single quotes, semicolons. No transpiler or bundler.
- Secrets are never literal values in config: use references (`env:NAME`, `agentEnv:NAME`, `file:path#field`). Never log them.
- All outbound fetches go through the SSRF guard (`src/fresh/net.js`, `ctx.fetch` in connectors).
- Tests are offline and deterministic: use `test/fake-hermes/` and the offline mocks. Never call real LLM, search, or paid
  APIs from tests. Set `HERMES_WEB_DATA_DIR` to a temp directory before importing `src/` in ad-hoc scripts.
- Runtime state lives in `data/` (git-ignored). `config.json` is git-ignored; `config.example.json` holds placeholders only.
- UI changes must be checked on a phone viewport (390x800) and a desktop viewport, in light and dark themes.
- No owner names, personal domains, IPs or home-directory paths in tracked public files (`test/unit/docs.test.js` scans for them).

## Add a connector

1. Write a module that default-exports `{ type, title, configSchema, credentials?, defaultSchedule, cost, fetch(ctx) }`.
   The full contract and a worked example are in [docs/connectors.md](docs/connectors.md).
2. Built-in: put it in `src/connectors/<type>.js`, register it in `src/connectors/registry.js`, and add a test under
   `test/unit/` using fixtures from `test/fixtures/`. Drop-in (no repo change): a `.js` file in `data/connectors/`.
3. Use `ctx.fetch`, `ctx.state`, `ctx.secret`; do not import from `src/fresh/`.
4. Add an instance to `connectors` in `config.json`, or to the presets in `src/connectors/presets.js` if it should ship by default.

## Add a provider

1. Implement a provider instance `{ id, type, text?, classify?, image?, search?, transcribe?, catalog? }` per the JSDoc contract in
   `src/providers/contract.js`. Throw `ProviderError` (`src/providers/errors.js`) on refusals.
2. Register the type in the `TYPES` map in `src/providers/compat.js`, or, for a private provider, export `{ type, create }` from a drop-in file under `data/providers/` (see `src/providers/dropins.js`).
3. Configure it in `data/providers.json` (`{ providers, capabilities }`) with secret references.
4. Test it against a local fake transport; never against the real service.
