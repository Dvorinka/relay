package server

// Tenant-isolation e2e: cross-workspace denial regressions for the MCP
// activity feed, send_message create-before-scope, agent-invite deletion,
// deployment-global admin gates, and GitHub installation binding. Same
// harness as e2e_test.go — real Postgres via RELAY_TEST_DATABASE_URL.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
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
	"github.com/Dvorinka/relay/internal/secrets"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pressly/goose/v3"
	"github.com/jackc/pgx/v5/stdlib"
	"go.uber.org/zap"
)

func newIsolationServer(t *testing.T) (*pgxpool.Pool, string) {
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
	return pool, srv.URL
}

func registerUser(t *testing.T, c *e2eClient, tag string) map[string]any {
	t.Helper()
	code, reg := c.call("POST", "/api/auth/register",
		fmt.Sprintf(`{"email":"%s-%d@relay.dev","password":"isopass12345","name":%q}`,
			tag, time.Now().UnixNano(), tag))
	if code != 201 && code != 200 {
		t.Fatalf("register %s: %d %v", tag, code, reg)
	}
	return reg
}

func makeWorkspace(t *testing.T, c *e2eClient, name string) string {
	t.Helper()
	code, ws := c.call("POST", "/api/workspaces", fmt.Sprintf(`{"name":%q}`, name))
	if code != 201 && code != 200 {
		t.Fatalf("workspace %s: %d %v", name, code, ws)
	}
	return ws["id"].(string)
}

func makeProject(t *testing.T, c *e2eClient, wsID, key, name string) string {
	t.Helper()
	code, proj := c.call("POST", "/api/projects",
		fmt.Sprintf(`{"workspace_id":%q,"key":%q,"name":%q}`, wsID, key, name))
	if code != 201 && code != 200 {
		t.Fatalf("project %s: %d %v", name, code, proj)
	}
	return proj["id"].(string)
}

// grantAllAgent mints a workspace-wide agent token via the invite flow.
func grantAllAgent(t *testing.T, c *e2eClient, wsID, name string) string {
	t.Helper()
	code, inv := c.call("POST", "/api/workspaces/"+wsID+"/agent-invites", `{}`)
	if code != 201 && code != 200 {
		t.Fatalf("invite: %d %v", code, inv)
	}
	code, red := c.call("POST", "/api/agent-invites/redeem",
		fmt.Sprintf(`{"token":%q,"name":%q}`, inv["token"], name))
	if code != 201 && code != 200 {
		t.Fatalf("redeem: %d %v", code, red)
	}
	return red["token"].(string)
}

func mcpSession(t *testing.T, c *e2eClient, token string) string {
	t.Helper()
	sid, _ := c.mcp(token, "", "1", "initialize",
		`{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}`)
	if sid == "" {
		t.Fatal("no mcp session id")
	}
	req, _ := http.NewRequest("POST", c.base+"/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Mcp-Session-Id", sid)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err == nil {
		_ = res.Body.Close()
	}
	return sid
}

func toolText(env map[string]any) string {
	result, _ := env["result"].(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		return ""
	}
	m, _ := content[0].(map[string]any)
	s, _ := m["text"].(string)
	return s
}

// The grant_all activity queries once matched projects in every workspace —
// a workspace-wide agent could read another tenant's open issues and recent
// message bodies. The agent must see its own workspace's feed and nothing
// from the second tenant.
func TestAgentActivityStaysInWorkspace(t *testing.T) {
	_, base := newIsolationServer(t)
	cA := &e2eClient{t: t, base: base}
	registerUser(t, cA, "acta")
	wsA := makeWorkspace(t, cA, "Act WS A")
	projA := makeProject(t, cA, wsA, "ACTA", "Act A")

	cB := &e2eClient{t: t, base: base}
	registerUser(t, cB, "actb")
	wsB := makeWorkspace(t, cB, "Act WS B")
	projB := makeProject(t, cB, wsB, "ACTB", "Act B")

	// B's private data: an open issue and a message.
	code, iss := cB.call("POST", "/api/projects/"+projB+"/issues",
		`{"title":"secret issue of tenant B"}`)
	if code != 201 && code != 200 {
		t.Fatalf("issue B: %d %v", code, iss)
	}
	code, conv := cB.call("GET", "/api/projects/"+projB+"/conversation", "")
	if code != 200 {
		t.Fatalf("conversation B: %d %v", code, conv)
	}
	code, _ = cB.call("POST", "/api/conversations/"+conv["id"].(string)+"/messages",
		`{"body":"tenant B private chatter"}`)
	if code != 201 && code != 200 {
		t.Fatalf("message B: %d", code)
	}

	rly := grantAllAgent(t, cA, wsA, "Act Bot")
	sid := mcpSession(t, cA, rly)

	// own-workspace positive control
	code, convA := cA.call("GET", "/api/projects/"+projA+"/conversation", "")
	if code != 200 {
		t.Fatalf("conversation A: %d", code)
	}
	code, _ = cA.call("POST", "/api/conversations/"+convA["id"].(string)+"/messages",
		`{"body":"tenant A feed entry"}`)
	if code != 201 && code != 200 {
		t.Fatalf("message A: %d", code)
	}

	_, env := cA.mcp(rly, sid, "2", "tools/call",
		`{"name":"activity","arguments":{}}`)
	got := mcpToolResult(t, env)

	foundA, sawB := false, false
	for _, m := range got["recent_messages"].([]any) {
		msg := m.(map[string]any)
		if msg["body"] == "tenant B private chatter" {
			sawB = true
		}
		if msg["body"] == "tenant A feed entry" {
			foundA = true
		}
	}
	for _, i := range got["open_issues"].([]any) {
		item := i.(map[string]any)
		if item["title"] == "secret issue of tenant B" {
			sawB = true
		}
	}
	if sawB {
		t.Fatalf("activity leaked tenant B data: %v", got)
	}
	if !foundA {
		t.Fatalf("activity missing own-workspace message: %v", got)
	}
}

// send_message used to create the project conversation before the grant
// check — the write was denied but the row landed in the foreign project.
// Now scope runs first: denied, and no conversation row must exist.
func TestSendMessageDeniedLeavesNoConversation(t *testing.T) {
	pool, base := newIsolationServer(t)
	ctx := context.Background()

	cA := &e2eClient{t: t, base: base}
	registerUser(t, cA, "smga")
	wsA := makeWorkspace(t, cA, "Smg WS A")

	cB := &e2eClient{t: t, base: base}
	registerUser(t, cB, "smgb")
	wsB := makeWorkspace(t, cB, "Smg WS B")
	projB := makeProject(t, cB, wsB, "SMGB", "Smg B")

	rly := grantAllAgent(t, cA, wsA, "Smg Bot")
	sid := mcpSession(t, cA, rly)

	_, env := cA.mcp(rly, sid, "2", "tools/call",
		fmt.Sprintf(`{"name":"send_message","arguments":{"project_id":%q,"body":"intruder"}}`, projB))
	if got := toolText(env); !strings.Contains(got, "no grant") &&
		!strings.Contains(got, "missing scope") && !strings.Contains(got, "not granted") {
		t.Fatalf("cross-workspace send_message was not denied: %v", env)
	}

	var n int
	if err := pool.QueryRow(ctx,
		"select count(*) from conversations where project_id=$1", projB).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("denied send_message still created %d conversation rows", n)
	}
}

// DELETE /workspaces/:id/agent-invites/:inviteId ran the workspace gate on
// :id but deleted by invite id alone — an admin in workspace B who knew an
// invite UUID from workspace A could cancel A's invite.
func TestAgentInviteDeleteCrossWorkspace(t *testing.T) {
	_, base := newIsolationServer(t)
	cA := &e2eClient{t: t, base: base}
	registerUser(t, cA, "inva")
	wsA := makeWorkspace(t, cA, "Inv WS A")

	cB := &e2eClient{t: t, base: base}
	registerUser(t, cB, "invb")
	wsB := makeWorkspace(t, cB, "Inv WS B")

	code, inv := cA.call("POST", "/api/workspaces/"+wsA+"/agent-invites", `{}`)
	if code != 201 && code != 200 {
		t.Fatalf("invite: %d %v", code, inv)
	}
	invID := inv["id"].(string)

	// B's admin path must not reach A's invite.
	code, _ = cB.call("DELETE",
		fmt.Sprintf("/api/workspaces/%s/agent-invites/%s", wsB, invID), "")
	if code != 404 {
		t.Fatalf("cross-workspace invite delete = %d, want 404", code)
	}

	// invite survives: it still redeems.
	code, red := cA.call("POST", "/api/agent-invites/redeem",
		fmt.Sprintf(`{"token":%q,"name":"Survivor"}`, inv["token"]))
	if code != 201 && code != 200 {
		t.Fatalf("redeem after foreign delete attempt: %d %v", code, red)
	}

	// own-workspace delete still works for A's second invite.
	code, inv2 := cA.call("POST", "/api/workspaces/"+wsA+"/agent-invites", `{}`)
	if code != 201 && code != 200 {
		t.Fatalf("invite2: %d %v", code, inv2)
	}
	code, _ = cA.call("DELETE",
		fmt.Sprintf("/api/workspaces/%s/agent-invites/%s", wsA, inv2["id"]), "")
	if code != 204 && code != 200 {
		t.Fatalf("own invite delete = %d", code)
	}
}

// github_app and smtp_settings are deployment-global singletons. Before the
// fix any workspace owner — every registrant — could register/delete them.
// Only an owner/admin of the first workspace passes now.
func TestDeploymentAdminRequiresFirstWorkspace(t *testing.T) {
	pool, base := newIsolationServer(t)
	ctx := context.Background()

	// wsA exists first so wsB can never be the oldest row.
	cA := &e2eClient{t: t, base: base}
	registerUser(t, cA, "adma")
	makeWorkspace(t, cA, "Adm WS A")

	cB := &e2eClient{t: t, base: base}
	regB := registerUser(t, cB, "admb")
	makeWorkspace(t, cB, "Adm WS B")
	userB := regB["user"].(map[string]any)["id"].(string)

	// B's workspaces are all younger than A's — B must be denied everywhere.
	if code, res := cB.call("POST", "/api/github/app/manifest", ""); code != 403 {
		t.Fatalf("github manifest as non-first-ws admin = %d %v", code, res)
	}
	if code, res := cB.call("DELETE", "/api/github/app", ""); code != 403 {
		t.Fatalf("github app delete as non-first-ws admin = %d %v", code, res)
	}
	if code, res := cB.call("GET", "/api/settings/smtp", ""); code != 403 {
		t.Fatalf("smtp read as non-first-ws owner = %d %v", code, res)
	}

	// Promote B to owner of the actual first workspace — the positive path.
	var firstWS string
	if err := pool.QueryRow(ctx,
		"select id from workspaces order by created_at limit 1").Scan(&firstWS); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into workspace_members (workspace_id, user_id, role)
		 values ($1, $2, 'owner') on conflict do nothing`, firstWS, userB); err != nil {
		t.Fatal(err)
	}
	if code, res := cB.call("POST", "/api/github/app/manifest", ""); code != 200 {
		t.Fatalf("github manifest as first-ws admin = %d %v", code, res)
	}
	if code, res := cB.call("GET", "/api/settings/smtp", ""); code != 200 {
		t.Fatalf("smtp read as first-ws owner = %d %v", code, res)
	}
}

// installation.created webhooks carry no Relay workspace context. Binding
// must use the workspace that just asked for the install page, or the sole
// workspace on a self-host — never "whichever workspace is oldest". On a
// multi-tenant instance an unattributed install lands unclaimed and a
// workspace admin claims it; bound installs are never rebindable.
func TestGitHubInstallBinding(t *testing.T) {
	pool, base := newIsolationServer(t)
	ctx := context.Background()

	// Seed the app row directly — the manifest flow itself is covered by the
	// boundary test above; here the webhook just needs a secret to verify.
	whsec := "whsec-isolation-e2e"
	sealed, err := secrets.Seal([]byte(whsec), "test-secret-test-secret-test-secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into github_app (app_id, slug, name, client_id,
			client_secret_enc, private_key_enc, webhook_secret_enc)
		 values (1, 'iso-app', 'Iso', 'cid', $1, $1, $1)
		 on conflict (id) do update set webhook_secret_enc = excluded.webhook_secret_enc`,
		sealed); err != nil {
		t.Fatal(err)
	}

	cA := &e2eClient{t: t, base: base}
	registerUser(t, cA, "gba")
	wsA := makeWorkspace(t, cA, "Gb WS A")

	cB := &e2eClient{t: t, base: base}
	registerUser(t, cB, "gbb")
	wsB := makeWorkspace(t, cB, "Gb WS B")

	fire := func(delivery string, installationID int64, login string) {
		t.Helper()
		body := fmt.Sprintf(
			`{"action":"created","installation":{"id":%d,"account":{"login":%q,"type":"User"}}}`,
			installationID, login)
		mac := hmac.New(sha256.New, []byte(whsec))
		mac.Write([]byte(body))
		req, err := http.NewRequest("POST", base+"/api/github/webhook",
			strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		req.Header.Set("X-GitHub-Event", "installation")
		req.Header.Set("X-GitHub-Delivery", delivery)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
		if res.StatusCode != 202 {
			t.Fatalf("webhook = %d", res.StatusCode)
		}
	}

	// dispatch is async — wait for the installations row to appear.
	waitWS := func(installationID int64) *string {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			var ws *string
			err := pool.QueryRow(ctx,
				"select workspace_id::text from github_installations where installation_id=$1",
				installationID).Scan(&ws)
			if err == nil {
				return ws
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("installation %d never landed", installationID)
		return nil
	}

	suffix := time.Now().UnixNano() % 1_000_000
	instUnclaimed := 900_000_000 + suffix
	instBound := 910_000_000 + suffix

	// 1) no marker anywhere in this fresh server: install lands unclaimed,
	//    NOT in whichever workspace happens to be oldest.
	fire(fmt.Sprintf("iso-%d-1", suffix), instUnclaimed, "tenant-a-gh")
	if ws := waitWS(instUnclaimed); ws != nil {
		t.Fatalf("unattributed install bound to %v — must stay unclaimed", *ws)
	}

	// 2) B asks for the install page -> marker -> next install binds to B.
	code, list := cB.call("GET", "/api/workspaces/"+wsB+"/github/installations", "")
	if code != 200 {
		t.Fatalf("installations B: %d %v", code, list)
	}
	fire(fmt.Sprintf("iso-%d-2", suffix), instBound, "tenant-b-gh")
	if ws := waitWS(instBound); ws == nil || *ws != wsB {
		t.Fatalf("marked install bound to %v, want %s", ws, wsB)
	}

	// The unclaimed install is visible to workspace admins for claiming.
	code, list = cB.call("GET", "/api/workspaces/"+wsB+"/github/installations", "")
	if code != 200 {
		t.Fatalf("installations refetch: %d", code)
	}
	seenUnclaimed := false
	for _, u := range list["unclaimed"].([]any) {
		if u.(map[string]any)["installation_id"] == float64(instUnclaimed) {
			seenUnclaimed = true
		}
	}
	if !seenUnclaimed {
		t.Fatalf("unclaimed install not visible to admin: %v", list)
	}

	// 3) A claims the unclaimed install; B cannot steal A's bound one and
	//    A cannot rebind B's.
	code, _ = cA.call("POST",
		fmt.Sprintf("/api/workspaces/%s/github/installations/%d/claim", wsA, instUnclaimed), "")
	if code != 204 && code != 200 {
		t.Fatalf("claim unclaimed = %d", code)
	}
	code, _ = cA.call("POST",
		fmt.Sprintf("/api/workspaces/%s/github/installations/%d/claim", wsA, instBound), "")
	if code != 404 {
		t.Fatalf("rebinding B's install = %d, want 404", code)
	}
	code, _ = cB.call("POST",
		fmt.Sprintf("/api/workspaces/%s/github/installations/%d/claim", wsB, instUnclaimed), "")
	if code != 404 {
		t.Fatalf("stealing A's claimed install = %d, want 404", code)
	}
}

