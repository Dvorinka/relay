// Package briefs: visual explanation documents. A brief pairs an
// Excalidraw-compatible scene JSON with a title/summary and its own
// conversation (kind='brief') so users and agents can comment and iterate.
// projects.brief_policy (never|on_request|pre_merge) configures when agents
// are expected to produce them.
package briefs

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

var validPolicy = map[string]bool{"never": true, "on_request": true, "pre_merge": true}
var validStatus = map[string]bool{"open": true, "resolved": true, "archived": true}

type Service struct {
	q   *db.Queries
	log *zap.Logger
}

func NewService(log *zap.Logger, pool *pgxpool.Pool) *Service {
	return &Service{q: db.New(pool), log: log}
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.GET("/projects/:id/briefs", s.projectGate, s.handleList)
	g.POST("/projects/:id/briefs", s.projectGate, s.handleCreate)
	g.POST("/projects/:id/brief-policy", s.projectGate, s.handlePolicy)
	g.GET("/briefs/:id", s.briefGate, s.handleGet)
	g.PATCH("/briefs/:id", s.briefGate, s.handleUpdate)
	g.DELETE("/briefs/:id", s.briefGate, s.handleDelete)
	g.GET("/briefs/:id/conversation", s.briefGate, s.handleConversation)
}

const ctxProjectKey = "relay.brief_project"
const ctxBriefKey = "relay.brief"

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

func (s *Service) briefGate(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	b, err := s.q.GetBrief(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "brief not found")
		return
	}
	if _, err := s.q.GetProjectForUser(c.Request.Context(), db.GetProjectForUserParams{
		ID: b.ProjectID, UserID: auth.CurrentUser(c).ID,
	}); err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	c.Set(ctxBriefKey, b)
	c.Next()
}

// --- handlers ---

type createReq struct {
	Title   string          `json:"title" binding:"required"`
	Summary string          `json:"summary"`
	IssueID string          `json:"issue_id"`
	Scene   json.RawMessage `json:"scene"`
}

func (s *Service) handleCreate(c *gin.Context) {
	p := c.MustGet(ctxProjectKey).(db.GetProjectForUserRow)
	var req createReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "title is required")
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "title is required")
		return
	}
	scene := []byte("{}")
	if len(req.Scene) > 0 {
		var probe any
		if json.Unmarshal(req.Scene, &probe) != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "scene must be valid JSON")
			return
		}
		scene = req.Scene
	}
	var issueID pgtype.UUID
	if req.IssueID != "" {
		if err := issueID.Scan(req.IssueID); err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid issue_id")
			return
		}
	}
	uid := auth.CurrentUser(c).ID
	b, err := s.q.CreateBrief(c.Request.Context(), db.CreateBriefParams{
		ProjectID:     p.ID,
		IssueID:       issueID,
		Title:         title,
		Summary:       req.Summary,
		Scene:         scene,
		CreatedByUser: uid,
	})
	if err != nil {
		s.log.Error("create brief", zap.Error(err))
		httpx.Error(c, http.StatusInternalServerError, "internal", "could not create brief")
		return
	}
	s.makeConversation(c, &b)
	c.JSON(http.StatusCreated, briefJSON(b, auth.CurrentUser(c).Name))
}

// makeConversation creates the comment thread if the brief lacks one.
func (s *Service) makeConversation(c *gin.Context, b *db.Brief) {
	if b.ConversationID.Valid {
		return
	}
	conv, err := s.q.CreateBriefConversation(c.Request.Context(), db.CreateBriefConversationParams{
		ProjectID: b.ProjectID,
		BriefID:   b.ID,
	})
	if err != nil {
		s.log.Error("brief conversation", zap.Error(err))
		return
	}
	_ = s.q.BriefSetConversation(c.Request.Context(), db.BriefSetConversationParams{
		ConversationID: conv.ID,
		ID:             b.ID,
	})
	b.ConversationID = conv.ID
}

func (s *Service) handleList(c *gin.Context) {
	p := c.MustGet(ctxProjectKey).(db.GetProjectForUserRow)
	var issueID pgtype.UUID
	if raw := c.Query("issue_id"); raw != "" {
		if err := issueID.Scan(raw); err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid issue_id")
			return
		}
	}
	rows, err := s.q.ListBriefs(c.Request.Context(), db.ListBriefsParams{
		ProjectID: p.ID,
		IssueID:   issueID,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "could not list briefs")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, briefJSON(listRowToBrief(r), r.AuthorName))
	}
	c.JSON(http.StatusOK, gin.H{"briefs": out, "policy": briefPolicy(p)})
}

func (s *Service) handleGet(c *gin.Context) {
	b := c.MustGet(ctxBriefKey).(db.GetBriefRow)
	c.JSON(http.StatusOK, briefJSON(getRowToBrief(b), b.AuthorName))
}

func (s *Service) handleConversation(c *gin.Context) {
	b := c.MustGet(ctxBriefKey).(db.GetBriefRow)
	if !b.ConversationID.Valid {
		b2 := getRowToBrief(b)
		s.makeConversation(c, &b2)
		b, _ = s.q.GetBrief(c.Request.Context(), b.ID)
	}
	c.JSON(http.StatusOK, gin.H{"id": uid(b.ConversationID)})
}

type updateReq struct {
	Title   *string          `json:"title"`
	Summary *string          `json:"summary"`
	Status  *string          `json:"status"`
	Scene   *json.RawMessage `json:"scene"`
}

func (s *Service) handleUpdate(c *gin.Context) {
	b := c.MustGet(ctxBriefKey).(db.GetBriefRow)
	var req updateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	var title, summary, status pgtype.Text
	var scene []byte
	if req.Title != nil {
		if t := strings.TrimSpace(*req.Title); t != "" {
			title = pgtype.Text{String: t, Valid: true}
		}
	}
	if req.Summary != nil {
		summary = pgtype.Text{String: *req.Summary, Valid: true}
	}
	if req.Status != nil {
		if !validStatus[*req.Status] {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "status must be open|resolved|archived")
			return
		}
		status = pgtype.Text{String: *req.Status, Valid: true}
	}
	if req.Scene != nil {
		var probe any
		if json.Unmarshal(*req.Scene, &probe) != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "scene must be valid JSON")
			return
		}
		scene = *req.Scene
	}
	updated, err := s.q.UpdateBrief(c.Request.Context(), db.UpdateBriefParams{
		ID:      b.ID,
		Title:   title,
		Summary: summary,
		Scene:   scene,
		Status:  status,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "could not update brief")
		return
	}
	c.JSON(http.StatusOK, briefJSON(updated, b.AuthorName))
}

// handleDelete removes the brief and its comment conversation. The FK
// direction (conversations.brief_id -> briefs on delete set null) means the
// conversation row must be deleted first or it survives as an orphan.
func (s *Service) handleDelete(c *gin.Context) {
	b := c.MustGet(ctxBriefKey).(db.GetBriefRow)
	if err := s.q.DeleteBriefConversation(c.Request.Context(), b.ID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "could not delete brief")
		return
	}
	if err := s.q.DeleteBrief(c.Request.Context(), b.ID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "could not delete brief")
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Service) handlePolicy(c *gin.Context) {
	p := c.MustGet(ctxProjectKey).(db.GetProjectForUserRow)
	var req struct {
		Policy string `json:"policy" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || !validPolicy[req.Policy] {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "policy must be never|on_request|pre_merge")
		return
	}
	pol, err := s.q.SetBriefPolicy(c.Request.Context(), db.SetBriefPolicyParams{
		ProjectID: p.ID,
		Policy:    req.Policy,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "could not set policy")
		return
	}
	c.JSON(http.StatusOK, gin.H{"policy": pol})
}

// --- JSON ---

func uid(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	id, _ := uuid.FromBytes(u.Bytes[:])
	return id.String()
}

func briefJSON(b db.Brief, authorName string) gin.H {
	return gin.H{
		"id":              uid(b.ID),
		"project_id":      uid(b.ProjectID),
		"issue_id":        uid(b.IssueID),
		"conversation_id": uid(b.ConversationID),
		"title":           b.Title,
		"summary":         b.Summary,
		"scene":           json.RawMessage(b.Scene),
		"status":          b.Status,
		"author_name":     authorName,
		"created_at":      b.CreatedAt.Time,
		"updated_at":      b.UpdatedAt.Time,
	}
}

func listRowToBrief(r db.ListBriefsRow) db.Brief {
	return db.Brief{
		ID: r.ID, ProjectID: r.ProjectID, IssueID: r.IssueID,
		ConversationID: r.ConversationID, Title: r.Title, Summary: r.Summary,
		Scene: r.Scene, Status: r.Status, CreatedByUser: r.CreatedByUser,
		CreatedByAgent: r.CreatedByAgent, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func getRowToBrief(r db.GetBriefRow) db.Brief {
	return db.Brief{
		ID: r.ID, ProjectID: r.ProjectID, IssueID: r.IssueID,
		ConversationID: r.ConversationID, Title: r.Title, Summary: r.Summary,
		Scene: r.Scene, Status: r.Status, CreatedByUser: r.CreatedByUser,
		CreatedByAgent: r.CreatedByAgent, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func briefPolicy(p db.GetProjectForUserRow) string {
	if p.BriefPolicy == "" {
		return "on_request"
	}
	return p.BriefPolicy
}
