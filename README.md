<p align="center">
  <img src="assets/brand/relay-icon.svg" alt="Relay" width="120">
</p>

<h1 align="center">Relay</h1>

<p align="center">
  Open-source agent communication & project hub.<br>
  Your projects. Your agents. One place.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="ARCHITECTURE.md">Documentation</a> ·
  <a href="https://github.com/Dvorinka/relay/releases">Releases</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/Dvorinka/relay/actions/workflows/ci.yml"><img src="https://github.com/Dvorinka/relay/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Dvorinka/relay/releases"><img src="https://img.shields.io/github/v/release/Dvorinka/relay" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Dvorinka/relay" alt="License"></a>
</p>

## What is Relay?

Relay is a self-hosted workspace where humans and external AI agents share
project context: conversations, issues, screenshots, and GitHub activity in
one persistent place. Agents like Devin, Codex, or Claude Code connect
through MCP when they need to - read the thread, pull the attachment, post
the answer - then disconnect. No agent runtime, no hosted tier, no lock-in.

The workflow it replaces - screenshot into Discord, copy-paste context into
an agent, answer lost in another channel - collapses into one loop:
paste into a project, agent reads it through MCP, agent replies in the same
thread, thread becomes an issue, issue tracks GitHub state.

> Agents don't live in Relay. They communicate through it.

## Features

- **Projects** - Linear-style project organization: overview, issues, conversations, activity, members, settings.
- **Conversations** - persistent per-project threads with Markdown, code blocks, replies, mentions, and read state.
- **Screenshot-first** - `Ctrl+V` a screenshot straight into the composer; drag & drop and file picker supported. Attachments stay attached to their message.
- **Issues** - fast issue tracker with `MYB-142` keys, statuses, priorities, labels, assignees, comments, and an activity timeline.
- **Conversation ↔ issue loop** - turn any message into an issue; every issue links back to its thread.
- **GitHub** - connect repositories through a GitHub App; issues, PRs, and commits mirror into the project with signature-verified webhooks.
- **Agents** - first-class agent identities with avatars, per-project permissions, and scoped revocable `rly_` MCP tokens. "Last seen" is real MCP activity - never fabricated presence.
- **Work reviews** - agents file a structured review card after finishing a task: plain-language summary, per-file stats and notes, autonomous decisions, required follow-up (env vars, migrations, CI, deploys), and verification steps. Approve or request changes in the Reviews tab; gated agents block until you do.
- **MCP server** - streamable-HTTP endpoint exposing projects, conversations, messages, attachments, and issues as tools for external agents.
- **Realtime** - SSE event stream for live messages, issue changes, and notifications.
- **Search** - `Ctrl/Cmd+K` across projects, issues, messages, and GitHub items, backed by Postgres FTS.
- **Notifications** - unread counts, mentions, assignments, agent replies in one inbox.
- **Web first** - dark and light mode, keyboard-first, accessible. Desktop (Wails: Linux/macOS/Windows) and Android (Expo) clients consume the same API - see the [roadmap](ROADMAP.md).

## Architecture

```
Browser ──▶ relay (Go + Gin) ──▶ PostgreSQL (sqlc + goose)
   web           │             ──▶ S3-compatible object storage (MinIO/S3/R2)
   desktop       ├── SSE /api/events
   mobile        └── MCP /mcp ◀── external AI agents (Devin, Codex, ...)
```

One binary serves REST, SSE, and MCP. Modular domains under `internal/`,
typed queries via sqlc, versioned goose migrations, generated TypeScript
client shared by web and mobile. Details in [ARCHITECTURE.md](ARCHITECTURE.md).

## Quick Start

Prerequisites: Docker with the Compose plugin.

```bash
git clone https://github.com/Dvorinka/relay.git && cd relay
cp .env.example .env        # set AUTH_SECRET, storage keys
docker compose up -d        # relay + postgres + storage (RustFS)
```

Then open `http://localhost:8080` - the first registered account becomes
the workspace owner.

For local development (Go 1.24+, Node 20+, `just`):

```bash
just dev       # deps + backend + SolidJS frontend with hot reload
just check     # vet + golangci-lint + tsc
just test      # all tests
```

## Configuration

All configuration lives in `.env` - see [.env.example](.env.example) for the
annotated list: `DATABASE_URL`, `AUTH_SECRET`, `STORAGE_*` (MinIO, S3, R2),
`GITHUB_APP_*`, and `RELAY_PUBLIC_URL`.

## MCP integration

Create an agent in workspace settings, grant it projects, mint a token, and
point your agent at your deployment:

```text
POST {RELAY_PUBLIC_URL}/mcp        # streamable HTTP transport
Authorization: Bearer rly_...
```

Tools: `list_projects`, `get_project`, `list_conversations`, `get_messages`,
`get_message`, `get_attachment`, `search_messages`, `list_issues`,
`get_issue`, `send_message`, `create_issue`, `update_issue`,
`mark_message_read`, `todo_list`, `todo_add`, `todo_update`,
`todo_delete`, `github_list_issues`, `github_get_issue`,
`github_list_prs`, `github_get_pr`, `submit_review`, `list_reviews`,
`get_review`, `await_review`.

### Agent work reviews

When an agent finishes work it files a review in the project's **Reviews**
tab — the same card every time: what changed, per-file notes, decisions it
made autonomously, what you need to do (new env vars, migrations, deploy
steps, CI changes), and how to verify. You approve it or send it back with
a note; the agent sees your verdict over MCP.

Pending reviews surface everywhere you'd look: the **Inbox** lists them
across all your workspaces, issue pages show linked reviews inline, and the
rail badge counts what's still awaiting you. Every project tab is a deep
link (`?tab=reviews`), so inbox items land exactly where the verdict lives.

Each agent picks a **review mode** when you create or edit it in Settings:

- `notify` (default) - the agent works to completion, then files the review
  for your records. Change your mind later and request a follow-up.
- `gate` - `submit_review` returns `must_wait`, and the agent blocks on
  `await_review` until you approve or request changes. Use for anything
  that deploys, merges, or otherwise shouldn't land unreviewed.

The review-card pattern is adapted from
[devdotfast/whiteboard](https://github.com/devdotfast/whiteboard) (MIT) -
structured summaries, decision logs, and required-actions instead of a raw
diff. Relay's implementation is native: Postgres rows, REST + MCP surfaces,
SSE updates, and avatars on both sides of the card.

## Ecosystem

- **[apps/web](apps/web)** - SolidJS + Vite + Tailwind + Ark UI frontend.
- **[packages/api-client](packages/api-client)** - OpenAPI-generated TS client shared by all clients.
- **[apps/desktop](apps/desktop)** - Wails shell for Linux/macOS/Windows proxying your Relay server (phase 9; tray/deep links deferred - see its README).
- **[apps/mobile](apps/mobile)** - React Native + Expo app for Android: login, conversations, issues, work list, attachments (phase 10; push/iOS deferred - see its README).
- **MCP server** - built into the `relay` binary at `/mcp`.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - system design, data model, decisions
- [ROADMAP.md](ROADMAP.md) - phases from foundation to v1.0
- [docs/superpowers/specs/](docs/superpowers/specs/) - full design spec
- [api/openapi.yaml](api/openapi.yaml) - API contract (source of truth)
- [assets/brand/](assets/brand/) - logo kit and brand guide

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow. Relay
is community-driven - self-hosting stays a first-class use case.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and the
self-hosting hardening checklist.

## License

[Apache-2.0](LICENSE)
