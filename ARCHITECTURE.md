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
| `users` | profiles, avatars |
| `workspaces` | workspace CRUD, members, roles (owner/admin/member) |
| `projects` | project CRUD, members, agents access, keys (`MYB`) |
| `conversations` | per-project threads, conversation↔issue linking |
| `messages` | messages, markdown, read state, mentions |
| `attachments` | upload pipeline, MIME/size validation, S3 keys, presigned URLs |
| `issues` | issue tracker, statuses, labels, counters, activity |
| `github` | app installation, repo linking, webhook ingest, sync state |
| `agents` | agent identities, MCP token lifecycle, review mode |
| `reviews` | structured agent work reviews, verdict flow, pending counts |
| `avatars` | user/agent logo upload, `/api/files` reader for avatar keys |
| `mcp` | streamable-HTTP MCP server, tool handlers, scope enforcement |
| `realtime` | in-process event hub → SSE fan-out |
| `notifications` | inbox items, unread aggregation |
| `search` | Postgres FTS queries |
| `storage` | S3 client abstraction (minio-go) |
| `config` | env loading, validation |

Rules: handlers are thin, domain logic lives in the package, data access is
sqlc-only. No package reaches into another's tables - cross-domain reads go
through the owning package or a dedicated query.

## Data model (core)

```text
users ── sessions
workspaces ── workspace_members ── users
projects ── project_members, project (key prefix + issue counter)
repositories ── github_installations
agents ── agent_project_permissions ── mcp_tokens
conversations ── messages ── message_attachments, message_reads
issues ── issue_labels, issue_comments, issue_activity
agent_reviews (project + agent, optional issue; verdict by a human)
notifications
github_links, github_sync_state
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

SSE at `/api/events`. Events: `message.created`, `issue.updated`,
`attachment.ready`, `notification.created`, `github.synced`. A single
in-process hub fans out to subscribers.

Known ceiling: one process only. If Relay ever runs multi-instance, swap the
hub's backend for Postgres `LISTEN/NOTIFY` - the SSE surface stays identical.

## MCP

Streamable HTTP transport (`mark3labs/mcp-go`) at `/mcp`. Tool surface:

`list_projects, get_project, list_conversations, get_messages, get_message,
get_attachment, search_messages, list_issues, get_issue, send_message,
create_issue, update_issue, mark_message_read`

"Last seen" = timestamp of the last authenticated MCP call. Relay reports
only what it can prove - no presence simulation.

## GitHub

GitHub App (manifest creation → install → webhook). Installation tokens are
short-lived and never persisted; webhook payloads are HMAC-SHA256 verified
and recorded idempotently in `github_sync_state`. MVP direction is
GitHub → Relay mirroring; Relay → GitHub writes are post-MVP.

## Storage

`minio-go` against `STORAGE_ENDPOINT` (RustFS dev default, MinIO, S3, R2, anything S3-shaped).
Uploads stream through `POST /api/attachments` (sniffed MIME, size cap,
random key); downloads use short-lived presigned GET URLs so the API never
proxies large bodies.

## Search

Postgres FTS (`tsvector` over messages, issues, projects) behind
`GET /api/search`. No external search service until FTS measurably fails.

## Frontend

Feature-sliced SolidJS (`src/features/{auth,projects,conversations,issues,
github,agents,search}`). Ark UI primitives, Tailwind utilities, dark + light
themes. Solid stores for client state; generated api-client for all server
state; optimistic send for messages.

## Testing

- Go: unit tests per package; integration tests run against real Postgres +
  MinIO via docker-compose services.
- The canonical E2E (register → workspace → project → message with pasted
  image → MCP read → MCP reply → browser sees it → issue → GitHub state)
  is phase-acceptance criteria, scripted in `tests/e2e`.
