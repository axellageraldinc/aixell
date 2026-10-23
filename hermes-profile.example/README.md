# Example Hermes profile

A generic, placeholder-only Hermes Agent profile for the web app in this
repository. It is not a working configuration: replace every placeholder.

## Create the profile

```sh
hermes profile create <profile>
cp hermes-profile.example/profile.yaml ~/.hermes/profiles/<profile>/profile.yaml
cp hermes-profile.example/SOUL.md      ~/.hermes/profiles/<profile>/SOUL.md
cp hermes-profile.example/config.yaml  ~/.hermes/profiles/<profile>/config.yaml
cp hermes-profile.example/env.example  ~/.hermes/profiles/<profile>/.env
```

Then edit `config.yaml` (provider and model) and `.env` (port, key), and
install the gateway with `hermes --profile <profile> gateway install` or the
unit in `deploy/examples/hermes-gateway.service`.

## How the app connects

The app reads only the `API_SERVER_*` lines from the profile's `.env`, then
calls the API server at `http://127.0.0.1:<port>` with `API_SERVER_KEY` as a
bearer token. The profile must be listed in `agents` in the app's
`config.json`, and `API_SERVER_ENABLED` must be `true`.

## Secrets

No real keys belong in these files. Keep provider keys and the API server key
in the profile's `.env` (mode 0600) or in the app's `config.json` through
`file:` references. `changeme` in `env.example` is a placeholder, not a key.
