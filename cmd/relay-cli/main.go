// relay-cli is a single-binary client for Relay's MCP endpoint. It exists
// for both humans (quick navigation) and agents (the whole surface without
// an MCP SDK). Auth: RELAY_TOKEN (an rly_ token) + RELAY_URL.
//
// Usage:
//
//	relay-cli projects
//	relay-cli messages <project_id> [--limit 30]
//	relay-cli say <project_id> "text"
//	relay-cli issues <project_id>
//	relay-cli issue <project_id> <issue_id>
//	relay-cli issue-new <project_id> "title" ["description"]
//	relay-cli issue-set <issue_id> status=done|priority=high
//	relay-cli todos <project_id>
//	relay-cli todo-add <project_id> "what remains" [--issue <id>]
//	relay-cli todo-done <todo_id> | todo-undo <todo_id> | todo-del <todo_id>
//	relay-cli gh issues|prs <project_id>
//	relay-cli gh issue|pr <project_id> <number>
//	relay-cli search <project_id> "query"
//	relay-cli reviews <project_id> [--status pending]
//	relay-cli review <review_id>
//	relay-cli review-submit <project_id> --file review.json (or - for stdin)
//	relay-cli review-await <review_id> [--timeout 60]
//	relay-cli attachment <id> [--out file]  (fetches the presigned URL)
//
// Global flags: --url, --token, --json
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
)

var (
	flagURL     = flag.String("url", envOr("RELAY_URL", "http://localhost:8080"), "Relay base URL")
	flagToken   = flag.String("token", os.Getenv("RELAY_TOKEN"), "rly_ agent token")
	flagOut     = flag.String("out", "", "attachment output file")
	flagLimit   = flag.Int("limit", 30, "message/issue list size")
	flagFile    = flag.String("file", "", "review payload JSON file (- for stdin)")
	flagStatus  = flag.String("status", "", "review status filter")
	flagTimeout = flag.Int("timeout", 60, "review wait timeout in seconds")
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
	if len(s) > n {
		return s[:n] + "…"
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
	s := &session{hc: &http.Client{}, relays: strings.TrimRight(*flagURL, "/"), token: *flagToken}
	_, err := s.call("initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "relay-cli", "version": "0.1.0"},
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

func main() {
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
			end++ // non-bool flag takes the next token as its value
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
	s := connect()

	switch args[0] {
	case "projects":
		out, err := s.tool("list_projects", nil)
		if err != nil {
			fail(err)
		}
		emit(out)

	case "messages":
		pid := need(args, 1, "project_id")
		out, err := s.tool("get_messages", map[string]any{"project_id": pid, "limit": *flagLimit})
		if err != nil {
			fail(err)
		}
		emit(out)

	case "say":
		pid := need(args, 1, "project_id")
		text := need(args, 2, "message text")
		out, err := s.tool("send_message", map[string]any{"project_id": pid, "body": text})
		if err != nil {
			fail(err)
		}
		emit(out)

	case "issues":
		pid := need(args, 1, "project_id")
		out, err := s.tool("list_issues", map[string]any{"project_id": pid})
		if err != nil {
			fail(err)
		}
		emit(out)

	case "issue":
		out, err := s.tool("get_issue", map[string]any{"issue_id": need(args, 1, "issue_id")})
		if err != nil {
			fail(err)
		}
		emit(out)

	case "issue-new":
		pid := need(args, 1, "project_id")
		title := need(args, 2, "title")
		a := map[string]any{"project_id": pid, "title": title}
		if len(args) > 3 {
			a["description"] = args[3]
		}
		out, err := s.tool("create_issue", a)
		if err != nil {
			fail(err)
		}
		emit(out)

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
		out, err := s.tool("update_issue", a)
		if err != nil {
			fail(err)
		}
		emit(out)

	case "todos":
		pid := need(args, 1, "project_id")
		out, err := s.tool("todo_list", map[string]any{"project_id": pid})
		if err != nil {
			fail(err)
		}
		emit(out)

	case "todo-add":
		pid := need(args, 1, "project_id")
		text := need(args, 2, "content")
		a := map[string]any{"project_id": pid, "content": text}
		out, err := s.tool("todo_add", a)
		if err != nil {
			fail(err)
		}
		emit(out)

	case "todo-done", "todo-undo":
		out, err := s.tool("todo_update", map[string]any{
			"todo_id": need(args, 1, "todo_id"),
			"done":    args[0] == "todo-done",
		})
		if err != nil {
			fail(err)
		}
		emit(out)

	case "todo-del":
		out, err := s.tool("todo_delete", map[string]any{"todo_id": need(args, 1, "todo_id")})
		if err != nil {
			fail(err)
		}
		emit(out)

	case "search":
		pid := need(args, 1, "project_id")
		q := need(args, 2, "query")
		out, err := s.tool("search_messages", map[string]any{"project_id": pid, "query": q})
		if err != nil {
			fail(err)
		}
		emit(out)

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
		out, err := s.tool(name, a)
		if err != nil {
			fail(err)
		}
		emit(out)

	case "reviews":
		a := map[string]any{"project_id": need(args, 1, "project_id")}
		if *flagStatus != "" {
			a["status"] = *flagStatus
		}
		out, err := s.tool("list_reviews", a)
		if err != nil {
			fail(err)
		}
		emit(out)

	case "review":
		out, err := s.tool("get_review", map[string]any{"review_id": need(args, 1, "review_id")})
		if err != nil {
			fail(err)
		}
		emit(out)

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
		out, err := s.tool("submit_review", payload)
		if err != nil {
			fail(err)
		}
		emit(out)

	case "review-await":
		out, err := s.tool("await_review", map[string]any{
			"review_id":       need(args, 1, "review_id"),
			"timeout_seconds": *flagTimeout,
		})
		if err != nil {
			fail(err)
		}
		emit(out)

	case "attachment":
		out, err := s.tool("get_attachment", map[string]any{"attachment_id": need(args, 1, "id")})
		if err != nil {
			fail(err)
		}
		var meta struct {
			URL string `json:"url"`
		}
		_ = json.Unmarshal(out, &meta)
		if meta.URL == "" {
			emit(out)
			return
		}
		if *flagOut == "" {
			fmt.Println(meta.URL)
			return
		}
		res, err := http.Get(meta.URL)
		if err != nil {
			fail(err)
		}
		defer func() { _ = res.Body.Close() }()
		f, err := os.Create(*flagOut)
		if err != nil {
			fail(err)
		}
		defer func() { _ = f.Close() }()
		if _, err := io.Copy(f, res.Body); err != nil {
			fail(err)
		}
		fmt.Println("saved to", *flagOut)

	default:
		fail("unknown command:", args[0])
	}
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
