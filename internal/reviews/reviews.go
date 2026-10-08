// Package reviews exposes agent work reviews over REST: structured
// "what I changed" reports a human approves or sends back. Agents submit
// them through internal/mcpserver. Design inspired by devdotfast/whiteboard
// (MIT): fixed-schema review docs with per-file changes, autonomous
// decisions, and required human follow-ups.
package reviews

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/httpx"
)

const ctxProject = "relay.review_project"
const ctxReview = "relay.review"

// Statuses the API emits. Reviews are immutable once answered; a revised
// submission creates a new row pointing at the superseded one.
const (
	StatusPending          = "pending"
	StatusApproved         = "approved"
	StatusChangesRequested = "changes_requested"
	StatusSuperseded       = "superseded"
)

type Service struct {
	q   *db.Queries
	log *zap.Logger
	// Bus publishes domain events for SSE subscribers. Optional.
	Bus *events.Hub
}

func NewService(log *zap.Logger, pool *pgxpool.Pool) *Service {
	return &Service{q: db.New(pool), log: log}
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.GET("/projects/:id/reviews", s.memberOnly, s.handleList)
	g.GET("/me/reviews", s.handleMine)
	g.GET("/issues/:id/reviews", s.issueGate, s.handleIssueReviews)
	g.GET("/reviews/:id", s.reviewGate, s.handleGet)
	g.POST("/reviews/:id/respond", s.reviewGate, s.handleRespond)
}

// --- gates ---

func (s *Service) memberOnly(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		c.Abort()
		return
	}
	p, err := s.q.GetProjectForUser(c.Request.Context(), db.GetProjectForUserParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		c.Abort()
		return
	}
	c.Set(ctxProject, p)
	c.Next()
}

// reviewGate loads the review and verifies the caller belongs to the
// workspace owning its project.
func (s *Service) reviewGate(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		c.Abort()
		return
	}
	r, err := s.q.GetReview(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "review not found")
		c.Abort()
		return
	}
	role, err := s.q.ReviewProjectMembership(c.Request.Context(), db.ReviewProjectMembershipParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil || role == "" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		c.Abort()
		return
	}
	c.Set(ctxReview, r)
	c.Next()
}

// --- JSON ---

func personJSON(id pgtype.UUID, name, avatar string, avatarValid bool) gin.H {
	var av any
	if avatarValid {
		av = "/api/files/" + avatar
	}
	var idv any
	if id.Valid {
		idv = id.String()
	}
	return gin.H{"id": idv, "name": name, "avatar_url": av}
}

// reviewJSON renders one joined review row. jsonb columns pass through as
// raw JSON so the wire shape matches what the agent submitted.
func reviewJSON(r db.GetReviewRow) gin.H {
	raw := func(b []byte) json.RawMessage {
		if len(b) == 0 {
			return json.RawMessage("[]")
		}
		return json.RawMessage(b)
	}
	var issue, respondedAt, supersedes any
	if r.IssueID.Valid && r.IssueNumber.Valid {
		issue = gin.H{
			"id":  r.IssueID.String(),
			"key": r.ProjectKey + "-" + strconv.Itoa(int(r.IssueNumber.Int32)),
		}
	}
	if r.RespondedAt.Valid {
		respondedAt = r.RespondedAt.Time.Format(time.RFC3339)
	}
	if r.Supersedes.Valid {
		supersedes = r.Supersedes.String()
	}
	var responder gin.H
	if r.RespondedBy.Valid {
		responder = personJSON(r.RespondedBy, r.ResponderName.String, r.ResponderAvatar.String, r.ResponderAvatar.Valid)
	}
	return gin.H{
		"id": r.ID.String(), "project_id": r.ProjectID.String(),
		"status": r.Status, "title": r.Title, "summary": r.Summary,
		"files": raw(r.Files), "decisions": raw(r.Decisions),
		"actions": raw(r.Actions), "links": raw(r.Links), "verify": r.Verify,
		"scenes": raw(r.Scenes),
		"agent":  personJSON(r.AgentID, r.AgentName, r.AgentAvatar.String, r.AgentAvatar.Valid),
		"issue":  issue, "supersedes": supersedes,
		"responder": responder, "response": r.Response,
		"responded_at": respondedAt,
		"created_at":   r.CreatedAt.Time.Format(time.RFC3339),
	}
}

// --- handlers ---

func (s *Service) handleList(c *gin.Context) {
	p := c.MustGet(ctxProject).(db.GetProjectForUserRow)
	var status pgtype.Text
	if v := c.Query("status"); v != "" {
		status = pgtype.Text{String: v, Valid: true}
	}
	rows, err := s.q.ListProjectReviews(c.Request.Context(), db.ListProjectReviewsParams{
		ProjectID: p.ID,
		Status:    status,
		Lim:       100,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, reviewJSON(listRowToGet(r)))
	}
	pending, _ := s.q.PendingReviewCount(c.Request.Context(), p.ID)
	c.JSON(http.StatusOK, gin.H{"reviews": out, "pending": pending})
}

// handleMine lists pending reviews across the caller's workspaces - the
// Inbox's "awaiting you" feed.
func (s *Service) handleMine(c *gin.Context) {
	rows, err := s.q.ListMyPendingReviews(c.Request.Context(), auth.CurrentUser(c).ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, gin.H{
			"id": r.ID.String(), "project_id": r.ProjectID.String(),
			"title":       r.Title,
			"agent":       personJSON(r.AgentID, r.AgentName, r.AgentAvatar.String, r.AgentAvatar.Valid),
			"project_key": r.ProjectKey, "project_name": r.ProjectName,
			"created_at": r.CreatedAt.Time.Format(time.RFC3339),
		})
	}
	c.JSON(http.StatusOK, gin.H{"reviews": out})
}

// issueGate verifies membership on the workspace owning the issue, then
// stashes the issue id for the handler (same 404/403 split as issues.go).
func (s *Service) issueGate(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		c.Abort()
		return
	}
	_, err := s.q.GetIssueForUser(c.Request.Context(), db.GetIssueForUserParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil {
		if _, err2 := s.q.GetIssueByID(c.Request.Context(), id); err2 == nil {
			httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		} else {
			httpx.Error(c, http.StatusNotFound, "not_found", "issue not found")
		}
		c.Abort()
		return
	}
	c.Set("relay.issue", id)
	c.Next()
}

// handleIssueReviews lists reviews linked to one issue - the "what the
// agent did about this" block on the issue page.
func (s *Service) handleIssueReviews(c *gin.Context) {
	rows, err := s.q.ListIssueReviews(c.Request.Context(), c.MustGet("relay.issue").(pgtype.UUID))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, reviewJSON(db.GetReviewRow(r)))
	}
	c.JSON(http.StatusOK, gin.H{"reviews": out})
}

func (s *Service) handleGet(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"review": reviewJSON(c.MustGet(ctxReview).(db.GetReviewRow))})
}

// handleRespond records the human verdict: approve or send back with a note.
func (s *Service) handleRespond(c *gin.Context) {
	r := c.MustGet(ctxReview).(db.GetReviewRow)
	var req struct {
		Status   string `json:"status" binding:"required"`
		Response string `json:"response"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if req.Status != StatusApproved && req.Status != StatusChangesRequested {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "status must be approved or changes_requested")
		return
	}
	if req.Status == StatusChangesRequested && strings.TrimSpace(req.Response) == "" {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "a note is required when requesting changes")
		return
	}
	row, err := s.q.RespondToReview(c.Request.Context(), db.RespondToReviewParams{
		ID: r.ID, Status: req.Status,
		RespondedBy: auth.CurrentUser(c).ID,
		Response:    strings.TrimSpace(req.Response),
	})
	if err != nil {
		// update returned no row: someone else answered first
		httpx.Error(c, http.StatusConflict, "already_responded", "this review was already answered")
		return
	}
	s.log.Info("review answered",
		zap.String("review", r.ID.String()), zap.String("status", req.Status))
	s.publish(r.ProjectID, "review.responded", map[string]any{"review_id": r.ID.String(), "status": req.Status})
	fresh, err := s.q.GetReview(c.Request.Context(), row.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"review": reviewJSON(fresh)})
}

func (s *Service) publish(projectID pgtype.UUID, typ string, data map[string]any) {
	if s.Bus == nil {
		return
	}
	pid, _ := uuid.FromBytes(projectID.Bytes[:])
	s.Bus.Publish(events.Event{Type: typ, ProjectID: pid, Data: data})
}

// listRowToGet bridges the two joined row types - identical fields.
func listRowToGet(r db.ListProjectReviewsRow) db.GetReviewRow {
	return db.GetReviewRow(r)
}
