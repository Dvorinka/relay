# Architecture

Relay is a **modular monolith**: one Go binary serving the REST API, the
realtime SSE stream, and the MCP endpoint. Deliberately boring - easy to
self-host, easy to contribute to, and splittable later if a domain ever
earns it.

```text
                 ┌────────────────────────────────────────┐
                 │                 relay                  │
                 │                                        │
   browser ────► │  /api/*   /api/events (SSE)   /mcp     │ ◄──── agents
                 │     \         |               /        │
                 │      internal/{domain packages}        │
                 │                 |                      │
                 │     PostgreSQL (sqlc + goose)          │
                 │     S3-compatible object storage       │
                 └────────────────────────────────────────┘
                          ▲              ▲
                  apps/web (SolidJS)   apps/desktop (Wails, embeds web build)
                  apps/mobile (Expo)   packages/api-client (generated, shared)
```

## Repository layout

```text
apps/web/            SolidJS + Vite + TS strict + Tailwind + Ark UI
apps/desktop/        Wails v3 shell (phase 10)
apps/mobile/         React Native + Expo, Android (phase 11)
packages/api-client/ OpenAPI-generated TS client + types (web + mobile)
cmd/relay/           main() - config, wiring, graceful shutdown
internal/            backend domains (below)
api/openapi.yaml     API contract - single source of truth
db/migrations/       goose migrations (versioned, never edited after merge)
db/queries/          sqlc query files, one per domain
deploy/              Dockerfile, docker-compose.yml, example configs
assets/brand/        logo kit
docs/                specs, plans, guides
.github/             CI, templates, dependabot
```

## Backend domains (`internal/`)

| Package | Responsibility |
|---|---|
| `auth` | registration, login/logout, sessions, password reset, rate limiting |
| `workspaces` | workspace CRUD, members, roles (owner/admin/member) |
| `projects` | project CRUD, members, agents access, keys (`MYB`) |
| `conversations` | per-project threads + channels, conversation↔issue linking |
| `attachments` | upload pipeline, MIME/size validation, S3 keys, presigned URLs |
| `issues` | issue tracker, statuses, labels, counters, activity |
| `github` | app/token/`gh` auth, repo linking, webhook ingest, message→issue filing |
| `agents` | agent identities, MCP token lifecycle, review mode |
| `reviews` | structured agent work reviews, verdict flow, pending counts |
| `briefs` | Excalidraw visual briefs attached to agent work |
| `ideas` | per-project whiteboard (sticky notes, shapes, mention cards) |
| `todos` | agent work lists (MCP `todo_*`, board "work list") |
| `reminders` | message reminders, `reminder.fired` events |
| `webhooks` | inbound hook tokens + outbound event subscriptions |
| `localfiles` | project-folder file listings + `@file:`/`@gh:` reads |
| `avatars` | user/agent/logo upload, `/api/files` reader for avatar keys |
| `mcpserver` | streamable-HTTP MCP server, tool handlers, scope enforcement |
| `agentdoc` | embedded agent guide (`get_guide`, `/api/agent-guide`) |
| `realtime`/`events` | in-process event hub → SSE fan-out |
| `saved` | saved-for-later message bookmarks |
| `statuses` | custom per-project issue lanes |
| `search` | Postgres FTS queries |
| `push` | VAPID web-push subscriptions |
| `unfurl` | link preview fetching |
| `mentions` | structured mention resolution (`KEY-1`, `owner/repo#42`, files) |
| `storage` | S3 client abstraction (minio-go) |
| `config` | env loading, validation |

Rules: handlers are thin, domain logic lives in the package, data access is
sqlc-only. No package reaches into another's tables - cross-domain reads go
through the owning package or a dedicated query.

## Data model (core)

```text
users ── sessions
workspaces ── workspace_members ── users
projects ── project_members (key prefix + issue counter)
repositories ── github_installations
agents ── agent_project_permissions ── mcp_tokens
conversations ── channels
   └── messages ── message_attachments ── attachments, message_reads
issues ── issue_labels, issue_comments, issue_activity, boards
agent_reviews (project + agent, optional issue; verdict by a human)
briefs, ideas, agent_todos, reminders
notifications
github_links, github_sync_state
webhook_subscriptions (outbound), inbound_hooks
```

Issue keys: per-project counter + prefix (`MYB-142`). `issue_activity` is the
single event table behind both the issue timeline and the project activity
feed.

## AuthN/Z

- **Humans**: email+password → argon2id hash → opaque session cookie.
  Middleware resolves session → user → workspace/project membership.
- **Agents**: `Authorization: Bearer rly_…` → hashed `mcp_tokens` row →
  agent → `agent_project_permissions`. Every tool call re-checks project +
  scope. No token, no table access - agents never share the user path.

## API contract

`api/openapi.yaml` is authoritative. `just api` regenerates
`packages/api-client` (openapi-typescript + fetch wrapper). Frontend imports
generated types only; writing API types by hand is a review rejection.

## Realtime

SSE at `/api/events`. Event families: `message.*` (created/updated/deleted/
read), `channel.*`, `thread.*`, `project.*` (created/updated), `issue.updated`,
`reaction.updated`, `github.ci`, `reminder.fired`, `review.*`, plus ephemeral
`typing` and `presence.update`. A single in-process hub fans out to subscribers; other
packages and the webhook dispatcher can subscribe in-process too.

Known ceiling: one process only. If Relay ever runs multi-instance, swap the
hub's backend for Postgres `LISTEN/NOTIFY` - the SSE surface stays identical.

## MCP

Streamable HTTP transport (`mark3labs/mcp-go`) at `/mcp`. ~55 tools across
projects, conversations/messages/threads, attachments, issues, todos,
project files, reviews, briefs, ideas, and the full GitHub surface
(`github_list_*`, `github_create_*`, `github_merge_pr`, `github_rerun`, …).
The canonical tool map is `internal/agentdoc/guide.md` — agents fetch it
via `get_guide`, `relay-cli guide`, or `GET /api/agent-guide`.

"Last seen" = timestamp of the last authenticated MCP call. Relay reports
only what it can prove - no presence simulation.

## GitHub

Three auth paths, resolved in order: a registered GitHub App (manifest
creation → install → webhook; short-lived installation tokens, never
persisted), `GITHUB_TOKEN`, or the host's `gh` CLI login. Webhook payloads
are HMAC-SHA256 verified and recorded idempotently in `github_sync_state`.

Sync runs **both directions**: GitHub → Relay mirrors issues, PRs, labels,
and CI; Relay → GitHub covers issue push, issue/PR creation, comments,
reviews, in-app merge, and message→issue filing (`bug:`-style auto-file and
the manual **File on GitHub** action, deduplicated by a `filed` tag claimed
atomically on the source message). See docs/GITHUB.md.

## Storage

`minio-go` against `STORAGE_ENDPOINT` (RustFS dev default, MinIO, S3, R2, anything S3-shaped).
Uploads stream through `POST /api/projects/:id/attachments` (sniffed MIME,
size cap, random key); downloads use short-lived presigned GET URLs so the
API never proxies large bodies.

## Search

Postgres FTS (`tsvector` over messages, issues, projects) behind
`GET /api/search`. No external search service until FTS measurably fails.

## Frontend

Feature-sliced SolidJS (`src/features/{agents,auth,briefs,conversations,
github,ideas,issues,projects,reviews,webhooks,workspaces}`). Ark UI
primitives, Tailwind utilities, dark + light themes. Solid stores for
client state; generated api-client for all server state; optimistic send
for messages.

**Offline/outage layer** (`src/lib/`): a response cache keeps last-synced
reads visible when the server is down; mutations queue in a durable outbox
(images park as blobs, placeholder attachment ids rewrite mid-replay) and
drain FIFO when `/api/health` recovers. "Work locally" imports the cached
workspace into IndexedDB local mode — remote entities keep their server
ids, so reconnect syncs only the delta without duplicating what was
imported.

## Testing

- Go: unit tests per package; integration tests run against real Postgres +
  MinIO via docker-compose services.
- The canonical E2E (register → workspace → project → message with pasted
  image → MCP read → MCP reply → browser sees it → issue → GitHub state)
  is phase-acceptance criteria, scripted in `tests/e2e`.
