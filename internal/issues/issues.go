// Package issues: Linear-style issues keyed PROJECT-N via the atomic
// project_counters upsert. Comments live in the issue's own conversation
// (kind='issue'); issue_activity is the single event log.
package issues

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/conversations"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/github"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/Dvorinka/relay/internal/statuses"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

var prioritySet = map[string]bool{
	"none": true, "urgent": true, "high": true, "medium": true, "low": true,
}

// defsFor resolves a project's status lanes; falls back to the built-ins.
func (s *Service) defsFor(ctx context.Context, projectID pgtype.UUID) []statuses.Def {
	meta, err := s.q.ProjectMeta(ctx, projectID)
	if err != nil {
		return statuses.Defaults()
	}
	return statuses.Parse(meta.Statuses)
}

type Service struct {
	q   *db.Queries
	log *zap.Logger
	// Bus publishes domain events for SSE subscribers. Optional.
	Bus *events.Hub
	// GH enables GitHub write-back (issue push + status sync). Optional.
	GH *github.Service
}

func NewService(log *zap.Logger, pool *pgxpool.Pool) *Service {
	return &Service{q: db.New(pool), log: log}
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.GET("/projects/:id/issues", s.projectGate, s.handleList)
	g.POST("/projects/:id/issues", s.projectGate, s.handleCreate)
	g.GET("/projects/:id/labels", s.projectGate, s.handleListLabels)
	g.POST("/projects/:id/labels", s.projectGate, s.handleCreateLabel)
	g.GET("/issues/:id", s.issueGate, s.handleGet)
	g.PATCH("/issues/:id", s.issueGate, s.handleUpdate)
	g.POST("/issues/:id/github", s.issueGate, s.handlePushToGitHub)
	g.GET("/issues/:id/conversation", s.issueGate, s.handleConversation)
	g.POST("/messages/:id/issue", s.handleFromMessage)
}

// --- gates ---

const ctxProjectKey = "relay.issue_project"
const ctxIssueKey = "relay.issue"

func (s *Service) projectGate(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	p, err := s.q.GetProjectForUser(c.Request.Context(), db.GetProjectForUserParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	c.Set(ctxProjectKey, p)
	c.Next()
}

// issueGate resolves :id -> issue, distinguishing 404 from 403 by checking
// existence first (same pattern as conversations.memberOnly).
func (s *Service) issueGate(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	row, err := s.q.GetIssueForUser(c.Request.Context(), db.GetIssueForUserParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil {
		if _, err2 := s.q.GetIssueByID(c.Request.Context(), id); err2 == nil {
			httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		} else {
			httpx.Error(c, http.StatusNotFound, "not_found", "issue not found")
		}
		return
	}
	c.Set(ctxIssueKey, row)
	c.Next()
}

// --- project-scoped handlers ---

func (s *Service) handleList(c *gin.Context) {
	p := c.MustGet(ctxProjectKey).(db.GetProjectForUserRow)
	params := db.ListIssuesForUserParams{ProjectID: p.ID, UserID: auth.CurrentUser(c).ID}
	defs := s.defsFor(c.Request.Context(), p.ID)
	if v := c.Query("status"); v != "" {
		if !statuses.Contains(defs, v) {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown status")
			return
		}
		params.Status = pgtype.Text{String: v, Valid: true}
	}
	if v := c.Query("assignee"); v != "" {
		if v == "me" {
			params.Assignee = auth.CurrentUser(c).ID
		} else if err := params.Assignee.Scan(v); err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid assignee")
			return
		}
	}
	if v := c.Query("label"); v != "" {
		if err := params.Label.Scan(v); err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid label id")
			return
		}
	}
	if v := c.Query("q"); v != "" {
		params.Q = pgtype.Text{String: v, Valid: true}
	}
	rows, err := s.q.ListIssuesForUser(c.Request.Context(), params)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	labelsByIssue := s.labelsFor(c, issueIDs(rows))
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, issueJSON(listRowToIssue(r), r.AssigneeName, r.AssigneeAvatar, labelsByIssue[r.ID.String()], p.Key, r.GithubRepoOwner, r.GithubRepoName, defs))
	}
	c.JSON(http.StatusOK, gin.H{"issues": out})
}

func (s *Service) handleCreate(c *gin.Context) {
	p := c.MustGet(ctxProjectKey).(db.GetProjectForUserRow)
	var req struct {
		Title       string   `json:"title" binding:"required"`
		Description string   `json:"description"`
		Status      string   `json:"status"`
		Priority    string   `json:"priority"`
		AssigneeID  string   `json:"assignee_id"`
		LabelIDs    []string `json:"label_ids"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if len(req.Title) == 0 || len(req.Title) > 200 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "title must be 1-200 characters")
		return
	}
	if len(req.Description) > 20000 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "description too long")
		return
	}
	if req.Status == "" {
		req.Status = "backlog"
	}
	if req.Priority == "" {
		req.Priority = "none"
	}
	defs := s.defsFor(c.Request.Context(), p.ID)
	if !statuses.Contains(defs, req.Status) || !prioritySet[req.Priority] {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown status or priority")
		return
	}
	var assignee pgtype.UUID
	if req.AssigneeID != "" {
		if err := assignee.Scan(req.AssigneeID); err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid assignee_id")
			return
		}
		ok, err := s.q.UserInProjectWorkspace(c.Request.Context(), db.UserInProjectWorkspaceParams{
			ProjectID: p.ID, MemberID: assignee,
		})
		if err != nil || !ok {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "assignee is not a workspace member")
			return
		}
	}
	labelIDs, bad := parseUUIDs(req.LabelIDs)
	if bad {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid label id")
		return
	}
	if len(labelIDs) > 0 {
		n, err := s.q.CountLabelsInProject(c.Request.Context(),
			db.CountLabelsInProjectParams{ProjectID: p.ID, Ids: labelIDs})
		if err != nil || int(n) != len(labelIDs) {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown label id")
			return
		}
	}

	num, err := s.q.NextIssueNumber(c.Request.Context(), p.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	user := auth.CurrentUser(c)
	row, err := s.q.CreateIssue(c.Request.Context(), db.CreateIssueParams{
		ProjectID: p.ID, Number: num, Title: req.Title, Description: req.Description,
		Status: req.Status, Priority: req.Priority, AssigneeID: assignee, CreatedBy: user.ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.linkLabels(c, row.ID, labelIDs)
	s.record(c, row.ID, user.ID, "created", gin.H{"status": req.Status})
	s.log.Info("issue created", zap.String("issue", p.Key+"-"+strconv.Itoa(int(num))))
	out := issueJSON(row, pgtype.Text{}, pgtype.Text{}, s.issueLabels(c, row.ID), p.Key, pgtype.Text{}, pgtype.Text{}, defs)
	s.publish(p.ID, "issue.created", out)
	c.JSON(http.StatusCreated, out)
}

// --- issue-scoped handlers ---

func (s *Service) handleGet(c *gin.Context) {
	row := c.MustGet(ctxIssueKey).(db.GetIssueForUserRow)
	pkey := s.projectKey(c, row.ProjectID)
	activity := s.activityJSON(c, row.ID)
	c.JSON(http.StatusOK, gin.H{
		"issue":    issueJSON(forUserRowToIssue(row), row.AssigneeName, row.AssigneeAvatar, s.issueLabels(c, row.ID), pkey, row.GithubRepoOwner, row.GithubRepoName, s.defsFor(c.Request.Context(), row.ProjectID)),
		"activity": activity,
	})
}

func (s *Service) handleUpdate(c *gin.Context) {
	old := c.MustGet(ctxIssueKey).(db.GetIssueForUserRow)
	var raw map[string]json.RawMessage
	if !httpx.BindJSON(c, &raw) {
		return
	}
	params := db.UpdateIssueFieldsParams{ID: old.ID}
	acts := []gin.H{}
	if v, ok := raw["title"]; ok {
		var t string
		if json.Unmarshal(v, &t) != nil || len(strings.TrimSpace(t)) == 0 || len(t) > 200 {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "title must be 1-200 characters")
			return
		}
		params.Title = pgtype.Text{String: t, Valid: true}
		acts = append(acts, gin.H{"field": "title", "from": old.Title, "to": t})
	}
	if v, ok := raw["description"]; ok {
		var d string
		if json.Unmarshal(v, &d) != nil || len(d) > 20000 {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "description too long")
			return
		}
		params.Description = pgtype.Text{String: d, Valid: true}
		acts = append(acts, gin.H{"field": "description"})
	}
	if v, ok := raw["status"]; ok {
		var st string
		if json.Unmarshal(v, &st) != nil || !statuses.Contains(s.defsFor(c.Request.Context(), old.ProjectID), st) {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown status")
			return
		}
		params.Status = pgtype.Text{String: st, Valid: true}
		if st != old.Status {
			acts = append(acts, gin.H{"field": "status", "from": old.Status, "to": st})
		}
	}
	if v, ok := raw["priority"]; ok {
		var pr string
		if json.Unmarshal(v, &pr) != nil || !prioritySet[pr] {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown priority")
			return
		}
		params.Priority = pgtype.Text{String: pr, Valid: true}
		if pr != old.Priority {
			acts = append(acts, gin.H{"field": "priority", "from": old.Priority, "to": pr})
		}
	}
	user := auth.CurrentUser(c)
	if len(acts) > 0 {
		if _, err := s.q.UpdateIssueFields(c.Request.Context(), params); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
	}
	if v, ok := raw["assignee_id"]; ok {
		var aid pgtype.UUID
		if string(v) != "null" {
			var s2 string
			if json.Unmarshal(v, &s2) != nil || aid.Scan(s2) != nil {
				httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid assignee_id")
				return
			}
			okm, err := s.q.UserInProjectWorkspace(c.Request.Context(), db.UserInProjectWorkspaceParams{
				ProjectID: old.ProjectID, MemberID: aid,
			})
			if err != nil || !okm {
				httpx.Error(c, http.StatusBadRequest, "bad_request", "assignee is not a workspace member")
				return
			}
		}
		if err := s.q.SetIssueAssignee(c.Request.Context(), db.SetIssueAssigneeParams{
			ID: old.ID, AssigneeID: aid,
		}); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		acts = append(acts, gin.H{"field": "assignee"})
		old.AssigneeID = aid
	}
	if v, ok := raw["label_ids"]; ok {
		var ids []string
		if json.Unmarshal(v, &ids) != nil || len(ids) > 20 {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid label_ids")
			return
		}
		labelIDs, bad := parseUUIDs(ids)
		if bad {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid label id")
			return
		}
		if len(labelIDs) > 0 {
			n, err := s.q.CountLabelsInProject(c.Request.Context(),
				db.CountLabelsInProjectParams{ProjectID: old.ProjectID, Ids: labelIDs})
			if err != nil || int(n) != len(labelIDs) {
				httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown label id")
				return
			}
		}
		_ = s.q.ReplaceIssueLabelLinks(c.Request.Context(), old.ID)
		s.linkLabels(c, old.ID, labelIDs)
		acts = append(acts, gin.H{"field": "labels"})
		_ = s.q.TouchIssue(c.Request.Context(), old.ID)
	}
	for _, a := range acts {
		kind := "field_changed"
		if a["field"] == "status" {
			kind = "status_changed"
			if st, _ := a["to"].(string); st != "" {
				s.syncGitHubState(old, st)
			}
		}
		s.record(c, old.ID, user.ID, kind, a)
	}
	fresh, err := s.q.GetIssueByID(c.Request.Context(), old.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := issueJSON(byIDRowToIssue(fresh), fresh.AssigneeName, fresh.AssigneeAvatar, s.issueLabels(c, fresh.ID), s.projectKey(c, fresh.ProjectID), fresh.GithubRepoOwner, fresh.GithubRepoName, s.defsFor(c.Request.Context(), fresh.ProjectID))
	s.publish(fresh.ProjectID, "issue.updated", out)
	c.JSON(http.StatusOK, out)
}

// handlePushToGitHub creates a GitHub issue for a Relay issue on the
// project's linked repository and records the linkage.
func (s *Service) handlePushToGitHub(c *gin.Context) {
	i := c.MustGet(ctxIssueKey).(db.GetIssueForUserRow)
	if i.GithubNumber.Valid {
		httpx.Error(c, http.StatusConflict, "conflict", "issue is already linked to GitHub")
		return
	}
	if s.GH == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "unavailable", "GitHub is not configured")
		return
	}
	repos, err := s.q.ListProjectRepos(c.Request.Context(), i.ProjectID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if len(repos) == 0 {
		httpx.Error(c, http.StatusConflict, "no_repo", "project has no linked GitHub repository")
		return
	}
	repo := repos[0]
	if len(repos) > 1 {
		var req struct {
			RepoID string `json:"repo_id"`
		}
		if httpx.BindJSON(c, &req) {
			matched := false
			for _, r := range repos {
				if r.ID.String() == req.RepoID {
					repo, matched = r, true
				}
			}
			if !matched {
				httpx.Error(c, http.StatusBadRequest, "bad_request", "repo_id is not linked to this project")
				return
			}
		} else {
			return
		}
	}
	client, err := s.GH.Client(c.Request.Context())
	if err != nil {
		httpx.Error(c, http.StatusServiceUnavailable, "unavailable", "GitHub is not configured")
		return
	}
	body := i.Description
	if body != "" {
		body += "\n\n---\n"
	}
	body += "*Tracked in Relay*"
	gh, err := client.CreateIssue(c.Request.Context(), repo.InstallationID, repo.Owner, repo.Name, i.Title, body)
	if err != nil {
		s.log.Warn("github create issue failed", zap.Error(err))
		httpx.Error(c, http.StatusBadGateway, "github_error", "GitHub rejected the issue")
		return
	}
	if err := s.q.SetIssueGitHub(c.Request.Context(), db.SetIssueGitHubParams{
		ID:           i.ID,
		GithubRepoID: repo.ID,
		GithubNumber: pgtype.Int4{Int32: int32(gh.Number), Valid: true},
		GithubNodeID: pgtype.Text{String: gh.NodeID, Valid: true},
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	// a relay-side closed state maps onto the fresh GitHub issue too
	if statuses.IsClosed(s.defsFor(c.Request.Context(), i.ProjectID), i.Status) {
		go s.closeOnGitHub(repo.InstallationID, repo.Owner, repo.Name, gh.Number, "closed")
	}
	fresh, err := s.q.GetIssueByID(c.Request.Context(), i.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := issueJSON(byIDRowToIssue(fresh), fresh.AssigneeName, fresh.AssigneeAvatar, s.issueLabels(c, fresh.ID), s.projectKey(c, fresh.ProjectID), fresh.GithubRepoOwner, fresh.GithubRepoName, s.defsFor(c.Request.Context(), fresh.ProjectID))
	s.publish(fresh.ProjectID, "issue.updated", out)
	c.JSON(http.StatusOK, out)
}

// syncGitHubState mirrors a Relay status flip onto the linked GitHub
// issue: done/cancelled -> closed, anything else -> open. Best-effort; the
// GitHub webhook echo then converges any drift back on the Relay side.
func (s *Service) syncGitHubState(i db.GetIssueForUserRow, status string) {
	if s.GH == nil || !i.GithubNumber.Valid || !i.GithubRepoOwner.Valid || !i.GithubRepoName.Valid {
		return
	}
	state := "open"
	if statuses.IsClosed(s.defsFor(context.Background(), i.ProjectID), status) {
		state = "closed"
	}
	go s.closeOnGitHub(i.GithubInstallationID.Int64, i.GithubRepoOwner.String, i.GithubRepoName.String, int(i.GithubNumber.Int32), state)
}

func (s *Service) closeOnGitHub(installID int64, owner, repo string, number int, state string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := s.GH.Client(ctx)
	if err != nil {
		return
	}
	if err := client.SetIssueState(ctx, installID, owner, repo, number, state); err != nil {
		s.log.Warn("github state sync failed", zap.String("state", state), zap.Error(err))
	}
}

func (s *Service) handleConversation(c *gin.Context) {
	row := c.MustGet(ctxIssueKey).(db.GetIssueForUserRow)
	conv, err := s.q.GetIssueConversation(c.Request.Context(), row.ID)
	if err != nil {
		conv, err = s.q.CreateIssueConversation(c.Request.Context(), db.CreateIssueConversationParams{
			ProjectID: row.ProjectID, IssueID: row.ID,
		})
		if err != nil {
			conv, err = s.q.GetIssueConversation(c.Request.Context(), row.ID)
		}
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, conversations.ConversationJSON(conv))
}

// handleFromMessage turns a message into an issue: title defaults to the
// body's first line; the issue thread gets a copy of the message (with its
// attachments) and an activity record links back to the source.
func (s *Service) handleFromMessage(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	user := auth.CurrentUser(c)
	msg, err := s.q.GetMessageWithProjectForUser(c.Request.Context(), db.GetMessageWithProjectForUserParams{
		ID: id, UserID: user.ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "message not found")
		return
	}
	var req struct {
		Title string `json:"title"`
	}
	if c.Request.Body != nil && c.Request.ContentLength > 0 {
		if !httpx.BindJSON(c, &req) {
			return
		}
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = firstLine(msg.Body, 80)
	}
	if title == "" {
		title = "Untitled"
	}
	proj, err := s.q.GetProjectByID(c.Request.Context(), msg.ProjectID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	num, err := s.q.NextIssueNumber(c.Request.Context(), msg.ProjectID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	row, err := s.q.CreateIssue(c.Request.Context(), db.CreateIssueParams{
		ProjectID: msg.ProjectID, Number: num, Title: title, Description: msg.Body,
		Status: "todo", Priority: "none", CreatedBy: user.ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.record(c, row.ID, user.ID, "from_message", gin.H{"message_id": msg.ID.String()})

	// copy the source message (with attachment links) into the issue thread
	if conv, err := s.q.CreateIssueConversation(c.Request.Context(), db.CreateIssueConversationParams{
		ProjectID: msg.ProjectID, IssueID: row.ID,
	}); err == nil {
		mid, err := s.q.CreateMessage(c.Request.Context(), db.CreateMessageParams{
			ConversationID: conv.ID, AuthorUserID: user.ID, Body: msg.Body,
		})
		if err == nil {
			atts, _ := s.q.ListAttachmentsForMessages(c.Request.Context(), []pgtype.UUID{msg.ID})
			for i, a := range atts {
				_ = s.q.LinkMessageAttachment(c.Request.Context(), db.LinkMessageAttachmentParams{
					MessageID: mid, AttachmentID: a.ID, Position: int32(i),
				})
			}
		}
	}
	c.JSON(http.StatusCreated, issueJSON(row, pgtype.Text{}, pgtype.Text{}, nil, proj.Key, pgtype.Text{}, pgtype.Text{}, s.defsFor(c.Request.Context(), proj.ID)))
}

// --- labels ---

func (s *Service) handleListLabels(c *gin.Context) {
	p := c.MustGet(ctxProjectKey).(db.GetProjectForUserRow)
	rows, err := s.q.ListProjectLabels(c.Request.Context(), p.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, l := range rows {
		out = append(out, labelJSON(l))
	}
	c.JSON(http.StatusOK, gin.H{"labels": out})
}

func (s *Service) handleCreateLabel(c *gin.Context) {
	p := c.MustGet(ctxProjectKey).(db.GetProjectForUserRow)
	var req struct {
		Name  string `json:"name" binding:"required"`
		Color string `json:"color" binding:"required"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if len(req.Name) == 0 || len(req.Name) > 40 || !colorRe.MatchString(req.Color) {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "name 1-40 chars, color must be #rrggbb")
		return
	}
	row, err := s.q.CreateLabel(c.Request.Context(), db.CreateLabelParams{
		ProjectID: p.ID, Name: req.Name, Color: req.Color,
	})
	if err != nil {
		if isUniqueViolation(err) {
			httpx.Error(c, http.StatusConflict, "conflict", "label already exists")
			return
		}
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusCreated, labelJSON(row))
}

// --- helpers ---

func (s *Service) linkLabels(c *gin.Context, issueID pgtype.UUID, ids []pgtype.UUID) {
	for _, id := range ids {
		_ = s.q.LinkIssueLabel(c.Request.Context(), db.LinkIssueLabelParams{IssueID: issueID, LabelID: id})
	}
}

func (s *Service) issueLabels(c *gin.Context, issueID pgtype.UUID) []gin.H {
	rows, err := s.q.ListIssueLabels(c.Request.Context(), issueID)
	if err != nil {
		return nil
	}
	out := make([]gin.H, 0, len(rows))
	for _, l := range rows {
		out = append(out, labelJSON(l))
	}
	return out
}

func (s *Service) labelsFor(c *gin.Context, ids []pgtype.UUID) map[string][]gin.H {
	out := map[string][]gin.H{}
	if len(ids) == 0 {
		return out
	}
	rows, err := s.q.ListLabelsForIssues(c.Request.Context(), ids)
	if err != nil {
		return out
	}
	for _, r := range rows {
		out[r.IssueID.String()] = append(out[r.IssueID.String()], labelJSON(db.IssueLabel{
			ID: r.ID, ProjectID: r.ProjectID, Name: r.Name, Color: r.Color,
		}))
	}
	return out
}

func (s *Service) projectKey(c *gin.Context, projectID pgtype.UUID) string {
	p, err := s.q.GetProjectByID(c.Request.Context(), projectID)
	if err != nil {
		return "?"
	}
	return p.Key
}

func (s *Service) record(c *gin.Context, issueID, actorID pgtype.UUID, kind string, payload gin.H) {
	b, _ := json.Marshal(payload)
	if _, err := s.q.RecordIssueActivity(c.Request.Context(), db.RecordIssueActivityParams{
		IssueID: issueID, ActorUserID: actorID, Kind: kind, Payload: b,
	}); err != nil {
		s.log.Error("issue activity write failed", zap.Error(err))
	}
}

func (s *Service) activityJSON(c *gin.Context, issueID pgtype.UUID) []gin.H {
	rows, err := s.q.ListIssueActivity(c.Request.Context(), issueID)
	if err != nil {
		return []gin.H{}
	}
	out := make([]gin.H, 0, len(rows))
	for _, a := range rows {
		var payload map[string]any
		_ = json.Unmarshal(a.Payload, &payload)
		var actor gin.H
		if a.ActorUserID.Valid {
			actor = authorJSON("user", a.ActorUserID, a.ActorName, a.ActorAvatar)
		} else {
			actor = authorJSON("agent", a.ActorAgentID, a.ActorName, a.ActorAvatar)
		}
		out = append(out, gin.H{
			"id": a.ID.String(), "kind": a.Kind, "actor": actor,
			"payload":    payload,
			"created_at": a.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	return out
}

var colorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func parseUUIDs(raw []string) ([]pgtype.UUID, bool) {
	ids := make([]pgtype.UUID, 0, len(raw))
	for _, s := range raw {
		var u pgtype.UUID
		if err := u.Scan(s); err != nil {
			return nil, true
		}
		ids = append(ids, u)
	}
	return ids, false
}

func issueIDs(rows []db.ListIssuesForUserRow) []pgtype.UUID {
	out := make([]pgtype.UUID, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.ID)
	}
	return out
}

func firstLine(s string, max int) string {
	line, _, _ := strings.Cut(s, "\n")
	line = strings.TrimSpace(line)
	if len(line) > max {
		line = strings.TrimSpace(line[:max]) + "..."
	}
	return line
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// --- wire shapes ---

func labelJSON(l db.IssueLabel) gin.H {
	return gin.H{
		"id": l.ID.String(), "project_id": l.ProjectID.String(),
		"name": l.Name, "color": l.Color,
	}
}

func authorJSON(kind string, id pgtype.UUID, name, avatar pgtype.Text) gin.H {
	var av *string
	if avatar.Valid {
		v := "/api/files/" + avatar.String
		av = &v
	}
	return gin.H{"kind": kind, "id": id.String(), "name": name.String, "avatar_url": av}
}

// issueJSON renders an issue; assignee fields come from the optional users
// join on the read queries.
func issueJSON(i db.Issue, assigneeName, assigneeAvatar pgtype.Text, labels []gin.H, projectKey string, ghOwner, ghRepo pgtype.Text, defs []statuses.Def) gin.H {
	var assignee gin.H
	if i.AssigneeID.Valid {
		assignee = authorJSON("user", i.AssigneeID, assigneeName, assigneeAvatar)
	}
	out := gin.H{
		"id": i.ID.String(), "project_id": i.ProjectID.String(),
		"number": i.Number, "key": projectKey + "-" + strconv.Itoa(int(i.Number)),
		"title": i.Title, "description": i.Description,
		"status": i.Status, "priority": i.Priority,
		"assignee": assignee, "labels": labelsOrEmpty(labels),
		"origin":     i.Origin,
		"created_at": i.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		"updated_at": i.UpdatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
	if i.GithubNumber.Valid && ghOwner.Valid && ghRepo.Valid {
		full := ghOwner.String + "/" + ghRepo.String
		state := "open"
		if i.GithubState.Valid && i.GithubState.String != "" {
			state = i.GithubState.String
		} else if statuses.IsClosed(defs, i.Status) {
			state = "closed"
		}
		url := i.GithubUrl.String
		if url == "" {
			path := "issues"
			if i.GithubKind == "pr" {
				path = "pull"
			}
			url = "https://github.com/" + full + "/" + path + "/" + strconv.Itoa(int(i.GithubNumber.Int32))
		}
		out["github"] = gin.H{
			"repo":   full,
			"number": i.GithubNumber.Int32,
			"kind":   i.GithubKind,
			"state":  state,
			"url":    url,
		}
	}
	return out
}

func labelsOrEmpty(l []gin.H) []gin.H {
	if l == nil {
		return []gin.H{}
	}
	return l
}

// row adapters - the three read queries all select i.* plus the assignee join
func listRowToIssue(r db.ListIssuesForUserRow) db.Issue {
	return db.Issue{
		ID: r.ID, ProjectID: r.ProjectID, Number: r.Number, Title: r.Title,
		Description: r.Description, Status: r.Status, Priority: r.Priority,
		AssigneeID: r.AssigneeID, AgentID: r.AgentID, CreatedBy: r.CreatedBy,
		GithubNodeID: r.GithubNodeID, GithubRepoID: r.GithubRepoID,
		GithubNumber: r.GithubNumber, Origin: r.Origin,
		GithubKind: r.GithubKind, GithubState: r.GithubState, GithubUrl: r.GithubUrl,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func forUserRowToIssue(r db.GetIssueForUserRow) db.Issue {
	return db.Issue{
		ID: r.ID, ProjectID: r.ProjectID, Number: r.Number, Title: r.Title,
		Description: r.Description, Status: r.Status, Priority: r.Priority,
		AssigneeID: r.AssigneeID, AgentID: r.AgentID, CreatedBy: r.CreatedBy,
		GithubNodeID: r.GithubNodeID, GithubRepoID: r.GithubRepoID,
		GithubNumber: r.GithubNumber, Origin: r.Origin,
		GithubKind: r.GithubKind, GithubState: r.GithubState, GithubUrl: r.GithubUrl,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func byIDRowToIssue(r db.GetIssueByIDRow) db.Issue {
	return db.Issue{
		ID: r.ID, ProjectID: r.ProjectID, Number: r.Number, Title: r.Title,
		Description: r.Description, Status: r.Status, Priority: r.Priority,
		AssigneeID: r.AssigneeID, AgentID: r.AgentID, CreatedBy: r.CreatedBy,
		GithubNodeID: r.GithubNodeID, GithubRepoID: r.GithubRepoID,
		GithubNumber: r.GithubNumber, Origin: r.Origin,
		GithubKind: r.GithubKind, GithubState: r.GithubState, GithubUrl: r.GithubUrl,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func (s *Service) publish(projectID pgtype.UUID, typ string, data gin.H) {
	if s.Bus == nil {
		return
	}
	pid, _ := uuid.FromBytes(projectID.Bytes[:])
	s.Bus.Publish(events.Event{Type: typ, ProjectID: pid, Data: map[string]any{"issue": data}})
}
