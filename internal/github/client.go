package github

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// apiBase is a var (not const) so tests can point the client at httptest.
var apiBase = "https://api.github.com"

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
	ID            int64     `json:"id"`
	Name          string    `json:"name"`
	FullName      string    `json:"full_name"`
	DefaultBranch string    `json:"default_branch"`
	Private       bool      `json:"private"`
	Description   string    `json:"description"`
	PushedAt      time.Time `json:"pushed_at"`
	Owner         struct {
		AvatarURL string `json:"avatar_url"`
	} `json:"owner"`
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
		Name  string `json:"name"`
		Color string `json:"color"`
	} `json:"labels"`
	UpdatedAt time.Time `json:"updated_at"`
}

type PR struct {
	Number         int        `json:"number"`
	Title          string     `json:"title"`
	State          string     `json:"state"`
	Draft          bool       `json:"draft"`
	Body           string     `json:"body"`
	NodeID         string     `json:"node_id"`
	Merged         bool       `json:"merged"`
	MergedAt       *time.Time `json:"merged_at"`
	Mergeable      *bool      `json:"mergeable"`
	MergeableState string     `json:"mergeable_state"`
	Additions      int        `json:"additions"`
	Deletions      int        `json:"deletions"`
	ChangedFiles   int        `json:"changed_files"`
	Commits        int        `json:"commits"`
	HTMLURL        string     `json:"html_url"`
	User           struct {
		Login string `json:"login"`
	} `json:"user"`
	Head struct {
		Ref string `json:"ref"`
		SHA string `json:"sha"`
	} `json:"head"`
	Base struct {
		Ref string `json:"ref"`
	} `json:"base"`
	Labels []struct {
		Name string `json:"name"`
	} `json:"labels"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// PRFile is one file touched by a pull request.
type PRFile struct {
	Filename  string `json:"filename"`
	Status    string `json:"status"` // added | modified | removed | renamed
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

// CheckRun is one CI check on a commit (statuses endpoint covers the
// aggregate; check-runs gives the detail list).
type CheckRun struct {
	Name       string `json:"name"`
	Status     string `json:"status"`     // queued | in_progress | completed
	Conclusion string `json:"conclusion"` // success | failure | neutral | skipped | …
	HTMLURL    string `json:"html_url"`
}

// Branch is a repo ref for the branch picker.
type Branch struct {
	Name      string `json:"name"`
	Protected bool   `json:"protected"`
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

// CommitDetail is the expanded view of one commit: full message, line stats,
// and the touched files — everything the in-app commit modal needs.
type CommitDetail struct {
	SHA     string `json:"sha"`
	HTMLURL string `json:"html_url"`
	Commit  struct {
		Message string `json:"message"`
		Author  struct {
			Name string    `json:"name"`
			Date time.Time `json:"date"`
		} `json:"author"`
	} `json:"commit"`
	Stats struct {
		Additions int `json:"additions"`
		Deletions int `json:"deletions"`
		Total     int `json:"total"`
	} `json:"stats"`
	Files []PRFile `json:"files"`
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

// maxImportPages bounds a single list call so imports stay finite even on
// very large repos. 5 pages x 100 = 500 items.
const maxImportPages = 5

// listPaged walks GitHub's ?page= pagination until a short page or the cap.
// Jarvis: ceiling 500 items per list call, upgrade if repos outgrow it.
func (c *Client) listPaged(ctx context.Context, tok, url string, each func(dec *json.Decoder) error) error {
	for page := 1; page <= maxImportPages; page++ {
		full := fmt.Sprintf("%s&per_page=100&page=%d", url, page)
		req, err := http.NewRequestWithContext(ctx, "GET", full, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		req.Header.Set("Authorization", "Bearer "+tok)
		res, err := c.hc.Do(req)
		if err != nil {
			return err
		}
		var items []json.RawMessage
		derr := json.NewDecoder(res.Body).Decode(&items)
		_ = res.Body.Close()
		if res.StatusCode >= 300 {
			return fmt.Errorf("github GET %s: %s", full, res.Status)
		}
		if derr != nil {
			return derr
		}
		for _, raw := range items {
			if err := each(json.NewDecoder(bytes.NewReader(raw))); err != nil {
				return err
			}
		}
		if len(items) < 100 {
			return nil
		}
	}
	return nil
}

// ListIssuesAll returns every issue (open and closed) on the repo, PRs
// excluded, up to the import cap.
func (c *Client) ListIssuesAll(ctx context.Context, installID int64, owner, repo string) ([]GHIssue, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out []GHIssue
	url := fmt.Sprintf("%s/repos/%s/%s/issues?state=all", apiBase, owner, repo)
	err = c.listPaged(ctx, tok, url, func(dec *json.Decoder) error {
		var i GHIssue
		if err := dec.Decode(&i); err != nil {
			return err
		}
		if i.PullRequest == nil { // issues endpoint returns PRs too
			out = append(out, i)
		}
		return nil
	})
	return out, err
}

// ListIssues is the dev-panel call: open issues only, first page, cheap.
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

// ListPRs is the dev-panel call: open PRs, first page.
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

// ListPRsAll returns every PR (open, closed, merged) up to the import cap.
func (c *Client) ListPRsAll(ctx context.Context, installID int64, owner, repo string) ([]PR, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out []PR
	url := fmt.Sprintf("%s/repos/%s/%s/pulls?state=all", apiBase, owner, repo)
	err = c.listPaged(ctx, tok, url, func(dec *json.Decoder) error {
		var pr PR
		if err := dec.Decode(&pr); err != nil {
			return err
		}
		out = append(out, pr)
		return nil
	})
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

// ListPRFiles returns the files changed by a pull request (first page, up to
// 100 — enough for a review surface; GitHub paginates beyond that).
func (c *Client) ListPRFiles(ctx context.Context, installID int64, owner, repo string, number int) ([]PRFile, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out []PRFile
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/pulls/%d/files?per_page=100", apiBase, owner, repo, number),
		tok, nil, &out)
	return out, err
}

// ListPRCommits returns the commits on a pull request, oldest first.
func (c *Client) ListPRCommits(ctx context.Context, installID int64, owner, repo string, number int) ([]Commit, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out []Commit
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/pulls/%d/commits?per_page=100", apiBase, owner, repo, number),
		tok, nil, &out)
	return out, err
}

// ListCheckRuns returns the check runs for a commit SHA — the CI detail list
// behind a PR's merge box.
func (c *Client) ListCheckRuns(ctx context.Context, installID int64, owner, repo, sha string) ([]CheckRun, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out struct {
		CheckRuns []CheckRun `json:"check_runs"`
	}
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/commits/%s/check-runs?per_page=100", apiBase, owner, repo, sha),
		tok, nil, &out)
	return out.CheckRuns, err
}

// MergeResult is GitHub's response to a merge call.
type MergeResult struct {
	Merged  bool   `json:"merged"`
	SHA     string `json:"sha"`
	Message string `json:"message"`
}

// MergePR merges a pull request — method is "merge" | "squash" | "rebase".
// Requires the app's pull_requests:write permission; older installations
// registered while the manifest asked for read get a 403/404 from GitHub.
func (c *Client) MergePR(ctx context.Context, installID int64, owner, repo string, number int, method, commitTitle, commitMessage string) (*MergeResult, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(map[string]string{
		"merge_method":   method,
		"commit_title":   commitTitle,
		"commit_message": commitMessage,
	})
	var out MergeResult
	err = c.do(ctx, "PUT",
		fmt.Sprintf("%s/repos/%s/%s/pulls/%d/merge", apiBase, owner, repo, number),
		tok, bytes.NewReader(payload), &out)
	return &out, err
}

// ListBranches returns the repo's branches (first 100).
func (c *Client) ListBranches(ctx context.Context, installID int64, owner, repo string) ([]Branch, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out []Branch
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/branches?per_page=100", apiBase, owner, repo),
		tok, nil, &out)
	return out, err
}

// ListCommitsPaged is ListCommits with an explicit page size — the git log
// view wants more history than the dev panel's 15.
func (c *Client) ListCommitsPaged(ctx context.Context, installID int64, owner, repo, branch string, perPage int) ([]Commit, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	if perPage <= 0 || perPage > 100 {
		perPage = 30
	}
	var out []Commit
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/commits?sha=%s&per_page=%d", apiBase, owner, repo, branch, perPage),
		tok, nil, &out)
	return out, err
}

// GetCommit returns full detail for one commit — message, stats, touched
// files. Powers the in-app commit view so users don't leave for github.com.
func (c *Client) GetCommit(ctx context.Context, installID int64, owner, repo, sha string) (*CommitDetail, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	var out CommitDetail
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/commits/%s", apiBase, owner, repo, sha),
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

// TreeEntry is one node in a repo's recursive git tree.
type TreeEntry struct {
	Path string `json:"path"`
	Type string `json:"type"` // "blob" | "tree"
}

// RepoTree returns the repo's recursive file tree (paths only). GitHub caps
// at 100k entries / ~7MB; truncated flags the cut.
func (c *Client) RepoTree(ctx context.Context, installID int64, owner, repo, branch string) ([]TreeEntry, bool, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, false, err
	}
	var out struct {
		Tree      []TreeEntry `json:"tree"`
		Truncated bool        `json:"truncated"`
	}
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/git/trees/%s?recursive=1", apiBase, owner, repo, url.PathEscape(branch)),
		tok, nil, &out)
	return out.Tree, out.Truncated, err
}

// RepoFile reads a UTF-8 file ≤256KB at branch. Returns the decoded content.
func (c *Client) RepoFile(ctx context.Context, installID int64, owner, repo, path, branch string) (string, int64, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return "", 0, err
	}
	var out struct {
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
		Size     int64  `json:"size"`
	}
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/contents/%s?ref=%s", apiBase, owner, repo,
			url.PathEscape(path), url.QueryEscape(branch)),
		tok, nil, &out)
	if err != nil {
		return "", 0, err
	}
	if out.Encoding != "base64" {
		return "", 0, fmt.Errorf("unexpected encoding %q", out.Encoding)
	}
	if out.Size > 256*1024 {
		return "", 0, fmt.Errorf("file exceeds 256KB")
	}
	// GitHub wraps base64 at 60 chars — strip whitespace before decoding
	raw, err := base64.StdEncoding.DecodeString(strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, out.Content))
	if err != nil {
		return "", 0, err
	}
	return string(raw), out.Size, nil
}

// SetPRState closes or reopens a pull request. state is "open"|"closed".
// Requires pull_requests:write, same as MergePR.
func (c *Client) SetPRState(ctx context.Context, installID int64, owner, repo string, number int, state string) (*PR, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(map[string]string{"state": state})
	var out PR
	err = c.do(ctx, "PATCH",
		fmt.Sprintf("%s/repos/%s/%s/pulls/%d", apiBase, owner, repo, number),
		tok, bytes.NewReader(payload), &out)
	return &out, err
}

// CreatePRReview submits a review on a pull request. event is GitHub's
// verb: "APPROVE" | "REQUEST_CHANGES" | "COMMENT". body is required for
// REQUEST_CHANGES, optional for the rest.
func (c *Client) CreatePRReview(ctx context.Context, installID int64, owner, repo string, number int, event, body string) error {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{"event": event, "body": body})
	var out struct {
		ID int64 `json:"id"`
	}
	err = c.do(ctx, "POST",
		fmt.Sprintf("%s/repos/%s/%s/pulls/%d/reviews", apiBase, owner, repo, number),
		tok, bytes.NewReader(payload), &out)
	return err
}

// WorkflowRun is one row of a repo's Actions tab.
type WorkflowRun struct {
	ID         int64     `json:"id"`
	Name       string    `json:"name"`
	Status     string    `json:"status"`     // queued | in_progress | completed | …
	Conclusion string    `json:"conclusion"` // success | failure | cancelled | skipped | …
	Event      string    `json:"event"`
	HeadBranch string    `json:"head_branch"`
	HeadSHA    string    `json:"head_sha"`
	RunNumber  int       `json:"run_number"`
	RunAttempt int       `json:"run_attempt"`
	HTMLURL    string    `json:"html_url"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
	Actor      struct {
		Login string `json:"login"`
	} `json:"actor"`
}

// ListWorkflowRuns returns the repo's most recent Actions runs.
func (c *Client) ListWorkflowRuns(ctx context.Context, installID int64, owner, repo string, perPage int) ([]WorkflowRun, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	if perPage <= 0 || perPage > 50 {
		perPage = 20
	}
	var out struct {
		WorkflowRuns []WorkflowRun `json:"workflow_runs"`
	}
	err = c.do(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/actions/runs?per_page=%d", apiBase, owner, repo, perPage),
		tok, nil, &out)
	return out.WorkflowRuns, err
}

// RerunWorkflowRun re-triggers a finished run (201 from GitHub on success).
// Failed-only variant exists upstream but the plain rerun covers both.
func (c *Client) RerunWorkflowRun(ctx context.Context, installID int64, owner, repo string, runID int64) error {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return err
	}
	return c.do(ctx, "POST",
		fmt.Sprintf("%s/repos/%s/%s/actions/runs/%d/rerun", apiBase, owner, repo, runID),
		tok, nil, nil)
}

// CreateIssueComment posts a comment on an issue or pull request — GitHub
// serves both through the issues comments API.
func (c *Client) CreateIssueComment(ctx context.Context, installID int64, owner, repo string, number int, body string) error {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{"body": body})
	return c.do(ctx, "POST",
		fmt.Sprintf("%s/repos/%s/%s/issues/%d/comments", apiBase, owner, repo, number),
		tok, bytes.NewReader(payload), nil)
}

// CreatePR opens a pull request on GitHub.
func (c *Client) CreatePR(ctx context.Context, installID int64, owner, repo, head, base, title, body string, draft bool) (*PR, error) {
	tok, err := c.installationToken(ctx, installID)
	if err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(map[string]any{
		"head": head, "base": base, "title": title, "body": body, "draft": draft,
	})
	var out PR
	err = c.do(ctx, "POST",
		fmt.Sprintf("%s/repos/%s/%s/pulls", apiBase, owner, repo),
		tok, bytes.NewReader(payload), &out)
	return &out, err
}
