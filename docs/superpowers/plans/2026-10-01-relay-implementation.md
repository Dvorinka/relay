# Relay - Implementation Plan

Date: 2026-10-01
Spec: `docs/superpowers/specs/2026-10-01-relay-design.md`
Execution: sequential phases; each ends in a merged PR with working software.

## How to read this plan

Each phase lists: goal, tasks (checkboxes, roughly PR-sized), schema work,
and the acceptance check that proves the phase. Work top to bottom; do not
start a phase until the previous phase's acceptance check passes.

Global rules applied to every phase:

- Migrations are append-only goose files; sqlc regenerates after each.
- API changes start in `api/openapi.yaml`; `just api` output is committed.
- Every PR runs `just check` + `just test` green; CI enforces it.
- Docs (README/.env.example/OpenAPI) update in the same PR, never later.

---

## Phase 0 - Skeleton (done when `docker compose up` boots a health endpoint)

- [x] Repo hygiene: LICENSE, README, CONTRIBUTING, CoC, SECURITY,
      ARCHITECTURE, ROADMAP, .env.example, .gitignore, .editorconfig
- [x] Brand kit (assets/brand), GitHub plumbing (.github/*)
- [ ] `go.mod`, `cmd/relay/main.go`: config load, zap logger, Gin router,
      graceful shutdown, `/api/health`
- [ ] `db/migrations/0001_core.sql`: users, sessions, workspaces,
      workspace_members
- [ ] `sqlc.yaml` + first generated queries
- [ ] `apps/web`: Vite + SolidJS + TS strict + Tailwind + Ark UI scaffold,
      route shell, theme tokens (ink/paper/signal)
- [ ] `packages/api-client` generation wired into `just api`
- [ ] CI green on the skeleton
- **Accept:** `docker compose up -d` -> `curl :8080/api/health` -> `{"status":"ok"}`;
  `just dev` shows a themed empty shell at :5173

## Phase 1 - Auth + workspaces

- [ ] `internal/auth`: argon2id hash/verify, session issue/rotate/revoke,
      cookie middleware, fixed-window rate limiter (Postgres counters)
- [ ] Endpoints: register, login, logout, forgot/reset (log-mailer),
      change password, `GET /api/auth/session`
- [ ] `internal/workspaces`: CRUD, member list, invite-by-add (user must
      exist; no email invites in v1), role check middleware
- [ ] First registered user auto-creates a personal workspace (owner)
- [ ] Web: auth pages (login/register/reset), session store, route guards,
      workspace settings (members)
- **Accept:** register -> login -> protected route OK; logout kills session;
  wrong-password hits the rate limit; reset flow works via logged mail

## Phase 2 - Projects + conversations

- [ ] `internal/projects`: CRUD, key-prefix validation, members
- [ ] `internal/conversations` + `internal/messages`: one `project`
      conversation per project; messages with markdown body, user/agent
      author pair, `message_reads`
- [ ] `GET /api/projects/:id/overview` (counts + recent activity stub)
- [ ] Web: app shell (top bar, project rail), project pages
      (Overview/Issues/Conversation/Activity tabs - only Conversation live),
      composer with markdown, message list, timestamps, own-read tracking
- **Accept:** two users in a project exchange messages; read markers update;
  project list keyed correctly

## Phase 3 - Attachments

- [ ] `internal/storage`: minio-go client, presign helpers
- [ ] `internal/attachments`: multipart upload (MIME sniff, 25 MiB cap,
      allowlist), `status: pending -> ready`, presigned GET endpoint
- [ ] Message create accepts `attachment_ids`; `message_attachments` rows
- [ ] Web: composer paste (Ctrl+V), drag&drop, picker, previews, remove,
      inline image render, download
- **Accept:** paste a screenshot -> send -> thumbnail renders; attachment URL
  expires; oversized/invalid MIME rejected

## Phase 4 - Issues

- [ ] `internal/issues`: `project_counters` keying (`MYB-142`), statuses
      (backlog/todo/in_progress/review/done/cancelled), priorities, labels,
      assignee, comments, `issue_activity`
- [ ] Conversation<->issue: `POST /api/issues/:id/from-message/:messageId`
      copies body + attachment refs; issue detail links back to thread
- [ ] Web: issue list (filters: all/mine/open/in-progress/done/github),
      detail page, `C` create dialog, `Cmd+K` stub routes to create,
      arrow-key nav
- **Accept:** create MYB-1..N without collisions under concurrent POSTs;
  message -> issue carries the screenshot; activity feed renders

## Phase 5 - Agents + MCP

- [ ] `internal/agents`: identities, `agent_project_permissions`, scope set
- [ ] `mcp_tokens`: mint (`rly_` + sha256 store, shown once), revoke,
      `last_used_at` touch
- [ ] `internal/mcp`: streamable HTTP server; token middleware ->
      agent + project + scope; tools per spec section 7
- [ ] Agent messages render with distinct identity; `last seen` from real
      `mcp_tokens.last_used_at` only
- [ ] Web: workspace agent settings (create agent, grant projects,
      mint/revoke tokens)
- **Accept:** an external MCP client with a scoped token lists only granted
  projects, reads messages/attachments, posts a reply that appears in the UI;
  a token for project A gets denied on project B (test asserts all tools)

## Phase 6 - GitHub

- [ ] `internal/github`: manifest create flow, installation callback,
      repo listing/linking
- [ ] Webhook endpoint: HMAC-SHA256 verify, delivery-ID idempotency,
      issues/PRs -> mirror + activity
- [ ] `github_links` on Relay issues; `GET development` panel data
      (open issues/PRs, recent commits, 60s cache)
- [ ] Web: project settings GitHub card, GitHub badges on issues,
      Development panel on Overview
- **Accept:** install app -> link repo -> open/close GitHub issue ->
  Relay shows `GitHub #142 Open/Closed` within webhook latency

## Phase 7 - Realtime + notifications

- [ ] `internal/realtime`: hub, per-user subscription filters, SSE handler
      with heartbeat; events emitted from message/issue/attachment/github paths
- [ ] `internal/notifications`: mention parse on message create,
      assignment + agent-reply notifications, inbox endpoints
- [ ] Web: EventSource client, unread badges on rail, inbox page,
      optimistic-send reconciliation via `message.created`
- **Accept:** user A posts -> user B's open tab updates without refresh;
  mention lands in inbox; kill-and-reconnect resumes cleanly

## Phase 8 - Search + polish

- [ ] tsvector columns + GIN indexes migration; `GET /api/search`
      grouped results (issues/messages/projects/github)
- [ ] Web: `Cmd+K` palette (search + create issue + navigation actions),
      full keyboard map, dark/light QA pass, focus/contrast a11y audit
- **Accept:** `Cmd+K` -> type -> grouped results with context lines; full
  app keyboard-navigable; axe-core finds no critical violations

## Phase 9 - Desktop (Wails v3)

- [ ] `apps/desktop`: Wails scaffold embedding `apps/web` build; config for
      remote `RELAY_PUBLIC_URL` vs bundled server mode (decide per release)
- [ ] Tray icon + menu, OS notifications via Wails runtime
- [ ] `relay://` deep links (open conversation/issue)
- [ ] Global screenshot shortcut -> paste-into-composer flow
- [ ] CI artifacts: Linux (deb/AppImage), macOS (dmg), Windows (nsis)
- **Accept:** packaged app on all three OSes logs in, receives SSE, and the
  hotkey lands a screenshot in the composer

## Phase 10 - Android (Expo)

- [ ] `apps/mobile`: Expo app on `packages/api-client`, auth screens,
      conversation list/thread, issue list/detail, attachments
      (gallery + camera), SSE or poll fallback
- [ ] Expo push for notifications; `relay://` deep links
- [ ] CI: EAS build for internal testing
- **Accept:** Android APK signs in, sends/receives messages with images,
  deep link opens the right issue

## Phase 11 - Hardening + 1.0

- [ ] Security review pass: rate limits verified, upload caps, token
      hygiene, CSP headers, `trivy`/`govulncheck` clean
- [ ] Canonical E2E automated in CI (mocked GitHub)
- [ ] Performance pass: conversation scroll, message send, project switch,
      search latency budget (<100ms p50 local)
- [ ] Docs sweep: README screenshots, self-host guide, MCP client examples
- [ ] Tag `v1.0.0`, publish release with compose + image

## Dependency order (for parallel work later)

```text
0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 11
                            \-> 9 (needs stable API, can start after 5)
                            \-> 10 (needs stable API, can start after 5)
```

## Tracking

Working todo for the whole build lives in `ROADMAP.md` (public phases) and
in the session task list; GitHub milestones get created per phase once the
remote exists.
