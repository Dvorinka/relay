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

## Phase 3 - Attachments ☐

- S3 upload pipeline (`Ctrl+V` paste, drag & drop, picker)
- Image preview, multi-attachment, presigned downloads
- Upload limits + MIME validation

## Phase 4 - Issues ☐

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

## Post-1.0 ideas (not committed)

- Relay → GitHub issue write-back and bi-directional sync
- Custom statuses, saved filters, issue boards
- Webhooks + outbound event subscriptions for agents
- Relay Cloud (hosted offering) - self-hosting stays first-class
- iOS build of the mobile app
- DragonflyDB cache layer if hot paths need it
