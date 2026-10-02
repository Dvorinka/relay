# GitHub integration

Relay connects to GitHub through a **GitHub App** — per-repository
permissions, short-lived installation tokens, and signed webhooks. No
personal access tokens are needed in production.

## What it gives you

- **Linked repositories** on a project — visible on the Development tab.
- **Development panel** — open GitHub issues, open pull requests, and recent
  commits per linked repository (cached 60 s).
- **Issue & PR mirroring** — GitHub issues and pull requests on linked repos
  become Relay issues (`origin: github`; PRs carry `github.kind="pr"` and a
  `/pull/N` link). Edits, closes, merges, and reopens on GitHub update the
  mirrored issue.
- **Bulk import** — Development tab → **Import issues & PRs** (or
  `POST /api/projects/:id/github/import`) pulls the full history:
  `state=all`, paginated, capped at 500 per kind per repo. Open PRs land in
  `review`, merged in `done`, closed in `cancelled`; GitHub labels are
  imported with their colors. Re-runs refresh in place — no duplicates.
- **MCP tools** — `github_list_issues`, `github_get_issue`,
  `github_list_prs`, `github_get_pr` under the `issue:read` scope.

## Setup (once per instance)

1. Workspace **Settings → GitHub → Register Relay as a GitHub App**.
   Relay POSTs an app manifest to GitHub; you confirm the name and
   permissions there, and GitHub redirects back. The app id, private key,
   and webhook secret are stored AES-256-GCM-encrypted under `AUTH_SECRET`.
2. Click **Install on GitHub** and pick the repositories to expose.
   The `installation` webhook event registers the installation in the
   workspace automatically.
3. Project → **Development** tab → link repositories.

## Webhook endpoint

`POST /api/github/webhook` — deliveries are:

- signature-verified (`X-Hub-Signature-256`, HMAC-SHA256);
- idempotent on `X-GitHub-Delivery` (replays return `200` without work);
- processed in arrival order (in-process mutex).

The app's webhook URL is set to `<PUBLIC_URL>/api/github/webhook` during
manifest registration, so expose that path publicly.

## Relay → GitHub write-back

Issue pages offer **Push to GitHub** when the project links repos and the
issue isn't mirrored: `POST /api/issues/:id/github` creates the GitHub
issue (`repo_id` picks the repo when several are linked) and stores the
link. Afterwards, status changes sync best-effort — `done`/`cancelled`
close the GitHub issue, other statuses reopen it. Inbound webhook events
keep flowing the other direction, so the two converge.

## Outbound webhooks (agents → Relay events)

Project **Settings → Outbound webhooks**: subscribe an HTTPS endpoint to
project events (`issue.*`, `message.created`, `review.*`, `*` …). Relay
POSTs `{id, type, project_id, occurred_at, data}` with
`X-Relay-Signature-256` (`sha256=` + HMAC of the body with the
subscription secret, shown once at creation). Deliveries retry with
1s/5s backoff and are inspectable under the subscription's delivery log;
`POST /api/webhooks/:id/test` sends a `webhook.test` event through the
same path.

## Development fallback

Setting `GITHUB_TOKEN` (any PAT/fine-grained token, or
`$(gh auth token)`) makes Relay skip the app flow: the repo picker lists the
token owner's repos (`affiliation=owner`) and REST calls use the token
directly. Linking works with `installation_id: 0`. Webhooks still require a
registered app — synthetic payloads signed with the stored webhook secret
work for local testing.
