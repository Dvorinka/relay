// Package projects: project CRUD inside workspaces. Access rule per the
// spec: any member of the project's workspace may read/write it;
// project_members tracks membership for finer gates later.
package projects

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/conversations"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

type Service struct {
	q   *db.Queries
	log *zap.Logger
}

func NewService(log *zap.Logger, pool *pgxpool.Pool) *Service {
	return &Service{q: db.New(pool), log: log}
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.GET("/projects", s.handleList)
	g.POST("/projects", s.handleCreate)
	g.GET("/projects/:id", s.memberOnly, s.handleGet)
	g.PATCH("/projects/:id", s.memberOnly, s.handleUpdate)
	g.GET("/projects/:id/overview", s.memberOnly, s.handleOverview)
}

const ctxProject = "relay.project"

// memberOnly resolves :id -> project -> caller's workspace role, stashing
// the project row on the context for the handler.
func (s *Service) memberOnly(c *gin.Context) {
	p, ok := s.projectForUser(c)
	if !ok {
		return
	}
	c.Set(ctxProject, p)
	c.Next()
}

// CurrentProject is the gate's output; handlers call this, never the DB.
func CurrentProject(c *gin.Context) db.GetProjectByIDRow {
	v, _ := c.Get(ctxProject)
	p, _ := v.(db.GetProjectByIDRow)
	return p
}

// projectForUser returns the project when the caller is a workspace member;
// on failure it writes 404 (unknown) or 403 (exists, no access).
func (s *Service) projectForUser(c *gin.Context) (db.GetProjectByIDRow, bool) {
	var p db.GetProjectByIDRow
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return p, false
	}
	p, err := s.q.GetProjectByID(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "project not found")
		return p, false
	}
	role, err := s.q.ProjectWorkspaceRole(c.Request.Context(), db.ProjectWorkspaceRoleParams{
		ID: p.ID, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil || role == "" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return p, false
	}
	return p, true
}

// ProjectJSON is the wire shape; conversations package reuses it.
func projectJSON(p db.GetProjectByIDRow) gin.H {
	return gin.H{
		"id": p.ID.String(), "workspace_id": p.WorkspaceID.String(),
		"key": p.Key, "name": p.Name, "description": p.Description,
		"icon":       textOrNil(p.Icon),
		"color":      textOrNil(p.Color),
		"created_at": p.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
}

func textOrNil(t pgtype.Text) *string {
	if !t.Valid {
		return nil
	}
	return &t.String
}

// --- handlers ---

func (s *Service) handleList(c *gin.Context) {
	rows, err := s.q.ListProjectsForUser(c.Request.Context(), auth.CurrentUser(c).ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, gin.H{
			"id": r.ID.String(), "workspace_id": r.WorkspaceID.String(),
			"key": r.Key, "name": r.Name, "description": r.Description,
			"icon": textOrNil(r.Icon), "color": textOrNil(r.Color),
			"created_at": r.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	c.JSON(http.StatusOK, gin.H{"projects": out})
}

var keyPattern = regexp.MustCompile(`^[A-Z0-9]{2,6}$`)
var colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (s *Service) handleCreate(c *gin.Context) {
	var req struct {
		WorkspaceID string  `json:"workspace_id" binding:"required"`
		Key         string  `json:"key" binding:"required"`
		Name        string  `json:"name" binding:"required"`
		Description string  `json:"description"`
		Icon        *string `json:"icon"`
		Color       *string `json:"color"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Key = strings.ToUpper(strings.TrimSpace(req.Key))
	if req.Name == "" || len(req.Name) > 80 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "name must be 1-80 characters")
		return
	}
	if !keyPattern.MatchString(req.Key) {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "key must match ^[A-Z0-9]{2,6}$")
		return
	}
	if req.Color != nil && *req.Color != "" && !colorPattern.MatchString(*req.Color) {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "color must be #rrggbb")
		return
	}
	var wsID pgtype.UUID
	if err := wsID.Scan(req.WorkspaceID); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid workspace_id")
		return
	}
	user := auth.CurrentUser(c)
	role, err := s.q.GetWorkspaceRole(c.Request.Context(), db.GetWorkspaceRoleParams{
		WorkspaceID: wsID, UserID: user.ID,
	})
	if err != nil || role == "" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	p, err := s.q.CreateProject(c.Request.Context(), db.CreateProjectParams{
		WorkspaceID: wsID, Key: req.Key, Name: req.Name,
		Description: req.Description,
		Icon:        pgtype.Text{String: deref(req.Icon), Valid: req.Icon != nil},
		Color:       pgtype.Text{String: deref(req.Color), Valid: req.Color != nil},
		CreatedBy:   user.ID,
	})
	if err != nil {
		if isUniqueViolation(err) {
			httpx.Error(c, http.StatusConflict, "key_taken", "a project with this key already exists in the workspace")
			return
		}
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	_ = s.q.AddProjectMember(c.Request.Context(), db.AddProjectMemberParams{
		ProjectID: p.ID, UserID: user.ID,
	})
	c.JSON(http.StatusCreated, projectJSON(db.GetProjectByIDRow(p)))
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (s *Service) handleGet(c *gin.Context) {
	c.JSON(http.StatusOK, projectJSON(CurrentProject(c)))
}

func (s *Service) handleUpdate(c *gin.Context) {
	p := CurrentProject(c)
	var req struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		Icon        *string `json:"icon"`
		Color       *string `json:"color"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if n == "" || len(n) > 80 {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "name must be 1-80 characters")
			return
		}
		req.Name = &n
	}
	if req.Color != nil && *req.Color != "" && !colorPattern.MatchString(*req.Color) {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "color must be #rrggbb")
		return
	}
	row, err := s.q.UpdateProject(c.Request.Context(), db.UpdateProjectParams{
		ID:          p.ID,
		Name:        pgtype.Text{String: deref(req.Name), Valid: req.Name != nil},
		Description: pgtype.Text{String: deref(req.Description), Valid: req.Description != nil},
		Icon:        pgtype.Text{String: deref(req.Icon), Valid: req.Icon != nil},
		Color:       pgtype.Text{String: deref(req.Color), Valid: req.Color != nil},
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, projectJSON(db.GetProjectByIDRow(row)))
}

func (s *Service) handleOverview(c *gin.Context) {
	p := CurrentProject(c)
	counts, err := s.q.ProjectCounts(c.Request.Context(), p.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	recent, _ := s.q.RecentProjectMessages(c.Request.Context(), p.ID)
	msgs := make([]gin.H, 0, len(recent))
	for _, m := range recent {
		msgs = append(msgs, conversations.MessageJSON(conversations.MessageView{
			ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
			Body: m.Body, CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
			AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
			AuthorName: m.AuthorName, AuthorAvatar: m.AuthorAvatar,
			ParentAuthorName: m.ParentAuthorName, ParentBody: m.ParentBody,
			ParentDeleted: m.ParentDeleted,
		}))
	}
	acts, _ := s.q.ListProjectIssueActivity(c.Request.Context(), p.ID)
	activity := make([]gin.H, 0, len(acts))
	for _, a := range acts {
		actor := ""
		if a.ActorName.Valid {
			actor = a.ActorName.String
		}
		activity = append(activity, gin.H{
			"id": a.ID.String(), "issue_id": a.IssueID.String(),
			"issue_number": a.IssueNumber, "issue_title": a.IssueTitle,
			"kind": a.Kind, "payload": json.RawMessage(a.Payload),
			"actor":      actor,
			"created_at": a.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"project": projectJSON(p),
		"counts": gin.H{
			"members":       counts.Members,
			"messages":      counts.Messages,
			"conversations": counts.Conversations,
		},
		"recent_messages": msgs,
		"issue_activity":  activity,
	})
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
