# Relay - Design Specification

Date: 2026-10-01
Status: Approved scope; pre-implementation
License: Apache-2.0

## 1. Product

**Relay - Open Source Agent Communication & Project Hub.**

Self-hosted web app combining Discord-like communication, Linear-like issue
tracking, GitHub-native development tracking, and MCP-based communication with
external AI agents.

> Agents don't live in Relay. They communicate through it.

Relay is not an IDE, not an agent runtime, and does not host agents. Agents
connect on demand via MCP, read context, and reply asynchronously.

### Core loop

```text
Screenshot -> paste into Relay -> project/issue context ->
agent reads via MCP -> agent works externally -> agent replies -> issue ->
GitHub state visible
```

## 2. Decisions locked (supersede PRD where conflicting)

| Decision | Choice | Rationale |
|---|---|---|
| Auth | **Go-native** (argon2id + opaque sessions) | PRD preferred Better Auth, but Better Auth is TypeScript-only; a Node sidecar would double the deploy surface. One binary wins. |
| GitHub | **GitHub App** | Per-repo installation, granular scopes, short-lived tokens, real webhooks. PATs and OAuth apps rejected. |
| Frontend | **SolidJS** + Vite + TS strict + Tailwind + Ark UI | Explicit in PRD; overrides the React default. |
| Realtime | **SSE** | Browser only ever receives; no bidirectional need. In-process hub, LISTEN/NOTIFY as the documented ceiling fix. |
| MCP transport | **Streamable HTTP** via `mark3labs/mcp-go` | Works for remote agents against a hosted Relay; stdio would require local co-residency. |
| Storage client | **minio-go** | Smaller and purpose-built vs aws-sdk-go-v2. |
| Search | **Postgres FTS** | No extra infra; Elasticsearch-class tools deferred until FTS measurably fails. |
| Cache | **None in v1** | DragonflyDB documented but not provisioned - add only if hot paths need it. |
| Desktop | **Wails v3** (Go + embedded web build) | Same backend language, single codebase for Linux/macOS/Windows. |
| Mobile | **React Native + Expo**, Android first | Locked stack default; API-only client. |

## 3. Scope of this document

Everything needed to build Relay v1.0: domain model, API, MCP surface, auth,
storage, realtime, GitHub sync, clients, deployment, testing, security.

## 4. System architecture

Single Go binary (Gin) serving:

- `GET/POST/PATCH/DELETE /api/*` - REST, session cookie auth
- `GET /api/events` - SSE stream, session auth
- `POST /mcp` - streamable-HTTP MCP endpoint, bearer-token auth
- `GET /api/health` - unauthenticated probe
- Static file serving for the built web app

Modular monolith; domain packages under `internal/` (see ARCHITECTURE.md for
the package table). No microservices.

### Clients

| Client | Status | Notes |
|---|---|---|
| `apps/web` | MVP | SolidJS, feature-sliced, generated API client |
| `apps/desktop` | phase 9 | Wails shell: tray, global screenshot hotkey, deep links, notifications |
| `apps/mobile` | phase 10 | Expo/Android: conversations, issues, push, deep links |
| `packages/api-client` | shared | openapi-typescript generated; consumed by web + mobile |

## 5. Data model (PostgreSQL, sqlc + goose)

```text
users(id, email, password_hash, name, avatar_key, created_at, ...)
sessions(id, user_id, token_hash, expires_at, last_seen_at, ip, ua)

workspaces(id, name, slug)
workspace_members(workspace_id, user_id, role)   -- owner|admin|member

projects(id, workspace_id, key, name, description, icon, color)
project_members(project_id, user_id)
project_counters(project_id, next_issue_number)

github_installations(id, workspace_id, installation_id, account_login)
repositories(id, project_id, installation_id, owner, name, default_branch)

agents(id, workspace_id, name, slug, description, avatar_key)
agent_project_permissions(agent_id, project_id, scopes[])
mcp_tokens(id, agent_id, token_hash, name, scopes[], last_used_at,
           revoked_at, expires_at)

conversations(id, project_id, kind, issue_id NULL)  -- kind: project|issue
messages(id, conversation_id, author_user_id NULL, author_agent_id NULL,
         body, created_at, edited_at)
message_attachments(message_id, attachment_id, position)
attachments(id, uploader_id, storage_key, mime, size, filename, status)
message_reads(message_id, user_id NULL, agent_id NULL, read_at)

issues(id, project_id, number, title, description, status, priority,
       assignee_id, agent_id, conversation_id NULL, github_issue_node_id NULL)
issue_labels(id, project_id, name, color)
issue_label_links(issue_id, label_id)
issue_comments(id, issue_id, author_user_id, author_agent_id, body)
issue_activity(id, issue_id, actor, kind, payload, created_at)

notifications(id, user_id, kind, entity_type, entity_id, read_at, created_at)
github_links(id, project_id, issue_id NULL, github_node_id, kind)
github_sync_state(id, repository_id, cursor, last_synced_at)
```

Notes:

- `project_counters` gives `MYB-142` keys without races (`INSERT ... ON
  CONFLICT DO UPDATE next_issue_number + 1 RETURNING`).
- Message authorship is a nullable pair (user XOR agent); same pattern for
  comments and activity actors.
- `issue_activity` is the one event log feeding issue timelines and the
  project activity feed.
- Full-text search adds `tsvector` columns + GIN indexes on messages and
  issues in a later migration - planned, not deferred invention.

## 6. API surface (OpenAPI, `api/openapi.yaml`)

Auth is session cookie; every route below requires membership in the
project's workspace unless noted.

```text
POST   /api/auth/register            (unauthenticated, rate-limited)
POST   /api/auth/login               (unauthenticated, rate-limited)
POST   /api/auth/logout
POST   /api/auth/password/forgot     (unauthenticated, rate-limited)
POST   /api/auth/password/reset      (unauthenticated, rate-limited)
POST   /api/auth/password/change
GET    /api/auth/session

GET    /api/workspaces
POST   /api/workspaces
GET    /api/workspaces/:id
GET    /api/workspaces/:id/members
POST   /api/workspaces/:id/invite

GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
GET    /api/projects/:id/overview     (counts + recent activity)
GET    /api/projects/:id/activity

GET    /api/projects/:id/conversation
GET    /api/conversations/:id/messages
POST   /api/conversations/:id/messages
POST   /api/messages/:id/read

POST   /api/attachments              (multipart; returns attachment id)
GET    /api/attachments/:id          (metadata)
GET    /api/attachments/:id/url      (presigned GET URL)

GET    /api/projects/:id/issues
POST   /api/projects/:id/issues
GET    /api/issues/:id
PATCH  /api/issues/:id
POST   /api/issues/:id/comments
POST   /api/issues/:id/from-message/:messageId
GET    /api/projects/:id/labels

GET    /api/github/installations
POST   /api/github/manifest          (start app creation flow)
GET    /api/github/callback
POST   /api/projects/:id/repositories   (link repo)
GET    /api/projects/:id/development    (issues/PRs/commits panel)
POST   /api/github/webhooks          (unauthenticated; HMAC-verified)

GET    /api/agents
POST   /api/agents
PATCH  /api/agents/:id
GET    /api/agents/:id/projects
PUT    /api/agents/:id/projects/:projectId  (set scopes)
POST   /api/agents/:id/tokens        (returns token once)
DELETE /api/agents/:id/tokens/:tokenId

GET    /api/search?q=&project=
GET    /api/notifications
POST   /api/notifications/read

GET    /api/events                   (SSE)
GET    /api/health                   (unauthenticated)
```

Conventions: cursor pagination (`?cursor=`), RFC-9457-style error body
(`{error:{code,message,details?}}`), `ETag` on issue reads for safe PATCH.

## 7. MCP surface

Transport: streamable HTTP at `/mcp`. Auth: `Authorization: Bearer rly_...`.

Every call resolves token -> agent -> project grant -> scope before handler
execution. Denied calls return JSON-RPC error `-32001` (unauthorized scope).

| Tool | Scopes |
|---|---|
| `list_projects` | project:read (returns granted projects only) |
| `get_project` | project:read |
| `list_conversations` | message:read |
| `get_messages`, `get_message` | message:read |
| `get_attachment` | attachment:read (returns presigned URL + metadata) |
| `search_messages` | message:read |
| `list_issues`, `get_issue` | issue:read |
| `send_message` | message:write (posts as the agent identity) |
| `create_issue`, `update_issue` | issue:write |
| `mark_message_read` | message:read (updates agent's `last read` marker) |

Agent-side identity: `send_message` creates a message with
`author_agent_id` set; the UI renders agent name/avatar distinctly.

Rate limiting: per-token token bucket (default 120 req/min) to bound a
misbehaving agent.

## 8. Authentication & security

- Passwords: argon2id (`x/crypto/argon2`, m=64MiB, t=3, p=2). Minimum 10 chars.
- Sessions: 256-bit random token, SHA-256 hash stored, HttpOnly + Secure +
  SameSite=Lax cookie, 30-day sliding expiry, UA/IP recorded for the
  session list.
- Password reset: single-use, 1-hour tokens sent via SMTP (log-mailer in dev).
- Rate limits: login 10/min/IP + exponential per-account backoff; register
  5/hour/IP; reset 5/hour/IP. Fixed-window counters in Postgres (no cache dep).
- MCP tokens: `rly_` + 32-byte random, SHA-256 stored, shown once,
  revocable, optional expiry.
- Uploads: MIME sniffed via `http.DetectContentType`, extension allowlist
  (images, pdf, text, archives), 25 MiB default cap, keys are
  `uploads/<ulid>` - user filenames stored as metadata only.
- Markdown: rendered server-side through a sanitized subset (no raw HTML,
  no `javascript:` URLs) and client-side with a DOMPurify-equivalent pass.
- CSRF: cookie auth + custom-header check (`X-Relay-Client`) on mutations;
  SameSite=Lax is the primary defense.
- Webhooks: `X-Hub-Signature-256` HMAC over raw body before parsing.
- Logging: `zap` structured logs; secrets, tokens, and password fields are
  structurally impossible to log (never placed on log fields).

## 9. Realtime & notifications

- `/api/events` SSE stream. Client subscribes once per session; server fans
  out events filtered by the user's project memberships.
- Event types: `message.created`, `message.read`, `issue.created`,
  `issue.updated`, `attachment.ready`, `notification.created`,
  `github.synced`.
- In-process hub (`internal/realtime`). Ceiling: single instance. Upgrade
  path documented: Postgres `LISTEN/NOTIFY` behind the same interface.
- Notifications written synchronously on mention/assignment/agent-reply;
  unread counts derive from `message_reads` + `notifications.read_at`.

## 10. GitHub integration (phase 6)

Flow: project settings -> "Connect GitHub" -> manifest flow creates a
relay-scoped GitHub App (if self-hosters haven't created one) ->
installation callback -> repo picker -> `repositories` rows.

Sync (GitHub -> Relay):

- Issues: created/edited/closed events -> `github_links` + issue mirror
  rows marked `origin=github`.
- PRs: open/merge/close -> activity feed entries.
- Commits: `development` panel lists recent commits via REST (cached 60s).
- All webhook writes are idempotent via `github_sync_state` + delivery IDs.

Relay -> GitHub: not in v1. Issue rows carry `github_issue_node_id` so a
later write-back phase doesn't need a schema migration.

## 11. Frontend design system

- SolidJS + Vite, TS strict, feature folders, Ark UI primitives, Tailwind.
- Dark + light themes, system-follow default. Tokens: surface/ink/ accent
  map to the brand palette (`#101318` ink, `#F2541B` signal, `#FAFAF8`
  paper).
- Typography: Inter; code in JetBrains Mono or system mono.
- Interaction: `Ctrl/Cmd+K` command palette, `C` new issue, arrow-key issue
  navigation, `Ctrl+V` image paste in composer, optimistic message send.
- Layout per PRD section 34: top bar + project rail + content pane +
  composer. Density Discord-like, calmness Claude-like, speed Linear-like.
- Explicitly banned: AI sparkle graphics, robot imagery, emoji-driven UI,
  hero cards, gratuitous animation.

## 12. Desktop & mobile (post-MVP phases)

- **Desktop (phase 9)**: Wails v3 app embedding the web build against the
  same Go binary in-process or remote `RELAY_PUBLIC_URL`. Features: tray
  icon, global screenshot hotkey (OS-level), notifications, `relay://`
  deep links, quick project picker.
- **Mobile (phase 10)**: Expo app (Android). Email+password auth against the
  same API; conversations, issues, camera/gallery attachments, Expo push,
  deep links. No offline mode in v1.

Both consume only the public API + SSE - no private endpoints, no
business logic in clients.

## 13. Deployment

- `docker compose up -d`: relay + postgres + minio (+ minio-init bucket job).
- `deploy/Dockerfile`: multi-stage (node web build -> go build -> alpine
  runtime, non-root user).
- Reverse proxy (TLS) left to the user: Traefik/Nginx/Caddy examples in
  `deploy/`.
- Upgrades: container ships `db/migrations/`; `relay` runs `goose up` on
  boot (idempotent) unless `RELAY_SKIP_MIGRATIONS=1`.

## 14. Testing & acceptance

- Go: unit tests in-domain; integration tests use compose Postgres+MinIO.
- Contract: CI regenerates the TS client and diffs it against the commit.
- Canonical E2E (PRD section 45): register -> workspace -> project ->
  connect repo (mocked GitHub in CI) -> issue -> message with image ->
  MCP reads message + attachment -> MCP replies -> browser sees reply ->
  issue update -> GitHub state visible. Lives in `tests/e2e`.
- Permission tests: agent token for project A must get 403-equivalent on
  every tool against project B.

## 15. Non-goals for v1

AI hosting/runtimes, SSO/OAuth sign-in, billing, iOS, enterprise
permissions, workflow automation, bi-directional GitHub sync, offline
mobile mode. Listed in the PRD and unchanged.

## 16. Open questions (not blockers)

- Issue boards (kanban view) vs list-only in v1 - decide during phase 4 UI
  work; schema already supports both.
- Whether DragonflyDB earns a place for session/rate-limit storage once
  real traffic exists - instrumentation first, cache second.
