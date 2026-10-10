// Package reminders implements "remind me about this message later". A
// scheduler marks due reminders fired, pushes a web notification, and
// publishes a hub event so an open client resurfaces them live.
package reminders

import (
	"context"
	"net/http"
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
	"github.com/Dvorinka/relay/internal/push"
)

const (
	minDelay = time.Minute
	maxDelay = 90 * 24 * time.Hour
	// dueSweep is how often the scheduler checks for reminders to fire.
	// Thirty seconds keeps "in 1 minute" presets honest without load.
	dueSweep = 30 * time.Second
)

type Service struct {
	q    *db.Queries
	log  *zap.Logger
	Bus  *events.Hub
	Push *push.Service
}

func NewService(log *zap.Logger, pool *pgxpool.Pool) *Service {
	return &Service{q: db.New(pool), log: log}
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.GET("/reminders", s.handleList)
	g.POST("/reminders", s.handleCreate)
	g.DELETE("/reminders/:id", s.handleDelete)
}

// Start runs the due-reminder sweep until ctx ends. Called once from server
// wiring — guarded like the janitor: pgx panics on a closed pool during
// shutdown and test teardown.
func (s *Service) Start(ctx context.Context) {
	t := time.NewTicker(dueSweep)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.fireDue(ctx)
		}
	}
}

func (s *Service) fireDue(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			s.log.Warn("reminder sweep aborted", zap.Any("panic", r))
		}
	}()
	rows, err := s.q.ListDueReminders(ctx)
	if err != nil {
		s.log.Error("reminder sweep failed", zap.Error(err))
		return
	}
	for _, r := range rows {
		if err := s.q.MarkReminderFired(ctx, r.ID); err != nil {
			continue
		}
		if s.Bus != nil {
			pid, _ := uuid.FromBytes(r.ProjectID.Bytes[:])
			s.Bus.Publish(events.Event{Type: "reminder.fired", ProjectID: pid,
				Data: map[string]any{
					"reminder_id": r.ID.String(), "user_id": r.UserID.String(),
					"message_id": r.MessageID.String(), "conversation_id": r.ConversationID.String(),
					"snippet": snippet(r.MessageBody), "author": r.AuthorName,
				}})
		}
		if s.Push != nil {
			s.Push.Notify(ctx, []pgtype.UUID{r.UserID}, push.Payload{
				Title: "Reminder: " + r.AuthorName,
				Body:  snippet(r.MessageBody),
				URL:   "/app/p/" + r.ProjectID.String(),
				Tag:   "rem-" + r.ID.String(),
			})
		}
	}
}

func snippet(body string) string {
	r := []rune(body)
	if len(r) > 140 {
		return string(r[:140]) + "…"
	}
	return body
}

func reminderJSON(r db.ListRemindersRow) gin.H {
	var fired *string
	if r.FiredAt.Valid {
		f := r.FiredAt.Time.Format("2006-01-02T15:04:05Z07:00")
		fired = &f
	}
	return gin.H{
		"id":              r.ID.String(),
		"message_id":      r.MessageID.String(),
		"conversation_id": r.ConversationID.String(),
		"project_id":      r.ProjectID.String(),
		"author_name":     r.AuthorName,
		"snippet":         snippet(r.MessageBody),
		"fire_at":         r.FireAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		"fired_at":        fired,
		"created_at":      r.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
}

func (s *Service) handleList(c *gin.Context) {
	rows, err := s.q.ListReminders(c.Request.Context(), auth.CurrentUser(c).ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, reminderJSON(r))
	}
	c.JSON(http.StatusOK, gin.H{"reminders": out})
}

func (s *Service) handleCreate(c *gin.Context) {
	var req struct {
		MessageID string `json:"message_id" binding:"required"`
		FireAt    string `json:"fire_at" binding:"required"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	var mid pgtype.UUID
	if err := mid.Scan(req.MessageID); err != nil || !mid.Valid {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid message_id")
		return
	}
	fireAt, err := time.Parse(time.RFC3339, req.FireAt)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "fire_at must be RFC3339")
		return
	}
	now := time.Now()
	if fireAt.Before(now.Add(minDelay)) || fireAt.After(now.Add(maxDelay)) {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "fire_at must be 1 minute to 90 days out")
		return
	}
	// membership gate: the message's conversation must be visible to the caller
	convID, err := s.q.GetMessageConversation(c.Request.Context(), mid)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "message not found")
		return
	}
	conv, err := s.q.GetConversationForUser(c.Request.Context(), db.GetConversationForUserParams{
		ID: convID, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	r, err := s.q.CreateReminder(c.Request.Context(), db.CreateReminderParams{
		UserID: auth.CurrentUser(c).ID, MessageID: mid,
		ProjectID: conv.ProjectID, FireAt: pgtype.Timestamptz{Time: fireAt.UTC(), Valid: true},
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": r.ID.String(), "fire_at": r.FireAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	})
}

func (s *Service) handleDelete(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	if err := s.q.DeleteReminder(c.Request.Context(), db.DeleteReminderParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.Status(http.StatusNoContent)
}
