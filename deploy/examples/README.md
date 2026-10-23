# Deployment examples

Generic templates for running this app on a small Linux host with `systemd
--user`, an optional Cloudflare Tunnel, and a reverse proxy. Every value that
depends on your machine is a placeholder: `<user>`, `<install-dir>`,
`<hostname>`, `<tunnel-id>`, `<port>`, `<profile>`. Replace them; nothing here
is meant to be copied verbatim.

| File | What it is for |
|---|---|
| `aixell.service` | systemd user unit that runs `node server.js` from `<install-dir>` |
| `hermes-gateway.service` | systemd user unit for the Hermes API gateway of profile `<profile>` |
| `cloudflared.service` | systemd user unit that keeps a Cloudflare Tunnel running |
| `cloudflared.yml.example` | tunnel config: one public hostname to `http://127.0.0.1:<port>` |
| `Caddyfile.example` | Caddy reverse proxy with automatic HTTPS and streaming-friendly settings |
| `nginx.conf.example` | nginx server block with the same streaming-friendly settings |

## Setup order

1. Install Hermes and create the agent profile (see `hermes-profile.example/`).
2. Install this repository into `<install-dir>` and create `config.json` there
   (start from `config.example.json`). Keep secrets out of the unit files.
3. Install `hermes-gateway.service`, then `aixell.service`; reload the user
   manager and enable both.
4. Put HTTPS in front of the app: either `cloudflared.service` with
   `cloudflared.yml.example`, or `Caddyfile.example` / `nginx.conf.example`.
5. Open the public URL and log in.

## Things to get right

- The app must be reached through HTTPS. The session cookie is marked `Secure`
  on HTTPS requests, and the public hostname must be listed in
  `server.allowedHosts` in `config.json`, otherwise the host check rejects it.
- If a Cloudflare Tunnel is the only way in, set `server.trustCloudflare` to
  `true` in `config.json` so the app can read the real client address from the
  loopback connector. Leave it `false` for direct or plain reverse-proxy setups.
- `server.hosts` should stay on the loopback interface; the proxy or tunnel
  terminates TLS and forwards to `127.0.0.1:<port>`.
- Provider API keys and the login record live in `config.json` (or in files it
  references with `file:`), never in these templates.
