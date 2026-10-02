package github

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

const apiBase = "https://api.github.com"

// Client talks to api.github.com. It carries the app's private key so it
// can mint JWTs and exchange them for per-installation access tokens,
// which are cached until shortly before expiry.
type Client struct {
	hc         *http.Client
	appID      int64
	privateKey []byte
	pat        string // dev fallback (GITHUB_TOKEN); bypasses installation tokens

	mu     sync.Mutex
	tokens map[int64]*installToken // installation id -> token
}

type installToken struct {
	value  string
	expiry time.Time
}

func NewClient(appID int64, privateKey []byte) *Client {
	return &Client{
		hc:         &http.Client{Timeout: 15 * time.Second},
		appID:      appID,
		privateKey: privateKey,
		tokens:     map[int64]*installToken{},
	}
}

// NewPATClient builds a client backed by a personal access token — the
// GITHUB_TOKEN dev fallback. Read-only usage; installation_id args are ignored.
func NewPATClient(token string) *Client {
	return &Client{
		hc:     &http.Client{Timeout: 15 * time.Second},
		pat:    token,
		tokens: map[int64]*installToken{},
	}
}

// ResetForKey swaps credentials after app (re)registration.
func (c *Client) ResetForKey(appID int64, privateKey []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.appID, c.privateKey = appID, privateKey
	c.tokens = map[int64]*installToken{}
}

func (c *Client) appToken(ctx context.Context) (string, error) {
	return appJWT(c.appID, c.privateKey, time.Now())
}

func (c *Client) installationToken(ctx context.Context, installID int64) (string, error) {
	if c.pat != "" {
		return c.pat, nil
	}
	c.mu.Lock()
	if t := c.tokens[installID]; t != nil && time.Now().Before(t.expiry) {
		v := t.value
		c.mu.Unlock()
		return v, nil
	}
	c.mu.Unlock()

	jwt, err := c.appToken(ctx)
	if err != nil {
		return "", err
	}
	var out struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	err = c.do(ctx, "POST",
		fmt.Sprintf("%s/app/installations/%d/access_tokens", apiBase, installID),
		jwt, nil, &out)
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	c.tokens[installID] = &installToken{value: out.Token, expiry: out.ExpiresAt.Add(-2 * time.Minute)}
	c.mu.Unlock()
	return out.Token, nil
}

func (c *Client) do(ctx context.Context, method, url, token string, body io.Reader, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("github %s %s: %s: %s", method, url, res.Status, raw)
	}
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	return nil
}

// --- payloads ---

type Repo struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	DefaultBranch string `json:"default_branch"`
	Private       bool   `json:"private"`
}

type GHIssue struct {
	Number  int    `json:"number"`
	Title   string `json:"title"`
	State   string `json:"state"`
	HTMLURL string `json:"html_url"`
	Body    string `json:"body"`
	NodeID  string `json:"node_id"`
	User    struct {
		Login string `json:"login"`
	} `json:"user"`
	PullRequest *struct{} `json:"pull_request"` // non-nil means it's a PR
	Labels      []struct {
		Name string `json:"name"`
	} `json:"labels"`
	UpdatedAt time.Time `json:"updated_at"`
}

type PR struct {
	Number   int        `json:"number"`
	Title    string     `json:"title"`
	State    string     `json:"state"`
	Draft    bool       `json:"draft"`
	MergedAt *time.Time `json:"merged_at"`
	HTMLURL  string     `json:"html_url"`
	User     struct {
		Login string `json:"login"`
	} `json:"user"`
	Head struct {
		Ref string `json:"ref"`
	} `json:"head"`
	Base struct {
		Ref string `json:"ref"`
	} `json:"base"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Commit struct {
	SHA     string `json:"sha"`
	HTMLURL string `json:"html_url"`
	Commit  struct {
		Message string `json:"message"`
		Author  struct {
			Name string    `json:"name"`
			Date time.Time `json:"date"`
		} `json:"author"`
	} `json:"commit"`
}

// IsPAT reports whether this client runs on a personal access token.
func (c *Client) IsPAT() bool { return c.pat != "" }

// ListViewerRepos lists repositories the PAT can see (most recently pushed).
func (c *Client) ListViewerRepos(ctx context.Context) ([]Repo, error) {
	var out []Repo
	err := c.do(ctx, "GET",
		apiBase+"/user/repos?per_page=100&sort=pushed&affiliation=owner",
		c.pat, nil, &out)
	return out, err
}

func (c *Client) ListInstallationRepos(ctx context.Context, installID int64) ([]Repo, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out struct {
		Repositories []Repo `json:"repositories"`
	}
	err = c.do(ctx, "GET", apiBase+"/installation/repositories?per_page=100", tok, nil, &out)
	return out.Repositories, err
}

func (c *Client) ListIssues(ctx context.Context, installID int64, owner, repo string) ([]GHIssue, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out []GHIssue
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/issues?state=open&per_page=50", apiBase, owner, repo),
		tok, nil, &out)
	if err != nil {
		return nil, err
	}
	issues := out[:0]
	for _, i := range out {
		if i.PullRequest == nil { // issues endpoint returns PRs too
			issues = append(issues, i)
		}
	}
	return issues, nil
}

// CreateIssue opens a new GitHub issue (write-back from Relay).
func (c *Client) CreateIssue(ctx context.Context, installID int64, owner, repo, title, body string) (*GHIssue, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(map[string]string{"title": title, "body": body})
	var out GHIssue
	err = c.do(ctx, "POST",
		fmt.Sprintf("%s/repos/%s/%s/issues", apiBase, owner, repo),
		tok, bytes.NewReader(payload), &out)
	return &out, err
}

// SetIssueState closes or reopens a GitHub issue ("closed" | "open").
func (c *Client) SetIssueState(ctx context.Context, installID int64, owner, repo string, number int, state string) error {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{"state": state})
	return c.do(ctx, "PATCH",
		fmt.Sprintf("%s/repos/%s/%s/issues/%d", apiBase, owner, repo, number),
		tok, bytes.NewReader(payload), nil)
}

func (c *Client) GetIssue(ctx context.Context, installID int64, owner, repo string, number int) (*GHIssue, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out GHIssue
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/issues/%d", apiBase, owner, repo, number),
		tok, nil, &out)
	return &out, err
}

func (c *Client) ListPRs(ctx context.Context, installID int64, owner, repo string) ([]PR, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out []PR
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/pulls?state=open&per_page=50", apiBase, owner, repo),
		tok, nil, &out)
	return out, err
}

func (c *Client) GetPR(ctx context.Context, installID int64, owner, repo string, number int) (*PR, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out PR
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/pulls/%d", apiBase, owner, repo, number),
		tok, nil, &out)
	return &out, err
}

func (c *Client) ListCommits(ctx context.Context, installID int64, owner, repo, branch string) ([]Commit, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out []Commit
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/commits?sha=%s&per_page=15", apiBase, owner, repo, branch),
		tok, nil, &out)
	return out, err
}
