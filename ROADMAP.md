# Roadmap

From nothing to finished thing. Each phase ships working software; later
phases only need the API contract, not finished UI.

Legend: ☐ not started · ◐ in progress · ☑ done

## Phase 0 - Foundation ☑

Repo scaffold, CI, `docker compose up` running relay + postgres + storage (RustFS),
goose + sqlc wired, OpenAPI skeleton, health endpoint, brand kit, docs.

## Phase 1 - Identity & workspaces ☑

- Email+password auth (argon2id, session cookies, reset flow, rate limits)
- Workspaces, members, roles (owner/admin/member)
- First-run owner bootstrap

## Phase 2 - Projects & conversations ☑

- Project CRUD, icons/colors, members
- Persistent project conversation: messages, Markdown, code blocks,
  timestamps, read state
- Layout shell: sidebar, project nav, composer

## Phase 3 - Attachments ☑

- S3 upload pipeline (`Ctrl+V` paste, drag & drop, picker)
- Image preview, multi-attachment, presigned downloads
- Upload limits + MIME validation

## Phase 4 - Issues ☑

- Issue model: `MYB-142` keys, statuses, priority, labels, assignee
- Issue list/detail views, filters, keyboard navigation, `C` quick-create
- Conversation ↔ issue loop (message → issue, issue → thread)
- `issue_activity` powering issue timeline + project activity feed

## Phase 4.5 - Landing page ☑

- Public landing at `/`; app moves under `/app`
- Hero, feature grid, MCP callout, self-host quickstart, footer
- Brand-true, dark/light aware, zero tracking

## Phase 5 - Agents & MCP ☑

- Agent identities (name, avatar, description, last-seen)
- Scoped, revocable `rly_` MCP tokens, per-project permissions
- MCP server (streamable HTTP): full tool list from the spec
- Project settings: agent access management
- Self-registration: admins mint one-shot `rli_` invites (scoped +
  project-granted, 72h default TTL); the agent redeems via
  `POST /api/agent-invites/redeem` with its own name/review mode and gets
  back a live `rly_` token + MCP URL

## Phase 5.5 - Agent workflow ☑

Verified live: `relay-cli` (stdlib-only MCP client) lists projects, posts
messages, manages issues/todos, and reads GitHub data with an `rly_` token.
Agent todos persist per project with optional issue links, surface in the
Board tab's work list (with agent attribution), and are enforceable by
`issue:read`/`issue:write` MCP scopes. `owner/repo#123` and `MYB-42`
references in messages and descriptions linkify; `KEY-42` resolves through
`/app/p/:id/k/:key` to the issue page. Board tab offers drag-drop kanban.

- `relay` CLI: single Go binary wrapping the MCP endpoint (`rly_` tokens)
- Agent-managed project todos - the agent's persistent "what remains" list,
  linked to issues, visible in the project UI
- GitHub refs in messages (`owner/repo#123`) linkified; `MYB-42` keys link
  to internal issues
- Kanban board view for issues

## Phase 6 - GitHub ☑

Verified end-to-end against `Dvorinka/relay`: PAT/dev token lists repos,
repo links to a project, development panel shows live commits, synthetic
webhooks mirror issue open/close/rename, and MCP tools read real GitHub
issues and PRs. App-mode (manifest registration + installation) is built
and exercised up to the one GitHub-side click that needs a browser session.

- GitHub App creation via manifest, installation flow
- Repository linking per project
- Issue/PR mirror + HMAC-verified webhooks, `github_sync_state`
- Project "Development" panel (issues, PRs, recent commits)

## Phase 7 - Realtime & notifications ☑

Verified live: an agent posting through `relay-cli` pushed a
`message.created` SSE frame to a connected browser session, bumped the
project's unread count, and surfaced the `@mention` in the Inbox feed —
all without refresh.

- SSE event hub, browser live updates — in-process `events.Hub`, filtered
  per subscriber by workspace membership, 25s keepalives, reconnecting
  client with backoff
- Unread counts (rail badges), `@name` mention feed, Inbox page

## Phase 8 - Search & polish ☑

Verified live: FTS indexes on messages/issues/projects/todos; `RLY-2`
matches its issue by key, `spacing` ranks the renamed sidebar issue first;
the `Ctrl/Cmd+K` palette groups results and navigates; the theme toggle
flips a persistent dark/light preference (system-aware default).

- Postgres FTS global search, `Ctrl/Cmd+K` palette
- Keyboard-first navigation pass (j/k lists, palette arrows, Enter to open)
- Dark/light theme toggle persisted in localStorage, a11y labels on icon
  buttons

## Phase 9 - Desktop (Wails) ☑ (core shell)

`apps/desktop` is a Wails v2 thin shell: all webview requests proxy to the
configured Relay server (no stale bundles, no CORS, same-origin cookies).
First launch shows a "connect to server" screen persisted to the user
config dir. Windows binary cross-builds via mingw-w64 and is produced by
CI as an artifact; Linux binary verified to launch a real window against
the local stack.

- Wails v2 shell proxying to the configured server — Linux/Windows
  (macOS supported by the same code path via `wails build -platform darwin`)
- System tray, notifications, deep links, global screenshot shortcut:
  deferred (see apps/desktop/README.md for the honest why)

## Phase 10 - Android (Expo) ☑

`apps/mobile` — Expo 57 / React Native + Expo Router, verified live on an
Android emulator end-to-end: login with configurable server URL, session
persisted in AsyncStorage across cold starts, projects list, project
conversation with composer + image attach, issues list with
tap-to-advance status, agent work list.

- Session cookie captured from `Set-Cookie` and reattached manually —
  RN's cookie jar does not persist across force-stops
- `relay://` scheme, `usesCleartextTraffic` for self-hosted http servers
- Push notifications, deep-link routes, EAS/iOS builds: deferred
  (see apps/mobile/README.md)

## Phase 11 - Hardening & 1.0 ☑

- Security pass: rate limits on auth endpoints, upload caps, argon2id,
  hashed `rly_` tokens, security headers (CSP, nosniff, frame-deny,
  referrer + permissions policy), Trivy in CI
- Canonical-flow E2E (`RELAY_TEST_DATABASE_URL`) covering
  register → project → gated agent → MCP submit_review → REST verdict
- Tag-triggered release workflow: server + CLI binaries, Windows desktop
  exe, checksums
- Docs: README, ARCHITECTURE, docs/CLI.md, docs/GITHUB.md, CONTRIBUTING,
  SECURITY, CODEOWNERS, per-app READMEs

## Phase 12 - Agent work reviews ☑

- `agent_reviews` table: structured card payload (summary, files with
  +/-/notes, decisions, required actions by kind, links, verify steps),
  status `pending → approved | changes_requested | superseded`
- `agents.review_mode`: `notify` (default) reports after the fact; `gate`
  makes `submit_review` return `must_wait` and the agent blocks on
  `await_review` until a human verdict arrives
- MCP tools `submit_review`, `list_reviews`, `get_review`,
  `await_review` (long-poll up to 5 min); `get_project` exposes the mode
- Reviews tab in the web app — whiteboard-style card; pending count badge
  on the project rail via `/api/me/unread`
- User + agent avatar upload (`PUT /api/me/avatar`,
  `PUT /api/agents/:id/avatar`) and the authenticated `/api/files/*`
  reader for avatar objects
- Security-headers middleware and the canonical E2E restored after the
  phase-11 merge dropped them
- Pattern adapted from devdotfast/whiteboard (MIT); Relay's implementation
  is native - no Whiteboard code vendored

## Phase 13 - Review surfacing ☑

- `GET /api/me/reviews`: pending reviews across all member workspaces —
  powers the Inbox "Awaiting your verdict" section
- `GET /api/issues/:id/reviews`: compact review block on issue pages
- `?tab=` deep links on project pages (`useSearchParams`), so Inbox items
  land directly on the Reviews tab
- Status filter chips on the Reviews tab; filter-aware empty state
- CI backend job runs a Postgres service so `TestCanonicalFlow` executes
  in CI; the test clears the DB-backed rate limiter for rerunnability

## Phase 14 - GitHub write-back & outbound webhooks ☑

- `POST /api/issues/:id/github` — creates a GitHub issue on the project's
  linked repo (optional `repo_id` when several are linked), stores
  `github_repo/number/node_id`, maps Relay `done`/`cancelled` to closed.
  Duplicate pushes and unlinked projects return 409; no GitHub app → 503
- Status sync: flipping a linked issue to `done`/`cancelled` closes the
  GitHub issue, any other status reopens it — best-effort, async, 15s cap
- Outbound webhooks: `webhook_subscriptions` + `webhook_deliveries`,
  project-scoped, admin-managed. A hub-fed worker POSTs a signed envelope
  (`X-Relay-Signature-256`, `X-Relay-Event`, `X-Relay-Delivery`), 3
  attempts with 1s/5s backoff, delivery log trimmed to 200 rows
- Event matching: exact names, `prefix.*` wildcards, `*` — against a
  fixed server-side catalog (`message.*`, `issue.*`, `todo.*`,
  `review.*`, `attachment.*`)
- REST: subscription CRUD, delivery history (50), `POST .../test` queues
  a synthetic `webhook.test` through the real pipeline. Secrets are shown
  once at creation; list/get expose only a `whsec_…` hint
- Project **Settings** tab: subscription list, create form with catalog
  chips, enable/disable, send-test, expandable delivery log, one-time
  secret banner. Issue pages show a **Push to GitHub** action when the
  project links repos and the issue isn't mirrored yet
- Canonical E2E extended: signed delivery verified against a local
  receiver (HMAC over the body), delivery log, test event, 409 no-repo

## Phase 15 - GitHub import & project activity feed ☑

Verified live against `Dvorinka/relay` with a dev token: one POST pulled
32 real objects (31 PRs, 1 issue) into Relay issues in ~1.4s, and a
re-run refreshed 32 in place with zero duplicates.

- `POST /api/projects/:id/github/import` (admin) — bulk-pulls every issue
  and PR on linked repos (`state=all`, 100/page, capped at 500 per kind).
  Idempotent upsert keyed on `(github_repo_id, github_number)`; PRs land
  as issues with `github.kind="pr"` — open → `review`, merged → `done`,
  closed-unmerged → `cancelled`, drafts → `todo`
- GitHub labels import with their colors; Relay-side labels are never
  removed by re-imports
- `pull_request` webhook now mirrors PRs into issues symmetric with
  `issues` events (was: activity-only on pre-mirrored rows)
- Issues expose `github.kind|state|url`; badges show a PR glyph and
  `merged` state with the correct `/pull/` URL
- Development tab: per-repo "Import issues & PRs" button with per-repo
  result line
- Overview page gains an **Issue activity** feed powered by
  `issue_activity` across the project (mirror/state/field events)
- Landing favicon: mark re-centered in its viewBox (was cropped)

## Phase 16 - Chat redesign & brand unification ☑

Verified live: user ↔ agent replies with parent previews, reaction toggles
from both REST and MCP, edits allowed until an agent reads the message
(409 `message_locked`, own-author reads excluded), agent `set_avatar`
rendered in chat. `TestChatSemantics` covers the semantics end-to-end.

- Discord-style grouped timeline: 40px avatars, day separators, hover
  toolbar (react / reply / edit / more), combined consecutive messages,
  text-then-image ordering, markdown with fenced code blocks
- `messages.parent_id` + `message_reactions` (migration 0016); parent
  validation rejects cross-conversation replies; `edited_at` + `agent_read`
  surfaced on every message payload; `message.updated` over SSE
- MCP parity: `send_message.reply_to`, `edit_message`, `react_to_message`,
  `mark_message_read`, `set_avatar`
- Theme system: persistent light/dark, accent presets + color wheel + hex
  readout (Settings → Appearance); cyan `#06B6D4` default; neutral
  near-black dark palette
- Same-origin `GET .../attachments/:id/download` and streamed `/api/files/*`
  (presigned redirects broke under Chrome Local Network Access on LAN dev)
- Every surface unified: web (incl. phone-width drawer layout), landing
  (cyan + real app screenshots), desktop shell + connect page, Expo app
  (light+dark schemes, in-app appearance override, inbox, reviews,
  replies/reactions/edit-lock, status-colored issues)

## Post-1.0 ideas (not committed)

- Custom statuses, saved filters, issue boards
- Relay Cloud (hosted offering) - self-hosting stays first-class
- iOS build of the mobile app
- DragonflyDB cache layer if hot paths need it
