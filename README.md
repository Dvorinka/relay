<p align="center">
  <img src="assets/brand/relay-mark-accent.svg" width="72" alt="Relay logo">
</p>

<h1 align="center">Relay</h1>

<p align="center">
  <strong>Your projects. Your agents. One place.</strong><br>
  Open-source, self-hosted workspace for projects, GitHub issues,
  conversations, screenshots, and external AI agents.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

---

## Why Relay exists

Talking to coding agents today looks like this:

```text
Screenshot → Discord → find the message → copy/paste to the agent →
explain the context → agent works → response lands somewhere else
```

With Relay:

```text
Screenshot → paste into Relay → project/issue → agent reads it through
MCP → agent works externally → agent replies in the same thread
```

Everything stays in one persistent project context. GitHub remains the
source of truth for code. Relay is the communication and coordination layer
on top of it.

> **Agents don't live in Relay. They communicate through it.**

Relay is not an AI IDE and not an agent runtime. External agents (Devin,
Codex, Claude Code, OpenCode, your own) connect through MCP whenever they
want. You can leave a message or a screenshot today; an agent can pick it up
tomorrow.

## What it does

- **Projects** - Linear-style project organization with overview, issues, conversations, and activity
- **Conversations** - persistent per-project threads with Markdown, code, files, and paste-a-screenshot image support
- **Issues** - fast issue tracker (`MYB-142` style keys, statuses, priorities, labels) with a conversation-to-issue loop
- **GitHub** - link repositories via a GitHub App; issues, PRs, and activity mirror into Relay
- **Agents** - first-class agent identities with scoped, revocable MCP tokens and per-project permissions
- **MCP server** - agents list projects, read conversations and attachments, send replies, manage issues
- **Search** - `Ctrl/Cmd+K` across projects, issues, messages, and GitHub items
- **Notifications** - unread state, mentions, assignments, agent replies
- **Web first** - desktop (Wails) and Android (Expo) clients consume the same API

## Architecture

```text
┌──────────────────────────────┐
│            relay             │  single Go binary (Gin)
│                              │
│   REST API    SSE     MCP    │  /api/*   /api/events   /mcp
│        \       |       /     │
│     internal/{domains}       │  modular monolith
│              |               │
│      PostgreSQL (sqlc)       │  goose migrations
│      S3-compatible storage   │  attachments (MinIO/S3/R2)
└──────────────────────────────┘
        ▲            ▲
   web (SolidJS)   external agents (MCP)
   desktop (Wails) mobile (Expo)
```

- **Backend**: Go + Gin, modular monolith in `internal/`, `zap` logging
- **Frontend**: SolidJS + Vite + TypeScript strict + Tailwind + Ark UI
- **API contract**: `api/openapi.yaml` is the source of truth; the TypeScript client is generated, never handwritten
- **Database**: PostgreSQL, `sqlc` for typed queries, `goose` for versioned migrations
- **Storage**: any S3-compatible backend (MinIO for self-hosting)
- **Auth**: email + password, argon2id, opaque session cookies, rate limiting
- **Desktop** (later): Wails v3 shell on the same web build - tray, global screenshot shortcut, deep links
- **Mobile** (later): React Native + Expo, Android

Full details: [ARCHITECTURE.md](ARCHITECTURE.md).

## Quick start (self-hosted)

```bash
cp .env.example .env        # fill in secrets
docker compose up -d        # relay + postgres + minio
```

Open `http://localhost:8080`. The first registered user becomes the
workspace owner.

## Local development

Prerequisites: Go 1.24+, Node 20+, Docker (for Postgres + MinIO), `just`.

```bash
just dev           # start deps + backend + frontend with hot reload
just migrate       # run goose migrations
just sqlc          # regenerate sqlc code after editing db/queries
just api           # regenerate the TS client after editing api/openapi.yaml
just test          # all tests
```

Repository layout:

```text
apps/web/          SolidJS frontend
apps/desktop/      Wails shell (phase 10)
apps/mobile/       Expo app, Android (phase 11)
cmd/relay/         Go entrypoint
internal/          backend domains (auth, projects, issues, mcp, ...)
packages/api-client/  generated OpenAPI client, shared by web + mobile
api/openapi.yaml   API contract
db/                migrations + sqlc queries
deploy/            Dockerfile, compose, examples
assets/brand/      logo kit and brand guide
docs/              specs, plans, guides
```

## GitHub integration

Relay connects through a **GitHub App** (manifest flow):

1. Project settings → GitHub → *Create GitHub App* (manifest pre-fills permissions)
2. Install the app on your repositories
3. Issues, PRs, and activity mirror into the linked project; webhooks keep state fresh

MVP syncs GitHub → Relay. Relay → GitHub write-back is on the
[roadmap](ROADMAP.md).

## MCP integration

Create an agent in workspace settings, grant it projects, and copy its MCP
token. Point your agent at:

```text
POST {RELAY_PUBLIC_URL}/mcp     (streamable HTTP transport)
Authorization: Bearer rly_...
```

Tools: `list_projects`, `get_project`, `list_conversations`,
`get_messages`, `get_message`, `get_attachment`, `search_messages`,
`list_issues`, `get_issue`, `send_message`, `create_issue`,
`update_issue`, `mark_message_read`.

Tokens are scoped per project and per permission, and revocable. Relay only
ever shows real agent metadata (last MCP activity, last read) - never
fabricated presence.

## Configuration

All configuration is environment variables - see [.env.example](.env.example)
for the complete list with comments. Minimum set:

```text
DATABASE_URL          postgres://relay:...@postgres:5432/relay
RELAY_PUBLIC_URL      https://relay.example.com
AUTH_SECRET           openssl rand -hex 32
STORAGE_*             S3-compatible endpoint, keys, bucket
GITHUB_APP_*          app credentials (phase 7)
```

## Security

Report vulnerabilities privately - see [SECURITY.md](SECURITY.md).
Highlights: argon2id password hashing, scoped + revocable MCP tokens,
per-project authorization checks, webhook signature verification, upload
MIME/size validation, rate-limited auth endpoints, no secrets in logs.

## Contributing

Relay is community-driven - see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[roadmap](ROADMAP.md). Good first contributions are tagged
`good first issue` once the repository is public.

## License

[Apache License 2.0](LICENSE). Self-hosting is a first-class use case and
always will be.
