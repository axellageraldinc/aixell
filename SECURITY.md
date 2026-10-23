# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Use GitHub's private vulnerability reporting on this repository
("Security" tab → "Report a vulnerability"). If that is unavailable, contact the
maintainer privately through the address listed on their GitHub profile.

Include: what you found, the affected file or endpoint, how to reproduce it, and
the impact you expect. Please give us reasonable time to fix it before any public
disclosure. We will confirm receipt, keep you updated, and credit you in the fix
unless you prefer otherwise.

## Supported versions

Only the latest `main` branch is supported. This project is not released as
versioned packages yet, so there are no maintained release branches or backports.

## Threat model (what the code actually does)

This is a single-user, self-hosted web app that talks to Hermes agents. It assumes
the operator controls the host and the data directory. The protections below are
implemented in this repository; verify them in the cited files when changing them.

**Login: password + authenticator (TOTP).**
- The password is stored as a scrypt hash (`N=131072, r=8, p=1`) in a login record
  file inside the data directory, never in the repository (`src/auth.js`).
- The second factor is a pre-provisioned TOTP secret (RFC 6238, SHA-1, 6 digits,
  30-second step, ±1 step tolerance) or a single-use recovery code whose SHA-256
  is checked against a list and then marked used (`src/auth.js`).
- Login attempts are rate-limited per client and globally, with a 15-minute
  window, and the counters are persisted so a restart does not reset them
  (`src/auth.js`).
- Comparison of secrets and hashes is constant-time, and unknown usernames still
  pay the same expensive hash calculation (`src/auth.js`).

**Sessions.**
- Sessions are stored server-side; only the SHA-256 of the cookie token is kept
  on disk, so sessions can be revoked (`src/web-sessions.js`).
- The login record must be a regular file with restricted permissions (0600 or
  0640), otherwise the server refuses to start (`src/auth.js`).
- The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when served over
  HTTPS (`server.js`).
- Session lifetime is a sliding window with an absolute maximum age
  (`src/web-sessions.js`).

**CSRF.**
- Every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) must carry the
  per-session CSRF token in `X-CSRF-Token`, compared in constant time. The only
  exemption is the push acknowledgement endpoint (`server.js`).
- Browser requests are also checked with `Origin`, and the `Host` header must be
  in the configured allow-list (`server.js`, `src/config.js`).
- Responses are sent with a restrictive `Content-Security-Policy`, `nosniff`,
  `X-Frame-Options: DENY`, and a `same-origin` resource policy (`src/http.js`).

**Outbound fetches (SSRF guard).**
- All outbound feed and article fetches go through `src/fresh/net.js`.
- Only `http:` and `https:` are accepted. The hostname is resolved and every
  resolved address must be public: loopback, private, link-local, and other
  non-public ranges are rejected, including IPv4-mapped IPv6 addresses.
  `localhost`, `.local`, and `.internal` names are rejected.
- Redirects are followed manually, up to 4 hops, and each hop is re-checked.
  Responses are size-capped and time-limited.

**Secrets and data.**
- Credentials, tokens, sessions, the database, and other runtime state live only
  under the data directory, which is gitignored. The repository ships no secrets.
- Provider API keys are read from the environment or the Hermes profile, not from
  committed files.

## Out of scope

- Vulnerabilities in the Hermes agent, the LLM/search providers, or other external
  services this app calls.
- Attacks that require an already-compromised host, root access, or physical
  access to the machine.
- Denial of service by resource exhaustion on a single-user instance.
- Misconfiguration by the operator (for example, exposing the app without HTTPS,
  or disabling the host allow-list).
