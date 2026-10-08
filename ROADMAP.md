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
the local stack. Releases ship a per-user NSIS installer
(`Relay-Setup-<ver>.exe` — shortcuts, uninstaller, WebView2 bootstrap,
no admin).

- Wails v2 shell proxying to the configured server — Linux/Windows
  (macOS supported by the same code path via `wails build -platform darwin`)
- `relay://` scheme registered by both installers; cold-start argv and
  second-instance launches reach the SPA as `relay:deeplink` events,
  routed to `/connect`/`/app`/`/login`/`/register` only
- In-app self-update (Windows silent NSIS, Linux binary swap + re-exec);
  update checks compare the binary's stamped version via `App.Version()`
- System tray, global screenshot shortcut: deferred
  (see apps/desktop/README.md for the honest why)

## Phase 10 - Android (Expo) ☑

`apps/mobile` — Expo 57 / React Native + Expo Router as a WebView shell
over the server's web UI: one connect screen, then the full web app with
cookies/localStorage persisting sign-in, hardware-back navigation, and
`relay://` deep links routing into web paths. The earlier hand-built
native screens were retired — parity with the web UI is now structural,
not a chase. APK filenames carry the version; CI builds arm64-v8a only.

- Push notifications, EAS/iOS builds: deferred
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
  toolbar (react / reply / edit / delete / more), combined consecutive
  messages, text-then-image ordering, markdown with fenced code blocks;
  optional two-sided bubble layout (Settings -> Appearance -> Chat layout)
- `messages.parent_id` + `message_reactions` (migration 0016); parent
  validation rejects cross-conversation replies; `edited_at` + `agent_read`
  surfaced on every message payload; `message.updated` over SSE
- MCP parity: `send_message.reply_to`, `edit_message`, `delete_message`,
  `react_to_message`, `mark_message_read`, `set_avatar`
- Theme system: persistent light/dark, accent presets + color wheel + hex
  readout (Settings → Appearance); cyan `#06B6D4` default; neutral
  near-black dark palette
- Same-origin `GET .../attachments/:id/download` and streamed `/api/files/*`
  (presigned redirects broke under Chrome Local Network Access on LAN dev)
- Every surface unified: web (incl. phone-width drawer layout), landing
  (cyan + real app screenshots), desktop shell + connect page, Expo app
  (light+dark schemes, in-app appearance override, inbox, reviews,
  replies/reactions/edit-lock, status-colored issues)

## Phase 17 - Navigation rework & local mode ☑

Verified live: local mode entered from the login screen, project + message +
issue + reaction created with no server, data persisted across reload, and
"Sync to server" replayed the workspace onto `localhost:8080` cross-origin
(bearer token + CORS). Board renders as its own page; PR sheet lists linked
repos' open PRs; rail search filters this project inline.

- Kanban is a dedicated page (`/app/p/:id/board`) reachable from the chat
  header; legacy `?view=board`/`?tab=board` links redirect
- PR button next to Issues opens the pull-requests sheet (linked-repo PRs
  with state, draft flag, head→base, author)
- Search moved into the project rail above Open issues (Discord-style):
  project-scoped results for issues/messages/todos, Esc/✕ clears; global
  ⌘K palette unchanged via keyboard
- **Local mode**: `lib/local.ts` is a localStorage-backed adapter behind the
  same `api.*` surface - projects, conversations, messages (replies, edits,
  reactions, data-URL attachments), issues, labels, todos, avatar, search.
  Agents/reviews/GitHub return empty and read-only surfaces degrade cleanly
- **Connection model**: login/register return a session token; `RequireAuth`
  accepts `Authorization: Bearer` and `?access_token=` (SSE); `/api` answers
  CORS `*` since bearer-auth requests carry no ambient credentials
- **Sync**: `syncToServer(url,email,password)` replays local projects →
  messages (with reply links and attachment re-upload) → issues → todos,
  preserving order and statuses
- Settings → Connection card shows mode, offers "Work locally", sync form,
  and connect-to-server; Rail marks the workspace `local`
- CSP `connect-src` widened to `http:`/`https:` so a hosted SPA can reach
  arbitrary servers

## Post-1.0 ideas (not committed)

- Relay Cloud (hosted offering) - self-hosting stays first-class
- iOS build of the mobile app
- Multiple simultaneous server connections per client (today a client
  signs in to one server; multi-server means per-server sessions, a
  unified rail, and merged notifications)
- In-app auto-update for the desktop app (check → download → apply with
  progress; Windows/macOS updater plumbing + Linux path TBD)
- Play Store distribution (EAS submit, store listing); the CI release
  APK is already signed with a stable keystore via
  `apps/mobile/plugins/withReleaseSigning.js`
- DragonflyDB cache layer if hot paths need it

## Phase 18 — project states, boards, push, local folders, mobile outbox

- **Custom statuses**: `projects.statuses` JSONB definitions (id, label,
  color, closed flag) editable in project settings; the DB CHECK constraint
  is gone — the server validates against project defs. Issues, lists, board
  lanes, and filters all honor custom lanes.
- **Saved filters & named boards**: `saved_filters` + `boards` tables;
  "Save view" in the issues panel and named board tabs on the board page
  persist per project.
- **Web Push**: VAPID (`RELAY_VAPID_*`), subscription endpoints, service
  worker (`sw.js`), Settings → Notifications card. Mentions, replies and
  review requests push to subscribed browsers.
- **Linked project folder**: `projects.local_path` — a local directory can
  stand beside (or instead of) GitHub; file tree/read endpoints with
  traversal + sensitive-file (`.env`, keys) protection. `@file:path` and
  `@gh:repo:path` composer mentions autocomplete and open an inline preview.
- **MCP `file:read` scope**: `list_project_files` / `read_project_file`
  tools serve the linked folder and GitHub trees to agents.
- **Mobile outbox**: messages and picked images queue in AsyncStorage when
  the server is unreachable; a successful poll drains them in order. Full
  local-mode remains a desktop/web feature by design.

## Phase 19 — mentions, briefs, IndexedDB, CLI polish

- **Structured mentions**: `messages.mentions` jsonb stores resolved
  references (`user`, `agent`, `issue`, `gh`, `file`, `repo`). `@name`,
  `@user:x`, `@agent:x`, `KEY-1`, `owner/repo#42`, `@file:p`, `@gh:r:p`
  extract server-side on REST and MCP posts; unresolved refs persist with
  `found:false`. `/api/projects/:id/mentionables` feeds the unified `@`/`#`
  composer menu (users, agents, issues incl. mirrored GitHub items, files).
- **Visual briefs**: `briefs` table + `kind='brief'` conversations.
  Excalidraw-compatible scene JSON rendered as SVG in the app; comment
  thread via the normal messages API. `projects.brief_policy`
  (never|on_request|pre_merge) — read by agents through the
  `get_brief_policy` MCP tool; `create_brief` is refused under `never`.
  New `brief:read`/`brief:write` scopes, backfilled onto `issue:write`
  grants.
- **Local `gh` provider**: when no app is registered and `GITHUB_TOKEN` is
  unset, Relay sources a PAT from `gh auth token` — same REST surface, zero
  GitHub App setup for self-hosters.
- **IndexedDB local mode**: the local adapter persists to IndexedDB — doc
  state in `kv`, attachment/avatar bytes in `blobs`. Legacy localStorage
  data migrates once; object URLs rehydrate on boot. Storage ceiling moves
  from ~5 MB to available disk quota.
- **CLI v2**: human-readable output by default, `--json` for machines,
  full command surface (messages/read/say/react/msg-edit, issues, todos,
  files, gh, reviews, briefs, attachments, shell completions), `--reply`,
  ambiguous project/conversation id handling, `--file` for JSON payloads.
- **Brand lock**: `#06b6d4` is the only accent; the Settings accent picker
  is gone (`relay.accent` pref purged); favicon is the white mark on brand
  black with a cyan dot, shared by web and landing.
## Phase 20 — release artifacts & landing refresh

- **Release builds**: `v*` tags produce the full artifact set —
  server + CLI binaries (linux/windows/darwin), Wails desktop for
  linux + windows, `relay-android.apk` (expo prebuild + Gradle,
  debug-signed; EAS remains the path for store signatures), and
  `ghcr.io/dvorinka/relay:<tag>` + `:latest`.
- **CI hardening**: the docker job now builds via buildx with GHA cache
  and publishes `ghcr.io/dvorinka/relay:latest` + `sha-<short>` on every
  main push; the desktop job builds the Linux binary alongside the
  Windows cross-build so both smoke on every PR.
- **Landing**: screenshots retaken against the redesigned app (chat hero,
  board, review card, brief viewer); new "Briefs" section; og:image on
  the chat shot.
- **Scene labels**: `SceneView` renders `text` on shapes (agent-authored
  labels), centered with line splits and a luminance-aware fill.

## Phase 21 — embedded Excalidraw editor

- **Real Excalidraw in briefs**: every brief gains an "Edit canvas" path that
  mounts the actual `@excalidraw/excalidraw` component as a React island
  inside the Solid app — full tool palette (shapes, arrows, freedraw, text,
  images, bindings), so users draw proper architecture diagrams instead of
  only commenting on agent output. Lazy-loaded; the ~1.4MB chunk only ships
  when the editor opens. `resolve.dedupe` + `optimizeDeps.include` keep one
  React copy (otherwise hooks explode).
- **Shared scene format**: saved scenes persist full Excalidraw JSON
  (elements/appState/files). `restore()` normalizes minimal agent-authored
  scenes before the editor sees them. Agents read and revise the identical
  JSON via `get_brief`/`update_brief` — user-drawn and agent-drawn canvases
  are interchangeable; the lightweight `SceneView` still renders the core
  subset for quick viewing.

## Phase 22 — message deletion, chat styles, threads

- **Message deletion**: `DELETE /api/messages/:id` soft-deletes (`deleted_at`),
  author-only, same agent-read lock as edit; `message.deleted` over SSE drops
  it live everywhere; replies keep tombstones. Parity across web (hover
  toolbar + confirm), mobile (long-press sheet), local mode, and MCP
  (`delete_message`).
- **Chat layout preference**: per-user `relay.chatStyle` — default grouped
  left-aligned timeline or WhatsApp-style two-sided bubbles (own messages
  right, tinted; Settings → Appearance). Shared `MessageRow` renders both.
- **Message threads**: `conversations.kind='thread'` rooted at a
  `parent_message_id` (migration 0020). `POST /api/messages/:id/thread` is
  idempotent (one thread per message, race-safe via partial unique index),
  titles optional with parent-excerpt default, nesting refused at schema
  and API. Parent messages carry a `thread` chip ({id,title,reply_count})
  patched live by `thread.created`/`thread.updated` SSE frames keyed to the
  parent conversation; replies post through the normal messages API and
  membership gates are unchanged. Web opens threads in a side panel reusing
  `ConversationThread`; local-mode adapter mirrors the surface; MCP gets
  `create_thread`. `GET /api/projects/:id/threads` indexes a project's
  threads most-recent-first.

## Phase 23 — channels, thread management, reviews-in-context, GitHub depth ☑

Verified live on a scratch stack (Postgres + built binary): migrations to
0033 apply, review scenes round-trip through MCP `submit_review` → REST,
channel + thread lifecycle works, delete-by-expiry returns `200
{deleted:true}` (fixed a 500 where the handler re-read the expired row it
just invalidated — regression covered in `TestChannelsAndExpiry`).

- **Channels**: `conversations.kind='channel'` (migration 0032) — named,
  persistent channels under each project; create/rename/delete from the
  left rail; `PATCH`/`DELETE /api/channels/:id`.
- **Thread management**: threads list under the project in the rail next
  to channels, "New thread" action, hover-delete on rows, delete from the
  threads modal and the open thread panel, `?thread=` deep links.
- **Composer slash commands**: `/thread`, `/channel`, `/review`,
  `/overview`, `/commits`, `/issues`, `/pulls`, `/ideas`, `/settings`,
  plus the existing message actions.
- **Reviews as the agent surface**: `agent_reviews.scenes` jsonb
  (migration 0033) — agents attach Excalidraw-shaped scene JSON on
  `submit_review`; review cards render diagrams via the shared
  `SceneView`. `?briefs=1` deep links redirect to the review queue;
  BriefsPanel removed (SceneView/SceneEditor stay as the shared renderer
  for reviews and ideas).
- **Context rail rework**: collapsible persisted sections (Development,
  issues, PRs, reviews, commits, members, agents, todos), 3-item caps with
  "All →" links, compact cards, Ideas moved to left nav.
- **In-app commit detail**: `GET /api/projects/:id/github/commit` —
  message, stats, files, checks. Clicking a commit anywhere (rail, git
  log, calendar, timeline, PR detail) opens `CommitModal` instead of
  github.com.
- **Markdown rendering**: GitHub bodies (README, issue, PR) render through
  the Markdown component with `allowHtml` — sanitised inline HTML.
- **Workspace "Pull requests" page** (`/app/pulls`): every linked repo's
  open PRs grouped by project, searchable, live-refreshed on `issue.*`
  events; rows deep-link `?pr=owner/name:number` into the project pulls
  view.
- **PR write actions in-app**: merge (merge|squash|rebase), close/reopen
  (`POST .../pull/state`, mirrored issue updated eagerly), submit review
  (`POST .../pull/review` — APPROVE / REQUEST_CHANGES / COMMENT).
- **CI/CD surface**: `GET .../github/actions` + `POST .../actions/rerun`;
  Actions section per repo in the Development panel with live status;
  `check_run`/`check_suite`/`workflow_run` webhooks republish as
  `github.ci` SSE frames so run lists and PR checks repaint live.
  Manifest now requests `actions:write` + `checks:read` (existing
  installations need the permission update approved on GitHub).
- **Inbox**: kind chips (all/unread/mentions/reviews/threads/issues/
  channels), project filter, search.
- **Home/Overview/Calendar/Timeline**: 5-item caps, responsive grid,
  searchable project picker, calendar search + kind toggles + grouped day
  detail, cross-project timeline feed.

## Phase 24 — agent GitHub write surface & inbound hooks ☑

- **MCP GitHub write tools**: `github_create_issue`, `github_create_pr`,
  `github_comment` (issues and PRs share the comments API),
  `github_merge_pr`, `github_review_pr`, `github_pr_state`,
  `github_ci_runs`, `github_rerun` — agents gain the same in-app GitHub
  powers users just got, gated by `issue:write`/`issue:read` scopes.
- **Create issues & PRs from the app**: `POST
  /api/projects/:id/github/issues` and `.../github/pulls` create on
  GitHub and mirror back onto the board immediately
  (`MirrorIssue`/`MirrorPR`/`SyncMirroredIssue`);
  `.../github/issues/comments` comments on issues and PRs alike —
  plain PR comments land on the review thread without leaving Relay.
  Dev panel + pulls list got the create modals.
- **Inbound channel webhooks**: `POST /api/hooks/:token` posts a message
  into a channel — the generic integration point for CI alerts, deploy
  bots, external services. `inbound_hooks` table (migration 0034), token
  sha256-stored, 30/min per-token limit, 64KiB cap, rotate/disable/delete
  management API + UI under project webhooks.
- **Fix**: `handlePullState`/`handlePullMerge` publish `issue.updated` so
  mirrored lists repaint without a manual refetch.
- **Workspace pulls**: bounded-concurrency repo fan-out + 60s cache —
  matches the dev panel's cache contract.

## Phase 25 — platform liveness ◐

- **Typing indicators**: shipped — ephemeral `typing` SSE events (no DB),
  3s composer throttle, 4s display expiry, self-events ignored. Agent
  `typing` MCP tool still open.
- **Presence**: who is online/viewing a channel — a periodic heartbeat via
  the existing SSE connection; rail member list greys offline.
- ~~**Unread per channel/thread**~~ — already shipped earlier: per-channel
  badges live in the rail via `useUnreadConversations`.
- **Draft attachment preservation**: shipped — upload-on-stage, ids +
  metadata persist in localStorage, stubs restore server-URL previews
  across reloads. Orphan sweep below.
- **Palette breadth**: shipped — ⌘K indexes channels, threads and
  mirrored GitHub issues/PRs; PR results deep-link into
  `?view=pulls&pr=repo:number`.
- **Janitor**: periodic sweeper (boot + every 10min) deletes expired
  threads and orphaned staged attachments (row + storage object) —
  replaces reliance on the listThreads lazy sweep.

## Phase 26 — desktop & mobile parity ◐

- **Linux tray**: shipped — `tray_linux.go` speaks StatusNotifierItem over
  D-Bus via fyne/systray (pure Go, already an indirect dep). KDE/wlroots
  render natively; GNOME needs an AppIndicator extension, otherwise the
  icon silently never appears. macOS keeps dock conventions.
- **Fullscreen/kiosk + always-on-top toggles** for the desktop shell
  (requested in the activity feed).
- **Mobile parity**: audited — the Expo app is a WebView shell around the
  SPA, so pulls/reviews/hooks/typing/search all inherit automatically.
  `deepLinkPath` already allows `/app/*`; share intent + notification
  bridge work. Remaining: gesture-path polish (long-press toolbars).
- **Deep links**: verified — `deepLinkRoute` allows `/app/**` including
  `/app/pulls`, `?pr=` and `?thread=` params ride along in the query.
- **GitHub deploy/release events**: `deployment_status` + `release`
  webhooks now republish as `github.ci`; manifest requests
  `deployments:read`. Pulls page refetches on `github.ci`; `/allpulls`
  slash command jumps to the workspace pulls page; review links to
  GitHub PRs route in-app.

## Phase 27 — integrations beyond GitHub ☐

- **GitLab/Bitbucket**: add a `provider` column on `repositories` and a
  provider interface beside `github.Client` — repo link, issue/PR mirror,
  dev panel, actions surface all generalise. Real work; GitHub stays the
  reference implementation.
- **Inbound webhook catalog widening**: message-posting hooks (P24) cover
  CI bots; consider a generic JSON-mapping profile (path → field) so
  non-Relay-shaped payloads (Alertmanager, Grafana, Uptime Kuma) ingest
  without a shim.
- **Outbound webhook events**: add `github.ci`, `thread.*`, `channel.*`,
  `idea.*` to the server-side catalog.
- **Slack/Discord import**: last resort — outbound webhooks + inbound
  hooks already bridge most workflows.

## Phase 28 — agent autonomy ☐

- **Review ↔ PR linkage**: reviews carry an optional `github_pr` ref;
  approving in Relay can submit the matching GitHub review, closing the
  agent-workflow loop (Relay verdict → GitHub review state).
- **Agent CI loop**: `github.ci` events reach agents through MCP polling
  or a subscribe tool — "my PR's checks went red" becomes actionable
  without a human relay.
- **Agent-initiated threads/channels**: `create_thread` exists; add
  `create_channel` + scoped `channel:write` permission.
- **Work journal**: agents append to a per-project log (built on todos +
  reviews) so "what did the agent do overnight" answers itself.
- **Multi-agent routing**: `@agent` mentions exist; add per-channel default
  agent + mention-targeted wake so the right agent picks up work.

## Post-1.0 ideas (not committed)

- Relay Cloud (hosted offering) - self-hosting stays first-class
- iOS build of the mobile app
- Multiple simultaneous server connections per client (per-server
  sessions, unified rail, merged notifications)
- In-app auto-update progress UI (plumbing shipped; polish pending)
- Play Store distribution (EAS submit, store listing); CI APK is already
  signed via `apps/mobile/plugins/withReleaseSigning.js`
- DragonflyDB cache layer if hot paths need it
- True `DELETE /conversations/:id` for threads (today: expire-now;
  the janitor sweeps expired rows on a 10-minute cycle)
