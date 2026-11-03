# Browser bridge

Lets an agent read and operate the owner's own browser through the **aixell extension** (a separate Chrome extension; it is
not part of this repository). Off by default.

## Turn it on

1. Install the extension in the browser you use for aixell, and note its ID (`chrome://extensions`).
2. Add the ID to the settings and restart: `server.browserExtensionIds: ["<id>"]` in `config.json`, or
   `HERMES_WEB_BROWSER_EXTENSION_IDS=<id>`. With no ID the endpoints below answer 404.
3. In the extension's side panel, enter the address of this app. It signs in with the same browser session as the web app.
4. Give the agent the tools: add `scripts/browser-mcp.js` to the agent's MCP servers
   (`env: AIXELL_URL, AIXELL_DATA_DIR`). The tool list is `src/browser-tools.js`.

## How it works

| Endpoint | Caller | Checks |
|---|---|---|
| `GET /api/browser/events` | extension | session cookie + marked as the extension (see below); one stream at a time; ends when the session ends |
| `POST /api/browser/results` | extension | session cookie + marked as the extension + CSRF token; an answer is accepted once |
| `POST /api/browser/call` | agent side (`scripts/browser-mcp.js`) | loopback only, rejected when it came through the tunnel (`CF-*`/`X-Forwarded-For` headers), bearer token from `data/browser-bridge-token` (0600) |
| `GET /api/browser/status` | web app | session |

The bridge only moves messages and forwards tool names from an allow-list. **Every permission decision is made in the
extension**: per-site modes (off by default), a confirmation for risky actions, no typing into password or card fields,
secrets masked in anything the agent sees, and page content handed over as fenced, untrusted data.

**Marked as the extension.** Chrome sends no `Origin` header for requests from an extension that has host permission for this
server; it sends `Sec-Fetch-Site: none`, which a web page cannot set. The server accepts that, or an `Origin` that is exactly one of
the configured extension IDs. A web page always has an `Origin` or another `Sec-Fetch-Site`, so it is refused even if the user is
signed in. This separates the extension from web content; it cannot separate it from another extension the user has given
access to this server, and such an extension could do anything the user can do in the app anyway.
