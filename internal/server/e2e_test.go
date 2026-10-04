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

// Threads: a message-rooted side conversation. Create is idempotent, titles
// default to the parent excerpt, nesting is refused, reply counts ride the
// parent message's thread chip, and thread messages use the normal
// conversation endpoints.
func TestThreads(t *testing.T) {
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
		fmt.Sprintf(`{"email":"thr-%d@relay.dev","password":"thrpass12345","name":"Threader"}`,
			time.Now().UnixNano()))
	if code != 201 && code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	code, ws := c.call("POST", "/api/workspaces", `{"name":"Thread WS"}`)
	if code != 201 && code != 200 {
		t.Fatalf("workspace: %d %v", code, ws)
	}
	wsID := ws["id"].(string)
	code, proj := c.call("POST", "/api/projects",
		fmt.Sprintf(`{"workspace_id":%q,"key":"THR","name":"Thread Lab"}`, wsID))
	if code != 201 && code != 200 {
		t.Fatalf("project: %d %v", code, proj)
	}
	projID := proj["id"].(string)

	code, conv := c.call("GET", "/api/projects/"+projID+"/conversation", "")
	if code != 200 {
		t.Fatalf("conversation: %d %v", code, conv)
	}
	convID := conv["id"].(string)

	code, m1 := c.call("POST", "/api/conversations/"+convID+"/messages",
		`{"body":"parent message for the thread"}`)
	if code != 201 && code != 200 {
		t.Fatalf("post: %d %v", code, m1)
	}
	parentID := m1["id"].(string)

	// create with an explicit title
	code, tr := c.call("POST", "/api/messages/"+parentID+"/thread",
		`{"title":"Side discussion"}`)
	if code != 201 && code != 200 {
		t.Fatalf("create thread: %d %v", code, tr)
	}
	thread := tr["thread"].(map[string]any)
	threadID := thread["id"].(string)
	if thread["title"] != "Side discussion" {
		t.Fatalf("title: %v", thread["title"])
	}
	if thread["parent_message_id"] != parentID {
		t.Fatalf("parent_message_id: %v", thread["parent_message_id"])
	}
	if thread["parent_conversation"] != convID {
		t.Fatalf("parent_conversation: %v", thread["parent_conversation"])
	}
	if thread["reply_count"].(float64) != 0 {
		t.Fatalf("fresh thread should have 0 replies: %v", thread)
	}
	pv, _ := thread["parent"].(map[string]any)
	if pv["author"] != "Threader" || pv["preview"] != "parent message for the thread" {
		t.Fatalf("parent preview: %v", pv)
	}

	// same message again returns the existing thread, not a new one
	code, tr2 := c.call("POST", "/api/messages/"+parentID+"/thread",
		`{"title":"Ignored"}`)
	if code != 201 && code != 200 {
		t.Fatalf("re-create: %d %v", code, tr2)
	}
	if tr2["thread"].(map[string]any)["id"] != threadID {
		t.Fatal("duplicate create returned a different thread")
	}

	// omitted title falls back to the parent excerpt
	code, m2 := c.call("POST", "/api/conversations/"+convID+"/messages",
		`{"body":"untitled thread parent here"}`)
	if code != 201 && code != 200 {
		t.Fatalf("post m2: %d %v", code, m2)
	}
	m2ID := m2["id"].(string)
	code, tr3 := c.call("POST", "/api/messages/"+m2ID+"/thread", "")
	if code != 201 && code != 200 {
		t.Fatalf("create untitled thread: %d %v", code, tr3)
	}
	if tr3["thread"].(map[string]any)["title"] != "untitled thread parent here" {
		t.Fatalf("default title: %v", tr3["thread"])
	}

	// a reply inside the thread bumps the count and uses the normal endpoints
	code, tm := c.call("POST", "/api/conversations/"+threadID+"/messages",
		`{"body":"first thread reply"}`)
	if code != 201 && code != 200 {
		t.Fatalf("thread reply: %d %v", code, tm)
	}
	threadReplyID := tm["id"].(string)

	code, lst := c.call("GET", "/api/conversations/"+threadID+"/messages", "")
	if code != 200 {
		t.Fatalf("thread list: %d", code)
	}
	if len(lst["messages"].([]any)) != 1 {
		t.Fatalf("thread should have exactly 1 message: %v", lst["messages"])
	}

	// the parent's chip reports the live reply count
	code, plst := c.call("GET", "/api/conversations/"+convID+"/messages", "")
	if code != 200 {
		t.Fatalf("parent list: %d", code)
	}
	var chip map[string]any
	for _, mm := range plst["messages"].([]any) {
		m := mm.(map[string]any)
		if m["id"] == parentID {
			chip, _ = m["thread"].(map[string]any)
		}
	}
	if chip == nil {
		t.Fatal("parent message has no thread chip")
	}
	if chip["id"] != threadID || chip["reply_count"].(float64) != 1 {
		t.Fatalf("thread chip: %v", chip)
	}

	// project thread index lists it most-recent-activity first
	code, idx := c.call("GET", "/api/projects/"+projID+"/threads", "")
	if code != 200 {
		t.Fatalf("threads index: %d", code)
	}
	threads := idx["threads"].([]any)
	if len(threads) < 2 {
		t.Fatalf("expected both threads listed: %v", threads)
	}
	first := threads[0].(map[string]any)
	if first["id"] != threadID {
		t.Fatalf("most recently active thread should sort first: %v", threads)
	}
	if first["last_reply_at"] == nil {
		t.Fatal("last_reply_at missing on active thread")
	}

	// threads cannot nest
	code, nested := c.call("POST", "/api/messages/"+threadReplyID+"/thread", "")
	if code != 400 {
		t.Fatalf("nested thread: %d %v", code, nested)
	}

	// deleting a thread reply drops the chip count back to zero
	code, del := c.call("DELETE", "/api/messages/"+threadReplyID, "")
	if code != 204 {
		t.Fatalf("delete thread reply: %d %v", code, del)
	}
	code, plst = c.call("GET", "/api/conversations/"+convID+"/messages", "")
	if code != 200 {
		t.Fatalf("parent list after delete: %d", code)
	}
	for _, mm := range plst["messages"].([]any) {
		m := mm.(map[string]any)
		if m["id"] != parentID {
			continue
		}
		chip, _ = m["thread"].(map[string]any)
		if chip["reply_count"].(float64) != 0 {
			t.Fatalf("reply count after delete: %v", chip)
		}
	}

	// deleting the parent message turns the thread card's parent into a tombstone
	code, delP := c.call("DELETE", "/api/messages/"+parentID, "")
	if code != 204 {
		t.Fatalf("delete parent: %d %v", code, delP)
	}
	code, tl := c.call("GET", "/api/projects/"+projID+"/threads", "")
	if code != 200 {
		t.Fatalf("threads index: %d", code)
	}
	for _, tt := range tl["threads"].([]any) {
		thr := tt.(map[string]any)
		if thr["id"] != threadID {
			continue
		}
		pv, _ = thr["parent"].(map[string]any)
		if pv["author"] != "Deleted" || pv["preview"] != "Original message was deleted" {
			t.Fatalf("deleted parent should tombstone: %v", pv)
		}
	}
}

// Pins and forwards: any member toggles pinned_at; the pins index sorts
// newest first. Forwarding copies a message into another project's
// conversation, credits the original author through `forwarded`, and chains
// resolve to the root message. Both refuse non-members.
func TestForwardPin(t *testing.T) {
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
		fmt.Sprintf(`{"email":"fwd-%d@relay.dev","password":"fwdpass12345","name":"Forwarder"}`,
			time.Now().UnixNano()))
	if code != 201 && code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	code, ws := c.call("POST", "/api/workspaces", `{"name":"Fwd WS"}`)
	if code != 201 && code != 200 {
		t.Fatalf("workspace: %d %v", code, ws)
	}
	wsID := ws["id"].(string)

	newProject := func(key, name string) string {
		code, proj := c.call("POST", "/api/projects",
			fmt.Sprintf(`{"workspace_id":%q,"key":%q,"name":%q}`, wsID, key, name))
		if code != 201 && code != 200 {
			t.Fatalf("project %s: %d %v", key, code, proj)
		}
		return proj["id"].(string)
	}
	projA := newProject("FPA", "Source")
	projB := newProject("FPB", "Target")
	projC := newProject("FPC", "Third")

	code, conv := c.call("GET", "/api/projects/"+projA+"/conversation", "")
	if code != 200 {
		t.Fatalf("conversation: %d %v", code, conv)
	}
	convA := conv["id"].(string)

	code, m1 := c.call("POST", "/api/conversations/"+convA+"/messages",
		`{"body":"pin and forward me"}`)
	if code != 201 && code != 200 {
		t.Fatalf("post: %d %v", code, m1)
	}
	msg1 := m1["id"].(string)

	// --- pin ---

	code, pin := c.call("PUT", "/api/messages/"+msg1+"/pin", "")
	if code != 200 {
		t.Fatalf("pin: %d %v", code, pin)
	}
	if pin["pinned_at"] == nil {
		t.Fatalf("pinned_at missing: %v", pin)
	}

	code, m2 := c.call("POST", "/api/conversations/"+convA+"/messages",
		`{"body":"second pin"}`)
	if code != 201 && code != 200 {
		t.Fatalf("post m2: %d %v", code, m2)
	}
	msg2 := m2["id"].(string)
	if code, _ = c.call("PUT", "/api/messages/"+msg2+"/pin", ""); code != 200 {
		t.Fatalf("pin m2: %d", code)
	}

	// pins list: newest pin first
	code, pins := c.call("GET", "/api/conversations/"+convA+"/pins", "")
	if code != 200 {
		t.Fatalf("pins: %d %v", code, pins)
	}
	pinList := pins["messages"].([]any)
	if len(pinList) != 2 {
		t.Fatalf("expected 2 pins: %v", pinList)
	}
	if pinList[0].(map[string]any)["id"] != msg2 {
		t.Fatalf("newest pin should sort first: %v", pinList)
	}

	// unpin removes it from the index
	code, unpin := c.call("DELETE", "/api/messages/"+msg2+"/pin", "")
	if code != 200 {
		t.Fatalf("unpin: %d %v", code, unpin)
	}
	if unpin["pinned_at"] != nil {
		t.Fatalf("pinned_at should clear: %v", unpin)
	}
	code, pins = c.call("GET", "/api/conversations/"+convA+"/pins", "")
	if code != 200 || len(pins["messages"].([]any)) != 1 {
		t.Fatalf("expected 1 pin after unpin: %d %v", code, pins)
	}

	// --- forward ---

	code, fwd := c.call("POST", "/api/messages/"+msg1+"/forward",
		fmt.Sprintf(`{"project_id":%q}`, projB))
	if code != 201 {
		t.Fatalf("forward: %d %v", code, fwd)
	}
	fmsg := fwd["message"].(map[string]any)
	fwdID := fmsg["id"].(string)
	fwdMeta, _ := fmsg["forwarded"].(map[string]any)
	if fwdMeta == nil {
		t.Fatalf("forwarded metadata missing: %v", fmsg)
	}
	if fwdMeta["message_id"] != msg1 || fwdMeta["author"] != "Forwarder" {
		t.Fatalf("forwarded credits wrong: %v", fwdMeta)
	}
	if fmsg["body"] != "pin and forward me" {
		t.Fatalf("forward body: %v", fmsg["body"])
	}

	// the copy lives in B's conversation, attributed to the forwarder
	code, convB := c.call("GET", "/api/projects/"+projB+"/conversation", "")
	if code != 200 {
		t.Fatalf("conv B: %d", code)
	}
	code, lstB := c.call("GET", "/api/conversations/"+convB["id"].(string)+"/messages", "")
	if code != 200 {
		t.Fatalf("list B: %d", code)
	}
	var foundFwd bool
	for _, mm := range lstB["messages"].([]any) {
		m := mm.(map[string]any)
		if m["id"] == fwdID {
			foundFwd = true
			if m["author"].(map[string]any)["name"] != "Forwarder" {
				t.Fatalf("forward author: %v", m["author"])
			}
		}
	}
	if !foundFwd {
		t.Fatal("forwarded copy missing from target conversation")
	}

	// forwarding the copy still credits the root message, not the hop
	code, fwd2 := c.call("POST", "/api/messages/"+fwdID+"/forward",
		fmt.Sprintf(`{"project_id":%q}`, projC))
	if code != 201 {
		t.Fatalf("forward chain: %d %v", code, fwd2)
	}
	fwd2Meta, _ := fwd2["message"].(map[string]any)["forwarded"].(map[string]any)
	if fwd2Meta["message_id"] != msg1 {
		t.Fatalf("chain should credit the root message: %v", fwd2Meta)
	}

	// a stranger's project refuses: second user cannot pull from our workspace
	c2 := &e2eClient{t: t, base: srv.URL}
	code, _ = c2.call("POST", "/api/auth/register",
		fmt.Sprintf(`{"email":"str-%d@relay.dev","password":"strpass12345","name":"Stranger"}`,
			time.Now().UnixNano()))
	if code != 201 && code != 200 {
		t.Fatalf("register stranger: %d", code)
	}
	code, smsg := c2.call("POST", "/api/messages/"+msg1+"/forward",
		fmt.Sprintf(`{"project_id":%q}`, projB))
	if code != 404 {
		t.Fatalf("stranger forward should 404: %d %v", code, smsg)
	}
	code, spin := c2.call("PUT", "/api/messages/"+msg1+"/pin", "")
	if code != 404 {
		t.Fatalf("stranger pin should 404: %d %v", code, spin)
	}

	// forwarding to a project outside the caller's workspace also refuses
	code, ws2 := c2.call("POST", "/api/workspaces", `{"name":"Stranger WS"}`)
	if code != 201 && code != 200 {
		t.Fatalf("stranger ws: %d", code)
	}
	code, sproj := c2.call("POST", "/api/projects",
		fmt.Sprintf(`{"workspace_id":%q,"key":"STR","name":"Stranger Proj"}`, ws2["id"]))
	if code != 201 && code != 200 {
		t.Fatalf("stranger project: %d", code)
	}
	code, off := c.call("POST", "/api/messages/"+msg1+"/forward",
		fmt.Sprintf(`{"project_id":%q}`, sproj["id"]))
	if code != 404 {
		t.Fatalf("forward to foreign project should 404: %d %v", code, off)
	}

	// deleted sources cannot be forwarded
	code, doomed := c.call("POST", "/api/conversations/"+convA+"/messages",
		`{"body":"about to be deleted"}`)
	if code != 201 && code != 200 {
		t.Fatalf("post doomed: %d", code)
	}
	doomedID := doomed["id"].(string)
	if code, _ = c.call("DELETE", "/api/messages/"+doomedID, ""); code != 204 {
		t.Fatalf("delete doomed: %d", code)
	}
	code, dfwd := c.call("POST", "/api/messages/"+doomedID+"/forward",
		fmt.Sprintf(`{"project_id":%q}`, projB))
	if code != 404 {
		t.Fatalf("forward deleted should 404: %d %v", code, dfwd)
	}
	code, dpin := c.call("PUT", "/api/messages/"+doomedID+"/pin", "")
	if code != 404 {
		t.Fatalf("pin deleted should 404: %d %v", code, dpin)
	}

	// --- MCP parity: pin_message / forward_message need message:write on both ends ---

	code, agent := c.call("POST", "/api/workspaces/"+wsID+"/agents",
		`{"name":"Fwd Bot","review_mode":"gate"}`)
	if code != 201 && code != 200 {
		t.Fatalf("agent: %d %v", code, agent)
	}
	agentID := agent["id"].(string)
	for _, pid := range []string{projA, projB} {
		code, _ = c.call("PUT", fmt.Sprintf("/api/agents/%s/projects/%s", agentID, pid),
			`{"scopes":["project:read","message:read","message:write"]}`)
		if code != 200 {
			t.Fatalf("grant %s: %d", pid, code)
		}
	}
	// project C intentionally gets no grant — the scope check must bite there
	code, tok := c.call("POST", fmt.Sprintf("/api/agents/%s/tokens", agentID), `{"name":"e2e"}`)
	if code != 201 && code != 200 {
		t.Fatalf("mint: %d %v", code, tok)
	}
	token := tok["token"].(string)

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
		fmt.Sprintf(`{"name":"pin_message","arguments":{"message_id":%q,"pinned":true}}`, msg1))
	if env["error"] != nil {
		t.Fatalf("mcp pin: %v", env["error"])
	}
	_, env = c.mcp(token, sid, "3", "tools/call",
		fmt.Sprintf(`{"name":"forward_message","arguments":{"message_id":%q,"project_id":%q}}`, msg1, projB))
	fres := mcpToolResult(t, env)
	fwd3, _ := fres["message"].(map[string]any)
	if fwd3 == nil || fwd3["forwarded"] == nil {
		t.Fatalf("mcp forward: %v", fres)
	}

	// unscoped target refuses the tool call
	_, env = c.mcp(token, sid, "4", "tools/call",
		fmt.Sprintf(`{"name":"forward_message","arguments":{"message_id":%q,"project_id":%q}}`, msg1, projC))
	res, _ := env["result"].(map[string]any)
	if res["isError"] != true {
		t.Fatalf("mcp forward to unscoped project should error: %v", env)
	}

	// list_pins resolves a project_id to its conversation and returns pins
	_, env = c.mcp(token, sid, "5", "tools/call",
		fmt.Sprintf(`{"name":"list_pins","arguments":{"project_id":%q}}`, projA))
	pres := mcpToolResult(t, env)
	pinned, _ := pres["messages"].([]any)
	if len(pinned) != 1 {
		t.Fatalf("mcp list_pins: %v", pres)
	}
}
