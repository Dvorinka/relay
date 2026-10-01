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

## Phase 4.5 - Landing page ☐

- Public landing at `/`; app moves under `/app`
- Hero, feature grid, MCP callout, self-host quickstart, footer
- Brand-true, dark/light aware, zero tracking

## Phase 5 - Agents & MCP ☐

- Agent identities (name, avatar, description, last-seen)
- Scoped, revocable `rly_` MCP tokens, per-project permissions
- MCP server (streamable HTTP): full tool list from the spec
- Project settings: agent access management

## Phase 6 - GitHub ☐

- GitHub App creation via manifest, installation flow
- Repository linking per project
- Issue/PR mirror + HMAC-verified webhooks, `github_sync_state`
- Project "Development" panel (issues, PRs, recent commits)

## Phase 7 - Realtime & notifications ☐

- SSE event hub, browser live updates
- Unread counts, mentions, notification center / inbox

## Phase 8 - Search & polish ☐

- Postgres FTS global search, `Ctrl/Cmd+K` palette
- Keyboard-first navigation pass, dark/light polish, a11y audit

## Phase 9 - Desktop (Wails) ☐

- Wails v3 shell embedding the web build - Linux/macOS/Windows
- System tray, notifications, deep links, global screenshot shortcut,
  quick project switcher

## Phase 10 - Android (Expo) ☐

- React Native + Expo app on `packages/api-client`
- Conversations + issues, image paste/camera, push notifications, deep links

## Phase 11 - Hardening & 1.0 ☐

- Security pass (rate limits, upload caps, token hygiene, CSP)
- E2E test of the canonical flow, performance pass on hot paths
- Docs completeness, release packaging, `v1.0.0`

## Post-1.0 ideas (not committed)

- Relay → GitHub issue write-back and bi-directional sync
- Custom statuses, saved filters, issue boards
- Webhooks + outbound event subscriptions for agents
- Relay Cloud (hosted offering) - self-hosting stays first-class
- iOS build of the mobile app
- DragonflyDB cache layer if hot paths need it
