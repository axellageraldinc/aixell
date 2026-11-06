# Follow-ups

The agent can promise to check in with you later, in the same chat. It decides when, tells you in its reply ("I'll check in
Friday morning"), and you can say "no need" and it cancels. At the time, the agent writes the check-in as a normal message in
that chat and your devices get a push that names nothing ("New message"). Your reply continues the same conversation, and the
agent updates its own memory the way it always does. aixell never reads or writes the agent's memory.

Nothing here depends on the topic: the agent chooses what deserves a check-in.

## Turn it on

1. In `config.json`:
   ```json
   "followups": { "enabled": true, "quietHours": "22:00-08:00", "maxPerDay": 1 }
   ```
   Quiet hours are read in the `timezone` of the config. See [configuration.md](configuration.md).
2. Give the agent the tools: add `scripts/followups-mcp.js` to the agent's MCP servers
   (`env: AIXELL_URL, AIXELL_DATA_DIR`), the same way as the browser bridge ([browser-bridge.md](browser-bridge.md)).
   The tool list is `src/followup-tools.js`. Restart aixell and the agent gateway.
3. Turn on push notifications for the device in the app settings.

## How it works

| Piece | Where |
|---|---|
| Tools `schedule_followup`, `list_followups`, `cancel_followup` | `src/followup-tools.js`, `scripts/followups-mcp.js` |
| Loopback route `POST /api/followups/call` | loopback only (refused through a tunnel), bearer secret in `data/followups-secret` (0600), and the chat's own key |
| The chat's key | derived from the agent and chat id with the secret; given to the agent in its instructions; it opens that chat only |
| The list | `data/followups.json` (0600, git-ignored) |
| The tick | a scheduler job every 2 minutes (`src/followups.js`) |
| Delivery | a hidden turn in the chat (`[[aixell:checkin]]` note, hidden by the chat page), then a push |

## Guardrails

- At most `maxPerDay` check-ins a day, none during quiet hours; what is due waits until they end.
- A chat that has a reply in progress is skipped and tried again.
- If the owner leaves two check-ins in a row unanswered, the agent is told to stop scheduling new ones until they write again.
- Five pending check-ins per chat, at most 90 days ahead. A check-in that could not be sent for 3 days is dropped.
- A failed delivery is retried twice, 30 minutes apart.
