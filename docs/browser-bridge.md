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
| `GET /api/browser/events` | extension | session cookie + exact `chrome-extension://<id>` origin; one stream at a time; ends when the session ends |
| `POST /api/browser/results` | extension | session cookie + origin + CSRF token; an answer is accepted once |
| `POST /api/browser/call` | agent side (`scripts/browser-mcp.js`) | loopback only, rejected when it came through the tunnel (`CF-*`/`X-Forwarded-For` headers), bearer token from `data/browser-bridge-token` (0600) |
| `GET /api/browser/status` | web app | session |

The bridge only moves messages and forwards tool names from an allow-list. **Every permission decision is made in the
extension**: per-site modes (off by default), a confirmation for risky actions, no typing into password or card fields,
secrets masked in anything the agent sees, and page content handed over as fenced, untrusted data.
