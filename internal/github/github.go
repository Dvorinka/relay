// Package github implements the GitHub App integration: manifest-based app
// registration, installation tracking, repo linking, HMAC-verified webhooks
// with delivery-id idempotency, and the project development panel.
package github

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
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
	// browser redirect targets / webhook entry
	pub.GET("/github/callback", s.handleCallback)
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
	manifest := gin.H{
		"name": "Relay (" + name + ")",
		"url":  s.cfg.PublicURL,
		"hook_attributes": gin.H{
			"url":    s.cfg.PublicURL + "/api/github/webhook",
			"active": true,
		},
		"redirect_url": s.cfg.PublicURL + "/api/github/callback?ws=" + url.QueryEscape(ws),
		"public":       false,
		"default_permissions": gin.H{
			"issues":        "write",
			"pull_requests": "read",
			"contents":      "read",
			"metadata":      "read",
		},
		"default_events": []string{"issues", "pull_request", "push", "installation"},
	}
	c.JSON(http.StatusOK, gin.H{
		"manifest": manifest,
		"post_url": "https://github.com/settings/apps/new",
	})
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
		if s.cfg.GitHubToken == "" {
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
		State   string `json:"state"`
		Merged  bool   `json:"merged"`
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
	// map GitHub state to ours
	status := "todo"
	if p.Issue.State == "closed" {
		status = "done"
	}
	existing, err := s.q.FindIssueByGitHub(ctx, db.FindIssueByGitHubParams{
		RepoID: repo.ID, Number: pgtype.Int4{Int32: int32(p.Issue.Number), Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		n, err := s.q.NextIssueNumber(ctx, repo.ProjectID)
		if err != nil {
			return
		}
		created, err := s.q.CreateGitHubIssue(ctx, db.CreateGitHubIssueParams{
			ProjectID: repo.ProjectID, Number: n,
			Title: p.Issue.Title, Description: truncate(p.Issue.Body, 40000),
			Status: status,
			NodeID: pgtype.Text{String: p.Issue.NodeID, Valid: true},
			RepoID: repo.ID, GhNumber: pgtype.Int4{Int32: int32(p.Issue.Number), Valid: true},
		})
		if err != nil {
			s.log.Warn("mirror issue", zap.Error(err))
			return
		}
		s.ghActivity(ctx, created.ID, "github_mirrored",
			fmt.Sprintf(`{"repo":"%s","number":%d,"state":%q}`, repo.Owner+"/"+repo.Name, p.Issue.Number, p.Issue.State))
		return
	}
	if err != nil {
		return
	}
	_, _ = s.q.UpdateGitHubIssue(ctx, db.UpdateGitHubIssueParams{
		ID:          existing.ID,
		Title:       pgtype.Text{String: p.Issue.Title, Valid: true},
		Description: pgtype.Text{String: truncate(p.Issue.Body, 40000), Valid: true},
		Status:      pgtype.Text{String: status, Valid: true},
	})
	if existing.Status != status {
		s.ghActivity(ctx, existing.ID, "github_state",
			fmt.Sprintf(`{"number":%d,"state":%q}`, p.Issue.Number, p.Issue.State))
	}
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
	state := p.PullRequest.State
	if p.PullRequest.Merged {
		state = "merged"
	}
	payload, _ := json.Marshal(gin.H{
		"number": p.PullRequest.Number, "title": p.PullRequest.Title,
		"state": state, "url": p.PullRequest.HTMLURL, "author": p.PullRequest.User.Login,
		"repo": repo.Owner + "/" + repo.Name,
	})
	// surface on the project conversation as an activity record — find the
	// project conversation and attach activity to it via issue_activity? No:
	// PR events land in project activity via a synthetic row keyed on the repo.
	// Cheapest correct surface: create an issue_activity row only if a
	// mirrored issue exists for this PR number.
	if iss, err := s.q.FindIssueByGitHub(ctx, db.FindIssueByGitHubParams{
		RepoID: repo.ID, Number: pgtype.Int4{Int32: int32(p.PullRequest.Number), Valid: true},
	}); err == nil {
		_, _ = s.q.RecordIssueActivity(ctx, db.RecordIssueActivityParams{
			IssueID: iss.ID, Kind: "github.pr_" + state, Payload: payload,
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
