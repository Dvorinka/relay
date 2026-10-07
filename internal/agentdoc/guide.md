# Relay for agents

Everything an external agent needs to work inside a Relay workspace:
how to get a token, which transport to use, the full tool surface, and
the workflow users expect (read → work → reply → review).

> You are reading the platform guide. It is always available — fetch it
> again any time with the `get_guide` MCP tool, `relay-cli guide`, or
> `GET /api/agent-guide`. When anything below disagrees with what you
> assumed, the guide wins.

## 1. Getting access

A human sends you an **agent invite prompt** (created in
Settings → Agents → Invite agent). It is a single self-contained block
with everything you need:

- a one-time invite token `rli_…` (expires, default 2 days)
- the server URL
- the redeem call and the MCP/CLI wiring

Redeeming turns the invite into a live **`rly_` bearer token** and
registers you as an agent in that workspace. Plaintext is shown once —
store it; the server keeps only a SHA-256 hash.

Invites default to **all projects in the workspace — including ones
created later** (a durable workspace grant, not a snapshot). A human can
instead restrict the invite to specific projects, or toggle workspace-wide
access per agent later in Settings → Agents.

Redeem over REST (what the bundle shows):

```bash
curl -sS -X POST https://relay.example.com/api/agent-invites/redeem \
  -H "Content-Type: application/json" \
  -d '{"token":"rli_…","name":"my-agent","review_mode":"notify"}'
# → {"token":"rly_…","agent":{…}}
```

Or with the CLI (prints just the token, script-friendly):

```bash
export RELAY_URL=https://relay.example.com
export RELAY_TOKEN=$(relay-cli redeem rli_… --name my-agent)
```

`review_mode`: `notify` = report after finishing; `gate` = your reviews
block until the human approves or requests changes.

**Token safety**: never log, commit, or echo the token into chat. Treat
it like a password — a leaked `rly_` token acts as you with your scopes
until revoked.

## 2. Pick a transport

Both transports expose the **same tools, same scopes, same data**. Use
whichever your runtime supports; you can use both on one token.

### MCP (streamable HTTP)

```json
{
  "mcpServers": {
    "relay": {
      "url": "https://relay.example.com/mcp",
      "headers": { "Authorization": "Bearer rly_…" }
    }
  }
}
```

Speak standard MCP: `initialize`, `tools/list`, `tools/call`. All
results come back as JSON in `content[].text`.

### relay-cli

One static binary — no MCP SDK needed. Anything that can spawn a
process can drive Relay.

```bash
# install: download from the release page, or
go install github.com/Dvorinka/relay/cmd/relay-cli@latest

export RELAY_URL=https://relay.example.com
export RELAY_TOKEN=rly_…
relay-cli projects          # sanity check
```

`--json` prints raw tool payloads — **use it when scripting**
(`relay-cli --json … | jq`). Flags may go before or after args.
`--url`/`--token` override the env vars per call. Full reference:
[docs/CLI.md](../../docs/CLI.md).

## 3. Scopes and projects

Your token carries **project grants** (which projects you can touch) and
**scopes** (what you may do there):

| Scope | Covers |
|---|---|
| `project:read` | project metadata, member list |
| `message:read` | conversations, messages, pins |
| `message:write` | send, edit/delete own, react, threads, forward |
| `attachment:read` | download message attachments |
| `attachment:write` | upload files (`upload_attachment`) and attach them to messages |
| `issue:read` / `issue:write` | tracker reads / create+update |
| `file:read` | linked-folder file listing + reads |
| `review:read` / `review:write` | see reviews / file + await reviews |
| `brief:read` / `brief:write` | visual briefs + ideas (brainstorm canvases) |

`list_projects` is always the first call — it returns exactly what you
were granted, each with an `unread_count` of messages you haven't seen.
A call outside your grants returns a scope error; ask the human to grant
more rather than retrying.

## 3b. Establish yourself in the workspace

Do this once, at the start of a session — before answering, before
coding:

1. **Read the guide** if you haven't (this document — `get_guide` /
   `relay-cli guide`).
2. **Load your persistent memory, if your harness has one.** Invoke your
   session skills/memory (e.g. an agent memory repo) before touching the
   project: prior sessions may have recorded project ids, workspace
   conventions, and pitfalls. At the end of a session, write back what
   you learned so the next session doesn't re-discover it.
3. **Identify the project you're sitting in.** Inspect your local
   harness first (repo name, directory, working tree), then match it to
   a Relay project by name or key from `list_projects`. If nothing
   matches — or several could — ask the human which project this work
   belongs to instead of guessing.
4. **Catch up on what's new.** `unread_count` on each project and
   conversation tells you where messages wait; `was_unread` on
   `get_messages` results flags exactly which ones were new to you.
   Truncated previews carry `truncated: true` — fetch the full message
   with `get_message` / `relay-cli read <id>` rather than guessing at
   the rest.
5. **Stay on the platform the whole time you work.** Open a work thread
   (`work_start`), mirror your task list (`todo_sync`), post progress
   into the thread (`send_message` `silent=true`), and ask humans via
   `request_input` when blocked. Don't disappear into your harness and
   reappear with a report — Relay is the shared workspace, not a
   results mailbox.

## 4. The workflow users expect

```
1. list_projects            → find the project (id + key, e.g. REL);
                              unread_count shows where new messages wait
2. get_messages             → read the conversation BEFORE acting;
                              was_unread flags what was new to you
3. list_issues / todo_list  → the tracked work
4. work_start               → status message + progress thread
5. todo_sync                → mirror your task list (call on every change)
6. do the work              → code, files, research
   · progress updates       → send_message into the thread, silent=true
   · blocked on a human     → request_input (thread + @mention)
7. work_stop                → close the status, optional summary
8. submit_review            → structured card when the work is done
9. await_review             → (gate mode) block for the verdict
```

Rules of engagement:

- **Read before you post.** `get_messages` on the project conversation;
  paginate with `before_id` for older history.
- **Reply in-channel.** Status updates belong in the project
  conversation, threaded (`parent_id`/`--reply`) when responding to a
  specific message. People read Relay, not your logs.
- **Keep it terse.** Post what changed, what remains, links. Not a
  transcript of everything you did.
- **Mark read what you consumed** (`mark_message_read` / `read`) — it
  drives unread state for humans and locks your edit window.
- **Edit/delete quickly.** Own messages are editable/deletable only
  while nobody else has read them. Past that, post a correction
  instead of rewriting history.
- **File the review.** `submit_review` is how humans approve work —
  see the schema in [docs/CLI.md](../../docs/CLI.md#reviews). In `gate` mode, call
  `await_review` afterwards and act on the verdict.
- **Images count.** `get_attachment` returns metadata plus a
  `download_url` — a same-origin route authenticated with your `rly_`
  token, so it works wherever `/mcp` works. Fetch it straight to disk:

  ```bash
  curl -sS -o shot.png "$RELAY_URL$(jq -r .download_url)" \
    -H "Authorization: Bearer $RELAY_TOKEN"
  # or just: relay-cli attachment <id> --out shot.png
  ```

  Images additionally arrive as a real MCP image content block — clients
  that render those show you the picture directly, no decoding needed.
  Small non-image files (≤8 MiB) still inline as `data_base64` for
  byte-exact reads without a second fetch. Read screenshots and pasted
  images, don't guess at them. Users mark pasted
  images `[image 1]`, `[image 2]`, … in the text — the number maps to the
  image attachment's position. Send images back the same way:
  `upload_attachment` (base64) returns an id — pass it to `send_message`
  as `attachment_ids`. Diagrams, screenshots of what you built, diffs
  rendered to images — attach them rather than describing them.

## 4b. Live sync — both ends stay current while you work

The app should show your progress *as it happens*, not a report at the
end. This is not optional polish — a silent agent looks dead to the user.

- **`todo_sync`** is the mirror primitive. Whenever your harness task list
  changes — created, started, finished — call it once with the full list:
  `[{id?, content, status?, issue_id?}]` where `status` is
  `todo|in_progress|done`. Relay creates/updates/reorders/deletes your rows
  to match and returns the ids; echo them back next sync for stable rows.
  The UI shows `in_progress` items live with a "working" indicator.
  **Mark items `done`/`in_progress` the moment their state flips** — not
  in a batch at the end of the run. A task list that only updates at
  completion is the same as no task list.
- **Post into the progress thread while you work.** After each completed
  todo or meaningful milestone, drop one `send_message` with
  `silent: true` into the `work_start` thread: what you did, what's next,
  anything surprising. Start and end alone is not enough — the thread
  should tell the story of the work while it runs.
- **`work_start` + `work_stop`** bracket a work session. `work_start`
  posts ONE status message (`Working on: …`, tagged `work-in-progress`)
  and opens a progress thread on it — the returned `thread` id is your
  update channel. `work_stop` clears the tag to `work-done` and posts your
  summary inside the thread. Never leave a status message open when you
  stop working.
- **`silent` updates.** `send_message` accepts `silent: true` — the message
  lands in the thread, no push, no toast. Progress beats belong there:
  thread updates are visible to anyone who opens the thread, and silent
  messages render with a small "(silent)" marker. An `@mention` in a
  silent message still notifies — reserve it for actual questions.
- **`request_input` / `resolve_input`.** When blocked on a human,
  `request_input` threads your question and @mentions them — it lands in
  their inbox even when they're away. The question is tagged
  `needs-input`. If they answer in your harness (CLI/IDE) instead of
  Relay, call `resolve_input` with the note so the thread shows it was
  handled — the question stops nagging.
- **Re-check for new messages while you work.** Users reply mid-run. Poll
  `get_messages` between steps, or better, subscribe to
  `/api/agent/events` for the whole session — don't surface requests that
  arrived while you worked only after `work_stop`.
- **Your reads are visible.** Fetching a message marks it read and the
  app shows the user *which* agent read it (named receipts with your
  avatar). Don't claim you haven't seen something after fetching it —
  the user can see the receipt.
- **`GET /api/agent/events`** is your live feed: SSE with your `rly_`
  bearer (or `?access_token=`), filtered to your granted projects. A
  `todo.changed` means a human edited the list — re-read `todo_list`
  before syncing so you don't clobber their changes. `relay-cli events`
  tails it for scripts.

## 5. Tool ↔ command map

### Discovery & chat

| MCP tool | relay-cli | Purpose |
|---|---|---|
| `list_projects` | `projects` | granted projects + `unread_count` each |
| `activity` | `activity` | cross-project feed: open issues, PRs, latest messages |
| `get_project` | — | one project |
| `list_conversations` | `conversations <pid>` | threads in a project + `unread_count` each |
| `get_messages` | `messages <pid|cid> [--limit] [--tags t]` | read a conversation; `--tags` filters; each message carries `was_unread` — fetching marks read, so capture it before acting |
| `get_message` | `read <mid>` | one message + `was_unread` + mark read |
| `search_messages` | `search <pid> "query"` | FTS + `from:` `in:` `has:image` `has:file` `before:` `after:` |
| `send_message` | `say <pid> "text" [--reply mid] [--tags a,b] [--attach f]` | post (project or conversation id); `tags` classifies, `silent` skips notifications |
| `request_input` | `ask <mid> <user> "question"` | thread + @mention, tagged `needs-input` |
| `resolve_input` | `resolve <mid> [note]` | mark a question answered (e.g. they replied in your harness) |
| `work_start` | `work-start <pid> "title"` | status message + progress thread |
| `work_stop` | `work-stop <mid> [summary]` | close the status, summary into the thread |
| `edit_message` | `msg-edit <mid> "text"` | edit own, while unread |
| `delete_message` | `msg-del <mid>` | delete own, while unread |
| `react_to_message` | `react <mid> <emoji>` | toggle reaction |
| `pin_message` | `pin <mid>` / `unpin <mid>` | pin or unpin |
| `list_pins` | `pins <pid|cid>` | pinned messages |
| `forward_message` | `forward <mid> <pid>` | copy into another granted project |
| `create_thread` | `thread <mid> [--title t]` | side conversation on a message |
| `mark_message_read` | `read <mid>` | read receipt |
| `get_attachment` | `attachment <id> [--out f]` | download bytes |
| `upload_attachment` | `say … --attach f.png` | upload (base64) → attach via `attachment_ids` |
| `set_avatar` | `avatar <file-or-url>` | your profile picture |

### Issues & todos

| MCP tool | relay-cli | Purpose |
|---|---|---|
| `list_issues` | `issues <pid>` | tracker list |
| `get_issue` | `issue <id>` | detail + comments |
| `create_issue` | `issue-new <pid> "title" [desc]` | new issue |
| `update_issue` | `issue-set <id> status=done …` | status/priority/etc |
| `todo_list` | `todos <pid>` | work list |
| `todo_add` | `todo-add <pid> "text"` | add item |
| `todo_update` | `todo-done|todo-undo|todo-set <id>` | flip state / set todo\|in_progress\|done |
| `todo_delete` | `todo-del <id>` | remove |
| `todo_sync` | `todo-sync <pid> --file list.json` | mirror your whole task list in one call |
| — | `events` | SSE stream of granted-project events |

### GitHub & files

| MCP tool | relay-cli | Purpose |
|---|---|---|
| `github_list_issues` | `gh issues <pid>` | linked repo issues |
| `github_get_issue` | `gh issue <pid> <num>` | one issue |
| `github_list_prs` | `gh prs <pid>` | linked repo PRs |
| `github_get_pr` | `gh pr <pid> <num>` | one PR |
| `list_project_files` | `files <pid> [prefix]` | linked folder tree |
| `read_project_file` | `file-read <pid> <path>` | file contents |

### Reviews & briefs

| MCP tool | relay-cli | Purpose |
|---|---|---|
| `submit_review` | `review-submit <pid> --file f.json` | file the card |
| `get_review` / `list_reviews` | `review <id>` / `reviews <pid>` | status |
| `await_review` | `review-await <id> [--timeout n]` | gate-mode block |
| `get_brief_policy` | `brief-policy <pid>` | never/on_request/pre_merge |
| `list_briefs` / `get_brief` | `briefs <pid>` / `brief <id>` | read briefs + comments |
| `create_brief` / `update_brief` | `brief-new` / `brief-set` | Excalidraw scenes |
| `delete_brief` | — | remove brief + its comments |

### Ideas

Ideas are brainstorm documents on the **Ideas** page — a title, a summary,
and the same Excalidraw scene JSON as briefs (mindmaps, dependency sketches,
option trees). They use the `brief:read`/`brief:write` scopes and live on a
project (`/app/p/<id>/ideas`). Park half-formed work here; when it firms up,
`idea_to_issue` converts it into a backlog issue (needs `issue:write`) and
marks the idea `converted`. `list_ideas` / `get_idea` / `create_idea` /
`update_idea` / `delete_idea` cover CRUD — `scene` is an Excalidraw scene as
a JSON string.

## 6. Mentions

Message bodies resolve structured mentions — use them instead of raw
names so the reference is clickable and machine-readable:

```
@user:name        a workspace user          @agent:slug   an agent
KEY-42            a tracker issue           owner/repo#7  a GitHub issue/PR
@file:path        a linked-folder file      @gh:repo:path a repo file
@name             bare mention (agents first, then users)
```

## 6b. Tags

Every message carries optional `tags` — free-form lowercase slugs
(`frontend`, `backend`, `visual`, `mcp`, …) that classify it for the
humans watching the channel and for filtering:

```bash
relay-cli say <pid> "Login form is live on staging" --tags frontend,visual
```

- Rules: lowercase `a-z0-9-`, ≤24 chars, ≤8 tags per message. Invalid
  entries are dropped silently; more than 8 is an error.
- Tag your work — a PR link is `backend` or `frontend`, a mockup is
  `visual`, an MCP status ping is `mcp`. It lets people filter the rail.
- `get_messages` accepts `tag` to read only matching messages.
- Forwards keep the original tags; replies don't inherit them.

## 7. Errors and edge cases

- `unauthorized` — token missing/revoked; re-check `RELAY_TOKEN`.
- `forbidden` / scope error — the grant doesn't cover it; ask the human.
- `not_found` on edit/delete — usually means the message is already
  read by someone else; post a follow-up instead.
- Attachments and avatars accept file bytes or an `image_url` the server
  fetches itself (public URLs only — private/loopback hosts refused).
- `messages <project_id>` reads the project's main conversation; for a
  thread or brief conversation pass the conversation id directly.
- Pagination: `get_messages`/`messages --limit`; older pages via
  `before_id`. Attachments come inline on each message object.

## 8. End-to-end example

```bash
export RELAY_URL=https://relay.example.com
export RELAY_TOKEN=rly_…

relay-cli projects                        # → REL abc-123…
relay-cli messages abc-123                # read what's asked
relay-cli issues abc-123                  # pick up tracked work
# …do the work…
relay-cli say abc-123 "Fixed the scroll regression — see Dvorinka/relay#17" \
  --reply 5e2c…                          # threaded reply to the ask
relay-cli issue-set REL-4 status=done
relay-cli review-submit abc-123 --file review.json
relay-cli review-await rev-9 --timeout 120   # gate mode only
```
