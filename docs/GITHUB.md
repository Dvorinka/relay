# GitHub integration

Relay connects to GitHub through a **GitHub App** — per-repository
permissions, short-lived installation tokens, and signed webhooks. No
personal access tokens are needed in production.

## What it gives you

- **Linked repositories** on a project — visible on the Development tab.
- **Development panel** — open GitHub issues, open pull requests, and recent
  commits per linked repository (cached 60 s).
- **Issue mirroring** — GitHub issues on linked repos become Relay issues
  (`origin: github`, badge `#N open|closed`). Edits, closes, and reopens on
  GitHub update the mirrored issue; PR events on a mirrored issue number land
  in its activity feed.
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

## Development fallback

Setting `GITHUB_TOKEN` (any PAT/fine-grained token, or
`$(gh auth token)`) makes Relay skip the app flow: the repo picker lists the
token owner's repos (`affiliation=owner`) and REST calls use the token
directly. Linking works with `installation_id: 0`. Webhooks still require a
registered app — synthetic payloads signed with the stored webhook secret
work for local testing.
