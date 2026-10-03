// Package github implements the GitHub App integration: manifest-based app
// registration, installation tracking, repo linking, HMAC-verified webhooks
// with delivery-id idempotency, and the project development panel.
package github

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/config"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
)

type Service struct {
	cfg  config.Config
	log  *zap.Logger
	q    *db.Queries
	pool *pgxpool.Pool

	mu     sync.Mutex
	client *Client  // built lazily from the stored app row
	cache  sync.Map // dev-panel cache: key -> {data, expiry}

	// dispatchMu serializes webhook processing: GitHub delivers resource events
	// in order, and concurrent handlers would race read-modify-write.
	dispatchMu sync.Mutex
}

type cacheEntry struct {
	data   any
	expiry time.Time
}

func NewService(cfg config.Config, log *zap.Logger, pool *pgxpool.Pool) *Service {
	return &Service{cfg: cfg, log: log, q: db.New(pool), pool: pool}
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup, pub *gin.RouterGroup) {
	g.GET("/github/app", s.handleGetApp)
	g.POST("/github/app/manifest", s.adminOnly, s.handleManifest)
	g.DELETE("/github/app", s.adminOnly, s.handleDeleteApp)
	g.GET("/workspaces/:id/github/installations", s.memberOnly, s.handleInstallations)
	g.GET("/workspaces/:id/github/repos", s.memberOnly, s.handleAvailableRepos)
	g.GET("/projects/:id/github/repos", s.projectMemberOnly, s.handleProjectRepos)
	g.PUT("/projects/:id/github/repo", s.projectAdminOnly, s.handleLinkRepo)
	g.DELETE("/projects/:id/github/repo/:repoId", s.projectAdminOnly, s.handleUnlinkRepo)
	g.GET("/projects/:id/development", s.projectMemberOnly, s.handleDevelopment)
	g.GET("/projects/:id/github/files", s.projectMemberOnly, s.handleRepoTree)
	g.GET("/projects/:id/github/files/read", s.projectMemberOnly, s.handleRepoFile)
	g.POST("/projects/:id/github/import", s.projectAdminOnly, s.handleImport)
	// browser redirect targets / webhook entry
	pub.GET("/github/callback", s.handleCallback)
	pub.GET("/github/manifest-page", s.handleManifestPage)
	pub.POST("/github/webhook", s.handleWebhook)
}

// --- app registration (manifest flow) ---

func (s *Service) handleGetApp(c *gin.Context) {
	app, err := s.q.GetGitHubApp(c.Request.Context())
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(http.StatusOK, gin.H{"registered": false})
		return
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"registered": true, "app_id": app.AppID, "slug": app.Slug,
		"name": app.Name, "install_url": "https://github.com/apps/" + app.Slug + "/installations/new",
	})
}

// handleManifest returns the manifest JSON and the URL to POST it to. The
// browser auto-submits a form to github.com/settings/apps/new; GitHub then
// redirects to our callback with a one-shot code.
func (s *Service) handleManifest(c *gin.Context) {
	ws := c.Query("workspace")
	name := c.DefaultQuery("name", "relay")
	homepage := s.cfg.LandingURL
	if homepage == "" {
		homepage = s.cfg.PublicURL
	}
	manifest := gin.H{
		"name": "Relay (" + name + ")",
		"url":  homepage,
		"hook_attributes": gin.H{
			"url":    s.cfg.PublicURL + "/api/github/webhook",
			"active": true,
		},
		"redirect_url": s.cfg.PublicURL + "/api/github/callback?ws=" + url.QueryEscape(ws),
		"setup_url":    s.cfg.PublicURL + "/app/settings",
		"public":       false,
		"default_permissions": gin.H{
			"issues":        "write",
			"pull_requests": "read",
			"contents":      "read",
			"metadata":      "read",
		},
		// "installation" is not a valid default_events entry - GitHub delivers
		// it to the app webhook automatically.
		"default_events": []string{"issues", "pull_request", "push"},
	}
	// page_url is a public auto-submitting page that POSTs the manifest to
	// github.com — desktop shells open it in the system browser, where the
	// user's GitHub session actually lives. The manifest contains no
	// secrets (those arrive later via the conversion), so embedding it in a
	// URL is safe.
	raw, _ := json.Marshal(manifest)
	c.JSON(http.StatusOK, gin.H{
		"manifest": manifest,
		"post_url": "https://github.com/settings/apps/new",
		"page_url": s.cfg.PublicURL + "/api/github/manifest-page?m=" +
			base64.RawURLEncoding.EncodeToString(raw),
	})
}

// handleManifestPage serves the auto-submitting manifest POST as a public
// page. The desktop app hands this URL to the OS browser; the SPA could also
// use it, but it submits the form itself since it already runs in a browser.
func (s *Service) handleManifestPage(c *gin.Context) {
	raw, err := base64.RawURLEncoding.DecodeString(c.Query("m"))
	if err != nil || len(raw) == 0 || len(raw) > 64<<10 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "bad manifest payload")
		return
	}
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "bad manifest payload")
		return
	}
	// The global CSP forbids inline scripts; this page's only job is its
	// auto-submit. Everything else stays locked down.
	c.Header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(`<!doctype html><meta charset="utf-8">
<title>Relay — register GitHub App</title>
<body style="font:14px system-ui;color:#9c9fa7;background:#0a0a0b;display:grid;place-items:center;min-height:100vh;margin:0">
<p>Opening GitHub…</p>
<form id="f" method="post" action="https://github.com/settings/apps/new">
<input type="hidden" name="manifest" value="`+html.EscapeString(string(raw))+`">
</form><script>document.getElementById('f').submit()</script>`))
}

type manifestConversion struct {
	ID            int64  `json:"id"`
	Slug          string `json:"slug"`
	Name          string `json:"name"`
	ClientID      string `json:"client_id"`
	ClientSecret  string `json:"client_secret"`
	WebhookSecret string `json:"webhook_secret"`
	PEM           string `json:"pem"`
}

func (s *Service) handleCallback(c *gin.Context) {
	code := c.Query("code")
	if code == "" {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "missing code")
		return
	}
	req, _ := http.NewRequestWithContext(c.Request.Context(), "POST",
		apiBase+"/app-manifests/"+code+"/conversions", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		httpx.Error(c, http.StatusBadGateway, "github_error", "manifest conversion failed")
		return
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != 201 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		s.log.Error("manifest conversion", zap.Int("status", res.StatusCode), zap.String("body", string(raw)))
		httpx.Error(c, http.StatusBadGateway, "github_error", "manifest conversion rejected")
		return
	}
	var mc manifestConversion
	if err := json.NewDecoder(res.Body).Decode(&mc); err != nil {
		httpx.Error(c, http.StatusBadGateway, "github_error", "bad manifest response")
		return
	}
	cs, _ := seal([]byte(mc.ClientSecret), s.cfg.AuthSecret)
	pk, _ := seal([]byte(mc.PEM), s.cfg.AuthSecret)
	wh, _ := seal([]byte(mc.WebhookSecret), s.cfg.AuthSecret)
	if err := s.q.UpsertGitHubApp(c.Request.Context(), db.UpsertGitHubAppParams{
		AppID: mc.ID, Slug: mc.Slug, Name: mc.Name, ClientID: mc.ClientID,
		ClientSecretEnc: cs, PrivateKeyEnc: pk, WebhookSecretEnc: wh,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.resetClient()
	// back to the app UI; ws param carries the workspace for context
	c.Redirect(http.StatusFound, "/app/settings?github=registered")
}

func (s *Service) handleDeleteApp(c *gin.Context) {
	if err := s.q.DeleteGitHubApp(c.Request.Context()); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.resetClient()
	c.Status(http.StatusNoContent)
}

// --- github REST client ---

// Client returns the GitHub REST client (lazily built from the stored app).
func (s *Service) Client(ctx context.Context) (*Client, error) {
	return s.githubClient(ctx)
}

func (s *Service) githubClient(ctx context.Context) (*Client, error) {
	s.mu.Lock()
	if s.client != nil {
		c := s.client
		s.mu.Unlock()
		return c, nil
	}
	s.mu.Unlock()
	// GITHUB_TOKEN dev override: when set, REST calls bypass the app/installation
	// flow entirely. Webhooks still need a registered app.
	if s.cfg.GitHubToken != "" {
		c := NewPATClient(s.cfg.GitHubToken)
		s.mu.Lock()
		s.client = c
		s.mu.Unlock()
		return c, nil
	}
	// Local-gh fallback: self-hosted/dev installs without an app use the
	// operator's `gh auth token` as a PAT — same REST surface, zero setup.
	if tok, err := ghCLIToken(ctx); err == nil && tok != "" {
		c := NewPATClient(tok)
		s.mu.Lock()
		s.client = c
		s.mu.Unlock()
		s.log.Info("github auth via local gh CLI")
		return c, nil
	}
	app, err := s.q.GetGitHubApp(ctx)
	if err != nil {
		return nil, errors.New("github app not registered")
	}
	key, err := open(app.PrivateKeyEnc, s.cfg.AuthSecret)
	if err != nil {
		return nil, err
	}
	c := NewClient(app.AppID, key)
	s.mu.Lock()
	s.client = c
	s.mu.Unlock()
	return c, nil
}

func (s *Service) resetClient() {
	s.mu.Lock()
	s.client = nil
	s.mu.Unlock()
}

// ghCLIToken shells out to the GitHub CLI for a token. Returns "" when gh is
// absent or unauthenticated — callers treat that as "no provider".
func ghCLIToken(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "gh", "auth", "token")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// --- installations & repos ---

func (s *Service) handleInstallations(c *gin.Context) {
	wsID, _ := httpx.PathUUID(c, "id")
	rows, err := s.q.ListInstallationsForWorkspace(c.Request.Context(), wsID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	app, _ := s.q.GetGitHubApp(c.Request.Context())
	out := gin.H{"installations": rows}
	if app.AppID != 0 {
		out["install_url"] = "https://github.com/apps/" + app.Slug + "/installations/new"
	}
	c.JSON(http.StatusOK, out)
}

func (s *Service) handleAvailableRepos(c *gin.Context) {
	wsID, _ := httpx.PathUUID(c, "id")
	installs, err := s.q.ListInstallationsForWorkspace(c.Request.Context(), wsID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	cli, err := s.githubClient(c.Request.Context())
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "not_registered", "GitHub App is not registered")
		return
	}
	type repoOut struct {
		InstallationID int64  `json:"installation_id"`
		FullName       string `json:"full_name"`
		Owner          string `json:"owner"`
		Name           string `json:"name"`
		DefaultBranch  string `json:"default_branch"`
		Private        bool   `json:"private"`
	}
	var repos []repoOut
	if cli.IsPAT() {
		list, err := cli.ListViewerRepos(c.Request.Context())
		if err != nil {
			httpx.Error(c, http.StatusBadGateway, "github_error", "could not list repositories")
			return
		}
		for _, r := range list {
			owner, name, _ := strings.Cut(r.FullName, "/")
			repos = append(repos, repoOut{0, r.FullName, owner, name, r.DefaultBranch, r.Private})
		}
		c.JSON(http.StatusOK, gin.H{"repos": repos})
		return
	}
	for _, in := range installs {
		list, err := cli.ListInstallationRepos(c.Request.Context(), in.InstallationID)
		if err != nil {
			s.log.Warn("list installation repos", zap.Int64("install", in.InstallationID), zap.Error(err))
			continue
		}
		for _, r := range list {
			owner, name, _ := strings.Cut(r.FullName, "/")
			repos = append(repos, repoOut{in.InstallationID, r.FullName, owner, name, r.DefaultBranch, r.Private})
		}
	}
	c.JSON(http.StatusOK, gin.H{"repos": repos})
}

func (s *Service) handleProjectRepos(c *gin.Context) {
	p := project(c)
	rows, err := s.q.ListProjectRepos(c.Request.Context(), p.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, repoJSON(r))
	}
	c.JSON(http.StatusOK, gin.H{"repos": out})
}

func repoJSON(r db.Repository) gin.H {
	return gin.H{
		"id": r.ID, "owner": r.Owner, "name": r.Name,
		"full_name": r.Owner + "/" + r.Name, "default_branch": r.DefaultBranch,
		"installation_id": r.InstallationID, "url": "https://github.com/" + r.Owner + "/" + r.Name,
	}
}

func (s *Service) handleLinkRepo(c *gin.Context) {
	p := project(c)
	var req struct {
		InstallationID int64  `json:"installation_id"`
		Owner          string `json:"owner" binding:"required"`
		Name           string `json:"name" binding:"required"`
		DefaultBranch  string `json:"default_branch"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if req.DefaultBranch == "" {
		req.DefaultBranch = "main"
	}
	if req.InstallationID == 0 {
		// Personal-token modes (GITHUB_TOKEN or local `gh`) have no real
		// installation — a synthetic id-0 row groups their repo links.
		cli, cerr := s.githubClient(c.Request.Context())
		if cerr != nil || !cli.IsPAT() {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown installation")
			return
		}
		if _, err := s.q.UpsertInstallation(c.Request.Context(), db.UpsertInstallationParams{
			WorkspaceID: p.WorkspaceID, InstallationID: 0,
			AccountLogin: "(token)", AccountType: "Token",
		}); err != nil {
			s.log.Error("upsert token installation", zap.Error(err))
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
	}
	inst, err := s.q.GetInstallationByInstallID(c.Request.Context(), req.InstallationID)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown installation")
		return
	}
	if inst.WorkspaceID != p.WorkspaceID {
		httpx.Error(c, http.StatusForbidden, "forbidden", "installation belongs to another workspace")
		return
	}
	uid := auth.CurrentUser(c).ID
	row, err := s.q.UpsertRepoLink(c.Request.Context(), db.UpsertRepoLinkParams{
		ProjectID: p.ID, InstallationID: req.InstallationID,
		Owner: req.Owner, Name: req.Name, DefaultBranch: req.DefaultBranch,
		LinkedBy: uid,
	})
	if err != nil {
		s.log.Error("link repo", zap.Error(err))
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusCreated, repoJSON(row))
}

func (s *Service) handleUnlinkRepo(c *gin.Context) {
	p := project(c)
	rid, ok := httpx.PathUUID(c, "repoId")
	if !ok {
		return
	}
	r, err := s.q.GetRepoByID(c.Request.Context(), rid)
	if err != nil || r.ProjectID != p.ID {
		httpx.Error(c, http.StatusNotFound, "not_found", "repo not linked to this project")
		return
	}
	if err := s.q.DeleteRepoLink(c.Request.Context(), rid); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.Status(http.StatusNoContent)
}

// --- development panel (60s in-memory cache) ---

func (s *Service) handleDevelopment(c *gin.Context) {
	p := project(c)
	key := "dev:" + p.ID.String()
	if v, ok := s.cache.Load(key); ok {
		if e := v.(cacheEntry); time.Now().Before(e.expiry) {
			c.JSON(http.StatusOK, e.data)
			return
		}
	}
	repos, err := s.q.ListProjectRepos(c.Request.Context(), p.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	cli, cliErr := s.githubClient(c.Request.Context())
	type repoPanel struct {
		Repo    gin.H   `json:"repo"`
		Issues  []gin.H `json:"issues"`
		PRs     []gin.H `json:"prs"`
		Commits []gin.H `json:"commits"`
		Error   string  `json:"error,omitempty"`
	}
	panels := make([]repoPanel, 0, len(repos))
	for _, r := range repos {
		panel := repoPanel{Repo: repoJSON(r), Issues: []gin.H{}, PRs: []gin.H{}, Commits: []gin.H{}}
		if cliErr != nil {
			panel.Error = "github app not registered"
			panels = append(panels, panel)
			continue
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
		if issues, err := cli.ListIssues(ctx, r.InstallationID, r.Owner, r.Name); err != nil {
			panel.Error = "issues: " + err.Error()
		} else {
			for _, i := range issues {
				panel.Issues = append(panel.Issues, gin.H{
					"number": i.Number, "title": i.Title, "state": i.State,
					"url": i.HTMLURL, "author": i.User.Login,
					"updated_at": i.UpdatedAt,
				})
			}
		}
		if prs, err := cli.ListPRs(ctx, r.InstallationID, r.Owner, r.Name); err == nil {
			for _, pr := range prs {
				panel.PRs = append(panel.PRs, gin.H{
					"number": pr.Number, "title": pr.Title, "state": pr.State,
					"draft": pr.Draft, "url": pr.HTMLURL, "author": pr.User.Login,
					"head": pr.Head.Ref, "base": pr.Base.Ref,
				})
			}
		}
		if commits, err := cli.ListCommits(ctx, r.InstallationID, r.Owner, r.Name, r.DefaultBranch); err == nil {
			for _, cm := range commits {
				msg, _, _ := strings.Cut(cm.Commit.Message, "\n")
				panel.Commits = append(panel.Commits, gin.H{
					"sha": cm.SHA[:7], "message": msg, "url": cm.HTMLURL,
					"author": cm.Commit.Author.Name, "date": cm.Commit.Author.Date,
				})
			}
		}
		cancel()
		panels = append(panels, panel)
	}
	payload := gin.H{"repos": panels, "fetched_at": time.Now()}
	s.cache.Store(key, cacheEntry{data: payload, expiry: time.Now().Add(60 * time.Second)})
	c.JSON(http.StatusOK, payload)
}

// --- webhook ---

// validSignature checks GitHub's X-Hub-Signature-256 (HMAC-SHA256 of the raw body).
func validSignature(secret, body []byte, header string) bool {
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(header), []byte(expected))
}

func (s *Service) handleWebhook(c *gin.Context) {
	app, err := s.q.GetGitHubApp(c.Request.Context())
	if err != nil {
		c.Status(http.StatusServiceUnavailable)
		return
	}
	secret, err := open(app.WebhookSecretEnc, s.cfg.AuthSecret)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 2<<20))
	if err != nil {
		c.Status(http.StatusBadRequest)
		return
	}
	if !validSignature(secret, body, c.GetHeader("X-Hub-Signature-256")) {
		c.Status(http.StatusUnauthorized)
		return
	}
	delivery := c.GetHeader("X-GitHub-Delivery")
	event := c.GetHeader("X-GitHub-Event")
	if delivery == "" || event == "" {
		c.Status(http.StatusBadRequest)
		return
	}
	// idempotent: seen delivery -> 200 without reprocessing
	if seen, _ := s.q.HasGitHubEvent(c.Request.Context(), delivery); seen {
		c.Status(http.StatusOK)
		return
	}
	if err := s.q.RecordGitHubEvent(c.Request.Context(), db.RecordGitHubEventParams{
		DeliveryID: delivery, Event: event,
	}); err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	go s.dispatch(event, body)
	c.Status(http.StatusAccepted)
}

type webhookPayload struct {
	Action       string `json:"action"`
	Installation *struct {
		ID int64 `json:"id"`
	} `json:"installation"`
	Repository *struct {
		Name     string `json:"name"`
		FullName string `json:"full_name"`
		Owner    struct {
			Login string `json:"login"`
			Type  string `json:"type"`
		} `json:"owner"`
	} `json:"repository"`
	Issue *struct {
		Number  int    `json:"number"`
		Title   string `json:"title"`
		Body    string `json:"body"`
		State   string `json:"state"`
		NodeID  string `json:"node_id"`
		HTMLURL string `json:"html_url"`
	} `json:"issue"`
	PullRequest *struct {
		Number  int    `json:"number"`
		Title   string `json:"title"`
		Body    string `json:"body"`
		State   string `json:"state"`
		Merged  bool   `json:"merged"`
		Draft   bool   `json:"draft"`
		NodeID  string `json:"node_id"`
		HTMLURL string `json:"html_url"`
		User    struct {
			Login string `json:"login"`
		} `json:"user"`
	} `json:"pull_request"`
}

func (s *Service) dispatch(event string, body []byte) {
	s.dispatchMu.Lock()
	defer s.dispatchMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var p webhookPayload
	if err := json.Unmarshal(body, &p); err != nil {
		s.log.Warn("webhook decode", zap.Error(err))
		return
	}
	switch event {
	case "installation":
		s.onInstallation(ctx, body, p)
	case "issues":
		s.onIssue(ctx, p)
	case "pull_request":
		s.onPullRequest(ctx, p)
	}
}

func (s *Service) onInstallation(ctx context.Context, body []byte, p webhookPayload) {
	var full struct {
		Action       string `json:"action"`
		Installation struct {
			ID      int64 `json:"id"`
			Account struct {
				Login string `json:"login"`
				Type  string `json:"type"`
			} `json:"account"`
		} `json:"installation"`
	}
	if err := json.Unmarshal(body, &full); err != nil {
		return
	}
	switch full.Action {
	case "created":
		// attach to every workspace for now: the installer chooses scope on
		// the GitHub side; linking is per-project anyway
		ws, err := s.firstWorkspace(ctx)
		if err != nil {
			s.log.Warn("installation created but no workspace", zap.Error(err))
			return
		}
		if _, err := s.q.UpsertInstallation(ctx, db.UpsertInstallationParams{
			WorkspaceID: ws, InstallationID: full.Installation.ID,
			AccountLogin: full.Installation.Account.Login,
			AccountType:  full.Installation.Account.Type,
		}); err != nil {
			s.log.Warn("upsert installation", zap.Error(err))
		}
	case "deleted":
		_ = s.q.DeleteInstallation(ctx, full.Installation.ID)
	}
}

func (s *Service) firstWorkspace(ctx context.Context) (pgtype.UUID, error) {
	var id pgtype.UUID
	err := s.pool.QueryRow(ctx, "select id from workspaces order by created_at limit 1").Scan(&id)
	return id, err
}

func (s *Service) onIssue(ctx context.Context, p webhookPayload) {
	if p.Issue == nil || p.Repository == nil || p.Installation == nil {
		return
	}
	repo, err := s.q.GetRepoForIssue(ctx, db.GetRepoForIssueParams{
		InstallationID: p.Installation.ID,
		Owner:          p.Repository.Owner.Login,
		Name:           p.Repository.Name,
	})
	if err != nil {
		return // repo not linked to any project — ignore
	}
	item := importItem{
		kind:   "issue",
		number: p.Issue.Number,
		title:  p.Issue.Title,
		body:   p.Issue.Body,
		state:  p.Issue.State,
		url:    p.Issue.HTMLURL,
		nodeID: p.Issue.NodeID,
		status: issueStatus(p.Issue.State),
	}
	_, created, err := s.upsertGitHub(ctx, repo, item)
	if err != nil {
		s.log.Warn("mirror issue", zap.Error(err))
		return
	}
	if created {
		s.ghActivity(ctx, item.issueID, "github_mirrored",
			fmt.Sprintf(`{"repo":"%s","number":%d,"state":%q}`, repo.Owner+"/"+repo.Name, p.Issue.Number, p.Issue.State))
	}
}

// importItem is one GitHub object normalized for upsertGitHub.
type importItem struct {
	kind    string // 'issue' | 'pr'
	number  int
	title   string
	body    string
	state   string // raw GitHub state: open|closed|merged
	url     string
	nodeID  string
	status  string      // mapped Relay status
	issueID pgtype.UUID // filled by upsertGitHub
}

// issueStatus maps a GitHub issue state onto a Relay status.
func issueStatus(state string) string {
	if state == "closed" {
		return "done"
	}
	return "todo"
}

// prStatus maps a GitHub PR onto a Relay status: merged lands done, closed
// without merge lands cancelled, drafts park in todo, open sits in review.
func prStatus(state string, merged, draft bool) string {
	switch {
	case merged:
		return "done"
	case state == "closed":
		return "cancelled"
	case draft:
		return "todo"
	default:
		return "review"
	}
}

// upsertGitHub creates or refreshes the Relay issue mirroring one GitHub
// object. Returns whether the row was created.
func (s *Service) upsertGitHub(ctx context.Context, repo db.Repository, in importItem) (pgtype.UUID, bool, error) {
	existing, err := s.q.FindIssueByGitHub(ctx, db.FindIssueByGitHubParams{
		RepoID: repo.ID, Number: pgtype.Int4{Int32: int32(in.number), Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		n, err := s.q.NextIssueNumber(ctx, repo.ProjectID)
		if err != nil {
			return pgtype.UUID{}, false, err
		}
		row, err := s.q.CreateGitHubIssue(ctx, db.CreateGitHubIssueParams{
			ProjectID: repo.ProjectID, Number: n,
			Title: in.title, Description: truncate(in.body, 40000),
			Status: in.status,
			NodeID: pgtype.Text{String: in.nodeID, Valid: in.nodeID != ""},
			RepoID: repo.ID, GhNumber: pgtype.Int4{Int32: int32(in.number), Valid: true},
			Kind:    in.kind,
			GhState: pgtype.Text{String: in.state, Valid: in.state != ""},
			GhUrl:   pgtype.Text{String: in.url, Valid: in.url != ""},
		})
		if err != nil {
			return pgtype.UUID{}, false, err
		}
		in.issueID = row.ID
		return row.ID, true, nil
	}
	if err != nil {
		return pgtype.UUID{}, false, err
	}
	if existing.Status != in.status {
		s.ghActivity(ctx, existing.ID, "github_state",
			fmt.Sprintf(`{"number":%d,"state":%q}`, in.number, in.state))
	}
	row, err := s.q.UpdateGitHubIssue(ctx, db.UpdateGitHubIssueParams{
		ID:          existing.ID,
		Title:       pgtype.Text{String: in.title, Valid: true},
		Description: pgtype.Text{String: truncate(in.body, 40000), Valid: true},
		Status:      pgtype.Text{String: in.status, Valid: true},
		GhState:     pgtype.Text{String: in.state, Valid: in.state != ""},
		GhUrl:       pgtype.Text{String: in.url, Valid: in.url != ""},
	})
	return row.ID, false, err
}

// ghActivity records a GitHub-originated entry in the issue's activity feed.
func (s *Service) ghActivity(ctx context.Context, issueID pgtype.UUID, kind, payload string) {
	if _, err := s.q.RecordIssueActivity(ctx, db.RecordIssueActivityParams{
		IssueID: issueID, Kind: kind, Payload: []byte(payload),
	}); err != nil {
		s.log.Warn("issue activity", zap.Error(err))
	}
}

func (s *Service) onPullRequest(ctx context.Context, p webhookPayload) {
	if p.PullRequest == nil || p.Repository == nil || p.Installation == nil {
		return
	}
	repo, err := s.q.GetRepoForIssue(ctx, db.GetRepoForIssueParams{
		InstallationID: p.Installation.ID,
		Owner:          p.Repository.Owner.Login,
		Name:           p.Repository.Name,
	})
	if err != nil {
		return
	}
	pr := p.PullRequest
	state := pr.State
	if pr.Merged {
		state = "merged"
	}
	item := importItem{
		kind:   "pr",
		number: pr.Number,
		title:  pr.Title,
		body:   pr.Body,
		state:  state,
		url:    pr.HTMLURL,
		nodeID: pr.NodeID,
		status: prStatus(pr.State, pr.Merged, pr.Draft),
	}
	_, created, err := s.upsertGitHub(ctx, repo, item)
	if err != nil {
		s.log.Warn("mirror pr", zap.Error(err))
		return
	}
	if created {
		s.ghActivity(ctx, item.issueID, "github_mirrored",
			fmt.Sprintf(`{"repo":"%s","number":%d,"state":%q,"kind":"pr","author":%q}`,
				repo.Owner+"/"+repo.Name, pr.Number, state, pr.User.Login))
	}
}

// --- bulk import ---

// handleImport pulls the full issue and PR history of a linked repo into
// Relay issues. Idempotent: existing mirrors are refreshed, not duplicated.
func (s *Service) handleImport(c *gin.Context) {
	p := project(c)

	var req struct {
		RepoID string `json:"repo_id"`
	}
	if c.Request.ContentLength > 0 {
		if err := c.ShouldBindJSON(&req); err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid body")
			return
		}
	}

	repos, err := s.q.ListProjectRepos(c.Request.Context(), p.ID)
	if err != nil || len(repos) == 0 {
		httpx.Error(c, http.StatusConflict, "no_repo", "project has no linked GitHub repository")
		return
	}
	if req.RepoID != "" {
		rid, err := uuid.Parse(req.RepoID)
		if err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid repo_id")
			return
		}
		found := repos[:0]
		for _, r := range repos {
			if r.ID.Valid && uuid.UUID(r.ID.Bytes) == rid {
				found = append(found, r)
			}
		}
		if len(found) == 0 {
			httpx.Error(c, http.StatusNotFound, "not_found", "repository not linked to this project")
			return
		}
		repos = found
	}

	cli, err := s.Client(c.Request.Context())
	if err != nil {
		httpx.Error(c, http.StatusServiceUnavailable, "github_unavailable", "GitHub is not configured")
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Minute)
	defer cancel()

	results := make([]gin.H, 0, len(repos))
	for _, r := range repos {
		res := s.importRepo(ctx, cli, r)
		res["repo"] = r.Owner + "/" + r.Name
		results = append(results, res)
	}
	c.JSON(http.StatusOK, gin.H{"results": results})
}

// importRepo pulls issues and PRs for one linked repo. Errors are recorded
// per repo so one bad repo does not sink the whole import.
func (s *Service) importRepo(ctx context.Context, cli *Client, repo db.Repository) gin.H {
	res := gin.H{"issues": gin.H{"created": 0, "updated": 0},
		"prs": gin.H{"created": 0, "updated": 0}}

	ghIssues, err := cli.ListIssuesAll(ctx, repo.InstallationID, repo.Owner, repo.Name)
	if err != nil {
		res["error"] = "issues: " + err.Error()
		return res
	}
	prs, err := cli.ListPRsAll(ctx, repo.InstallationID, repo.Owner, repo.Name)
	if err != nil {
		res["error"] = "pull_requests: " + err.Error()
		return res
	}
	res["truncated"] = len(ghIssues) >= maxImportPages*100 || len(prs) >= maxImportPages*100

	sort.Slice(ghIssues, func(i, j int) bool { return ghIssues[i].Number < ghIssues[j].Number })
	sort.Slice(prs, func(i, j int) bool { return prs[i].Number < prs[j].Number })

	for _, gi := range ghIssues {
		item := importItem{
			kind: "issue", number: gi.Number, title: gi.Title, body: gi.Body,
			state: gi.State, url: gi.HTMLURL, nodeID: gi.NodeID,
			status: issueStatus(gi.State),
		}
		id, created, err := s.upsertGitHub(ctx, repo, item)
		if err != nil {
			s.log.Warn("import issue", zap.Int("number", gi.Number), zap.Error(err))
			continue
		}
		s.linkGitHubLabels(ctx, repo.ProjectID, id, gi.Labels)
		bump(res["issues"], created)
	}
	for _, pr := range prs {
		state := pr.State
		if pr.MergedAt != nil {
			state = "merged"
		}
		item := importItem{
			kind: "pr", number: pr.Number, title: pr.Title, body: pr.Body,
			state: state, url: pr.HTMLURL, nodeID: pr.NodeID,
			status: prStatus(pr.State, pr.MergedAt != nil, pr.Draft),
		}
		_, created, err := s.upsertGitHub(ctx, repo, item)
		if err != nil {
			s.log.Warn("import pr", zap.Int("number", pr.Number), zap.Error(err))
			continue
		}
		bump(res["prs"], created)
	}
	return res
}

func bump(counts any, created bool) {
	m := counts.(gin.H)
	if created {
		m["created"] = m["created"].(int) + 1
	} else {
		m["updated"] = m["updated"].(int) + 1
	}
}

// linkGitHubLabels ensures each GitHub label exists as a project label and
// links it to the issue. Relay-side labels the user added are never removed;
// GitHub-side removals do not propagate.
func (s *Service) linkGitHubLabels(ctx context.Context, projectID, issueID pgtype.UUID, labels []struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}) {
	for _, l := range labels {
		name := strings.TrimSpace(l.Name)
		if name == "" {
			continue
		}
		color := "#" + l.Color
		if len(l.Color) != 6 {
			color = "#6b7280"
		}
		_ = s.q.InsertLabelIfMissing(ctx, db.InsertLabelIfMissingParams{
			ProjectID: projectID, Name: name, Color: color,
		})
		lab, err := s.q.GetLabelByName(ctx, db.GetLabelByNameParams{
			ProjectID: projectID, Name: name,
		})
		if err != nil {
			continue
		}
		_ = s.q.LinkIssueLabel(ctx, db.LinkIssueLabelParams{
			IssueID: issueID, LabelID: lab.ID,
		})
	}
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// --- gates ---

func project(c *gin.Context) db.GetProjectByIDRow {
	v, _ := c.Get("relay.project")
	p, _ := v.(db.GetProjectByIDRow)
	return p
}

func (s *Service) userWorkspaceRole(c *gin.Context, wsID pgtype.UUID) (string, bool) {
	uid := auth.CurrentUser(c).ID
	if !uid.Valid {
		return "", false
	}
	role, err := s.q.GetWorkspaceRole(c.Request.Context(), db.GetWorkspaceRoleParams{
		WorkspaceID: wsID, UserID: uid,
	})
	return role, err == nil
}

func (s *Service) adminOnly(c *gin.Context) {
	// app registration is a deployment-level decision: require any workspace
	// admin. For single-workspace self-hosts this is the owner.
	uid := auth.CurrentUser(c).ID
	var ok bool
	err := s.pool.QueryRow(c.Request.Context(),
		`select exists(select 1 from workspace_members where user_id=$1 and role in ('owner','admin'))`,
		uid).Scan(&ok)
	if err != nil || !ok {
		httpx.Error(c, http.StatusForbidden, "forbidden", "workspace admin required")
		c.Abort()
		return
	}
	c.Next()
}

func (s *Service) memberOnly(c *gin.Context) {
	wsID, ok := httpx.PathUUID(c, "id")
	if !ok {
		c.Abort()
		return
	}
	role, ok := s.userWorkspaceRole(c, wsID)
	if !ok || role == "" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "workspace membership required")
		c.Abort()
		return
	}
	c.Next()
}

// projectMemberOnly resolves the project and requires workspace membership.
func (s *Service) projectGate(c *gin.Context, admin bool) {
	pid, ok := httpx.PathUUID(c, "id")
	if !ok {
		c.Abort()
		return
	}
	p, err := s.q.GetProjectByID(c.Request.Context(), pid)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "project not found")
		c.Abort()
		return
	}
	role, ok := s.userWorkspaceRole(c, p.WorkspaceID)
	if !ok || role == "" || (admin && role != "owner" && role != "admin") {
		httpx.Error(c, http.StatusForbidden, "forbidden", "insufficient workspace role")
		c.Abort()
		return
	}
	c.Set("relay.project", p)
	c.Next()
}

func (s *Service) projectMemberOnly(c *gin.Context) { s.projectGate(c, false) }
func (s *Service) projectAdminOnly(c *gin.Context)  { s.projectGate(c, true) }

// --- repo file browsing (feeds chat file mentions) ---

// repoForQuery resolves ?repo=owner/name against the project's linked repos.
func (s *Service) repoForQuery(c *gin.Context) (db.Repository, bool) {
	var zero db.Repository
	p := c.MustGet("relay.project").(db.GetProjectByIDRow)
	full := c.Query("repo")
	if full == "" {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "repo=owner/name required")
		return zero, false
	}
	repos, err := s.q.ListProjectRepos(c.Request.Context(), p.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return zero, false
	}
	for _, r := range repos {
		if r.Owner+"/"+r.Name == full {
			return r, true
		}
	}
	httpx.Error(c, http.StatusNotFound, "not_found", "repo not linked to this project")
	return zero, false
}

func (s *Service) handleRepoTree(c *gin.Context) {
	repo, ok := s.repoForQuery(c)
	if !ok {
		return
	}
	client, err := s.Client(c.Request.Context())
	if err != nil {
		httpx.Error(c, http.StatusServiceUnavailable, "github_unavailable", "github app not configured")
		return
	}
	tree, truncated, err := client.RepoTree(c.Request.Context(),
		repo.InstallationID, repo.Owner, repo.Name, repo.DefaultBranch)
	if err != nil {
		httpx.Error(c, http.StatusBadGateway, "github_error", "tree fetch failed")
		return
	}
	type entry struct {
		Path string `json:"path"`
		Dir  bool   `json:"dir"`
	}
	out := make([]entry, 0, len(tree))
	for _, t := range tree {
		out = append(out, entry{Path: t.Path, Dir: t.Type == "tree"})
		if len(out) >= 5000 {
			truncated = true
			break
		}
	}
	c.JSON(http.StatusOK, gin.H{"entries": out, "truncated": truncated,
		"repo": repo.Owner + "/" + repo.Name, "branch": repo.DefaultBranch})
}

func (s *Service) handleRepoFile(c *gin.Context) {
	repo, ok := s.repoForQuery(c)
	if !ok {
		return
	}
	path := c.Query("path")
	if path == "" || strings.Contains(path, "..") {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "path required")
		return
	}
	client, err := s.Client(c.Request.Context())
	if err != nil {
		httpx.Error(c, http.StatusServiceUnavailable, "github_unavailable", "github app not configured")
		return
	}
	content, size, err := client.RepoFile(c.Request.Context(),
		repo.InstallationID, repo.Owner, repo.Name, path, repo.DefaultBranch)
	if err != nil {
		httpx.Error(c, http.StatusBadGateway, "github_error", "file fetch failed")
		return
	}
	c.JSON(http.StatusOK, gin.H{"path": path, "content": content, "size": size,
		"repo": repo.Owner + "/" + repo.Name})
}
