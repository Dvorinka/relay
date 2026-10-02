// Package realtime serves the SSE stream and the notification reads
// (unread counts, mentions) that power live UI updates.
package realtime

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	q   *db.Queries
	hub *events.Hub
}

func NewService(hub *events.Hub, pool *pgxpool.Pool) *Service {
	return &Service{q: db.New(pool), hub: hub}
}

func (s *Service) RegisterRoutes(priv gin.IRoutes) {
	priv.GET("/events", s.handleStream)
	priv.GET("/me/unread", s.handleUnread)
	priv.GET("/me/mentions", s.handleMentions)
}

// handleStream is the single SSE endpoint. Events carry a project_id; each
// event is filtered through a membership check so a subscriber only receives
// events for workspaces they belong to. Self-hosted scale makes the per-event
// query acceptable.
func (s *Service) handleStream(c *gin.Context) {
	user := auth.CurrentUser(c)
	w := c.Writer
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	w.Flush()

	id, ch := s.hub.Subscribe()
	defer s.hub.Unsubscribe(id)

	ctx := c.Request.Context()
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-keepalive.C:
			if _, err := w.WriteString(": ka\n\n"); err != nil {
				return
			}
			w.Flush()
		case e, ok := <-ch:
			if !ok {
				return
			}
			// membership gate — drop events from workspaces the user isn't in
			pid := pgtype.UUID{Bytes: e.ProjectID, Valid: true}
			if _, err := s.q.GetProjectForUser(ctx, db.GetProjectForUserParams{
				ID: pid, UserID: user.ID,
			}); err != nil {
				continue
			}
			data, _ := json.Marshal(e)
			if _, err := w.WriteString("data: " + string(data) + "\n\n"); err != nil {
				return
			}
			w.Flush()
		}
	}
}

func (s *Service) handleUnread(c *gin.Context) {
	user := auth.CurrentUser(c)
	rows, err := s.q.UnreadCounts(c.Request.Context(), user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "internal", "message": "internal error"}})
		return
	}
	out := map[string]int{}
	for _, r := range rows {
		out[r.ProjectID.String()] = int(r.Unread)
	}
	c.JSON(http.StatusOK, gin.H{"unread": out})
}

func (s *Service) handleMentions(c *gin.Context) {
	user := auth.CurrentUser(c)
	rows, err := s.q.MentionsForUser(c.Request.Context(), user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "internal", "message": "internal error"}})
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, m := range rows {
		kind := "user"
		if m.AuthorAgentID.Valid {
			kind = "agent"
		}
		var avatar any
		if m.AuthorAvatar.Valid && m.AuthorAvatar.String != "" {
			avatar = m.AuthorAvatar.String
		}
		out = append(out, gin.H{
			"id":         m.ID.String(),
			"body":       m.Body,
			"created_at": m.CreatedAt.Time,
			"project_id": m.ProjectID.String(),
			"is_read":    m.IsRead,
			"author": gin.H{
				"name":   m.AuthorName,
				"avatar": avatar,
				"kind":   kind,
			},
		})
	}
	c.JSON(http.StatusOK, gin.H{"mentions": out})
}
