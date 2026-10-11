package server

// End-to-end auto-filing: a message that opens with a report marker on a
// repo-linked project becomes a GitHub issue (against a stub API), mirrors
// back into Relay's issues table, and announces itself as a reply.
import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	relaydb "github.com/Dvorinka/relay/db"
	"github.com/Dvorinka/relay/internal/config"
	"github.com/Dvorinka/relay/internal/github"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"go.uber.org/zap/zaptest"
)

func TestAutoFileMessage(t *testing.T) {
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

	// Stub GitHub: PAT mode posts straight to apiBase; the client is swapped
	// package-wide, so save/restore around the test.
	var created atomic.Int32
	var ghTitle atomic.Value
	// Unique issue number per run — upsertGitHub keys on (repo, number), so
	// a fixed number against a shared database would update a prior run's
	// mirrored issue instead of creating this run's.
	ghNumber := int(time.Now().UnixNano() % 1000000)
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/repos/acme/demo/issues" {
			var body struct {
				Title string `json:"title"`
				Body  string `json:"body"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			ghTitle.Store(body.Title)
			created.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			resp, _ := json.Marshal(map[string]any{
				"number": ghNumber, "title": body.Title, "state": "open",
				"node_id": "n1", "html_url": fmt.Sprintf("https://gh.test/acme/demo/issues/%d", ghNumber),
			})
			_, _ = w.Write(resp)
			return
		}
		http.NotFound(w, r)
	}))
	defer gh.Close()
	defer github.SetAPIBaseForTest(gh.URL)()

	cfg := config.Config{
		DatabaseURL:     dsn,
		AuthSecret:      "test-secret-test-secret-test-secret",
		InsecureDev:     true,
		SessionTTLHours: 1,
		GitHubToken:     "stub-pat",
	}
	srv := httptest.NewServer(New(cfg, zaptest.NewLogger(t), pool, "test"))
	defer srv.Close()
	c := &e2eClient{t: t, base: srv.URL}

	code, reg := c.call("POST", "/api/auth/register",
		fmt.Sprintf(`{"email":"autofile-%d@relay.dev","password":"e2epass12345","name":"AF"}`,
			time.Now().UnixNano()))
	if code != 201 && code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	code, ws := c.call("POST", "/api/workspaces", `{"name":"AF WS"}`)
	if code != 201 && code != 200 {
		t.Fatalf("workspace: %d %v", code, ws)
	}
	wsID := ws["id"].(string)
	code, proj := c.call("POST", "/api/projects",
		fmt.Sprintf(`{"workspace_id":%q,"key":"AF","name":"AF Lab"}`, wsID))
	if code != 201 && code != 200 {
		t.Fatalf("project: %d %v", code, proj)
	}
	projID := proj["id"].(string)

	// Link the project to a repo — normally the install flow does this;
	// the stub client never reads installation rows, so IDs only need to
	// satisfy the FK shape.
	if _, err := pool.Exec(ctx,
		`insert into github_installations (workspace_id, installation_id, account_login)
		 values ($1, 424242, 'acme') on conflict (installation_id) do nothing`, wsID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into repositories (project_id, installation_id, owner, name)
		 values ($1, 424242, 'acme', 'demo')
		 on conflict (installation_id, owner, name)
		 do update set project_id = excluded.project_id`, projID); err != nil {
		t.Fatal(err)
	}

	code, conv := c.call("GET", "/api/projects/"+projID+"/conversation", "")
	if code != 200 {
		t.Fatalf("conversation: %d %v", code, conv)
	}
	convID := conv["id"].(string)

	// A prose message mentioning a bug must NOT file.
	code, _ = c.call("POST", "/api/conversations/"+convID+"/messages",
		`{"body":"the bug we saw yesterday is back"}`)
	if code != 201 && code != 200 {
		t.Fatalf("prose message: %d", code)
	}
	// A marked report must file.
	code, msg := c.call("POST", "/api/conversations/"+convID+"/messages",
		`{"body":"bug: login form clears itself on submit"}`)
	if code != 201 && code != 200 {
		t.Fatalf("marked message: %d", code)
	}
	msgID := msg["id"].(string)

	// Auto-filing runs async off the event bus — poll for the announce
	// reply rather than racing it.
	var announce map[string]any
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		code, lst := c.call("GET", "/api/conversations/"+convID+"/messages", "")
		if code != 200 {
			continue
		}
		for _, m := range lst["messages"].([]any) {
			mm := m.(map[string]any)
			if s, _ := mm["body"].(string); len(s) > 8 && s[:8] == "Filed on" {
				announce = mm
			}
		}
		if announce != nil {
			break
		}
	}
	if announce == nil {
		t.Fatal("no announce reply appeared")
	}
	if created.Load() != 1 {
		t.Fatalf("github issue posts = %d, want 1", created.Load())
	}
	if v, _ := ghTitle.Load().(string); v != "login form clears itself on submit" {
		t.Fatalf("github issue title = %q", v)
	}
	if p, _ := announce["parent"].(map[string]any); p["id"] != msgID {
		t.Fatalf("announce parent = %v, want %s", p["id"], msgID)
	}
	// The mirrored issue sits on the Relay board, linked to the GH number.
	var n int
	if err := pool.QueryRow(ctx,
		`select count(*) from issues where project_id=$1 and github_number=$2`,
		projID, ghNumber).Scan(&n); err != nil || n != 1 {
		t.Fatalf("mirrored issues = %d (err %v)", n, err)
	}
}

// Manual filing: POST /api/messages/:id/github pushes any user message —
// marker or not — to a linked repo, with repo_id disambiguating projects
// that link several.
func TestManualFileMessage(t *testing.T) {
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

	var created atomic.Int32
	// Incrementing numbers — upsertGitHub keys on (repo, number), so each
	// created issue needs a fresh one across the cases below.
	var next atomic.Int64
	next.Store(time.Now().UnixNano() % 1000000)
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost &&
			strings.HasPrefix(r.URL.Path, "/repos/") &&
			strings.HasSuffix(r.URL.Path, "/issues") {
			var body struct {
				Title string `json:"title"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			created.Add(1)
			num := next.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			resp, _ := json.Marshal(map[string]any{
				"number": num, "title": body.Title, "state": "open",
				"node_id": "n1", "html_url": fmt.Sprintf("https://gh.test%s/%d", r.URL.Path, num),
			})
			_, _ = w.Write(resp)
			return
		}
		http.NotFound(w, r)
	}))
	defer gh.Close()
	defer github.SetAPIBaseForTest(gh.URL)()

	cfg := config.Config{
		DatabaseURL:     dsn,
		AuthSecret:      "test-secret-test-secret-test-secret",
		InsecureDev:     true,
		SessionTTLHours: 1,
		GitHubToken:     "stub-pat",
	}
	srv := httptest.NewServer(New(cfg, zaptest.NewLogger(t), pool, "test"))
	defer srv.Close()
	c := &e2eClient{t: t, base: srv.URL}

	code, reg := c.call("POST", "/api/auth/register",
		fmt.Sprintf(`{"email":"manfile-%d@relay.dev","password":"e2epass12345","name":"MF"}`,
			time.Now().UnixNano()))
	if code != 201 && code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	code, ws := c.call("POST", "/api/workspaces", `{"name":"MF WS"}`)
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
	inst := time.Now().UnixNano() % 100000
	if _, err := pool.Exec(ctx,
		`insert into github_installations (workspace_id, installation_id, account_login)
		 values ($1, $2, 'acme') on conflict (installation_id) do nothing`, wsID, inst); err != nil {
		t.Fatal(err)
	}
	linkRepo := func(projID, owner, name string) string {
		if _, err := pool.Exec(ctx,
			`insert into repositories (project_id, installation_id, owner, name)
			 values ($1, $2, $3, $4)
			 on conflict (installation_id, owner, name)
			 do update set project_id = excluded.project_id`,
			projID, inst, owner, name); err != nil {
			t.Fatal(err)
		}
		var id string
		if err := pool.QueryRow(ctx,
			`select id from repositories where installation_id=$1 and owner=$2 and name=$3`,
			inst, owner, name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	postMsg := func(projID, body string) string {
		code, conv := c.call("GET", "/api/projects/"+projID+"/conversation", "")
		if code != 200 {
			t.Fatalf("conversation: %d %v", code, conv)
		}
		code, msg := c.call("POST",
			"/api/conversations/"+conv["id"].(string)+"/messages",
			fmt.Sprintf(`{"body":%q}`, body))
		if code != 201 && code != 200 {
			t.Fatalf("message: %d %v", code, msg)
		}
		return msg["id"].(string)
	}

	// Single repo: an unmarked message files directly.
	p1 := newProject("MF1", "MF One")
	linkRepo(p1, "acme", "demo")
	m1 := postMsg(p1, "scroll position resets after reload")
	code, res := c.call("POST", "/api/messages/"+m1+"/github", `{}`)
	if code != 201 {
		t.Fatalf("file: %d %v", code, res)
	}
	issue, _ := res["issue"].(map[string]any)
	if issue["number"] == nil || issue["url"] == nil {
		t.Fatalf("issue payload: %v", res)
	}

	// Zero repos: 409, nothing created.
	p0 := newProject("MF0", "MF Zero")
	m0 := postMsg(p0, "nothing to file against")
	code, res = c.call("POST", "/api/messages/"+m0+"/github", `{}`)
	if code != 409 {
		t.Fatalf("no-repo file: %d %v", code, res)
	}

	// Two repos: no repo_id → 400; foreign repo_id → 400; valid → 201.
	p2 := newProject("MF2", "MF Two")
	repoA := linkRepo(p2, "acme", "alpha")
	linkRepo(p2, "acme", "beta")
	m2 := postMsg(p2, "ambiguous report")
	if code, res = c.call("POST", "/api/messages/"+m2+"/github", `{}`); code != 400 {
		t.Fatalf("ambiguous file: %d %v", code, res)
	}
	other := newProject("MF3", "MF Three")
	foreign := linkRepo(other, "acme", "other")
	code, res = c.call("POST", "/api/messages/"+m2+"/github",
		fmt.Sprintf(`{"repo_id":%q}`, foreign))
	if code != 400 {
		t.Fatalf("foreign repo file: %d %v", code, res)
	}
	code, res = c.call("POST", "/api/messages/"+m2+"/github",
		fmt.Sprintf(`{"repo_id":%q}`, repoA))
	if code != 201 {
		t.Fatalf("picked repo file: %d %v", code, res)
	}

	// A non-member cannot reach the message at all.
	c2 := &e2eClient{t: t, base: srv.URL}
	code, _ = c2.call("POST", "/api/auth/register",
		fmt.Sprintf(`{"email":"outsider-%d@relay.dev","password":"e2epass12345","name":"Out"}`,
			time.Now().UnixNano()))
	if code != 201 && code != 200 {
		t.Fatalf("register outsider: %d", code)
	}
	if code, res = c2.call("POST", "/api/messages/"+m1+"/github", `{}`); code != 404 {
		t.Fatalf("outsider file: %d %v", code, res)
	}

	// Two successful filings only — auto-filing must not have doubled any.
	if created.Load() != 2 {
		t.Fatalf("github issue posts = %d, want 2", created.Load())
	}
}
