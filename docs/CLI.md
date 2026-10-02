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

The token's project grants and scopes apply exactly as they do over MCP —
a token with `issue:read` on project A cannot write todos on project B.

## Commands

```
relay-cli projects                              # list granted projects
relay-cli messages <project_id> [--limit 30]    # read the project thread
relay-cli say <project_id> "text"               # post a message

relay-cli issues <project_id>                   # list issues
relay-cli issue <issue_id>                      # issue detail
relay-cli issue-new <project_id> "title" ["description"]
relay-cli issue-set <issue_id> status=done priority=high

relay-cli todos <project_id>                    # work list
relay-cli todo-add <project_id> "what remains" [--issue <id>]
relay-cli todo-done <todo_id>                   # mark done
relay-cli todo-undo <todo_id>                   # reopen
relay-cli todo-del <todo_id>

relay-cli gh issues|prs <project_id>            # GitHub lists
relay-cli gh issue|pr <project_id> <number>     # GitHub detail

relay-cli search <project_id> "query"           # message search
relay-cli attachment <id>                       # print presigned URL
relay-cli attachment <id> --out shot.png        # download
```

Output is pretty-printed JSON — pipe to `jq` freely.

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
