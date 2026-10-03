package server

// Canonical end-to-end: register -> workspace -> project -> gated agent ->
// MCP submit_review -> REST verdict -> unread counts. Runs against a real
// Postgres (set RELAY_TEST_DATABASE_URL); skipped otherwise. Uses the embedded
// migrations so the test exercises the shipped schema.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	relaydb "github.com/Dvorinka/relay/db"
	"github.com/Dvorinka/relay/internal/config"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"go.uber.org/zap"
)

type e2eClient struct {
	t      *testing.T
	base   string
	cookie string
}

func (c *e2eClient) call(method, path, body string) (int, map[string]any) {
	c.t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, c.base+path, rdr)
	if err != nil {
		c.t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.cookie != "" {
		req.Header.Set("Cookie", "relay_session="+c.cookie)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	for _, ck := range res.Cookies() {
		if ck.Name == "relay_session" {
			c.cookie = ck.Value
		}
	}
	out := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			c.t.Fatalf("%s %s: bad json: %v (%s)", method, path, err, raw[:min(200, len(raw))])
		}
	}
	return res.StatusCode, out
}

func (c *e2eClient) mcp(token, sessionID, id, method, params string) (string, map[string]any) {
	c.t.Helper()
	env := fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"method":%q,"params":%s}`, id, method, params)
	req, err := http.NewRequest("POST", c.base+"/mcp", strings.NewReader(env))
	if err != nil {
		c.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if sessionID != "" {
		req.Header.Set("Mcp-Session-Id", sessionID)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	// streamable responses arrive as SSE frames; take the data payload
	payload := string(raw)
	if strings.HasPrefix(payload, "event:") {
		for _, line := range strings.Split(payload, "\n") {
			if strings.HasPrefix(line, "data:") {
				payload = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			}
		}
	}
	out := map[string]any{}
	if err := json.Unmarshal([]byte(payload), &out); err != nil {
		c.t.Fatalf("mcp %s: bad envelope: %v (%s)", method, err, payload[:min(200, len(payload))])
	}
	return res.Header.Get("Mcp-Session-Id"), out
}

func mcpToolResult(t *testing.T, env map[string]any) map[string]any {
	t.Helper()
	result, ok := env["result"].(map[string]any)
	if !ok {
		t.Fatalf("mcp error envelope: %v", env["error"])
	}
	if sc, ok := result["structuredContent"].(map[string]any); ok {
		return sc
	}
	content, _ := result["content"].([]any)
	for _, blk := range content {
		m, _ := blk.(map[string]any)
		if m["type"] == "text" {
			var parsed map[string]any
			if json.Unmarshal([]byte(m["text"].(string)), &parsed) == nil {
				return parsed
			}
		}
	}
	t.Fatalf("no structured content in %v", result)
	return nil
}

func TestCanonicalFlow(t *testing.T) {
	dsn := os.Getenv("RELAY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("RELAY_TEST_DATABASE_URL unset")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	goose.SetBaseFS(relaydb.MigrationsFS)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	if err := goose.UpContext(ctx, stdlib.OpenDBFromPool(pool), "migrations"); err != nil {
		t.Fatal(err)
	}

	// the rate limiter is DB-backed (fixed window per IP); clear it so
	// repeated runs against a shared database don't trip on stale hits
	if _, err := pool.Exec(ctx, "delete from rate_limits"); err != nil {
		t.Fatal(err)
	}

	cfg := config.Config{
		DatabaseURL:     dsn,
		AuthSecret:      "test-secret-test-secret-test-secret",
		InsecureDev:     true,
		SessionTTLHours: 1,
	}
	srv := httptest.NewServer(New(cfg, zap.NewNop(), pool, "test"))
	defer srv.Close()
	c := &e2eClient{t: t, base: srv.URL}

	// register + workspace + project; email is unique per run so the test
	// stays rerunnable against a shared database
	code, reg := c.call("POST", "/api/auth/register",
		fmt.Sprintf(`{"email":"e2e-%d@relay.dev","password":"e2epass12345","name":"E2E"}`,
			time.Now().UnixNano()))
	if code != 201 && code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	code, ws := c.call("POST", "/api/workspaces", `{"name":"E2E WS"}`)
	if code != 201 && code != 200 {
		t.Fatalf("workspace: %d %v", code, ws)
	}
	wsID := ws["id"].(string)
	code, proj := c.call("POST", "/api/projects",
		fmt.Sprintf(`{"workspace_id":%q,"key":"E2E","name":"E2E Lab"}`, wsID))
	if code != 201 && code != 200 {
		t.Fatalf("project: %d %v", code, proj)
	}
	projID := proj["id"].(string)

	// gated agent + grants + token
	code, agent := c.call("POST", "/api/workspaces/"+wsID+"/agents",
		`{"name":"E2E Bot","review_mode":"gate"}`)
	if code != 201 && code != 200 {
		t.Fatalf("agent: %d %v", code, agent)
	}
	agentID := agent["id"].(string)
	if agent["review_mode"] != "gate" {
		t.Fatalf("review_mode = %v", agent["review_mode"])
	}
	code, _ = c.call("PUT", fmt.Sprintf("/api/agents/%s/projects/%s", agentID, projID),
		`{"scopes":["project:read","review:read","review:write","message:read","message:write"]}`)
	if code != 200 {
		t.Fatalf("grant: %d", code)
	}
	code, tok := c.call("POST", fmt.Sprintf("/api/agents/%s/tokens", agentID), `{"name":"e2e"}`)
	if code != 201 && code != 200 {
		t.Fatalf("mint: %d %v", code, tok)
	}
	token := tok["token"].(string)

	// MCP: initialize -> get_project -> submit_review
	sid, _ := c.mcp(token, "", "1", "initialize",
		`{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}`)
	if sid == "" {
		t.Fatal("no mcp session id")
	}
	req, _ := http.NewRequest("POST", srv.URL+"/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Mcp-Session-Id", sid)
	req.Header.Set("Content-Type", "application/json")
	_, _ = http.DefaultClient.Do(req)

	_, env := c.mcp(token, sid, "2", "tools/call",
		fmt.Sprintf(`{"name":"get_project","arguments":{"project_id":%q}}`, projID))
	got := mcpToolResult(t, env)
	if got["review_mode"] != "gate" {
		t.Fatalf("get_project review_mode = %v", got["review_mode"])
	}

	_, env = c.mcp(token, sid, "3", "tools/call", fmt.Sprintf(
		`{"name":"submit_review","arguments":{"project_id":%q,"title":"E2E review",`+
			`"summary":"Changed one thing.","files":[{"path":"a.go","status":"modified",`+
			`"additions":3,"deletions":1,"note":"touched the thing"}],`+
			`"actions":[{"kind":"env","label":"None","detail":"nothing to declare"}],`+
			`"verify":"read this test"}}`, projID))
	rev := mcpToolResult(t, env)
	if rev["status"] != "pending" || rev["must_wait"] != true {
		t.Fatalf("submit_review = %v", rev)
	}
	reviewID := rev["id"].(string)

	// REST: pending review surfaces in list + unread counts
	code, list := c.call("GET", "/api/projects/"+projID+"/reviews", "")
	if code != 200 {
		t.Fatalf("list reviews: %d", code)
	}
	if list["pending"].(float64) != 1 {
		t.Fatalf("pending = %v", list["pending"])
	}
	_, unread := c.call("GET", "/api/me/unread", "")
	if rv, _ := unread["reviews"].(map[string]any); rv[projID].(float64) != 1 {
		t.Fatalf("unread.reviews = %v", unread["reviews"])
	}

	// respond: request changes
	code, resp := c.call("POST", "/api/reviews/"+reviewID+"/respond",
		`{"status":"changes_requested","response":"rename the thing first"}`)
	if code != 200 {
		t.Fatalf("respond: %d %v", code, resp)
	}
	got = resp["review"].(map[string]any)
	if got["status"] != "changes_requested" {
		t.Fatalf("status = %v", got["status"])
	}
	if got["responder"].(map[string]any)["name"] != "E2E" {
		t.Fatalf("responder = %v", got["responder"])
	}

	// agent sees the verdict
	_, env = c.mcp(token, sid, "4", "tools/call",
		fmt.Sprintf(`{"name":"get_review","arguments":{"review_id":%q}}`, reviewID))
	got = mcpToolResult(t, env)
	gotReview, _ := got["review"].(map[string]any)
	if gotReview != nil && gotReview["status"] != "changes_requested" {
		t.Fatalf("agent-side status = %v", gotReview["status"])
	}

	// supersede with a fresh review, approve it
	_, env = c.mcp(token, sid, "5", "tools/call", fmt.Sprintf(
		`{"name":"submit_review","arguments":{"project_id":%q,"title":"E2E v2",`+
			`"summary":"Renamed.","supersedes":%q}}`, projID, reviewID))
	rev2 := mcpToolResult(t, env)
	code, _ = c.call("POST", fmt.Sprintf("/api/reviews/%s/respond", rev2["id"].(string)),
		`{"status":"approved"}`)
	if code != 200 {
		t.Fatalf("approve: %d", code)
	}

	_, unread = c.call("GET", "/api/me/unread", "")
	if rv, _ := unread["reviews"].(map[string]any); len(rv) != 0 {
		t.Fatalf("reviews still pending: %v", rv)
	}

	// webhooks: subscribe a local receiver, fire a real event, verify the
	// HMAC signature over the delivered body
	type delivery struct {
		sig, typ, id string
		body         []byte
	}
	received := make(chan delivery, 4)
	hookReceiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received <- delivery{
			sig:  r.Header.Get("X-Relay-Signature-256"),
			typ:  r.Header.Get("X-Relay-Event"),
			id:   r.Header.Get("X-Relay-Delivery"),
			body: body,
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer hookReceiver.Close()

	code, wh := c.call("POST", "/api/projects/"+projID+"/webhooks",
		fmt.Sprintf(`{"url":%q,"events":["issue.*"]}`, hookReceiver.URL))
	if code != 201 {
		t.Fatalf("webhook create: %d %v", code, wh)
	}
	secret, _ := wh["secret"].(string)
	if !strings.HasPrefix(secret, "whsec_") {
		t.Fatalf("secret = %v", wh["secret"])
	}
	whID := wh["id"].(string)

	// list shows the subscription but only a secret hint
	code, whl := c.call("GET", "/api/projects/"+projID+"/webhooks", "")
	if code != 200 || len(whl["webhooks"].([]any)) != 1 {
		t.Fatalf("webhook list: %d %v", code, whl)
	}
	listed := whl["webhooks"].([]any)[0].(map[string]any)
	if listed["secret"] != nil || !strings.HasPrefix(listed["secret_hint"].(string), "whsec_") {
		t.Fatalf("list leaks/hides secret wrongly: %v", listed)
	}

	// creating an issue dispatches issue.created to the receiver
	code, issue := c.call("POST", "/api/projects/"+projID+"/issues",
		`{"title":"E2E webhook issue"}`)
	if code != 201 && code != 200 {
		t.Fatalf("issue create: %d %v", code, issue)
	}
	issueID := issue["id"].(string)

	var d delivery
	select {
	case d = <-received:
	case <-time.After(10 * time.Second):
		t.Fatal("no webhook delivery within 10s")
	}
	if d.typ != "issue.created" || d.id == "" {
		t.Fatalf("delivery headers: %q %q", d.typ, d.id)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(d.body)
	if want := "sha256=" + hex.EncodeToString(mac.Sum(nil)); d.sig != want {
		t.Fatalf("signature %q != %q", d.sig, want)
	}
	var env2 struct {
		ID        string `json:"id"`
		Type      string `json:"type"`
		ProjectID string `json:"project_id"`
	}
	if err := json.Unmarshal(d.body, &env2); err != nil || env2.Type != "issue.created" {
		t.Fatalf("envelope: %v %s", err, d.body[:min(200, len(d.body))])
	}

	// delivery log records the successful attempt
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, dl := c.call("GET", "/api/webhooks/"+whID+"/deliveries", "")
		rows, _ := dl["deliveries"].([]any)
		if len(rows) > 0 {
			row := rows[0].(map[string]any)
			if row["success"] != true || row["status_code"].(float64) != 200 {
				t.Fatalf("delivery row: %v", row)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("delivery never recorded")
		}
		time.Sleep(100 * time.Millisecond)
	}

	// synthetic test event queues through the same path
	code, tst := c.call("POST", "/api/webhooks/"+whID+"/test", "")
	if code != 202 || tst["queued"] != true {
		t.Fatalf("test delivery: %d %v", code, tst)
	}
	select {
	case d = <-received:
		if d.typ != "webhook.test" {
			t.Fatalf("test event type = %q", d.typ)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no test delivery within 10s")
	}

	// GitHub push: no linked repo on the project -> 409 (503 needs a linked
	// repo plus an unconfigured GitHub app, unreachable in this fixture)
	code, gh := c.call("POST", "/api/issues/"+issueID+"/github", `{}`)
	if code != 409 {
		t.Fatalf("push to github: %d %v", code, gh)
	}

	// Bulk import: no linked repo -> 409 regardless of GitHub config
	code, imp := c.call("POST", "/api/projects/"+projID+"/github/import", `{}`)
	if code != 409 {
		t.Fatalf("github import: %d %v", code, imp)
	}

	// Overview now carries the issue-activity feed alongside messages
	code, ov := c.call("GET", "/api/projects/"+projID+"/overview", "")
	if code != 200 {
		t.Fatalf("overview: %d %v", code, ov)
	}
	if _, ok := ov["issue_activity"].([]any); !ok {
		t.Fatalf("overview missing issue_activity: %v", ov)
	}
}

// Chat redesign semantics: replies carry a parent preview, parents must live
// in the same conversation, reactions toggle, and a message becomes
// edit-locked once an agent other than its author has read it.
func TestChatSemantics(t *testing.T) {
	dsn := os.Getenv("RELAY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("RELAY_TEST_DATABASE_URL unset")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	goose.SetBaseFS(relaydb.MigrationsFS)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	if err := goose.UpContext(ctx, stdlib.OpenDBFromPool(pool), "migrations"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "delete from rate_limits"); err != nil {
		t.Fatal(err)
	}

	cfg := config.Config{
		DatabaseURL:     dsn,
		AuthSecret:      "test-secret-test-secret-test-secret",
		InsecureDev:     true,
		SessionTTLHours: 1,
	}
	srv := httptest.NewServer(New(cfg, zap.NewNop(), pool, "test"))
	defer srv.Close()
	c := &e2eClient{t: t, base: srv.URL}

	code, reg := c.call("POST", "/api/auth/register",
		fmt.Sprintf(`{"email":"chat-%d@relay.dev","password":"chatpass12345","name":"Chat"}`,
			time.Now().UnixNano()))
	if code != 201 && code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	code, ws := c.call("POST", "/api/workspaces", `{"name":"Chat WS"}`)
	if code != 201 && code != 200 {
		t.Fatalf("workspace: %d %v", code, ws)
	}
	wsID := ws["id"].(string)
	code, proj := c.call("POST", "/api/projects",
		fmt.Sprintf(`{"workspace_id":%q,"key":"CHT","name":"Chat Lab"}`, wsID))
	if code != 201 && code != 200 {
		t.Fatalf("project: %d %v", code, proj)
	}
	projID := proj["id"].(string)

	code, agent := c.call("POST", "/api/workspaces/"+wsID+"/agents",
		`{"name":"Chat Bot","review_mode":"gate"}`)
	if code != 201 && code != 200 {
		t.Fatalf("agent: %d %v", code, agent)
	}
	agentID := agent["id"].(string)
	code, _ = c.call("PUT", fmt.Sprintf("/api/agents/%s/projects/%s", agentID, projID),
		`{"scopes":["project:read","message:read","message:write"]}`)
	if code != 200 {
		t.Fatalf("grant: %d", code)
	}
	code, tok := c.call("POST", fmt.Sprintf("/api/agents/%s/tokens", agentID), `{"name":"e2e"}`)
	if code != 201 && code != 200 {
		t.Fatalf("mint: %d %v", code, tok)
	}
	token := tok["token"].(string)

	code, conv := c.call("GET", "/api/projects/"+projID+"/conversation", "")
	if code != 200 {
		t.Fatalf("conversation: %d %v", code, conv)
	}
	convID := conv["id"].(string)

	// plain message
	code, m1 := c.call("POST", "/api/conversations/"+convID+"/messages",
		`{"body":"first message"}`)
	if code != 201 && code != 200 {
		t.Fatalf("post: %d %v", code, m1)
	}
	msg1 := m1["id"].(string)

	// reply carries the parent preview
	code, m2 := c.call("POST", "/api/conversations/"+convID+"/messages",
		fmt.Sprintf(`{"body":"replying to it","parent_id":%q}`, msg1))
	if code != 201 && code != 200 {
		t.Fatalf("reply: %d %v", code, m2)
	}
	parent, _ := m2["parent"].(map[string]any)
	if parent["id"] != msg1 || parent["author"] != "Chat" {
		t.Fatalf("parent preview wrong: %v", parent)
	}
	if parent["preview"] != "first message" {
		t.Fatalf("parent.preview = %v", parent["preview"])
	}

	// a parent that is not a message in this conversation is rejected
	code, bad := c.call("POST", "/api/conversations/"+convID+"/messages",
		`{"body":"x","parent_id":"00000000-0000-0000-0000-000000000000"}`)
	if code != 400 {
		t.Fatalf("bad parent: %d %v", code, bad)
	}

	// reaction toggles on and off
	code, rx := c.call("PUT", "/api/messages/"+msg1+"/reactions", `{"emoji":"👀"}`)
	if code != 200 {
		t.Fatalf("react: %d %v", code, rx)
	}
	rxns := rx["reactions"].([]any)
	r0 := rxns[0].(map[string]any)
	if r0["emoji"] != "👀" || r0["count"].(float64) != 1 || r0["mine"] != true {
		t.Fatalf("reaction wrong: %v", r0)
	}
	code, rx = c.call("PUT", "/api/messages/"+msg1+"/reactions", `{"emoji":"👀"}`)
	if code != 200 {
		t.Fatalf("unreact: %d %v", code, rx)
	}
	if len(rx["reactions"].([]any)) != 0 {
		t.Fatalf("reaction not removed: %v", rx["reactions"])
	}

	// edit before any agent read -> 200 with edited_at
	code, ed := c.call("PATCH", "/api/messages/"+msg1, `{"body":"edited body"}`)
	if code != 200 {
		t.Fatalf("edit: %d %v", code, ed)
	}
	if ed["edited_at"] == nil {
		t.Fatal("edited_at not set")
	}

	// agent session: mark the user message read, then confirm the lock
	sid, _ := c.mcp(token, "", "1", "initialize",
		`{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}`)
	if sid == "" {
		t.Fatal("no mcp session id")
	}
	req, _ := http.NewRequest("POST", srv.URL+"/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Mcp-Session-Id", sid)
	req.Header.Set("Content-Type", "application/json")
	_, _ = http.DefaultClient.Do(req)

	_, env := c.mcp(token, sid, "2", "tools/call",
		fmt.Sprintf(`{"name":"mark_message_read","arguments":{"message_id":%q}}`, msg1))
	if env["error"] != nil {
		t.Fatalf("mark_message_read: %v", env["error"])
	}

	// agent_read surfaces on the REST list
	code, lst := c.call("GET", "/api/conversations/"+convID+"/messages", "")
	if code != 200 {
		t.Fatalf("list: %d", code)
	}
	found := false
	for _, mm := range lst["messages"].([]any) {
		m := mm.(map[string]any)
		if m["id"] == msg1 {
			found = true
			if m["agent_read"] != true {
				t.Fatal("agent_read should be true after mark_message_read")
			}
		}
	}
	if !found {
		t.Fatal("msg1 missing from list")
	}

	// user edit is now locked
	code, locked := c.call("PATCH", "/api/messages/"+msg1, `{"body":"too late"}`)
	if code != 409 {
		t.Fatalf("edit after agent read: %d %v", code, locked)
	}

	// agent posts its own message, reads it, and can still edit it
	_, env = c.mcp(token, sid, "3", "tools/call",
		fmt.Sprintf(`{"name":"send_message","arguments":{"conversation_id":%q,"body":"agent says hi"}}`, convID))
	amsg := mcpToolResult(t, env)
	amsgID := amsg["id"].(string)

	_, env = c.mcp(token, sid, "4", "tools/call",
		fmt.Sprintf(`{"name":"mark_message_read","arguments":{"message_id":%q}}`, amsgID))
	if env["error"] != nil {
		t.Fatalf("agent self-read: %v", env["error"])
	}
	_, env = c.mcp(token, sid, "5", "tools/call",
		fmt.Sprintf(`{"name":"edit_message","arguments":{"message_id":%q,"body":"agent edited itself"}}`, amsgID))
	aedit := mcpToolResult(t, env)
	if aedit["edited_at"] == nil && aedit["body"] != "agent edited itself" {
		t.Fatalf("agent self-edit should succeed despite own read: %v", aedit)
	}

	// agent reaction lands on the REST view (count 1, not "mine")
	_, env = c.mcp(token, sid, "6", "tools/call",
		fmt.Sprintf(`{"name":"react_to_message","arguments":{"message_id":%q,"emoji":"✅"}}`, msg1))
	if env["error"] != nil {
		t.Fatalf("react_to_message: %v", env["error"])
	}
	_, lst = c.call("GET", "/api/conversations/"+convID+"/messages", "")
	for _, mm := range lst["messages"].([]any) {
		m := mm.(map[string]any)
		if m["id"] != msg1 {
			continue
		}
		rs := m["reactions"].([]any)
		if len(rs) == 0 {
			t.Fatal("agent reaction missing")
		}
		r := rs[0].(map[string]any)
		if r["emoji"] != "✅" || r["mine"] != false {
			t.Fatalf("agent reaction wrong: %v", r)
		}
	}

	// delete before any agent read -> 204, gone from list, reply tombstones
	code, m3 := c.call("POST", "/api/conversations/"+convID+"/messages",
		`{"body":"delete me"}`)
	if code != 201 && code != 200 {
		t.Fatalf("post m3: %d %v", code, m3)
	}
	msg3 := m3["id"].(string)
	code, m4 := c.call("POST", "/api/conversations/"+convID+"/messages",
		fmt.Sprintf(`{"body":"reply to a doomed parent","parent_id":%q}`, msg3))
	if code != 201 && code != 200 {
		t.Fatalf("post m4: %d %v", code, m4)
	}
	msg4 := m4["id"].(string)

	code, del := c.call("DELETE", "/api/messages/"+msg3, "")
	if code != 204 {
		t.Fatalf("delete: %d %v", code, del)
	}
	_, lst = c.call("GET", "/api/conversations/"+convID+"/messages", "")
	var saw4 bool
	for _, mm := range lst["messages"].([]any) {
		m := mm.(map[string]any)
		if m["id"] == msg3 {
			t.Fatal("deleted message still listed")
		}
		if m["id"] == msg4 {
			saw4 = true
			p, _ := m["parent"].(map[string]any)
			if p["deleted"] != true {
				t.Fatalf("reply parent should tombstone, got %v", p)
			}
		}
	}
	if !saw4 {
		t.Fatal("reply missing from list")
	}

	// second delete is a no-op 403 (author-scoped update finds no live row)
	code, again := c.call("DELETE", "/api/messages/"+msg3, "")
	if again["error"] == nil || code != 403 {
		t.Fatalf("double delete: %d %v", code, again)
	}

	// agent-read messages cannot be deleted either (same lock as edit)
	code, dlocked := c.call("DELETE", "/api/messages/"+msg1, "")
	if code != 409 {
		t.Fatalf("delete after agent read: %d %v", code, dlocked)
	}

	// agents can delete their own messages via MCP (own read receipt doesn't lock)
	_, env = c.mcp(token, sid, "7", "tools/call",
		fmt.Sprintf(`{"name":"send_message","arguments":{"conversation_id":%q,"body":"agent deletes this"}}`, convID))
	amsg2 := mcpToolResult(t, env)
	amsg2ID := amsg2["id"].(string)
	_, env = c.mcp(token, sid, "8", "tools/call",
		fmt.Sprintf(`{"name":"delete_message","arguments":{"message_id":%q}}`, amsg2ID))
	if env["error"] != nil {
		t.Fatalf("agent delete_message: %v", env["error"])
	}
	// and a user message is refused at the author check
	_, env = c.mcp(token, sid, "9", "tools/call",
		fmt.Sprintf(`{"name":"delete_message","arguments":{"message_id":%q}}`, msg4))
	res, _ := env["result"].(map[string]any)
	if res["isError"] != true {
		t.Fatalf("agent deleted another author's message: %v", env)
	}
}
