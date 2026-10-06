// Package todos exposes agent-managed project todos over REST. MCP agents
// get the same table through internal/mcpserver tools.
package todos

import (
	"net/http"
	"strconv"
	"strings"

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

const ctxProject = "relay.todo_project"
const ctxTodo = "relay.todo"

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
	g.GET("/projects/:id/todos", s.memberOnly, s.handleList)
	g.POST("/projects/:id/todos", s.memberOnly, s.handleCreate)
	g.POST("/projects/:id/todos/delete", s.memberOnly, s.handleBulkDelete)
	g.PATCH("/todos/:id", s.todoGate, s.handleUpdate)
	g.DELETE("/todos/:id", s.todoGate, s.handleDelete)
	// key-based issue resolution for message linkification (/app/p/:id/k/KEY-N)
	g.GET("/projects/:id/issues/key/:key", s.memberOnly, s.handleIssueByKey)
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

func (s *Service) todoGate(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		c.Abort()
		return
	}
	t, err := s.q.GetTodo(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "todo not found")
		c.Abort()
		return
	}
	if _, err := s.q.GetProjectForUser(c.Request.Context(), db.GetProjectForUserParams{
		ID: t.ProjectID, UserID: auth.CurrentUser(c).ID,
	}); err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		c.Abort()
		return
	}
	c.Set(ctxTodo, t)
	c.Next()
}

// --- JSON ---

func todoJSON(t db.ListTodosRow) gin.H {
	var agent, issue gin.H
	if t.AgentID.Valid || t.AgentName != "" {
		agent = gin.H{"name": t.AgentName}
		if t.AgentID.Valid {
			agent["id"] = t.AgentID.String()
		}
	}
	if t.IssueID.Valid && t.IssueKey.Valid {
		issue = gin.H{
			"id":  t.IssueID.String(),
			"key": t.IssueKey.String + "-" + strconv.Itoa(int(t.IssueNumber.Int32)),
		}
	}
	return gin.H{
		"id": t.ID.String(), "project_id": t.ProjectID.String(),
		"content": t.Content, "done": t.Done, "status": t.Status, "position": t.Position,
		"agent": agent, "issue": issue,
		"created_at": t.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		"updated_at": t.UpdatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
}

// --- handlers ---

func (s *Service) handleList(c *gin.Context) {
	p := c.MustGet(ctxProject).(db.GetProjectForUserRow)
	rows, err := s.q.ListTodos(c.Request.Context(), p.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, todoJSON(r))
	}
	c.JSON(http.StatusOK, gin.H{"todos": out})
}

func (s *Service) handleCreate(c *gin.Context) {
	p := c.MustGet(ctxProject).(db.GetProjectForUserRow)
	var req struct {
		Content string `json:"content" binding:"required"`
		IssueID string `json:"issue_id"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" || len(req.Content) > 500 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "content must be 1-500 chars")
		return
	}
	var issueID pgtype.UUID
	if req.IssueID != "" {
		if err := issueID.Scan(req.IssueID); err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid issue_id")
			return
		}
	}
	row, err := s.q.CreateTodo(c.Request.Context(), db.CreateTodoParams{
		ProjectID: p.ID, IssueID: issueID, Content: req.Content,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.publish(p.ID, "todo.changed")
	c.JSON(http.StatusCreated, s.todoByID(c, row.ID))
}

func (s *Service) handleUpdate(c *gin.Context) {
	t := c.MustGet(ctxTodo).(db.AgentTodo)
	var req struct {
		Content *string `json:"content"`
		Done    *bool   `json:"done"`
		Status  *string `json:"status"`
		IssueID *string `json:"issue_id"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	var params db.UpdateTodoParams
	params.ID = t.ID
	if req.Content != nil {
		v := strings.TrimSpace(*req.Content)
		if v == "" || len(v) > 500 {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "content must be 1-500 chars")
			return
		}
		params.Content = pgtype.Text{String: v, Valid: true}
	}
	if req.Done != nil {
		params.Done = pgtype.Bool{Bool: *req.Done, Valid: true}
	}
	if req.Status != nil {
		switch *req.Status {
		case "todo", "in_progress", "done":
			params.Status = pgtype.Text{String: *req.Status, Valid: true}
		default:
			httpx.Error(c, http.StatusBadRequest, "bad_request", "status must be todo|in_progress|done")
			return
		}
	}
	if req.IssueID != nil {
		var iid pgtype.UUID
		if *req.IssueID != "" {
			if err := iid.Scan(*req.IssueID); err != nil {
				httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid issue_id")
				return
			}
		}
		params.IssueID = iid
	}
	if _, err := s.q.UpdateTodo(c.Request.Context(), params); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.publish(t.ProjectID, "todo.changed")
	c.JSON(http.StatusOK, s.todoByID(c, t.ID))
}

func (s *Service) handleDelete(c *gin.Context) {
	t := c.MustGet(ctxTodo).(db.AgentTodo)
	if err := s.q.DeleteTodo(c.Request.Context(), t.ID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.publish(t.ProjectID, "todo.changed")
	c.Status(http.StatusNoContent)
}

// handleBulkDelete drops many todos in one call — one query, one event. The
// DELETE verb can't carry a JSON body through every proxy, so this is a POST.
func (s *Service) handleBulkDelete(c *gin.Context) {
	p := c.MustGet(ctxProject).(db.GetProjectForUserRow)
	var req struct {
		IDs []string `json:"ids" binding:"required"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if len(req.IDs) == 0 || len(req.IDs) > 200 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "ids must contain 1-200 items")
		return
	}
	ids := make([]pgtype.UUID, 0, len(req.IDs))
	for _, raw := range req.IDs {
		var id pgtype.UUID
		if err := id.Scan(raw); err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid todo id")
			return
		}
		ids = append(ids, id)
	}
	n, err := s.q.DeleteTodos(c.Request.Context(), db.DeleteTodosParams{
		ProjectID: p.ID,
		Ids:       ids,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.publish(p.ID, "todo.changed")
	c.JSON(http.StatusOK, gin.H{"deleted": n})
}

// handleIssueByKey resolves KEY-42 -> the issue id for linkification.
func (s *Service) handleIssueByKey(c *gin.Context) {
	p := c.MustGet(ctxProject).(db.GetProjectForUserRow)
	key := strings.ToUpper(c.Param("key"))
	prefix, numStr, ok := strings.Cut(key, "-")
	if !ok || prefix != strings.ToUpper(p.Key) {
		httpx.Error(c, http.StatusNotFound, "not_found", "issue not found")
		return
	}
	var num int32
	for _, r := range numStr {
		if r < '0' || r > '9' {
			httpx.Error(c, http.StatusNotFound, "not_found", "issue not found")
			return
		}
		num = num*10 + (r - '0')
	}
	row, err := s.q.GetIssueByKey(c.Request.Context(), db.GetIssueByKeyParams{
		ProjectID: p.ID, Number: num,
	})
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "issue not found")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": row.ID.String(), "key": key})
}

func (s *Service) todoByID(c *gin.Context, id pgtype.UUID) gin.H {
	t, err := s.q.GetTodoJoined(c.Request.Context(), id)
	if err != nil {
		return gin.H{"id": id.String()}
	}
	return todoJSON(db.ListTodosRow(t))
}

func (s *Service) publish(projectID pgtype.UUID, typ string) {
	if s.Bus == nil {
		return
	}
	pid, _ := uuid.FromBytes(projectID.Bytes[:])
	s.Bus.Publish(events.Event{Type: typ, ProjectID: pid})
}
