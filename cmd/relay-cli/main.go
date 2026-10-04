// relay-cli is a single-binary client for Relay's MCP endpoint. It exists
// for both humans (readable lists by default) and agents (--json emits the
// exact tool payloads). Auth: RELAY_TOKEN (an rly_ token) + RELAY_URL.
//
// Usage:
//
//	relay-cli projects
//	relay-cli conversations <project_id>
//	relay-cli messages <project_id|conversation_id> [--conv <id>] [--limit 30]
//	relay-cli read <message_id>        (also marks the message read)
//	relay-cli say <project_id> "text" [--reply <message_id>]
//	relay-cli react <message_id> <emoji>
//	relay-cli msg-edit <message_id> "new text"
//	relay-cli msg-del <message_id>
//	relay-cli pin|unpin <message_id>
//	relay-cli pins <project_id|conversation_id>
//	relay-cli forward <message_id> <project_id>
//	relay-cli thread <message_id> [--title t]
//	relay-cli avatar <file-or-https-url>
//	relay-cli redeem <rli_…> [--name x] [--mode notify]
//	relay-cli issues <project_id>
//	relay-cli issue <issue_id>
//	relay-cli issue-new <project_id> "title" ["description"]
//	relay-cli issue-set <issue_id> status=done|priority=high
//	relay-cli todos <project_id>
//	relay-cli todo-add <project_id> "what remains"
//	relay-cli todo-done <todo_id> | todo-undo <todo_id> | todo-del <todo_id>
//	relay-cli files <project_id> [prefix]
//	relay-cli file-read <project_id> <path> [--repo owner/name]
//	relay-cli gh issues|prs <project_id>
//	relay-cli gh issue|pr <project_id> <number>
//	relay-cli search <project_id> "query"
//	relay-cli reviews <project_id> [--status pending]
//	relay-cli review <review_id>
//	relay-cli review-submit <project_id> --file review.json (or - for stdin)
//	relay-cli review-await <review_id> [--timeout 60]
//	relay-cli attachment <id> [--out file]
//	relay-cli completion bash|zsh|fish
//
// Global flags: --url, --token, --json (raw tool payloads), --limit, --out,
// --file, --status, --timeout, --reply, --conv, --repo
package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

var (
	flagURL     = flag.String("url", envOr("RELAY_URL", "http://localhost:8080"), "Relay base URL")
	flagToken   = flag.String("token", os.Getenv("RELAY_TOKEN"), "rly_ agent token")
	flagJSON    = flag.Bool("json", false, "raw JSON output")
	flagOut     = flag.String("out", "", "attachment output file")
	flagLimit   = flag.Int("limit", 30, "message/issue list size")
	flagFile    = flag.String("file", "", "review payload JSON file (- for stdin)")
	flagStatus  = flag.String("status", "", "review status filter")
	flagTimeout = flag.Int("timeout", 60, "review wait timeout in seconds")
	flagReply   = flag.String("reply", "", "message id this send replies to")
	flagTags    = flag.String("tags", "", "comma-separated message tags (say/messages)")
	flagConv    = flag.String("conv", "", "conversation id (for messages/read in a specific thread)")
	flagName    = flag.String("name", "", "agent name (redeem)")
	flagTitle   = flag.String("title", "", "thread title (thread)")
	flagMode    = flag.String("mode", "notify", "review mode for redeem: notify|gate")
)

var rpcID atomic.Int64

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func fail(args ...any) {
	fmt.Fprintln(os.Stderr, args...)
	os.Exit(1)
}

// --- MCP transport (streamable HTTP, minimal) ---

type rpcResult struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type session struct {
	hc     *http.Client
	sessID string
	relays string
	token  string
}

func (s *session) call(method string, params any) (json.RawMessage, error) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": rpcID.Add(1), "method": method, "params": params,
	})
	req, err := http.NewRequest("POST", s.relays+"/mcp", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}
	if s.sessID != "" {
		req.Header.Set("Mcp-Session-Id", s.sessID)
	}
	res, err := s.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if id := res.Header.Get("Mcp-Session-Id"); id != "" {
		s.sessID = id
	}
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	// streamable HTTP may answer SSE; fall back to the last data: line
	if ct := res.Header.Get("Content-Type"); strings.HasPrefix(ct, "text/event-stream") {
		var last string
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "data:") {
				last = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			}
		}
		if last == "" {
			return nil, fmt.Errorf("empty SSE response")
		}
		raw = []byte(last)
	}
	var r rpcResult
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("bad reply: %s", truncate(string(raw), 300))
	}
	if r.Error != nil {
		return nil, fmt.Errorf("rpc %d: %s", r.Error.Code, r.Error.Message)
	}
	return r.Result, nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// toolResult unwraps a tools/call result into structuredContent or text.
type toolResult struct {
	Content []struct {
		Text string `json:"text"`
	} `json:"content"`
	StructuredContent json.RawMessage `json:"structuredContent"`
	IsError           bool            `json:"isError"`
}

func (s *session) tool(name string, args map[string]any) (json.RawMessage, error) {
	raw, err := s.call("tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return nil, err
	}
	var tr toolResult
	if err := json.Unmarshal(raw, &tr); err != nil {
		return nil, err
	}
	if tr.IsError {
		msg := "tool error"
		if len(tr.Content) > 0 {
			msg = tr.Content[0].Text
		}
		return nil, fmt.Errorf("%s", msg)
	}
	if len(tr.StructuredContent) > 0 {
		return tr.StructuredContent, nil
	}
	if len(tr.Content) > 0 {
		return json.RawMessage(tr.Content[0].Text), nil
	}
	return json.RawMessage("null"), nil
}

func connect() *session {
	s := &session{hc: &http.Client{Timeout: 90 * time.Second}, relays: strings.TrimRight(*flagURL, "/"), token: *flagToken}
	_, err := s.call("initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "relay-cli", "version": "0.2.0"},
	})
	if err != nil {
		fail("initialize failed:", err)
	}
	// announce readiness (stateless servers ignore it if unsupported)
	_, _ = s.call("notifications/initialized", nil)
	return s
}

func emit(v json.RawMessage) {
	var buf bytes.Buffer
	if err := json.Indent(&buf, v, "", "  "); err != nil {
		fmt.Println(string(v))
		return
	}
	fmt.Println(buf.String())
}

// --- human rendering ---

type anyMap map[string]any

func str(m anyMap, k string) string {
	if s, ok := m[k].(string); ok {
		return s
	}
	return ""
}

func list(m anyMap, k string) []any {
	if l, ok := m[k].([]any); ok {
		return l
	}
	return nil
}

func asMap(v any) anyMap {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

func num(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return 0
}

// fmtTime trims an RFC3339 stamp to HH:MM for display.
func fmtTime(v any) string {
	s, _ := v.(string)
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.Local().Format("2006-01-02 15:04")
	}
	return s
}

// render prints tool payloads human-readably; unknown shapes fall through to
// JSON. Kept small — one renderer per command family.
func render(kind string, raw json.RawMessage) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		emit(raw)
		return
	}
	top := asMap(v)
	// tools return either {"items":[...]} or a bare array — normalize
	rows := func(key string) []any {
		if arr, ok := v.([]any); ok {
			return arr
		}
		return list(top, key)
	}
	switch kind {
	case "projects":
		for _, p := range rows("projects") {
			m := asMap(p)
			fmt.Printf("%-8s %-24s %s\n", str(m, "key"), str(m, "name"), str(m, "id"))
		}
	case "conversations":
		for _, c := range rows("conversations") {
			m := asMap(c)
			fmt.Printf("%s  %s\n", str(m, "id"), str(m, "kind"))
		}
	case "messages":
		msgs := rows("messages")
		for i := len(msgs) - 1; i >= 0; i-- { // newest last, like the app
			m := asMap(msgs[i])
			author := asMap(m["author"])
			name := str(author, "name")
			if str(author, "kind") == "agent" {
				name += "·agent"
			}
			if p := asMap(m["parent"]); p != nil {
				fmt.Printf("  %s\n  └ reply to %s: %s\n", str(p, "id"),
					str(p, "author"), truncate(str(p, "preview"), 60))
			}
			atts := len(list(asMap(m), "attachments"))
			suffix := ""
			if atts > 0 {
				suffix = fmt.Sprintf("  [%d attachment(s)]", atts)
			}
			if m["pinned_at"] != nil {
				suffix += "  [pinned]"
			}
			if f := asMap(m["forwarded"]); f != nil {
				suffix += "  [fwd from " + str(f, "author") + "]"
			}
			for _, t := range list(m, "tags") {
				suffix += fmt.Sprintf("  #%v", t)
			}
			fmt.Printf("%s %s  %s\n%s%s\n\n", str(m, "id"), name,
				fmtTime(m["created_at"]), str(m, "body"), suffix)
		}
	case "issues":
		for _, i := range rows("issues") {
			m := asMap(i)
			fmt.Printf("%-9s %-9s %-6s %s\n",
				str(m, "key"), str(m, "status"), str(m, "priority"), str(m, "title"))
		}
	case "todos":
		for _, t := range rows("todos") {
			m := asMap(t)
			mark := " "
			switch str(m, "status") {
			case "in_progress":
				mark = "~"
			case "done":
				mark = "x"
			}
			fmt.Printf("[%s] %s  %s\n", mark, str(m, "content"), str(m, "id"))
		}
	case "briefs":
		if p := str(top, "policy"); p != "" {
			fmt.Printf("policy: %s\n", p)
		}
		for _, b := range rows("briefs") {
			m := asMap(b)
			key := str(m, "issue_key")
			if key != "" {
				key = "  " + key
			}
			fmt.Printf("%-9s %-40s%s  %s\n",
				str(m, "status"), str(m, "title"), key, str(m, "id"))
		}
	case "reviews":
		for _, r := range rows("reviews") {
			m := asMap(r)
			fmt.Printf("%s  %-9s %s\n", str(m, "id"), str(m, "status"), str(m, "summary"))
		}
	case "files":
		for _, e := range rows("entries") {
			m := asMap(e)
			kind := "f"
			if m["dir"] == true {
				kind = "d"
			}
			fmt.Printf("%s %s\n", kind, str(m, "path"))
		}
	case "gh":
		for _, it := range rows("issues") {
			m := asMap(it)
			fmt.Printf("%-6s %-8s %s\n", "#"+fmt.Sprint(num(m["number"])),
				str(m, "state"), str(m, "title"))
		}
	default:
		emit(raw)
	}
}

func out(kind string, raw json.RawMessage) {
	if *flagJSON {
		emit(raw)
		return
	}
	render(kind, raw)
}

func main() {
	flag.Usage = func() {
		_, _ = fmt.Fprintf(flag.CommandLine.Output(), `relay-cli — Relay for agents and humans, via MCP.

Usage: relay-cli [--url URL] [--token rly_...] [--json] <command> [args] [flags]

Chat
  projects                              list granted projects
  conversations <project_id>            list conversations
  messages <project_id|conversation_id> list messages (use --conv for a thread, --tags t to filter)
  read <project_id|conversation_id>     mark-read alias for messages
  say <project_id> <body> [--reply id] [--tags a,b]  post a message (mentions: @user, KEY-1, repo#42)
  react <message_id> <emoji>            toggle a reaction
  msg-edit <message_id> <body>          edit an unread agent message
  msg-del <message_id>                  delete an own unread message
  pin|unpin <message_id>                pin or unpin a message
  pins <project_id|conversation_id>     list pinned messages
  forward <message_id> <project_id>     forward a message into another project
  thread <message_id> [title]           open (or get) the thread on a message
  avatar <file|url>                     set this agent's profile picture

Work
  issues <project_id>                   list issues
  issue <issue_id>                      show one issue
  issue-new <project_id> <title>        create an issue
  issue-set <issue_id> --status S       update an issue
  todos <project_id>                    list todos
  todo-add <project_id> <text>          add a todo
  todo-done|todo-undo|todo-del <id>     update todos
  todo-set <id> <status>                set status (todo|in_progress|done)
  todo-sync <project_id> --file list.json   mirror your whole task list in one call
  work-start <project_id> <title>       status message + progress thread
  work-stop <status_msg_id> [summary]   close the work status
  ask <message_id> <user> <question>    ask a person (thread + @mention)
  resolve <question_msg_id> [note]      mark a question answered
  events                                stream live events for your grants (Ctrl+C to stop)

Files & attachments
  files <project_id> [path]             list the linked folder
  file-read <project_id> <path>         read a text file
  attachment <id> [--out file]          attachment metadata + download

GitHub
  gh issues|prs <project_id>            list GitHub issues / PRs
  gh issue|pr <project_id> <number>     show one

Reviews
  reviews <project_id> [--status S]     list work reviews
  review <review_id>                    show a review
  review-submit <project_id> --file f.json   submit a structured review
  review-await <review_id> [--timeout n]     block for a verdict

Briefs (visual explanations)
  briefs <project_id> [issue_id]        list briefs + policy
  brief <brief_id>                      show a brief incl. scene JSON
  brief-new <project_id> <title> --file scene.json   create a brief
  brief-set <brief_id> [--status S] [--file patch]   update a brief
  brief-policy <project_id>             show the project's brief policy

  search <project_id> <query>           substring search over messages
  redeem <rli_...> [--name n] [--mode]  exchange an invite for an rly_ token
  completion bash|zsh|fish              print a shell completion script

Environment: RELAY_URL, RELAY_TOKEN.
`)
		flag.PrintDefaults()
	}
	flag.Parse()
	args := flag.Args()
	// Go's flag stops at the first positional, but usage documents flags
	// after commands (`messages $P --limit 5`). Re-parse the tail: tokens
	// starting with "-" go through the flagset, the rest stay positional.
	var pos []string
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "-") || args[i] == "-" {
			pos = append(pos, args[i])
			continue
		}
		end := i + 1
		if !strings.Contains(args[i], "=") && end < len(args) {
			name := strings.TrimLeft(strings.SplitN(args[i], "=", 2)[0], "-")
			if f := flag.CommandLine.Lookup(name); f != nil {
				if bf, ok := f.Value.(interface{ IsBoolFlag() bool }); !ok || !bf.IsBoolFlag() {
					end++ // non-bool flag takes the next token as its value
				}
			}
		}
		if err := flag.CommandLine.Parse(args[i:end]); err != nil {
			fail(err)
		}
		i = end - 1
	}
	args = pos
	if len(args) == 0 {
		flag.Usage()
		os.Exit(2)
	}
	if args[0] == "completion" {
		shell := need(args, 1, "bash|zsh|fish")
		fmt.Print(completionScript(shell))
		return
	}
	if args[0] == "redeem" {
		redeemInvite(args)
		return
	}
	s := connect()

	run := func(kind, name string, a map[string]any) {
		res, err := s.tool(name, a)
		if err != nil {
			fail(err)
		}
		out(kind, res)
	}

	switch args[0] {
	case "projects":
		run("projects", "list_projects", nil)

	case "conversations":
		run("conversations", "list_conversations",
			map[string]any{"project_id": need(args, 1, "project_id")})

	case "messages":
		pid := need(args, 1, "project_id or conversation_id")
		a := map[string]any{"limit": *flagLimit}
		if *flagConv != "" {
			a["conversation_id"] = *flagConv
		} else {
			a["project_id"] = pid
		}
		if *flagTags != "" {
			a["tag"] = *flagTags
		}
		run("messages", "get_messages", a)

	case "read":
		id := need(args, 1, "message_id")
		run("", "get_message", map[string]any{"message_id": id})
		_, _ = s.tool("mark_message_read", map[string]any{"message_id": id})

	case "say":
		pid := need(args, 1, "project_id")
		text := need(args, 2, "message text")
		a := map[string]any{"project_id": pid, "body": text}
		if *flagReply != "" {
			a["reply_to"] = *flagReply
		}
		if *flagTags != "" {
			a["tags"] = *flagTags
		}
		run("", "send_message", a)

	case "react":
		run("", "react_to_message", map[string]any{
			"message_id": need(args, 1, "message_id"),
			"emoji":      need(args, 2, "emoji"),
		})

	case "msg-edit":
		run("", "edit_message", map[string]any{
			"message_id": need(args, 1, "message_id"),
			"body":       need(args, 2, "new body"),
		})

	case "msg-del":
		run("", "delete_message", map[string]any{
			"message_id": need(args, 1, "message_id"),
		})

	case "pin", "unpin":
		run("", "pin_message", map[string]any{
			"message_id": need(args, 1, "message_id"),
			"pinned":     args[0] == "pin",
		})

	case "pins":
		run("messages", "list_pins",
			map[string]any{"project_id": need(args, 1, "project_id or conversation_id")})

	case "forward":
		run("", "forward_message", map[string]any{
			"message_id": need(args, 1, "message_id"),
			"project_id": need(args, 2, "target project_id"),
		})

	case "thread":
		a := map[string]any{"message_id": need(args, 1, "message_id")}
		if *flagTitle != "" {
			a["title"] = *flagTitle
		} else if len(args) > 2 {
			a["title"] = args[2]
		}
		run("", "create_thread", a)

	case "avatar":
		// avatar <file|url> — files go up base64-encoded; http(s) URLs are
		// fetched and stored server-side
		src := need(args, 1, "image file or url")
		if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
			run("", "set_avatar", map[string]any{"image_url": src})
			break
		}
		raw, err := os.ReadFile(src)
		if err != nil {
			fail(err)
		}
		run("", "set_avatar", map[string]any{
			"image_base64": base64.StdEncoding.EncodeToString(raw),
		})

	case "issues":
		run("issues", "list_issues",
			map[string]any{"project_id": need(args, 1, "project_id")})

	case "issue":
		run("", "get_issue", map[string]any{"issue_id": need(args, 1, "issue_id")})

	case "issue-new":
		pid := need(args, 1, "project_id")
		title := need(args, 2, "title")
		a := map[string]any{"project_id": pid, "title": title}
		if len(args) > 3 {
			a["description"] = args[3]
		}
		run("", "create_issue", a)

	case "issue-set":
		id := need(args, 1, "issue_id")
		a := map[string]any{"issue_id": id}
		for _, kv := range args[2:] {
			k, v, ok := strings.Cut(kv, "=")
			if !ok {
				fail("expected key=value, got:", kv)
			}
			a[k] = v
		}
		run("", "update_issue", a)

	case "todos":
		run("todos", "todo_list",
			map[string]any{"project_id": need(args, 1, "project_id")})

	case "todo-add":
		run("", "todo_add", map[string]any{
			"project_id": need(args, 1, "project_id"),
			"content":    need(args, 2, "content"),
		})

	case "todo-done", "todo-undo":
		run("", "todo_update", map[string]any{
			"todo_id": need(args, 1, "todo_id"),
			"done":    args[0] == "todo-done",
		})

	case "todo-del":
		run("", "todo_delete", map[string]any{"todo_id": need(args, 1, "todo_id")})

	case "todo-set":
		// todo-set <todo_id> <status> — todo|in_progress|done
		run("", "todo_update", map[string]any{
			"todo_id": need(args, 1, "todo_id"),
			"status":  need(args, 2, "status (todo|in_progress|done)"),
		})

	case "todo-sync":
		// todo-sync <project_id> --file list.json | --file -
		// Mirrors the whole harness task list in one call:
		// [{id?, content, status?, issue_id?}] — echoed ids keep rows stable.
		pid := need(args, 1, "project_id")
		var raw []byte
		var err error
		switch {
		case *flagFile == "-":
			raw, err = io.ReadAll(os.Stdin)
		case *flagFile != "":
			raw, err = os.ReadFile(*flagFile)
		default:
			fail("todo-sync needs --file list.json or --file - for stdin")
		}
		if err != nil {
			fail(err)
		}
		var items []any
		if err := json.Unmarshal(raw, &items); err != nil {
			fail("bad todo JSON:", err)
		}
		run("", "todo_sync", map[string]any{"project_id": pid, "items": items})

	case "work-start":
		// work-start <project_id> <title> — status message + progress thread
		run("", "work_start", map[string]any{
			"project_id": need(args, 1, "project_id"),
			"title":      need(args, 2, "title"),
		})

	case "work-stop":
		// work-stop <status_message_id> [summary]
		a := map[string]any{"message_id": need(args, 1, "status message id")}
		if len(args) > 2 {
			a["summary"] = args[2]
		}
		run("", "work_stop", a)

	case "ask":
		// ask <message_id> <user> <question> — thread + @mention
		run("", "request_input", map[string]any{
			"message_id": need(args, 1, "message_id"),
			"user":       need(args, 2, "user"),
			"question":   need(args, 3, "question"),
		})

	case "resolve":
		// resolve <question_message_id> [note] — clears needs-input
		a := map[string]any{"message_id": need(args, 1, "question message id")}
		if len(args) > 2 {
			a["note"] = args[2]
		}
		run("", "resolve_input", a)

	case "events":
		streamEvents(s)

	case "search":
		run("", "search_messages", map[string]any{
			"project_id": need(args, 1, "project_id"),
			"query":      need(args, 2, "query"),
		})

	case "files":
		a := map[string]any{"project_id": need(args, 1, "project_id")}
		if len(args) > 2 {
			a["path"] = args[2]
		}
		run("files", "list_project_files", a)

	case "file-read":
		a := map[string]any{
			"project_id": need(args, 1, "project_id"),
			"path":       need(args, 2, "path"),
		}
		res, err := s.tool("read_project_file", a)
		if err != nil {
			fail(err)
		}
		var m anyMap
		if err := json.Unmarshal(res, &m); err == nil && !*flagJSON {
			if c := str(m, "content"); c != "" {
				fmt.Print(c)
				if !strings.HasSuffix(c, "\n") {
					fmt.Println()
				}
				return
			}
		}
		emit(res)

	case "gh":
		sub := need(args, 1, "issues|prs|issue|pr")
		pid := need(args, 2, "project_id")
		var name string
		a := map[string]any{"project_id": pid}
		switch sub {
		case "issues":
			name = "github_list_issues"
		case "prs":
			name = "github_list_prs"
		case "issue":
			name = "github_get_issue"
			a["number"] = atoi(need(args, 3, "number"))
		case "pr":
			name = "github_get_pr"
			a["number"] = atoi(need(args, 3, "number"))
		default:
			fail("gh subcommand:", sub)
		}
		run("gh", name, a)

	case "reviews":
		a := map[string]any{"project_id": need(args, 1, "project_id")}
		if *flagStatus != "" {
			a["status"] = *flagStatus
		}
		run("reviews", "list_reviews", a)

	case "review":
		run("", "get_review", map[string]any{"review_id": need(args, 1, "review_id")})

	case "review-submit":
		// The structured payload (files/decisions/actions/…) is read as
		// JSON from --file or stdin; project_id is injected from argv.
		pid := need(args, 1, "project_id")
		var raw []byte
		var err error
		switch {
		case *flagFile == "-":
			raw, err = io.ReadAll(os.Stdin)
		case *flagFile != "":
			raw, err = os.ReadFile(*flagFile)
		default:
			fail("review-submit needs --file review.json or --file - for stdin")
		}
		if err != nil {
			fail(err)
		}
		payload := map[string]any{}
		if err := json.Unmarshal(raw, &payload); err != nil {
			fail("bad review JSON:", err)
		}
		payload["project_id"] = pid
		run("", "submit_review", payload)

	case "review-await":
		run("", "await_review", map[string]any{
			"review_id":       need(args, 1, "review_id"),
			"timeout_seconds": *flagTimeout,
		})

	case "briefs":
		// briefs <project_id> [issue_id]
		a := map[string]any{"project_id": need(args, 1, "project_id")}
		if len(args) > 2 {
			a["issue_id"] = args[2]
		}
		run("briefs", "list_briefs", a)

	case "brief":
		run("", "get_brief", map[string]any{"brief_id": need(args, 1, "brief_id")})

	case "brief-policy":
		run("", "get_brief_policy", map[string]any{"project_id": need(args, 1, "project_id")})

	case "brief-new":
		// brief-new <project_id> <title> — scene/summary JSON via --file
		pid := need(args, 1, "project_id")
		payload := map[string]any{"project_id": pid, "title": need(args, 2, "title")}
		if *flagFile != "" {
			raw, err := os.ReadFile(*flagFile)
			if err != nil {
				fail(err)
			}
			var extra map[string]any
			if err := json.Unmarshal(raw, &extra); err != nil {
				fail("bad JSON in --file:", err)
			}
			for k, v := range extra {
				payload[k] = v
			}
			if sc, ok := extra["scene"]; ok {
				b, _ := json.Marshal(sc)
				payload["scene"] = string(b)
			}
		}
		run("", "create_brief", payload)

	case "brief-set":
		// brief-set <brief_id> — fields via --status/--file
		bid := need(args, 1, "brief_id")
		payload := map[string]any{"brief_id": bid}
		if *flagStatus != "" {
			payload["status"] = *flagStatus
		}
		if *flagFile != "" {
			raw, err := os.ReadFile(*flagFile)
			if err != nil {
				fail(err)
			}
			var extra map[string]any
			if err := json.Unmarshal(raw, &extra); err != nil {
				fail("bad JSON in --file:", err)
			}
			for k, v := range extra {
				if k == "scene" {
					b, _ := json.Marshal(v)
					payload[k] = string(b)
					continue
				}
				payload[k] = v
			}
		}
		run("", "update_brief", payload)

	case "attachment":
		res, err := s.tool("get_attachment", map[string]any{"attachment_id": need(args, 1, "id")})
		if err != nil {
			fail(err)
		}
		var meta struct {
			URL string `json:"download_url"`
		}
		_ = json.Unmarshal(res, &meta)
		if meta.URL == "" {
			emit(res)
			return
		}
		if *flagOut == "" {
			fmt.Println(meta.URL)
			return
		}
		dl := meta.URL
		if strings.HasPrefix(dl, "/") {
			dl = strings.TrimRight(*flagURL, "/") + dl
		}
		req, err := http.NewRequest("GET", dl, nil)
		if err != nil {
			fail(err)
		}
		if s.token != "" {
			req.Header.Set("Authorization", "Bearer "+s.token)
		}
		resp, err := s.hc.Do(req)
		if err != nil {
			fail(err)
		}
		defer func() { _ = resp.Body.Close() }()
		f, err := os.Create(*flagOut)
		if err != nil {
			fail(err)
		}
		defer func() { _ = f.Close() }()
		if _, err := io.Copy(f, resp.Body); err != nil {
			fail(err)
		}
		fmt.Println("saved to", *flagOut)

	default:
		fail("unknown command:", args[0])
	}
}

// streamEvents tails GET /api/agent/events and prints each SSE data line —
// the agent-side half of live sync (todo.changed, message.created, …).
func streamEvents(s *session) {
	req, err := http.NewRequest("GET",
		strings.TrimRight(*flagURL, "/")+"/api/agent/events", nil)
	if err != nil {
		fail(err)
	}
	req.Header.Set("Accept", "text/event-stream")
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}
	// streams outlive the shared client's request timeout
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		fail("events:", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		fail("events:", resp.Status)
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if data, ok := strings.CutPrefix(line, "data: "); ok {
			fmt.Println(data)
		}
	}
	if err := sc.Err(); err != nil {
		fail("events stream:", err)
	}
}

// redeemInvite exchanges an rli_ invite token for a live rly_ agent token.
// Plain REST — no MCP session exists yet. Prints the token plainly so a
// script can capture it: RELAY_TOKEN=$(relay-cli redeem rli_... --name bot)
func redeemInvite(args []string) {
	tok := need(args, 1, "invite token (rli_...)")
	name := *flagName
	if name == "" && len(args) > 2 {
		name = args[2]
	}
	if name == "" {
		name = "cli-agent"
	}
	body, _ := json.Marshal(map[string]any{
		"token": tok, "name": name, "review_mode": *flagMode,
	})
	res, err := http.Post(
		strings.TrimRight(*flagURL, "/")+"/api/agent-invites/redeem",
		"application/json", bytes.NewReader(body))
	if err != nil {
		fail("redeem:", err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	var out anyMap
	if err := json.Unmarshal(raw, &out); err != nil {
		fail("bad reply:", truncate(string(raw), 300))
	}
	if res.StatusCode >= 300 {
		msg := str(asMap(out["error"]), "message")
		if msg == "" {
			msg = truncate(string(raw), 200)
		}
		fail("redeem failed:", res.Status, "-", msg)
	}
	if *flagJSON {
		emit(raw)
		return
	}
	token := str(out, "token")
	agent := asMap(out["agent"])
	if token == "" {
		emit(raw)
		return
	}
	fmt.Fprintf(os.Stderr, "registered %s (%s) — export this token:\n",
		str(agent, "name"), str(agent, "id"))
	fmt.Println(token)
}

func need(args []string, i int, what string) string {
	if i >= len(args) || args[i] == "" {
		fail("missing argument:", what)
	}
	return args[i]
}

func atoi(s string) int {
	var n int
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
		fail("bad number:", s)
	}
	return n
}

func completionScript(shell string) string {
	cmds := "projects conversations messages read say react msg-edit msg-del " +
		"pin unpin pins forward thread avatar issues " +
		"issue issue-new issue-set todos todo-add todo-done todo-undo todo-del " +
		"todo-set todo-sync work-start work-stop ask resolve events " +
		"search files file-read gh reviews review review-submit review-await " +
		"briefs brief brief-new brief-set brief-policy attachment redeem completion"
	switch shell {
	case "bash":
		return "# relay-cli bash completion\n_relay_cli() {\n" +
			"  COMPREPLY=($(compgen -W \"" + cmds + "\" -- \"${COMP_WORDS[1]}\"))\n" +
			"}\ncomplete -F _relay_cli relay-cli\n"
	case "zsh":
		return "#compdef relay-cli\n_relay_cli() {\n  _arguments '1:command:(" + cmds + ")'\n}\ncompdef _relay_cli relay-cli\n"
	case "fish":
		var b strings.Builder
		for _, c := range strings.Fields(cmds) {
			fmt.Fprintf(&b, "complete -c relay-cli -f -n '__fish_use_subcommand' -a %s\n", c)
		}
		return b.String()
	default:
		fail("unknown shell:", shell)
		return ""
	}
}
