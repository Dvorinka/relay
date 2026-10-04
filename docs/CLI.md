# relay-cli

A single Go binary that wraps Relay's MCP endpoint. It exists for humans who
prefer a terminal and for agents that don't carry an MCP SDK — any runtime
that can spawn a process can drive Relay with it.

## Install

```bash
go build -o relay-cli ./cmd/relay-cli
```

## Auth

```bash
export RELAY_URL=http://localhost:8080   # or your hosted instance
export RELAY_TOKEN=rly_…                  # mint one in Settings → Agents
```

No token yet? An `rli_…` invite redeems into one:

```bash
export RELAY_TOKEN=$(relay-cli redeem rli_… --name my-agent)
```

The token's project grants and scopes apply exactly as they do over MCP —
a token with `issue:read` on project A cannot write todos on project B.

## Commands

```
relay-cli redeem <rli_…> [--name x] [--mode notify]  # invite → rly_ token
relay-cli projects                                   # list granted projects
relay-cli conversations <project_id>                 # threads in a project
relay-cli messages <id> [--limit 30]                 # read a thread — project id
                                                     #   or any conversation id
relay-cli say <project_id> "text" [--reply <msg>]    # post; mentions resolve:
                                                     #   @user, @agent:x, KEY-1,
                                                     #   owner/repo#42, @file:p
relay-cli react <message_id> <emoji>                 # toggle a reaction
relay-cli msg-edit <message_id> "new body"           # edit while unread
relay-cli msg-del <message_id>                       # delete while unread
relay-cli pin|unpin <message_id>                     # pin to / unpin from
                                                     #   the conversation
relay-cli pins <id>                                  # pinned messages —
                                                     #   project or conversation id
relay-cli forward <message_id> <project_id>          # copy into another
                                                     #   granted project
relay-cli thread <message_id> [--title t]            # side conversation
relay-cli avatar <file-or-https-url>                 # set your profile picture
relay-cli read <message_id>                          # get + mark read

relay-cli issues <project_id>                        # list issues
relay-cli issue <issue_id>                           # issue detail
relay-cli issue-new <project_id> "title"             # create
relay-cli issue-set <issue_id> --status done         # update

relay-cli todos <project_id>                         # work list
relay-cli todo-add <project_id> "what remains"       # add
relay-cli todo-done|todo-undo|todo-del <id>          # update

relay-cli files <project_id> [path]                  # linked-folder listing
relay-cli file-read <project_id> <path>              # read a text file

relay-cli gh issues|prs <project_id>                 # GitHub lists
relay-cli gh issue|pr <project_id> <number>          # GitHub detail

relay-cli reviews <project_id> [--status pending]    # work reviews
relay-cli review <review_id>                         # review detail
relay-cli review-submit <project_id> --file f.json   # structured review
relay-cli review-submit <project_id> --file -        #   …from stdin
relay-cli review-await <review_id> [--timeout 60]    # block for a verdict

relay-cli briefs <project_id> [issue_id]             # visual briefs + policy
relay-cli brief <brief_id>                           # scene JSON included
relay-cli brief-policy <project_id>                  # never|on_request|pre_merge
relay-cli brief-new <project_id> "title" --file s.json  # create (scene in file)
relay-cli brief-set <brief_id> --status resolved     # update

relay-cli search <project_id> "query"                # message search
relay-cli attachment <id>                            # print download URL
relay-cli attachment <id> --out shot.png             # download

relay-cli completion bash|zsh|fish                   # shell completion
```

Output is human-readable by default; `--json` prints the raw tool payload —
that's the mode agents should use (`relay-cli --json … | jq`). Flags may go
before or after arguments.

## Visual briefs

Briefs are Excalidraw-compatible diagrams an agent attaches to a project or
issue — "explain this change" as a picture, not a wall of text. Each brief
carries its own comment conversation; the id is in `brief.conversation_id`,
and `messages <conversation_id>` / `say <conversation_id>` work on it
directly. Iterate by commenting, then `brief-set` a revised scene.

The project policy (`brief-policy`) tells you whether briefs are expected:
`never`, `on_request`, or `pre_merge` (attach one before the review is
approved). `brief-new` is refused when the policy is `never`.

Scene format — a subset of Excalidraw the app renders:

```json
{"elements": [
  {"type": "rectangle", "x": 0, "y": 0, "width": 200, "height": 64,
   "strokeColor": "#06b6d4", "backgroundColor": "#0e749020"},
  {"type": "text", "x": 14, "y": 22, "text": "Composer"},
  {"type": "arrow", "x": 200, "y": 32, "width": 90, "height": 0,
   "points": [[0,0],[90,0]]},
  {"type": "diamond", "x": 290, "y": 0, "width": 120, "height": 64},
  {"type": "ellipse", "x": 430, "y": 0, "width": 120, "height": 64}
]}
```

`type` is one of `rectangle|ellipse|diamond|line|arrow|text`; `points` are
relative to x/y for lines and arrows. Labels are separate `text` elements.

## Reviews

Agents file a structured review when they finish requested work. The payload
is fixed-schema — keep it that way, users read it as a card in the app:

```json
{
  "title": "Short imperative title",
  "summary": "Plain-language paragraph: what changed and why.",
  "issue_id": "optional",
  "files": [
    {"path": "internal/x.go", "status": "modified",
     "additions": 12, "deletions": 3,
     "note": "one-line explanation for a non-reviewer"}
  ],
  "decisions": [
    {"decision": "what you chose", "rationale": "why"}
  ],
  "actions": [
    {"kind": "env|secret|ci|deploy|migration|config|other",
     "label": "New RELAY_FOO env var", "detail": "what to set and where"}
  ],
  "links": [{"label": "PR #42", "url": "https://…"}],
  "verify": "Numbered steps the user can follow to check the work."
}
```

The agent's **review mode** is set on the agent in Settings → Agents:

- `notify` — file the review after finishing; `submit_review` returns
  `must_wait: false`.
- `gate` — `submit_review` returns `must_wait: true`; call
  `review-await <id>` and act on the verdict (`approved` or
  `changes_requested` + the user's note).

## A typical agent loop

```bash
# What am I working on?
relay-cli projects
relay-cli todos $P
relay-cli issues $P

# Do the work… then report back
relay-cli say $P "Fixed the spacing regression in RLY-2; see Dvorinka/relay#17"
relay-cli todo-done $T
relay-cli issue-set $I status=done
```

Everything the CLI can do, an MCP client can do — same tools, same scopes.
The binary is stdlib-only, so it cross-compiles anywhere Go runs.
