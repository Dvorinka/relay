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
//	relay-cli say <project_id> "text" [--reply <message_id>] [--attach f.png] [--silent]
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
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

var (
	flagURL = flag.String("url", envOr("RELAY_URL", "http://localhost:8080"), "Relay base URL")
	// Deliberately empty default: flag.PrintDefaults echoes defaults into
	// --help, and a live rly_ token must never end up in help output,
	// transcripts, or screenshots. RELAY_TOKEN is resolved after parsing.
	flagToken   = flag.String("token", "", "rly_ agent token (default: $RELAY_TOKEN)")
	flagJSON    = flag.Bool("json", false, "raw JSON output")
	flagOut     = flag.String("out", "", "attachment output file")
	flagLimit   = flag.Int("limit", 30, "message/issue list size")
	flagFile    = flag.String("file", "", "payload file: review JSON, message body, scene JSON (- for stdin)")
	flagStatus  = flag.String("status", "", "status filter or new status (reviews, idea-set)")
	flagTimeout = flag.Int("timeout", 60, "review/await wait timeout in seconds")
	flagReply   = flag.String("reply", "", "message id this send replies to")
	flagTags    = flag.String("tags", "", "comma-separated message tags (say/messages)")
	flagConv    = flag.String("conv", "", "conversation id (only when the positional id is ambiguous)")
	flagName    = flag.String("name", "", "agent name (redeem)")
	flagTitle   = flag.String("title", "", "thread title (thread)")
	flagMode    = flag.String("mode", "notify", "review mode for redeem: notify|gate")
	flagAttach  = flag.String("attach", "", "comma-separated file paths to upload + attach (say)")
	flagSilent  = flag.Bool("silent", false, "post without notifications (say, work beats)")
	flagBefore  = flag.String("before", "", "paginate messages before this message id")
	flagBase    = flag.String("base", "", "PR base branch (gh pr-new; default: repo default)")
	flagBody    = flag.String("body", "", "body text/file target for gh commands (- for stdin)")
	flagDraft   = flag.Bool("draft", false, "open the PR as a draft (gh pr-new)")
	flagMethod  = flag.String("method", "", "merge method: merge|squash|rebase (gh merge; default: repo default)")
	flagProject = flag.String("project", "", "filter events to one project (id or key)")
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
	token := *flagToken
	if token == "" {
		token = os.Getenv("RELAY_TOKEN")
	}
	if token == "" {
		fail("RELAY_TOKEN unset — mint one in the app (agent settings) or run:",
			"  relay-cli redeem <rli_...> --name my-agent")
	}
	s := &session{hc: &http.Client{Timeout: 90 * time.Second}, relays: strings.TrimRight(*flagURL, "/"), token: token}
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

// unreadSuffix renders " (N unread)" when the row carries an unread_count.
func unreadSuffix(m anyMap) string {
	if n := num(m["unread_count"]); n > 0 {
		return fmt.Sprintf("  (%d unread)", n)
	}
	return ""
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

// negNumber reports whether s is a negative numeric literal (-5, -1.5) —
// those are legal flag values, unlike another flag's name.
func negNumber(s string) bool {
	if len(s) < 2 || s[0] != '-' {
		return false
	}
	return s[1] >= '0' && s[1] <= '9'
}

// humanSize renders a byte count for attachment listings.
func humanSize(n int) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// readArgBody resolves a text body: "-" reads stdin, --file reads a file
// (or stdin on "-"), otherwise the positional argument stands.
func readArgBody(positional string) string {
	var raw []byte
	var err error
	switch {
	case *flagFile != "":
		if *flagFile == "-" {
			raw, err = io.ReadAll(os.Stdin)
		} else {
			raw, err = os.ReadFile(*flagFile)
		}
	case positional == "-":
		raw, err = io.ReadAll(os.Stdin)
	case positional != "":
		return positional
	default:
		fail("missing body text (or pass - / --file for stdin/file)")
	}
	if err != nil {
		fail(err)
	}
	s := strings.TrimRight(string(raw), "\n")
	if strings.TrimSpace(s) == "" {
		fail("body is empty")
	}
	return s
}

// confirm prints a one-line acknowledgement for mutations instead of
// echoing the full payload back. --json still emits everything. It picks
// the few fields a follow-up command needs (ids, keys, PR numbers).
func confirm(verb string, raw json.RawMessage) {
	if *flagJSON {
		emit(raw)
		return
	}
	var m anyMap
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		fmt.Println(verb)
		return
	}
	var bits []string
	seen := map[string]bool{}
	pick := func(mm anyMap) {
		for _, k := range []string{"key", "id", "message_id", "number", "issue_number"} {
			var v string
			if s := str(mm, k); s != "" {
				v = s
			} else if n := num(mm[k]); n != 0 {
				v = fmt.Sprint(n)
			}
			if v != "" && !seen[v] {
				seen[v] = true
				bits = append(bits, v)
			}
		}
	}
	pick(m)
	for _, k := range []string{"message", "thread", "issue", "idea", "brief", "review"} {
		if sub := asMap(m[k]); sub != nil {
			before := len(bits)
			pick(sub)
			if len(bits) > before && k == "thread" {
				bits[before] = "thread " + bits[before]
			}
		}
	}
	if len(bits) == 0 {
		fmt.Println(verb)
		return
	}
	fmt.Printf("%s %s\n", verb, strings.Join(bits, " "))
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
			fmt.Printf("%-8s %-24s %s%s\n", str(m, "key"), str(m, "name"), str(m, "id"),
				unreadSuffix(m))
		}
	case "conversations":
		for _, c := range rows("conversations") {
			m := asMap(c)
			name := str(m, "name")
			if name == "" {
				// issue conversations carry the computed key + title
				name = str(m, "issue_key")
				if t := str(m, "issue_title"); name != "" && t != "" {
					name += "  " + t
				}
			}
			if name == "" {
				name = "-"
			}
			extra := unreadSuffix(m)
			if e := str(m, "expires_at"); e != "" {
				extra += "  expires " + fmtTime(e)
			}
			fmt.Printf("%s  %-9s %-28s%s\n", str(m, "id"), str(m, "kind"), name, extra)
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
				truncNote := ""
				if p["truncated"] == true {
					truncNote = " …(truncated — relay-cli read " + str(p, "id") + " for the full message)"
				}
				fmt.Printf("  %s\n  └ reply to %s: %s%s\n", str(p, "id"),
					str(p, "author"), truncate(str(p, "preview"), 60), truncNote)
			}
			suffix := ""
			if m["pinned_at"] != nil {
				suffix += "  [pinned]"
			}
			if f := asMap(m["forwarded"]); f != nil {
				suffix += "  [fwd from " + str(f, "author") + "]"
			}
			for _, t := range list(m, "tags") {
				suffix += fmt.Sprintf("  #%v", t)
			}
			if m["was_unread"] == true {
				suffix += "  [new]"
			}
			body := str(m, "body")
			if body == "" {
				body = str(m, "excerpt")
			}
			fmt.Printf("%s %s  %s\n%s%s\n", str(m, "id"), name,
				fmtTime(m["created_at"]), body, suffix)
			for _, a := range list(m, "attachments") {
				am := asMap(a)
				fmt.Printf("  └ attach %s  %s  %s\n",
					str(am, "filename"), humanSize(num(am["size_bytes"])), str(am, "id"))
			}
			fmt.Println()
		}
		if nb := str(top, "next_before"); nb != "" {
			fmt.Printf("… older — relay-cli messages <id> --before %s\n", nb)
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
	case "ideas":
		for _, i := range rows("ideas") {
			m := asMap(i)
			fmt.Printf("%-10s %-40s %s\n",
				str(m, "status"), str(m, "title"), str(m, "id"))
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
	case "ghci":
		for _, it := range rows("workflow_runs") {
			m := asMap(it)
			fmt.Printf("%-12s %-10s %-12s %-8s %s\n",
				fmt.Sprint(num(m["run_number"])), str(m, "status"),
				str(m, "conclusion"), str(m, "branch"), str(m, "name"))
		}
	case "whoami":
		ws := asMap(top["workspace"])
		fmt.Printf("%s (@%s)\n", str(top, "name"), str(top, "slug"))
		if ws != nil {
			fmt.Printf("workspace  %s (%s)\n", str(ws, "name"), str(ws, "slug"))
		}
		fmt.Printf("mode       %s\n", str(top, "review_mode"))
		for _, p := range list(top, "projects") {
			m := asMap(p)
			fmt.Printf("grant      %-8s %s\n", str(m, "key"), str(m, "id"))
		}
	case "search":
		if n := num(top["total"]); n > 0 {
			fmt.Printf("%d match(es)\n\n", n)
		}
		for _, it := range rows("results") {
			m := asMap(it)
			who := str(m, "author_name")
			if str(m, "author_kind") == "agent" {
				who += "·agent"
			}
			where := str(m, "conversation_title")
			if where == "" {
				where = str(m, "conversation_kind")
			}
			extra := ""
			if m["has_attachments"] == true {
				extra = "  📎"
			}
			for _, t := range list(m, "tags") {
				extra += fmt.Sprintf("  #%v", t)
			}
			body := str(m, "body")
			if body == "" {
				body = str(m, "excerpt")
			}
			fmt.Printf("%s %s  %s  in %s%s\n  %s\n\n", str(m, "id"), who,
				fmtTime(m["created_at"]), where, extra, truncate(body, 140))
		}
	case "issue":
		m := top
		fmt.Printf("%s  %-9s %-6s %s\n", str(m, "key"), str(m, "status"),
			str(m, "priority"), str(m, "title"))
		if d := str(m, "description"); d != "" {
			fmt.Println(truncate(d, 400))
		}
	case "project":
		m := top
		fmt.Printf("%s  %s\n%s\n", str(m, "key"), str(m, "name"), str(m, "id"))
		if d := str(m, "description"); d != "" {
			fmt.Println(d)
		}
	case "idea":
		m := top
		fmt.Printf("%-10s %s\n%s\n", str(m, "status"), str(m, "title"), str(m, "id"))
		if d := str(m, "summary"); d != "" {
			fmt.Println(d)
		}
	case "review":
		m := top
		fmt.Printf("%-9s %s\n%s\n", str(m, "status"), str(m, "title"), str(m, "id"))
		if d := str(m, "summary"); d != "" {
			fmt.Println(d)
		}
	case "ghdetail":
		m := top
		fmt.Printf("#%v  %-8s %s\n%s\n", m["number"], str(m, "state"),
			str(m, "title"), str(m, "url"))
		if d := str(m, "body"); d != "" {
			fmt.Println(truncate(d, 400))
		}
	case "unread":
		us := rows("unread")
		if len(us) == 0 {
			fmt.Println("all read")
			break
		}
		for _, u := range us {
			m := asMap(u)
			p := asMap(m["project"])
			name := str(m, "name")
			if name == "" {
				name = str(m, "issue_key")
			}
			if name == "" {
				name = "-"
			}
			fmt.Printf("%-8s %-9s %4d  %-26s %s\n",
				str(p, "key"), str(m, "kind"), num(m["unread_count"]), name, str(m, "id"))
			if lu := asMap(m["latest_unread"]); lu != nil {
				fmt.Printf("         └ %s: %s\n", str(lu, "author"),
					truncate(str(lu, "excerpt"), 90))
			}
		}
	case "inbox":
		for _, it := range rows("items") {
			m := asMap(it)
			fmt.Printf("%-7s %-16s %s  %s\n  %s\n",
				str(m, "kind"), str(asMap(m["author"]), "name"), fmtTime(m["at"]),
				str(m, "message_id"), truncate(str(m, "excerpt"), 90))
		}
	case "mentionables":
		for _, u := range list(top, "users") {
			fmt.Printf("@%s\n", str(asMap(u), "name"))
		}
		for _, a := range list(top, "agents") {
			m := asMap(a)
			fmt.Printf("@%s  (agent: %s)\n", str(m, "slug"), str(m, "name"))
		}
		for _, i := range list(top, "issues") {
			m := asMap(i)
			fmt.Printf("%s  %s\n", str(m, "key"), str(m, "title"))
		}
		for _, r := range list(top, "repos") {
			fmt.Printf("%s\n", fmt.Sprint(r))
		}
	case "activity":
		for _, sec := range []struct{ head, key string }{
			{"OPEN PRs", "open_prs"}, {"OPEN ISSUES", "open_issues"},
		} {
			items := list(top, sec.key)
			if len(items) == 0 {
				continue
			}
			fmt.Println(sec.head)
			for _, it := range items {
				m := asMap(it)
				fmt.Printf("  %-10s %-9s %s\n",
					str(m, "key"), str(m, "status"), str(m, "title"))
			}
		}
		if msgs := list(top, "recent_messages"); len(msgs) > 0 {
			fmt.Println("RECENT MESSAGES")
			for _, it := range msgs {
				m := asMap(it)
				fmt.Printf("  %-10s %-16s %.60s\n",
					str(asMap(m["project"]), "key"),
					str(asMap(m["author"]), "name"),
					str(m, "body"))
			}
		}
		if len(list(top, "open_prs"))+len(list(top, "open_issues"))+len(list(top, "recent_messages")) == 0 {
			fmt.Println("all quiet")
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

Guide
  guide                                 print the platform agent guide (read first on a new workspace)
  whoami                                your agent identity, workspace and grants

Chat
  projects                              list granted projects
  project <project_id>                  one project's details
  activity                              cross-project feed: open issues, PRs, latest messages
  unread                                per-conversation unread breakdown
  inbox                                 mentions, replies and unread aimed at you
  await <project_id|conversation_id>    block until a reply lands (--timeout s)
  conversations <project_id>            list conversations (id, kind, name, unread)
  mentionables <project_id>             names that resolve: @users, @agents, KEY-1, repo#N
  messages <project_id|conversation_id> list messages (--tags t, --before id to paginate)
  read <message_id>                     show one message + mark it read
  say <project_id|conversation_id> <body|-> [--reply id] [--tags a,b] [--attach f.png] [--silent]
                                              post a message; "-" or --file reads the body from stdin/a file
  react <message_id> <emoji>            toggle a reaction
  msg-edit <message_id> <body|->        edit an unread agent message
  msg-del <message_id>                  delete an own unread message
  pin|unpin <message_id>                pin or unpin a message
  pins <project_id|conversation_id>     list pinned messages
  forward <message_id> <project_id>     forward a message into another project
  thread <message_id> [title]           open (or get) the thread on a message
  avatar <file|url>                     set this agent's profile picture

Work
  issues <project_id> [--status S]      list issues (backlog|todo|in_progress|review|done|cancelled)
  issue <issue_id>                      show one issue
  issue-new <project_id> <title> [desc] create an issue
  issue-set <issue_id> key=value …      update an issue
  todos <project_id>                    list todos
  todo-add <project_id> <text>          add a todo
  todo-done|todo-undo|todo-del <id>     update todos
  todo-set <id> <status>                set status (todo|in_progress|done)
  todo-sync <project_id> --file list.json   mirror your whole task list in one call
  work-start <project_id> <title>       status message + progress thread
  work-stop <status_msg_id> [summary]   close the work status
  ask <message_id> <user> <question>    ask a person (thread + @mention)
  resolve <question_msg_id> [note]      mark a question answered
  events [--project KEY] [--json]       stream live events; pretty by default, raw frames with --json

Files & attachments
  files <project_id> [path]             list the linked folder
  file-read <project_id> <path>         read a text file
  attach <project_id> <file>            upload a file, print its attachment id
  attachment <id> [--out file]          attachment metadata + download

GitHub
  gh issues|prs <project_id>            list GitHub issues / PRs
  gh issue|pr <project_id> <number>     show one
  gh issue-new <project_id> <title> [body]      file a GitHub issue
  gh pr-new <project_id> <head> <title> [--base b] [--body t|-] [--draft]
                                              open a pull request
  gh comment <project_id> <num> <body|->      comment on an issue/PR
  gh review <project_id> <num> approve|request-changes|comment [body]
                                              submit a PR review
  gh pr-state <project_id> <num> open|closed  close or reopen a PR
  gh merge <project_id> <num> [merge|squash|rebase]   merge a PR
  gh ci <project_id>                    recent workflow runs
  gh rerun <project_id> <run_id>        rerun a workflow run

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
  brief-del <brief_id>                  delete a brief (irreversible)
  brief-policy <project_id>             show the project's brief policy

Ideas (brainstorm whiteboards)
  ideas <project_id>                    list ideas
  idea <idea_id>                        show one idea incl. scene
  idea-new <project_id> <title> ["summary"] [--file scene.json]   create
  idea-set <idea_id> key=value … [--file scene.json]              update
  idea-del <idea_id>                    delete (irreversible)
  idea-promote <idea_id> ["title"]      convert an idea into a backlog issue

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
					// Refuse to swallow a flag-looking token as the value —
					// `--conv --limit 5` must fail loudly, not set
					// conv="--limit" and silently return empty output.
					if next := args[end]; strings.HasPrefix(next, "-") && next != "-" && !negNumber(next) {
						fail("flag --" + name + " needs an argument, got " + next)
					}
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
	// runOK is for mutations: one ack line, not the whole echoed payload.
	runOK := func(verb, name string, a map[string]any) {
		res, err := s.tool(name, a)
		if err != nil {
			fail(err)
		}
		confirm(verb, res)
	}

	switch args[0] {
	case "guide":
		// the embedded platform manual — plain text, not JSON
		res, err := s.tool("get_guide", nil)
		if err != nil {
			fail(err)
		}
		fmt.Print(string(res))

	case "whoami":
		run("whoami", "whoami", nil)

	case "activity":
		run("activity", "activity", nil)

	case "projects":
		run("projects", "list_projects", nil)

	case "project":
		run("project", "get_project",
			map[string]any{"project_id": need(args, 1, "project_id")})

	case "inbox":
		run("inbox", "inbox", map[string]any{"limit": *flagLimit})

	case "await":
		// block until a human posts in the conversation (timeout_s <= 55)
		a := map[string]any{"timeout_s": *flagTimeout}
		if *flagConv != "" {
			a["conversation_id"] = *flagConv
		} else {
			a["project_id"] = need(args, 1, "project_id or conversation_id")
		}
		run("await", "await_message", a)

	case "unread":
		// Prefer the server-side rollup (one call); fall back to composing
		// it from list_projects + list_conversations on older servers.
		if res, err := s.tool("list_unread", nil); err == nil {
			out("unread", res)
			return
		}
		raw, err := s.tool("list_projects", nil)
		if err != nil {
			fail(err)
		}
		var projects []anyMap
		var projWrap anyMap
		if err := json.Unmarshal(raw, &projects); err != nil {
			if err := json.Unmarshal(raw, &projWrap); err != nil {
				fail("parse projects:", err)
			}
			projects = nil
			for _, p := range list(projWrap, "projects") {
				projects = append(projects, asMap(p))
			}
		}
		total := 0
		for _, p := range projects {
			pid := str(p, "id")
			res, err := s.tool("list_conversations", map[string]any{"project_id": pid})
			if err != nil {
				fail(err)
			}
			var convs []anyMap
			var convWrap anyMap
			if err := json.Unmarshal(res, &convs); err != nil {
				if err := json.Unmarshal(res, &convWrap); err != nil {
					fail("parse conversations:", err)
				}
				for _, c := range list(convWrap, "conversations") {
					convs = append(convs, asMap(c))
				}
			}
			for _, c := range convs {
				n := num(c["unread_count"])
				if n == 0 {
					continue
				}
				total += n
				cname := str(c, "name")
				if cname == "" {
					cname = str(c, "issue_key")
				}
				if cname == "" {
					cname = "-"
				}
				fmt.Printf("%-8s %-9s %4d  %-26s %s\n",
					str(p, "key"), str(c, "kind"), n, cname, str(c, "id"))
			}
		}
		if total == 0 {
			fmt.Println("all read")
		}

	case "mentionables":
		run("mentionables", "list_mentionables",
			map[string]any{"project_id": need(args, 1, "project_id")})

	case "conversations":
		run("conversations", "list_conversations",
			map[string]any{"project_id": need(args, 1, "project_id")})

	case "messages":
		pid := need(args, 1, "project_id or conversation_id")
		a := map[string]any{"limit": *flagLimit}
		if *flagConv != "" {
			a["conversation_id"] = *flagConv
		} else {
			// get_messages resolves a bare id either way — a project id
			// opens the main conversation, a conversation id reads it.
			a["project_id"] = pid
		}
		if *flagTags != "" {
			a["tag"] = *flagTags
		}
		if *flagBefore != "" {
			a["before_id"] = *flagBefore
		}
		run("messages", "get_messages", a)

	case "read":
		// get_message already writes the read receipt server-side.
		run("", "get_message", map[string]any{"message_id": need(args, 1, "message_id")})

	case "say":
		// say <pid|cid> "text" | - | --file f — the server resolves a bare
		// conversation id in the project_id slot, so channels and threads
		// are addressable positionally.
		pid := need(args, 1, "project_id or conversation_id")
		var text string
		if len(args) > 2 {
			text = args[2]
		}
		text = readArgBody(text)
		a := map[string]any{"project_id": pid, "body": text}
		if *flagConv != "" {
			a["conversation_id"] = *flagConv
		}
		if *flagReply != "" {
			a["reply_to"] = *flagReply
		}
		if *flagTags != "" {
			a["tags"] = *flagTags
		}
		if *flagSilent {
			a["silent"] = true
		}
		var ids []string
		for _, f := range strings.Split(*flagAttach, ",") {
			f = strings.TrimSpace(f)
			if f == "" {
				continue
			}
			ids = append(ids, uploadFile(s, pid, f))
		}
		if len(ids) > 0 {
			a["attachment_ids"] = strings.Join(ids, ",")
		}
		runOK("posted", "send_message", a)

	case "attach":
		// attach <pid> <file> — standalone upload; the id can later go to
		// send_message's attachment_ids (--json gives the full object).
		id := uploadFile(s, need(args, 1, "project_id"), need(args, 2, "file"))
		fmt.Println(id)

	case "react":
		runOK("reacted", "react_to_message", map[string]any{
			"message_id": need(args, 1, "message_id"),
			"emoji":      need(args, 2, "emoji"),
		})

	case "msg-edit":
		var text string
		if len(args) > 2 {
			text = args[2]
		}
		runOK("edited", "edit_message", map[string]any{
			"message_id": need(args, 1, "message_id"),
			"body":       readArgBody(text),
		})

	case "msg-del":
		runOK("deleted", "delete_message", map[string]any{
			"message_id": need(args, 1, "message_id"),
		})

	case "pin", "unpin":
		runOK(args[0]+"ned", "pin_message", map[string]any{
			"message_id": need(args, 1, "message_id"),
			"pinned":     args[0] == "pin",
		})

	case "pins":
		run("messages", "list_pins",
			map[string]any{"project_id": need(args, 1, "project_id or conversation_id")})

	case "forward":
		runOK("forwarded", "forward_message", map[string]any{
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
		runOK("thread", "create_thread", a)

	case "avatar":
		// avatar <file|url> — files go up base64-encoded; http(s) URLs are
		// fetched and stored server-side
		src := need(args, 1, "image file or url")
		if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
			runOK("avatar set", "set_avatar", map[string]any{"image_url": src})
			break
		}
		raw, err := os.ReadFile(src)
		if err != nil {
			fail(err)
		}
		runOK("avatar set", "set_avatar", map[string]any{
			"image_base64": base64.StdEncoding.EncodeToString(raw),
		})

	case "issues":
		a := map[string]any{"project_id": need(args, 1, "project_id")}
		if *flagStatus != "" {
			a["status"] = *flagStatus
		}
		run("issues", "list_issues", a)

	case "issue":
		run("issue", "get_issue", map[string]any{"issue_id": need(args, 1, "issue_id")})

	case "issue-new":
		pid := need(args, 1, "project_id")
		title := need(args, 2, "title")
		a := map[string]any{"project_id": pid, "title": title}
		if len(args) > 3 {
			a["description"] = args[3]
		}
		runOK("created", "create_issue", a)

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
		runOK("updated", "update_issue", a)

	case "todos":
		run("todos", "todo_list",
			map[string]any{"project_id": need(args, 1, "project_id")})

	case "todo-add":
		runOK("added", "todo_add", map[string]any{
			"project_id": need(args, 1, "project_id"),
			"content":    need(args, 2, "content"),
		})

	case "todo-done", "todo-undo":
		runOK("ok", "todo_update", map[string]any{
			"todo_id": need(args, 1, "todo_id"),
			"done":    args[0] == "todo-done",
		})

	case "todo-del":
		runOK("deleted", "todo_delete", map[string]any{"todo_id": need(args, 1, "todo_id")})

	case "todo-set":
		// todo-set <todo_id> <status> — todo|in_progress|done
		runOK("ok", "todo_update", map[string]any{
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
		runOK("synced", "todo_sync", map[string]any{"project_id": pid, "items": items})

	case "work-start":
		// work-start <project_id> <title> — status message + progress thread
		runOK("working", "work_start", map[string]any{
			"project_id": need(args, 1, "project_id"),
			"title":      need(args, 2, "title"),
		})

	case "work-stop":
		// work-stop <status_message_id> [summary]
		a := map[string]any{"message_id": need(args, 1, "status message id")}
		if len(args) > 2 {
			a["summary"] = args[2]
		}
		runOK("stopped", "work_stop", a)

	case "ask":
		// ask <message_id> <user> <question> — thread + @mention
		runOK("asked", "request_input", map[string]any{
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
		runOK("resolved", "resolve_input", a)

	case "events":
		streamEvents(s)

	case "search":
		// search <pid> "query" — operators: from: in: has:image|has:file
		// before:YYYY-MM-DD after:YYYY-MM-DD
		run("search", "search_messages", map[string]any{
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
		sub := need(args, 1, "issues|prs|issue|pr|issue-new|pr-new|comment|review|pr-state|merge|ci|rerun")
		pid := need(args, 2, "project_id")
		var name string
		verb := ""
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
		case "issue-new":
			// gh issue-new <pid> <title> [body|-]
			name = "github_create_issue"
			verb = "created"
			a["title"] = need(args, 3, "title")
			if len(args) > 4 || *flagBody != "" {
				body := *flagBody
				if len(args) > 4 {
					body = args[4]
				}
				a["body"] = readArgBody(body)
			}
		case "pr-new":
			// gh pr-new <pid> <head> <title> [--base b] [--body t|-] [--draft]
			name = "github_create_pr"
			verb = "opened"
			a["head"] = need(args, 3, "head branch")
			a["title"] = need(args, 4, "title")
			if *flagBase != "" {
				a["base"] = *flagBase
			}
			if *flagBody != "" {
				a["body"] = readArgBody(*flagBody)
			}
			if *flagDraft {
				a["draft"] = true
			}
		case "comment":
			// gh comment <pid> <num> <body|->
			name = "github_comment"
			verb = "commented"
			a["number"] = atoi(need(args, 3, "number"))
			var body string
			if len(args) > 4 {
				body = args[4]
			} else {
				body = *flagBody
			}
			a["body"] = readArgBody(body)
		case "review":
			// gh review <pid> <num> approve|request-changes|comment [body|-]
			name = "github_review_pr"
			verb = "reviewed"
			a["number"] = atoi(need(args, 3, "number"))
			switch ev := need(args, 4, "approve|request-changes|comment"); ev {
			case "approve":
				a["event"] = "APPROVE"
			case "request-changes":
				a["event"] = "REQUEST_CHANGES"
			case "comment":
				a["event"] = "COMMENT"
			default:
				fail("review event must be approve|request-changes|comment, got:", ev)
			}
			var body string
			if len(args) > 5 {
				body = args[5]
			} else {
				body = *flagBody
			}
			if body != "" || *flagFile != "" {
				a["body"] = readArgBody(body)
			}
		case "pr-state":
			// gh pr-state <pid> <num> open|closed
			name = "github_pr_state"
			verb = "state set"
			a["number"] = atoi(need(args, 3, "number"))
			a["state"] = need(args, 4, "open|closed")
		case "merge":
			// gh merge <pid> <num> [merge|squash|rebase]
			name = "github_merge_pr"
			verb = "merged"
			a["number"] = atoi(need(args, 3, "number"))
			if len(args) > 4 {
				a["method"] = args[4]
			} else if *flagMethod != "" {
				a["method"] = *flagMethod
			}
		case "ci":
			name = "github_ci_runs"
		case "rerun":
			name = "github_rerun"
			verb = "rerun"
			a["run_id"] = atoi(need(args, 3, "run_id"))
		default:
			fail("gh subcommand:", sub)
		}
		if verb != "" {
			runOK(verb, name, a)
			return
		}
		kind := "gh"
		switch sub {
		case "ci":
			kind = "ghci"
		case "issue", "pr":
			kind = "ghdetail"
		}
		run(kind, name, a)

	case "reviews":
		a := map[string]any{"project_id": need(args, 1, "project_id")}
		if *flagStatus != "" {
			a["status"] = *flagStatus
		}
		run("reviews", "list_reviews", a)

	case "review":
		run("review", "get_review", map[string]any{"review_id": need(args, 1, "review_id")})

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
		runOK("submitted", "submit_review", payload)

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
		runOK("created", "create_brief", payload)

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
		runOK("updated", "update_brief", payload)

	case "brief-del":
		runOK("deleted", "delete_brief",
			map[string]any{"brief_id": need(args, 1, "brief_id")})

	case "ideas":
		run("ideas", "list_ideas",
			map[string]any{"project_id": need(args, 1, "project_id")})

	case "idea":
		run("idea", "get_idea", map[string]any{"idea_id": need(args, 1, "idea_id")})

	case "idea-new":
		// idea-new <pid> <title> ["summary"] [--file scene.json]
		pid := need(args, 1, "project_id")
		a := map[string]any{"project_id": pid, "title": need(args, 2, "title")}
		if len(args) > 3 {
			a["summary"] = args[3]
		}
		if *flagFile != "" {
			raw, err := readFileOrStdin(*flagFile)
			if err != nil {
				fail(err)
			}
			a["scene"] = strings.TrimSpace(string(raw))
		}
		runOK("created", "create_idea", a)

	case "idea-set":
		// idea-set <id> [title=..] [summary=..] [status=open|converted|archived] [--file scene.json]
		a := map[string]any{"idea_id": need(args, 1, "idea_id")}
		for _, kv := range args[2:] {
			k, v, ok := strings.Cut(kv, "=")
			if !ok {
				fail("expected key=value, got:", kv)
			}
			a[k] = v
		}
		if *flagFile != "" {
			raw, err := readFileOrStdin(*flagFile)
			if err != nil {
				fail(err)
			}
			a["scene"] = strings.TrimSpace(string(raw))
		}
		runOK("updated", "update_idea", a)

	case "idea-del":
		runOK("deleted", "delete_idea",
			map[string]any{"idea_id": need(args, 1, "idea_id")})

	case "idea-promote":
		// idea-promote <idea_id> ["issue title"] — idea → backlog issue
		a := map[string]any{"idea_id": need(args, 1, "idea_id")}
		if len(args) > 2 {
			a["title"] = args[2]
		}
		runOK("promoted", "idea_to_issue", a)

	case "attachment":
		res, err := s.tool("get_attachment", map[string]any{"attachment_id": need(args, 1, "id")})
		if err != nil {
			fail(err)
		}
		var meta struct {
			URL  string `json:"download_url"`
			Data string `json:"data_base64"`
		}
		_ = json.Unmarshal(res, &meta)
		// Inline bytes don't depend on the public storage endpoint —
		// prefer them whenever the server shipped them.
		if meta.Data != "" && *flagOut != "" {
			raw, err := base64.StdEncoding.DecodeString(meta.Data)
			if err != nil {
				fail("decode attachment:", err)
			}
			if err := os.WriteFile(*flagOut, raw, 0o644); err != nil {
				fail(err)
			}
			fmt.Println("saved to", *flagOut)
			return
		}
		if meta.URL == "" {
			var m anyMap
			_ = json.Unmarshal(res, &m)
			delete(m, "data_base64")
			m["hint"] = "bytes were inlined — pass --out <file> to save"
			out, _ := json.Marshal(m)
			emit(out)
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
		if resp.StatusCode != http.StatusOK {
			fail("download:", resp.Status)
		}
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

// uploadFile pushes one file to the project's attachment store and
// returns its id for attachment_ids / say --attach.
func uploadFile(s *session, pid, path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		fail("read attachment:", err)
	}
	att, err := s.tool("upload_attachment", map[string]any{
		"project_id":  pid,
		"name":        filepath.Base(path),
		"data_base64": base64.StdEncoding.EncodeToString(data),
	})
	if err != nil {
		fail("upload", path+":", err)
	}
	var m anyMap
	_ = json.Unmarshal(att, &m)
	id := str(m, "id")
	if id == "" {
		fail("upload", path+": no id in reply")
	}
	return id
}

// readFileOrStdin reads a payload file; "-" means stdin.
func readFileOrStdin(path string) ([]byte, error) {
	if path == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(path)
}

// streamEvents tails GET /api/agent/events and prints each SSE data line —
// the agent-side half of live sync (todo.changed, message.created, …).
// Human mode prints "HH:MM  type  summary"; --json passes raw frames.
// --project <id|key> narrows the stream to one grant.
func streamEvents(s *session) {
	filter := *flagProject
	if filter != "" && len(filter) != 36 { // a key, not a uuid — resolve
		raw, err := s.tool("list_projects", nil)
		if err != nil {
			fail(err)
		}
		var v any
		_ = json.Unmarshal(raw, &v)
		var arr []any
		if l, ok := v.([]any); ok {
			arr = l
		} else {
			arr = list(asMap(v), "projects")
		}
		for _, p := range arr {
			m := asMap(p)
			if strings.EqualFold(str(m, "key"), filter) {
				filter = str(m, "id")
				break
			}
		}
		if len(filter) != 36 {
			fail("no granted project matching:", *flagProject)
		}
	}
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
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}
		if *flagJSON {
			fmt.Println(data)
			continue
		}
		var e struct {
			Type      string         `json:"type"`
			ProjectID string         `json:"project_id"`
			Data      map[string]any `json:"data"`
		}
		if err := json.Unmarshal([]byte(data), &e); err != nil {
			fmt.Println(data)
			continue
		}
		if filter != "" && e.ProjectID != filter {
			continue
		}
		fmt.Printf("%s  %-20s %s\n", time.Now().Format("15:04"), e.Type, eventSummary(e.Data))
	}
	if err := sc.Err(); err != nil {
		fail("events stream:", err)
	}
}

// eventSummary distils an event payload to one line for the human view.
func eventSummary(d map[string]any) string {
	if m := asMap(d["message"]); m != nil {
		return str(asMap(m["author"]), "name") + ": " + truncate(str(m, "body"), 80)
	}
	for _, k := range []string{"title", "content", "key", "summary"} {
		if s := str(d, k); s != "" {
			return truncate(s, 80)
		}
	}
	if t := asMap(d["todo"]); t != nil {
		return truncate(str(t, "content"), 80)
	}
	return ""
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
	cmds := "guide whoami projects project activity unread conversations mentionables messages read say react msg-edit msg-del " +
		"pin unpin pins forward thread avatar issues " +
		"issue issue-new issue-set todos todo-add todo-done todo-undo todo-del " +
		"todo-set todo-sync work-start work-stop ask resolve events " +
		"search files file-read attach gh reviews review review-submit review-await " +
		"briefs brief brief-new brief-set brief-del brief-policy " +
		"ideas idea idea-new idea-set idea-del idea-promote attachment redeem completion"
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
