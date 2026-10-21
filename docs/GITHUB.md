# GitHub integration

Relay connects to GitHub through a **GitHub App** — per-repository
permissions, short-lived installation tokens, and signed webhooks. No
personal access tokens are needed in production.

Two alternatives resolve automatically when no app is registered:

1. `GITHUB_TOKEN` — any PAT or fine-grained token.
2. The host's `gh` CLI login — Relay runs `gh auth token` when neither of
   the above is configured, so a self-hosted instance whose operator is
   `gh`-authed works with zero setup. (This is the *server's* `gh` — a
   remote client's login is never touched.)

Webhooks still require the app path; token/`gh` mode is read/write REST
only — see [Development fallback](#development-fallback).

## What it gives you

- **Linked repositories** on a project — visible on the Development tab.
- **Development panel** — open GitHub issues, open pull requests, and recent
  commits per linked repository (cached 60 s).
- **Issue & PR mirroring** — GitHub issues and pull requests on linked repos
  become Relay issues (`origin: github`; PRs carry `github.kind="pr"` and a
  `/pull/N` link). Edits, closes, merges, and reopens on GitHub update the
  mirrored issue. A reconcile sweep re-pulls every linked repo's recent
  activity at boot and every 10 min, so a missed webhook self-heals instead
  of leaving a stale mirror.
- **Bulk import** — Development tab → **Import issues & PRs** (or
  `POST /api/projects/:id/github/import`) pulls the full history:
  `state=all`, paginated, capped at 500 per kind per repo. Open PRs land in
  `review`, merged in `done`, closed in `cancelled`; GitHub labels are
  imported with their colors. Re-runs refresh in place — no duplicates.
- **MCP tools** — read: `github_list_issues`, `github_get_issue`,
  `github_list_prs`, `github_get_pr`, `github_ci_runs` under `issue:read`.
  Write: `github_create_issue`, `github_create_pr`, `github_comment`,
  `github_review_pr`, `github_pr_state`, `github_merge_pr`, `github_rerun`
  under `issue:write`. Created issues/PRs are mirrored onto the board;
  state changes broadcast `issue.updated`.
- **Create from Relay** — Development → "+ New issue" / "+ New PR" (or
  `POST /api/projects/:id/github/issues`, `.../github/pulls`,
  `.../github/issues/comments`) files directly on the linked repo as the
  app installation and mirrors the result back to the board.
- **In-app PR merge** — the pull-request view offers merge, squash, or
  rebase (`POST /api/projects/:id/github/pull/merge`). GitHub runs the
  merge itself and enforces branch protection, required checks, and
  reviews; Relay reports back whatever GitHub decided.

## Setup (once per instance)

1. Workspace **Settings → GitHub → Register Relay as a GitHub App**.
   Relay POSTs an app manifest to GitHub; you confirm the name and
   permissions there, and GitHub redirects back. The app id, private key,
   and webhook secret are stored AES-256-GCM-encrypted under `AUTH_SECRET`.
   The manifest asks for `issues: write`, `pull_requests: write`
   (in-app merge), `contents: read`, `metadata: read`.
2. Click **Install on GitHub** and pick the repositories to expose.
   The `installation` webhook event registers the installation in the
   workspace automatically.
3. Project → **Development** tab → link repositories.

> Existing installations created while the app asked for `pull_requests:
> read` must accept the updated permissions: GitHub → Settings →
> Applications/Installations → the Relay app → "Review request". Until
> then, in-app merge returns GitHub's 403/404.

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

## Message → issue filing

Conversation messages can become GitHub issues directly.

**Automatic** — a user message on a project, channel, or thread of a
project with **exactly one** linked repo files itself when it opens with
a line-start marker: `bug:`, `issue:`, `enhancement:`, `feature request:`,
`suggestion:`, `proposal:`, or slash forms (`/bug`, `/issue`, …). The
marker is stripped, the first report line becomes the title, image
attachments embed inline via presigned URLs, other files link with size
labels, the result mirrors onto the Relay board, and a threaded reply
links `owner/repo#N`. Prose that merely mentions a bug never files;
agent messages and the filing reply itself (`autofile`-tagged) can't
retrigger.

**Manual** — any user message's ⋯ menu → **File on GitHub**, or
`POST /api/messages/:id/github` (`{repo_id?, title?}`), runs the same
filing core. One linked repo files immediately; several pop a repo picker
and the request must name a repo linked to that project. Errors are real:
`409 no_repo` when nothing is linked, `400` for a foreign `repo_id`,
`404` for non-members, `502 github_error` for upstream failures.

**Multi-repo projects never guess.** An auto-file candidate on a
multi-repo project gets a guidance reply pointing at the manual action
instead of picking a repo.

**Deduplication** — the first file claims a `filed` tag on the source
message atomically; repeats return `409 already_filed` and the menu item
disappears live via `message.updated`. If GitHub creation fails before an
issue exists, the claim releases so retry is possible.

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
directly. With no `GITHUB_TOKEN` at all, Relay falls back to the host's
`gh auth token` automatically when the CLI is installed and authed.
Linking works with `installation_id: 0`. Webhooks still require a
registered app — synthetic payloads signed with the stored webhook secret
work for local testing.
