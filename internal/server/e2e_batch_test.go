package server

// Batch-fix regressions: ideas CRUD + convert, bulk todo delete
// (project-scoped), brief delete (comment thread goes with it), and /clear
// resetting unread rows in threads orphaned by the wipe.
//
// Runs against a real Postgres (set RELAY_TEST_DATABASE_URL); skipped
// otherwise.

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	relaydb "github.com/Dvorinka/relay/db"
	"github.com/Dvorinka/relay/internal/config"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"go.uber.org/zap"
)

// e2eSetup spins the server, registers a user, workspace and project, and
// returns the client + ids. Mirrors the per-test boilerplate used elsewhere.
func e2eSetup(t *testing.T, tag string) (*e2eClient, *pgxpool.Pool, string, string) {
	t.Helper()
	dsn := os.Getenv("RELAY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("RELAY_TEST_DATABASE_URL unset")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

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
	t.Cleanup(srv.Close)
	c := &e2eClient{t: t, base: srv.URL}

	code, reg := c.call("POST", "/api/auth/register",
		fmt.Sprintf(`{"email":"%s-%d@relay.dev","password":"e2epass12345","name":"%s"}`,
			tag, time.Now().UnixNano(), tag))
	if code != 201 && code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	code, ws := c.call("POST", "/api/workspaces", `{"name":"Batch WS"}`)
	if code != 201 && code != 200 {
		t.Fatalf("workspace: %d %v", code, ws)
	}
	wsID := ws["id"].(string)
	code, proj := c.call("POST", "/api/projects",
		fmt.Sprintf(`{"workspace_id":%q,"key":"BAT","name":"Batch Lab"}`, wsID))
	if code != 201 && code != 200 {
		t.Fatalf("project: %d %v", code, proj)
	}
	return c, pool, wsID, proj["id"].(string)
}

// unreadConvIDs returns the set of conversation ids flagged unread for the
// signed-in user.
func unreadConvIDs(t *testing.T, c *e2eClient) map[string]float64 {
	t.Helper()
	code, un := c.call("GET", "/api/me/unread", "")
	if code != 200 {
		t.Fatalf("unread: %d", code)
	}
	out := map[string]float64{}
	for _, r := range un["conversations"].([]any) {
		row := r.(map[string]any)
		out[row["conversation_id"].(string)] = row["unread"].(float64)
	}
	return out
}

func TestBatchFixes(t *testing.T) {
	c, _, wsID, projID := e2eSetup(t, "bat")

	// --- bulk todo delete -------------------------------------------------
	todoIDs := make([]string, 0, 3)
	for _, body := range []string{"one", "two", "three"} {
		code, td := c.call("POST", "/api/projects/"+projID+"/todos",
			fmt.Sprintf(`{"content":%q}`, body))
		if code != 201 && code != 200 {
			t.Fatalf("create todo: %d %v", code, td)
		}
		todoIDs = append(todoIDs, td["id"].(string))
	}
	// a todo on a second project must not be deletable through this one's
	// bulk endpoint — the query is scoped by project_id.
	code, proj2 := c.call("POST", "/api/projects",
		fmt.Sprintf(`{"workspace_id":%q,"key":"BT2","name":"Batch Lab 2"}`, wsID))
	if code != 201 && code != 200 {
		t.Fatalf("project2: %d %v", code, proj2)
	}
	proj2ID := proj2["id"].(string)
	code, other := c.call("POST", "/api/projects/"+proj2ID+"/todos",
		`{"content":"other project's todo"}`)
	if code != 201 && code != 200 {
		t.Fatalf("other todo: %d %v", code, other)
	}
	otherID := other["id"].(string)

	code, del := c.call("POST", "/api/projects/"+projID+"/todos/delete",
		fmt.Sprintf(`{"ids":[%q,%q,%q]}`,
			todoIDs[0], todoIDs[1], otherID))
	if code != 200 {
		t.Fatalf("bulk delete: %d %v", code, del)
	}
	if del["deleted"].(float64) != 2 {
		t.Fatalf("deleted = %v, want 2 (cross-project id must not count)", del)
	}
	code, tl := c.call("GET", "/api/projects/"+projID+"/todos", "")
	if code != 200 {
		t.Fatalf("list todos: %d %v", code, tl)
	}
	remain := tl["todos"].([]any)
	if len(remain) != 1 || remain[0].(map[string]any)["id"] != todoIDs[2] {
		t.Fatalf("todos after bulk delete: %v", remain)
	}
	code, tl2 := c.call("GET", "/api/projects/"+proj2ID+"/todos", "")
	if code != 200 || len(tl2["todos"].([]any)) != 1 {
		t.Fatalf("other project's todo was deleted: %d %v", code, tl2)
	}

	// --- brief delete -----------------------------------------------------
	code, br := c.call("POST", "/api/projects/"+projID+"/briefs",
		`{"title":"Doomed brief","summary":"to be deleted","scene":{}}`)
	if code != 201 && code != 200 {
		t.Fatalf("create brief: %d %v", code, br)
	}
	briefID := br["id"].(string)
	code, bc := c.call("GET", "/api/briefs/"+briefID+"/conversation", "")
	if code != 200 {
		t.Fatalf("brief conversation: %d %v", code, bc)
	}
	briefConv := bc["id"].(string)
	code, _ = c.call("POST", "/api/conversations/"+briefConv+"/messages",
		`{"body":"comment on the brief"}`)
	if code != 201 && code != 200 {
		t.Fatalf("brief comment: %d", code)
	}
	code, _ = c.call("DELETE", "/api/briefs/"+briefID, "")
	if code != 204 {
		t.Fatalf("delete brief: %d", code)
	}
	code, _ = c.call("GET", "/api/briefs/"+briefID, "")
	if code != 404 {
		t.Fatalf("brief should be gone: %d", code)
	}
	// The comment conversation is deleted with the brief.
	code, _ = c.call("GET", "/api/conversations/"+briefConv+"/messages", "")
	if code != 404 && code != 403 {
		t.Fatalf("brief conversation should be gone: %d", code)
	}

	// --- ideas ------------------------------------------------------------
	code, id1 := c.call("POST", "/api/projects/"+projID+"/ideas",
		`{"title":"Mindmap one","summary":"first brainstorm","scene":{"elements":[]}}`)
	if code != 201 {
		t.Fatalf("create idea: %d %v", code, id1)
	}
	ideaID := id1["id"].(string)
	code, il := c.call("GET", "/api/projects/"+projID+"/ideas", "")
	if code != 200 || len(il["ideas"].([]any)) != 1 {
		t.Fatalf("list ideas: %d %v", code, il)
	}
	code, wi := c.call("GET", "/api/workspaces/"+wsID+"/ideas", "")
	if code != 200 || len(wi["ideas"].([]any)) != 1 {
		t.Fatalf("workspace ideas: %d %v", code, wi)
	}
	code, up := c.call("PATCH", "/api/ideas/"+ideaID,
		`{"summary":"revised"}`)
	if code != 200 || up["summary"] != "revised" {
		t.Fatalf("update idea: %d %v", code, up)
	}
	// convert to issue
	code, cv := c.call("POST", "/api/ideas/"+ideaID+"/convert", `{"kind":"issue"}`)
	if code != 201 {
		t.Fatalf("convert to issue: %d %v", code, cv)
	}
	issueID := cv["issue"].(map[string]any)["id"].(string)
	code, gi := c.call("GET", "/api/issues/"+issueID, "")
	if code != 200 {
		t.Fatalf("converted issue not fetchable: %d %v", code, gi)
	}
	// convert to project — second idea since the first is now "converted"
	// (conversion is allowed regardless; use it again for simplicity).
	code, cv2 := c.call("POST", "/api/ideas/"+ideaID+"/convert",
		`{"kind":"project","key":"BTP","title":"Spun Out"}`)
	if code != 201 {
		t.Fatalf("convert to project: %d %v", code, cv2)
	}
	if cv2["project"].(map[string]any)["key"] != "BTP" {
		t.Fatalf("project convert: %v", cv2)
	}
	code, _ = c.call("DELETE", "/api/ideas/"+ideaID, "")
	if code != 204 {
		t.Fatalf("delete idea: %d", code)
	}
	code, il = c.call("GET", "/api/projects/"+projID+"/ideas", "")
	if code != 200 || len(il["ideas"].([]any)) != 0 {
		t.Fatalf("ideas after delete: %d %v", code, il)
	}

	// --- /clear resets unread (incl. threads rooted at wiped messages) ----
	code, conv := c.call("GET", "/api/projects/"+projID+"/conversation", "")
	if code != 200 {
		t.Fatalf("conversation: %d %v", code, conv)
	}
	convID := conv["id"].(string)

	// an agent with message scopes posts — its messages are unread for me
	code, agent := c.call("POST", "/api/workspaces/"+wsID+"/agents",
		`{"name":"Clear Bot","review_mode":"notify"}`)
	if code != 201 && code != 200 {
		t.Fatalf("agent: %d %v", code, agent)
	}
	agentID := agent["id"].(string)
	code, _ = c.call("PUT",
		fmt.Sprintf("/api/agents/%s/projects/%s", agentID, projID),
		`{"scopes":["project:read","message:read","message:write"]}`)
	if code != 200 {
		t.Fatalf("grant: %d", code)
	}
	code, tok := c.call("POST",
		fmt.Sprintf("/api/agents/%s/tokens", agentID), `{"name":"e2e"}`)
	if code != 201 && code != 200 {
		t.Fatalf("mint: %d %v", code, tok)
	}
	token := tok["token"].(string)
	sid, _ := c.mcp(token, "", "1", "initialize",
		`{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}`)
	if sid == "" {
		t.Fatal("no mcp session id")
	}

	_, env := c.mcp(token, sid, "2", "tools/call",
		fmt.Sprintf(`{"name":"send_message","arguments":{"conversation_id":%q,"body":"unread parent"}}`, convID))
	amsg := mcpToolResult(t, env)
	parentID := amsg["id"].(string)

	// open a thread on it and have the agent reply inside — that reply lives
	// in the thread conversation, which survives /clear's message wipe.
	code, tr := c.call("POST", "/api/messages/"+parentID+"/thread", `{"title":"side"}`)
	if code != 201 && code != 200 {
		t.Fatalf("thread: %d %v", code, tr)
	}
	threadID := tr["thread"].(map[string]any)["id"].(string)
	_, env = c.mcp(token, sid, "3", "tools/call",
		fmt.Sprintf(`{"name":"send_message","arguments":{"conversation_id":%q,"body":"unread reply"}}`, threadID))
	_ = mcpToolResult(t, env)

	un := unreadConvIDs(t, c)
	if un[convID] != 1 || un[threadID] != 1 {
		t.Fatalf("expected unread in channel+thread, got %v", un)
	}

	code, _ = c.call("DELETE", "/api/conversations/"+convID+"/messages", "")
	if code != 200 {
		t.Fatalf("clear: %d", code)
	}
	if un := unreadConvIDs(t, c); len(un) != 0 {
		t.Fatalf("/clear left phantom unread rows: %v", un)
	}
}
