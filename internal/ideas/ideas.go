// Package ideas: brainstorm documents. An idea pairs a title/summary with an
// Excalidraw-compatible scene (mindmaps, sketches) and lives on a project for
// context. "Convert" spins the idea into an issue or a fresh project once the
// brainstorm turns into real work.
package ideas

import (
	"encoding/json"
	"net/http"
	"regexp"
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

var validStatus = map[string]bool{"open": true, "converted": true, "archived": true}
var keyPattern = regexp.MustCompile(`^[A-Z0-9]{2,6}$`)

type Service struct {
	q   *db.Queries
	log *zap.Logger
}

func NewService(log *zap.Logger, pool *pgxpool.Pool) *Service {
	return &Service{q: db.New(pool), log: log}
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.GET("/projects/:id/ideas", s.projectGate, s.handleList)
	g.POST("/projects/:id/ideas", s.projectGate, s.handleCreate)
	g.GET("/workspaces/:id/ideas", s.workspaceGate, s.handleWorkspaceList)
	g.POST("/workspaces/:id/ideas", s.workspaceGate, s.handleWorkspaceCreate)
	g.GET("/ideas/:id", s.ideaGate, s.handleGet)
	g.PATCH("/ideas/:id", s.ideaGate, s.handleUpdate)
	g.DELETE("/ideas/:id", s.ideaGate, s.handleDelete)
	g.POST("/ideas/:id/convert", s.ideaGate, s.handleConvert)
}

const ctxProjectKey = "relay.idea_project"
const ctxIdeaKey = "relay.idea"

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

func (s *Service) workspaceGate(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	role, err := s.q.GetWorkspaceRole(c.Request.Context(), db.GetWorkspaceRoleParams{
		WorkspaceID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil || role == "" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	c.Set(ctxProjectKey, id)
	c.Next()
}

func (s *Service) ideaGate(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	i, err := s.q.GetIdea(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "idea not found")
		return
	}
	role, err := s.q.GetWorkspaceRole(c.Request.Context(), db.GetWorkspaceRoleParams{
		WorkspaceID: i.WorkspaceID, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil || role == "" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	c.Set(ctxIdeaKey, i)
	c.Next()
}

// --- handlers ---

func (s *Service) handleList(c *gin.Context) {
	p := c.MustGet(ctxProjectKey).(db.GetProjectForUserRow)
	rows, err := s.q.ListProjectIdeas(c.Request.Context(), p.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "could not list ideas")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, ideaJSON(listToIdea(r), r.ProjectKey, r.ProjectName, r.AuthorName))
	}
	c.JSON(http.StatusOK, gin.H{"ideas": out})
}

func (s *Service) handleWorkspaceList(c *gin.Context) {
	wsID := c.MustGet(ctxProjectKey).(pgtype.UUID)
	rows, err := s.q.ListWorkspaceIdeas(c.Request.Context(), wsID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "could not list ideas")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, ideaJSON(wsToIdea(r), r.ProjectKey.String, r.ProjectName.String, r.AuthorName))
	}
	c.JSON(http.StatusOK, gin.H{"ideas": out})
}

// projectInWorkspace resolves an optional project_id body field to a project
// the caller can see inside wsID — platform-wide ideas carry none.
func (s *Service) projectInWorkspace(c *gin.Context, wsID pgtype.UUID, raw string) (db.GetProjectForUserRow, bool) {
	var p db.GetProjectForUserRow
	if strings.TrimSpace(raw) == "" {
		return p, true
	}
	var pid pgtype.UUID
	if err := pid.Scan(raw); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid project_id")
		return p, false
	}
	p, err := s.q.GetProjectForUser(c.Request.Context(), db.GetProjectForUserParams{
		ID: pid, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil || p.WorkspaceID != wsID {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "project_id must be a project in this workspace")
		return p, false
	}
	return p, true
}

func (s *Service) handleCreate(c *gin.Context) {
	p := c.MustGet(ctxProjectKey).(db.GetProjectForUserRow)
	var req struct {
		Title   string          `json:"title" binding:"required"`
		Summary string          `json:"summary"`
		Scene   json.RawMessage `json:"scene"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "title is required")
		return
	}
	s.create(c, p.WorkspaceID, p.ID, p.Key, p.Name, req.Title, req.Summary, req.Scene)
}

// handleWorkspaceCreate is the workspace-level entry: project_id in the body
// is optional — omit for a platform-wide idea.
func (s *Service) handleWorkspaceCreate(c *gin.Context) {
	wsID := c.MustGet(ctxProjectKey).(pgtype.UUID)
	var req struct {
		Title     string          `json:"title" binding:"required"`
		Summary   string          `json:"summary"`
		Scene     json.RawMessage `json:"scene"`
		ProjectID string          `json:"project_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "title is required")
		return
	}
	p, ok := s.projectInWorkspace(c, wsID, req.ProjectID)
	if !ok {
		return
	}
	s.create(c, wsID, p.ID, p.Key, p.Name, req.Title, req.Summary, req.Scene)
}

func (s *Service) create(c *gin.Context, wsID, projectID pgtype.UUID, key, name, title, summary string, rawScene json.RawMessage) {
	title = strings.TrimSpace(title)
	if title == "" || len(title) > 200 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "title must be 1-200 chars")
		return
	}
	scene := []byte("{}")
	if len(rawScene) > 0 {
		var probe any
		if json.Unmarshal(rawScene, &probe) != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "scene must be valid JSON")
			return
		}
		scene = rawScene
	}
	i, err := s.q.CreateIdea(c.Request.Context(), db.CreateIdeaParams{
		WorkspaceID:   wsID,
		ProjectID:     projectID,
		Title:         title,
		Summary:       summary,
		Scene:         scene,
		CreatedByUser: auth.CurrentUser(c).ID,
	})
	if err != nil {
		s.log.Error("create idea", zap.Error(err))
		httpx.Error(c, http.StatusInternalServerError, "internal", "could not create idea")
		return
	}
	c.JSON(http.StatusCreated, ideaJSON(i, key, name, auth.CurrentUser(c).Name))
}

func (s *Service) handleGet(c *gin.Context) {
	i := c.MustGet(ctxIdeaKey).(db.GetIdeaRow)
	c.JSON(http.StatusOK, ideaJSON(getToIdea(i), i.ProjectKey.String, i.ProjectName.String, i.AuthorName))
}

func (s *Service) handleUpdate(c *gin.Context) {
	i := c.MustGet(ctxIdeaKey).(db.GetIdeaRow)
	var req struct {
		Title     *string          `json:"title"`
		Summary   *string          `json:"summary"`
		Status    *string          `json:"status"`
		Scene     *json.RawMessage `json:"scene"`
		ProjectID *string          `json:"project_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	var title, summary, status pgtype.Text
	var scene []byte
	if req.Title != nil {
		if t := strings.TrimSpace(*req.Title); t != "" && len(t) <= 200 {
			title = pgtype.Text{String: t, Valid: true}
		}
	}
	if req.Summary != nil {
		summary = pgtype.Text{String: *req.Summary, Valid: true}
	}
	if req.Status != nil {
		if !validStatus[*req.Status] {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "status must be open|converted|archived")
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
	var projectID pgtype.UUID
	key, name := i.ProjectKey.String, i.ProjectName.String
	if req.ProjectID != nil {
		p, ok := s.projectInWorkspace(c, i.WorkspaceID, *req.ProjectID)
		if !ok {
			return
		}
		projectID = p.ID
		key, name = p.Key, p.Name
	}
	updated, err := s.q.UpdateIdea(c.Request.Context(), db.UpdateIdeaParams{
		ID: i.ID, Title: title, Summary: summary, Scene: scene, Status: status,
		ProjectID: projectID,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "could not update idea")
		return
	}
	c.JSON(http.StatusOK, ideaJSON(updated, key, name, i.AuthorName))
}

func (s *Service) handleDelete(c *gin.Context) {
	i := c.MustGet(ctxIdeaKey).(db.GetIdeaRow)
	if err := s.q.DeleteIdea(c.Request.Context(), i.ID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "could not delete idea")
		return
	}
	c.Status(http.StatusNoContent)
}

// handleConvert turns a brainstormed idea into real work: an issue on its
// project, or a brand-new project in the same workspace. Either way the idea
// is marked converted but kept — the canvas stays viewable as history.
func (s *Service) handleConvert(c *gin.Context) {
	i := c.MustGet(ctxIdeaKey).(db.GetIdeaRow)
	user := auth.CurrentUser(c)
	var req struct {
		Kind        string `json:"kind" binding:"required"` // issue | project
		Title       string `json:"title"`
		Description string `json:"description"`
		Key         string `json:"key"`        // project kind only
		ProjectID   string `json:"project_id"` // issue kind on a platform idea
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "kind is required")
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = i.Title
	}
	desc := strings.TrimSpace(req.Description)
	if desc == "" {
		desc = i.Summary
	}
	switch req.Kind {
	case "issue":
		pid := i.ProjectID
		if !pid.Valid {
			// platform-wide ideas pick a target project at convert time
			p, ok := s.projectInWorkspace(c, i.WorkspaceID, req.ProjectID)
			if !ok {
				return
			}
			if !p.ID.Valid {
				httpx.Error(c, http.StatusBadRequest, "bad_request", "project_id is required for platform-wide ideas")
				return
			}
			pid = p.ID
		}
		num, err := s.q.NextIssueNumber(c.Request.Context(), pid)
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "could not create issue")
			return
		}
		issue, err := s.q.CreateIssue(c.Request.Context(), db.CreateIssueParams{
			ProjectID: pid, Number: num, Title: title,
			Description: desc, Status: "backlog", Priority: "medium",
			CreatedBy: user.ID,
		})
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "could not create issue")
			return
		}
		_, _ = s.q.CreateIssueConversation(c.Request.Context(), db.CreateIssueConversationParams{
			ProjectID: pid, IssueID: issue.ID,
		})
		s.markConverted(c, i.ID)
		c.JSON(http.StatusCreated, gin.H{
			"issue": gin.H{"id": issue.ID.String(), "number": issue.Number},
		})
	case "project":
		key := strings.ToUpper(strings.TrimSpace(req.Key))
		if !keyPattern.MatchString(key) {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "key must match ^[A-Z0-9]{2,6}$")
			return
		}
		np, err := s.q.CreateProject(c.Request.Context(), db.CreateProjectParams{
			WorkspaceID: i.WorkspaceID, Key: key, Name: title,
			Description: desc, CreatedBy: user.ID,
		})
		if err != nil {
			httpx.Error(c, http.StatusConflict, "key_taken", "a project with this key already exists in the workspace")
			return
		}
		_ = s.q.AddProjectMember(c.Request.Context(), db.AddProjectMemberParams{
			ProjectID: np.ID, UserID: user.ID,
		})
		_, _ = s.q.CreateProjectConversation(c.Request.Context(), np.ID)
		s.markConverted(c, i.ID)
		c.JSON(http.StatusCreated, gin.H{
			"project": gin.H{"id": np.ID.String(), "key": np.Key, "name": np.Name},
		})
	default:
		httpx.Error(c, http.StatusBadRequest, "bad_request", "kind must be issue|project")
	}
}

func (s *Service) markConverted(c *gin.Context, id pgtype.UUID) {
	_, err := s.q.UpdateIdea(c.Request.Context(), db.UpdateIdeaParams{
		ID:     id,
		Status: pgtype.Text{String: "converted", Valid: true},
	})
	if err != nil {
		s.log.Error("mark idea converted", zap.Error(err))
	}
}

// --- JSON ---

func uid(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	id, _ := uuid.FromBytes(u.Bytes[:])
	return id.String()
}

func ideaJSON(i db.Idea, projectKey, projectName, authorName string) gin.H {
	var pid any
	if i.ProjectID.Valid {
		pid = uid(i.ProjectID)
	}
	return gin.H{
		"id":           uid(i.ID),
		"workspace_id": uid(i.WorkspaceID),
		"project_id":   pid,
		"project_key":  projectKey,
		"project_name": projectName,
		"title":        i.Title,
		"summary":      i.Summary,
		"scene":        json.RawMessage(i.Scene),
		"status":       i.Status,
		"author_name":  authorName,
		"created_at":   i.CreatedAt.Time,
		"updated_at":   i.UpdatedAt.Time,
	}
}

func listToIdea(r db.ListProjectIdeasRow) db.Idea {
	return db.Idea{
		ID: r.ID, WorkspaceID: r.WorkspaceID, ProjectID: r.ProjectID,
		Title: r.Title, Summary: r.Summary,
		Scene: r.Scene, Status: r.Status, CreatedByUser: r.CreatedByUser,
		CreatedByAgent: r.CreatedByAgent, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func wsToIdea(r db.ListWorkspaceIdeasRow) db.Idea {
	return db.Idea{
		ID: r.ID, WorkspaceID: r.WorkspaceID, ProjectID: r.ProjectID,
		Title: r.Title, Summary: r.Summary,
		Scene: r.Scene, Status: r.Status, CreatedByUser: r.CreatedByUser,
		CreatedByAgent: r.CreatedByAgent, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func getToIdea(r db.GetIdeaRow) db.Idea {
	return db.Idea{
		ID: r.ID, WorkspaceID: r.WorkspaceID, ProjectID: r.ProjectID,
		Title: r.Title, Summary: r.Summary,
		Scene: r.Scene, Status: r.Status, CreatedByUser: r.CreatedByUser,
		CreatedByAgent: r.CreatedByAgent, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}
