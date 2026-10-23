# Backend / frontend contract

A single page (SPA) with no build step: plain HTML + CSS + ES-module JavaScript. No CDN and no external libraries (private
data, often on a LAN). The UI text is localised (see `public/locales/`). **Dark mode only** in the original contract; the app
now also ships a light theme.

An "agent" is one Hermes profile (for example `default`, `research`). The list of agents is dynamic and comes from the backend.

## Hard rules for the frontend (strict CSP set by the server)

The server sends: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'`.
This means:
- **Forbidden:** inline `<script>`, `onclick=` attributes, `style="..."` attributes, `eval`, and `innerHTML` with untrusted data.
- Dynamic styling goes through CSS classes or `element.style.prop = ...` (allowed). Never `setAttribute('style', ...)`.
- All message content, file names, session titles and tool output coming from the server are **untrusted**. Render them with
  `textContent` / `createElement`. Markdown: write a small renderer of your own that builds DOM nodes (headings, bold, italic,
  inline code, code blocks, lists, `http(s)` links only with `rel="noopener noreferrer"` and `target="_blank"`, optional simple
  tables). No raw HTML.
- Every mutating request (`POST/PUT/PATCH/DELETE`) must carry the header `X-CSRF-Token: <csrf from /api/me>`. The `HttpOnly`
  session cookie is handled by the browser (use `fetch(..., {credentials:'same-origin'})`). On a `401` response, redirect to `/login.html`.
- Never store secrets in localStorage. UI preferences (last agent, panel width) may be stored.

## Files to create (in `public/` only)

```
public/login.html   public/login.js
public/index.html   public/app.js   public/app.css
public/lib/*.js     (modules: api.js, markdown.js, sse.js, state.js, UI components, and so on; free choice)
```

## Login page (`/login.html`)
A form with username, password and authenticator code (6 digits, `inputmode="numeric"`, `autocomplete="one-time-code"`), or a
recovery code (the same field accepts both). It calls `POST /api/login`. Show the error; for `429` show
"Too many attempts, try again in N seconds" using `retryAfter`. On success, `location.href = '/'`.

## App layout (`/`)
Desktop: 3 columns. Mobile (<900px): the columns become slide-in panels (drawers) opened from buttons in the header.
1. **Left: agents and sessions.** A list of agents (online/offline dot, name, active model). Choosing an agent shows its sessions below it.
   Source toggle: **Web** (default, `source=web`) / **Telegram** (`source=telegram`, *read-only*, no chat input) / All.
   A "New chat" button, rename a session title, delete a session (with confirmation). Local search on titles. Infinite scroll or a
   "load more" button (`has_more`).
2. **Middle: chat.** Message history (user right-aligned, assistant left-aligned), token streaming, tool cards (tool name, status
   running/done/failed, collapsible), code blocks with a copy button, and auto-scroll that stops when the user scrolls up.
   Composer: a textarea (Enter sends, Shift+Enter adds a new line), an attach-file button, drag-and-drop, **paste images from the clipboard**,
   attachment chips with a thumbnail for images and a remove button, and a **Stop** button while a run is active. When a Telegram session
   is selected, the composer is disabled with the note "Telegram history (read-only)".
   **Approval** card: when an `approval.request` event arrives, show the command/tool and the buttons "Allow once" and "Deny";
   count down 120 s and deny automatically when it runs out.
3. **Right: settings and usage** (tabs):
   - **Model**: a dropdown/list of models from `/models` (columns: name, reasoning yes/no, context window, price per 1M tokens, monthly quota limit,
     note). The choice is stored per session in the UI and sent with every chat. Options: **Effort** (`none, minimal, low, medium, high, xhigh, max, ultra`;
     only enabled when the model supports reasoning) and **Service tier** (`default`/`priority`). A button resets to the agent's default.
   - **Usage**: for the selected session: input/output/cache/reasoning tokens, number of API calls, estimated cost (USD), and a **context-window bar**
     (`input_tokens` of the last call divided by the model's context window; the colour changes above 70% and 90%). For the agent: totals for the
     last N days (`/usage?days=30`) as number cards, a bar chart per day (hand-made SVG, no library) and a table per model.

Required UI states: loading, empty, error (with a retry button), agent offline.

## Endpoints (all on the same origin; JSON unless noted)
Errors are always `{"error":{"message":string,"code":string}}` with the matching HTTP status.

| Method & path | Body / query | Success response |
|---|---|---|
| `POST /api/login` | `{username,password,code}` | `200 {ok:true}` · `401` · `429 {error, retryAfter}` |
| `POST /api/logout` | – | `200 {ok:true}` |
| `POST /api/logout-all` | – | `200 {ok:true}` (revokes every device) |
| `GET /api/me` | – | `200 {username,csrf,expiresAt}` · `401` |
| `GET /api/agents` | – | `{agents:[{name,label,online,isDefault,provider,model}]}` |
| `GET /api/agents/:a/models` | – | see below |
| `GET /api/agents/:a/sessions` | `source=web\|telegram\|all` (default web), `limit` (≤100), `offset` | `{data:[Session],has_more}` |
| `POST /api/agents/:a/sessions` | `{title?}` | `{session:Session}` |
| `GET /api/agents/:a/sessions/:id` | – | `{session:Session}` |
| `PATCH /api/agents/:a/sessions/:id` | `{title}` | `{session:Session}` |
| `DELETE /api/agents/:a/sessions/:id` | – | `{ok:true}` |
| `GET /api/agents/:a/sessions/:id/messages` | `limit`, `offset`, `order=asc\|desc` | `{data:[Message],pagination}` |
| `POST /api/agents/:a/chat` | see below | **SSE** `text/event-stream` |
| `POST /api/agents/:a/runs/:runId/stop` | – | `{ok:true}` |
| `POST /api/agents/:a/runs/:runId/approval` | `{decision:"once"\|"deny"}` | `{ok:true}` |
| `POST /api/agents/:a/uploads` | **raw body** (not a form). Headers: `X-Filename` (URL-encoded), `Content-Type` = the file's mime type | `{id,name,size,mime,kind:"image"\|"file"}` |
| `GET /api/uploads/:id` | – | the file (images inline, everything else as a download) |
| `GET /api/agents/:a/usage` | `days` (1–90, default 30) | see below |

Uploads are limited to 25 MB per file; the server rejects larger ones with `413`. Show its error.

### Session
```
{ id, source:"api_server"|"telegram"|..., title|null, model|null, started_at, last_active, ended_at|null, message_count, tool_call_count,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, api_call_count,
  estimated_cost_usd, actual_cost_usd|null, preview, pinned, archived }
```
`started_at`/`last_active` are epoch seconds (float). A `null` title: show `preview` or "New conversation".

### Message
`{id, session_id, role:"user"|"assistant"|"tool"|"system", content:string, tool_name|null, tool_call_id|null, timestamp, display_kind}`.
A `role:"tool"` message is shown as a collapsed tool card (name plus truncated output). A user message that contains lines like
`[Attachment: file-name (kind)]` may be shown as is.

### `GET /api/agents/:a/models`
```
{ current:{provider,model},
  effortLevels:["none","minimal","low","medium","high","xhigh","max","ultra"],
  serviceTiers:["default","priority"],
  models:[{ id, provider, reasoning:boolean,
            contextWindow:number|null,
            price:{inputPerM:number|null, outputPerM:number|null, cachedPerM:number|null, currency?:string}|null,   // per 1 million tokens, in `currency` (default USD)
            quota:{monthlyUsd:number|null, requestsPerMonth:number|null}|null,                   // subscription limit of the provider
            note:string|null }] }
```
A `null` value means unknown: show "-". Never guess numbers.

### `POST /api/agents/:a/chat` (SSE)
Body: `{sessionId?, text, attachments?:[uploadId], model?, provider?, reasoningEffort?, serviceTier?}`.
Without a `sessionId` the server creates a new session and sends `web.session` as the first event.
SSE events (a line `event: <name>` followed by `data: <json>`) are exactly Hermes' own, plus events made by the server:

| event | important data |
|---|---|
| `web.session` | `{session_id}` (only when a new session was created) |
| `run.started` | `{run_id, session_id, user_message}`: keep `run_id` for Stop/approval |
| `message.started` | `{message_id}` |
| `assistant.delta` | `{message_id, delta}`: append to the assistant text |
| `assistant.commentary` | `{message_id, text}`: commentary in the middle of a turn, shown dimmed |
| `tool.started` / `tool.completed` / `tool.failed` | `{tool_name, ...}`: tool card |
| `tool.progress` | `{tool_name, delta}`: `tool_name:"_thinking"` is reasoning text (show it in a collapsed "Thinking" block) |
| `approval.request` | details of the permission request (show every field present, as text) plus `run_id` |
| `assistant.completed` | `{content, runtime:{provider,model}}` |
| `run.completed` | `{usage:{input_tokens,output_tokens,total_tokens}, messages}`: `input_tokens` is the prompt size of this call (used for the context bar) |
| `done` | end of the stream |
| `error` | `{message}` (from the server or from Hermes) |

A real sample is in `docs/sse-sample.txt`. Unknown events must be ignored without an error. Use `fetch` + `ReadableStream`
(not `EventSource`, because the method is POST). If the connection drops midway, mark the message "interrupted" and offer to reload the history from the server.

### `GET /api/agents/:a/usage?days=30`
```
{ days, totals:{sessions,apiCalls,inputTokens,outputTokens,cacheReadTokens,reasoningTokens,estimatedCostUsd},
  byDay:[{date:"YYYY-MM-DD",inputTokens,outputTokens,estimatedCostUsd,apiCalls}],
  byModel:[{model,sessions,apiCalls,inputTokens,outputTokens,estimatedCostUsd}] }
```

## Feed endpoints (`/api/fresh`)

Same session cookie as everything else; writes need `X-CSRF-Token`.

| Method & path | Body / query | Success response |
|---|---|---|
| `GET /api/fresh/` | `cat` (category id), `mode=foryou\|latest`, `saved=1`, `cursor`, `limit` (default 12) | story list page (supports ETag) |
| `POST /api/fresh/refresh` | – | `200`; wakes the worker and returns at once (never waits for gathering) |
| `GET /api/fresh/status` | – | `200` worker status |
| `GET /api/fresh/poll` | `since` (number) | `200` what changed since that point |
| `GET /api/fresh/settings` | – | `200` settings plus `sources`, `categories`, `ingest`, locale info |
| `GET /api/fresh/categories` | – | `200 {categories, from, editable}` |
| `PUT /api/fresh/categories` | `{categories: [{id, label, halfLifeHours, keywords:{pos,neg}}]}` | `200` the saved list and `catOrder` · `400 bad_categories` (also when `config.json` owns the list) |
| `PUT /api/fresh/settings` | `{enabled?, intervalMin?, x?, catOrder?, notify?, llmPerMin?}` | `200` updated settings · `400 bad_order` |
| `POST /api/fresh/seen` | `{ids: string[]}` (body up to 8 KB) | `200` marks those stories as seen |
| `GET /api/fresh/img/:id` | – | `200 image/jpeg`, cacheable for a week · `404 no_image` |
| `GET /api/fresh/:id/reader` | – | `200` reader view of one story · `404 no_item` |
| `POST /api/fresh/:id/signal` | `{kind: "open"\|"read"\|"dwell"\|"skip"\|"ask"\|"save"\|"share", ms?}` | `200` marks the story seen · `400 bad_signal` · `429 rate_limited` |
| `POST /api/fresh/:id/save` `unsave` `hide` `read` | – | `200` sets the flag on the story · `404 no_item` |
| `POST /api/fresh/sources` | `{url, cat?, name?}` | `200` finds the feed at that address and adds it · `400 bad_source` |
| `PATCH /api/fresh/sources/:id` | `{on: boolean}` | `200 {ok:true}` switches a source on or off · `404 no_source` |
| `DELETE /api/fresh/sources/:id` | – | `200 {ok:true}`; only sources you added yourself · `404 no_source` |
| `GET /api/fresh/glossary` | – | `200 {entries}` terms awaiting or holding a decision |
| `PUT /api/fresh/glossary/:term` | `{decision, form?, bad?}` | `200` records the decision · `400 bad_term` |
| `GET /api/fresh/ingest-token` | – | `200 {token}` the bearer token a worker uses below |

Two routes use the ingest bearer token (`Authorization: Bearer <token>`) instead of a browser session, so they need neither
cookie nor CSRF header:

| Method & path | Body / query | Success response |
|---|---|---|
| `POST /api/fresh/ingest` | items in the connector ingest shape (body up to 512 KB) | `200` ingest result · `401 unauthorized` |
| `POST /api/fresh/bootstrap` | `?force=1` skips the once-per-24-hours guard | `202 {job}` · `409 bootstrap_running` · `429 bootstrap_recent` |
| `GET /api/fresh/bootstrap` | – | `200 {job}` progress · `404 no_job` |

## Visual style
Dark mode: a background around #0f1115, layered surfaces, high-contrast text (WCAG AA), one accent colour. System font
(`system-ui`) and `ui-monospace` for code. Moderately rounded corners, generous spacing, no excessive animation
(respect `prefers-reduced-motion`). Visible keyboard focus. Touch targets of at least 40px on mobile. All colours go through CSS custom properties on `:root`.
`<meta name="color-scheme" content="dark">` and `<meta name="viewport" ...>`.
