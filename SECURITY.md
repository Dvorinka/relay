# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for security vulnerabilities.

Report privately to **info@tdvorak.dev** with:

- a description of the issue and its impact
- steps to reproduce / proof of concept
- affected versions or commit

You will receive an acknowledgement within 72 hours. We aim to resolve
confirmed issues within 30 days and will credit reporters in the release
notes unless you prefer otherwise.

## Supported versions

Relay is pre-1.0. Only the latest release receives security fixes.
Upgrade to the newest tag before reporting old-version issues.

## Security-relevant design notes

Things reporters and self-hosters should know:

- **Auth** - argon2id password hashing, opaque session tokens (stored
  hashed), HttpOnly + Secure + SameSite cookies, sliding expiry,
  single-use password-reset tokens, per-IP and per-account rate limiting
  on all auth endpoints.
- **MCP tokens** - `rly_`-prefixed bearer tokens, stored as SHA-256 hashes,
  scoped to projects and permission sets, revocable per token. Treat them
  as credentials; Relay never logs them.
- **GitHub** - GitHub App installation tokens only (short-lived); webhooks
  verified with HMAC-SHA256 signatures; no personal access tokens stored.
- **Uploads** - server-side MIME sniffing (not just extension checks),
  size caps, randomized storage keys, content served via short-lived
  presigned URLs.
- **Content** - Markdown is sanitized server-side before render; no raw
  HTML from users or agents reaches the DOM.
- **Authorization** - every project-scoped route checks membership (users)
  or project grants (agents). Agent tokens can never exceed their granted
  scope, even for a compromised agent.

## Self-hosting hardening checklist

- Serve Relay over HTTPS (`RELAY_PUBLIC_URL` must be `https://`) so cookies
  stay `Secure`.
- Keep `AUTH_SECRET` unique per deployment and rotate if leaked.
- Restrict the MinIO/S3 bucket policy to the Relay service credentials.
- Rotate MCP tokens periodically; revoke on agent decommissioning.
- Put the `docker-compose` Postgres on a private network; never expose
  `5432` publicly.
