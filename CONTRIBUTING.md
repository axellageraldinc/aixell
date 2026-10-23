# Contributing

Thanks for helping. This is a small, dependency-free Node.js app: the server is
`server.js` plus `src/**`, the client is plain ES modules under `public/**`, and
there is **no build step** for the app itself.

## Setup

Requirements: **Node.js 22.5 or newer** (see `.nvmrc`).

```sh
npm install     # no runtime dependencies; this only prepares local tooling
npm test        # offline, no credentials needed, about 40 s
npm run check   # node --check on every source file, then npm test
npm run test:ui # optional headless browser smoke test
```

`npm test` must stay green. It must not need network access or credentials, and it
must not call real LLM, search, or other paid APIs.

Running the app locally:

```sh
npm start       # serves on the configured port
```

Runtime state (database, sessions, credentials) lives in `data/`, which is
gitignored. Never commit anything from it.

## Code style

- Plain ES modules (`import`/`export`), no transpiler, no bundler.
- Match the surrounding file: 2-space indent, single quotes, semicolons, short
  helper functions, comments only where the reason is not obvious.
- Keep client modules DOM-only and server modules free of DOM assumptions.
- `.editorconfig` describes the whitespace rules; markdown keeps trailing spaces.

## Tests

- Every behavioural change needs a test. Server logic goes under `test/unit/` or
  `test/integration/`; browser checks go under `test/ui/`.
- Tests must be deterministic and offline. Use the fake Hermes agent and the
  offline mocks in `test/` instead of real services.
- If you change the outbound fetch guard, the auth flow, or the static server,
  add a regression test with the change.

## UI changes

**Every UI change must be checked on a phone viewport (390×800) and on a desktop
viewport.** Check the main views you touched: home, story/chat view, panels and
dialogs, and the composer. Text must not overflow, tap targets must stay usable,
and nothing may hide behind the tab bar or the safe-area insets.

Also check both light and dark themes when you touch colours.

## Commits

- Small, descriptive commits. One concern per commit.
- Say what changed and why in the subject line; add detail in the body if needed.
- Do not commit secrets, tokens, database files, or anything under `data/`.
- Do not mix unrelated formatting changes into a functional commit.

## Reporting bugs and security issues

Open a regular issue for bugs, with steps to reproduce and the viewport or browser
you used. For security problems, follow `SECURITY.md` instead — do not open a
public issue.
