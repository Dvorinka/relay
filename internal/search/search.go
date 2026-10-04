// Package search serves the global search endpoint — Postgres FTS over
// messages, issues, projects, and todos, restricted to the caller's
// workspaces. Discord-style qualifiers narrow message results:
// from:name, in:KEY, has:image|file, before:/after:YYYY-MM-DD.
package search

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
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

var qualifier = regexp.MustCompile(`^(from|in|has|before|after):(\S+)`)

// splitQuery extracts Discord-style qualifiers; the remainder is FTS text.
func splitQuery(raw string) (text, author, projectKey, has string, before, after pgtype.Timestamptz) {
	var words []string
	for _, w := range strings.Fields(raw) {
		if m := qualifier.FindStringSubmatch(w); m != nil {
			switch m[1] {
			case "from":
				author = m[2]
				continue
			case "in":
				projectKey = m[2]
				continue
			case "has":
				has = strings.ToLower(m[2])
				continue
			case "before", "after":
				if t, err := time.Parse("2006-01-02", m[2]); err == nil {
					ts := pgtype.Timestamptz{Time: t, Valid: true}
					if m[1] == "before" {
						before = ts
					} else {
						after = ts
					}
					continue
				}
			}
		}
		words = append(words, w)
	}
	text = strings.Join(words, " ")
	return
}

func (s *Service) handle(c *gin.Context) {
	user := auth.CurrentUser(c)
	raw := strings.TrimSpace(c.Query("q"))
	if len(raw) < 2 || len(raw) > 200 {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"code": "bad_request", "message": "q must be 2-200 chars"}})
		return
	}
	ctx := c.Request.Context()
	text, author, projectKey, has, before, after := splitQuery(raw)

	hasImage := pgtype.Bool{}
	hasFile := pgtype.Bool{}
	switch has {
	case "image":
		hasImage = pgtype.Bool{Bool: true, Valid: true}
	case "file", "attachment":
		hasFile = pgtype.Bool{Bool: true, Valid: true}
	}

	// Qualifier-only searches skip the other entity kinds — a bare
	// "from:me" should not flood results with every issue and todo.
	if author == "me" {
		author = user.Name
	}
	authorLike, keyEq := "", ""
	if author != "" {
		authorLike = "%" + author + "%"
	}
	if projectKey != "" {
		keyEq = projectKey
	}
	msgs, _ := s.q.SearchMessages(ctx, db.SearchMessagesParams{
		UserID:     user.ID,
		Q:          text,
		Author:     authorLike,
		ProjectKey: keyEq,
		HasImage:   hasImage,
		HasFile:    hasFile,
		Before:     before,
		After:      after,
	})
	issues := []db.SearchIssuesRow{}
	projs := []db.SearchProjectsRow{}
	todos := []db.SearchTodosRow{}
	if text != "" {
		issues, _ = s.q.SearchIssues(ctx, db.SearchIssuesParams{UserID: user.ID, WebsearchToTsquery: text})
		projs, _ = s.q.SearchProjects(ctx, db.SearchProjectsParams{UserID: user.ID, WebsearchToTsquery: text})
		todos, _ = s.q.SearchTodos(ctx, db.SearchTodosParams{UserID: user.ID, WebsearchToTsquery: text})
	}

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
