// Package search serves the global search endpoint — Postgres FTS over
// messages, issues, projects, and todos, restricted to the caller's
// workspaces.
package search

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	q *db.Queries
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{q: db.New(pool)}
}

func (s *Service) RegisterRoutes(priv gin.IRoutes) {
	priv.GET("/search", s.handle)
}

func (s *Service) handle(c *gin.Context) {
	user := auth.CurrentUser(c)
	q := strings.TrimSpace(c.Query("q"))
	if len(q) < 2 || len(q) > 200 {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"code": "bad_request", "message": "q must be 2-200 chars"}})
		return
	}
	ctx := c.Request.Context()

	msgs, _ := s.q.SearchMessages(ctx, db.SearchMessagesParams{UserID: user.ID, WebsearchToTsquery: q})
	issues, _ := s.q.SearchIssues(ctx, db.SearchIssuesParams{UserID: user.ID, WebsearchToTsquery: q})
	projs, _ := s.q.SearchProjects(ctx, db.SearchProjectsParams{UserID: user.ID, WebsearchToTsquery: q})
	todos, _ := s.q.SearchTodos(ctx, db.SearchTodosParams{UserID: user.ID, WebsearchToTsquery: q})

	mOut := make([]gin.H, 0, len(msgs))
	for _, m := range msgs {
		mOut = append(mOut, gin.H{
			"id": m.ID.String(), "body": m.Body, "project_id": m.ProjectID.String(),
			"author": m.AuthorName, "created_at": m.CreatedAt.Time,
		})
	}
	iOut := make([]gin.H, 0, len(issues))
	for _, i := range issues {
		iOut = append(iOut, gin.H{
			"id": i.ID.String(), "key": i.ProjectKey + "-" + strconv.Itoa(int(i.Number)),
			"title": i.Title, "status": i.Status, "priority": i.Priority,
			"project_id": i.ProjectID.String(),
		})
	}
	pOut := make([]gin.H, 0, len(projs))
	for _, p := range projs {
		pOut = append(pOut, gin.H{
			"id": p.ID.String(), "key": p.Key, "name": p.Name,
			"description": p.Description, "icon": p.Icon, "color": p.Color,
		})
	}
	tOut := make([]gin.H, 0, len(todos))
	for _, t := range todos {
		tOut = append(tOut, gin.H{
			"id": t.ID.String(), "content": t.Content, "done": t.Done,
			"project_id": t.ProjectID.String(),
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"messages": mOut, "issues": iOut, "projects": pOut, "todos": tOut,
	})
}
