package conversations

// Scheduled sends: a draft parked server-side until send_at, then the sweep
// posts it through the same createMessage path the composer uses — mentions,
// events and push included. Rows live in scheduled_messages; sent_at marks
// consumption.

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"go.uber.org/zap"
)

const (
	minScheduleDelay = time.Minute
	maxScheduleDelay = 90 * 24 * time.Hour
	// scheduledSweep mirrors the reminder janitor — 30s keeps presets honest.
	scheduledSweep = 30 * time.Second
)

func (s *Service) registerScheduledRoutes(g *gin.RouterGroup) {
	g.GET("/conversations/:id/messages/scheduled", s.memberOnly, s.handleListScheduled)
	g.POST("/conversations/:id/messages/scheduled", s.memberOnly, s.handleCreateScheduled)
	g.DELETE("/scheduled/:id", s.handleDeleteScheduled)
}

// StartScheduledSweep posts due scheduled messages until ctx ends. Guarded
// like the reminder janitor — pgx panics on a closed pool during teardown.
func (s *Service) StartScheduledSweep(ctx context.Context) {
	t := time.NewTicker(scheduledSweep)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.postDue(ctx)
		}
	}
}

func (s *Service) postDue(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			s.log.Warn("scheduled sweep aborted", zap.Any("panic", r))
		}
	}()
	rows, err := s.q.ListDueScheduledMessages(ctx)
	if err != nil {
		s.log.Error("scheduled sweep failed", zap.Error(err))
		return
	}
	for _, r := range rows {
		conv, err := s.q.GetConversationByID(ctx, r.ConversationID)
		if err != nil {
			s.log.Warn("scheduled message conversation gone", zap.String("id", r.ID.String()))
			_ = s.q.MarkScheduledMessageSent(ctx, r.ID)
			continue
		}
		var tags []string
		_ = json.Unmarshal(r.Tags, &tags)
		_, _, err = s.createMessage(ctx, conv, r.UserID, r.Body,
			r.ParentID, nil, tags, false, pgtype.Text{})
		if err != nil {
			// Body was validated at schedule time; a failure here means the
			// message can't post (e.g. conversation state changed) — consume
			// it rather than retry forever.
			s.log.Error("scheduled message failed to post",
				zap.String("id", r.ID.String()), zap.Error(err))
		}
		_ = s.q.MarkScheduledMessageSent(ctx, r.ID)
	}
}

func scheduledJSON(r db.ScheduledMessage) gin.H {
	var parent any
	if r.ParentID.Valid {
		parent = r.ParentID.String()
	}
	return gin.H{
		"id":              r.ID.String(),
		"conversation_id": r.ConversationID.String(),
		"project_id":      r.ProjectID.String(),
		"body":            r.Body,
		"parent_id":       parent,
		"send_at":         r.SendAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		"created_at":      r.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
}

func (s *Service) handleListScheduled(c *gin.Context) {
	conv := c.MustGet(ctxConversation).(db.Conversation)
	rows, err := s.q.ListScheduledMessages(c.Request.Context(), auth.CurrentUser(c).ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		if r.ConversationID == conv.ID {
			out = append(out, scheduledJSON(r))
		}
	}
	c.JSON(http.StatusOK, gin.H{"scheduled": out})
}

func (s *Service) handleCreateScheduled(c *gin.Context) {
	conv := c.MustGet(ctxConversation).(db.Conversation)
	var req struct {
		Body     string `json:"body" binding:"required"`
		ParentID string `json:"parent_id"`
		SendAt   string `json:"send_at" binding:"required"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if n := len(req.Body); n == 0 || n > MaxMessageBodyChars {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "body is empty or too large")
		return
	}
	sendAt, err := time.Parse(time.RFC3339, req.SendAt)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "send_at must be RFC3339")
		return
	}
	now := time.Now()
	if sendAt.Before(now.Add(minScheduleDelay)) || sendAt.After(now.Add(maxScheduleDelay)) {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "send_at must be 1 minute to 90 days out")
		return
	}
	var parent pgtype.UUID
	if req.ParentID != "" {
		if err := parent.Scan(req.ParentID); err != nil || !parent.Valid {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid parent_id")
			return
		}
		if _, err := s.q.MessageParentInConversation(c.Request.Context(),
			db.MessageParentInConversationParams{ID: parent, ConversationID: conv.ID}); err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "parent_id is not a message in this conversation")
			return
		}
	}
	r, err := s.q.CreateScheduledMessage(c.Request.Context(), db.CreateScheduledMessageParams{
		UserID: auth.CurrentUser(c).ID, ConversationID: conv.ID,
		ProjectID: conv.ProjectID, Body: req.Body, ParentID: parent,
		SendAt: pgtype.Timestamptz{Time: sendAt.UTC(), Valid: true},
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusCreated, scheduledJSON(r))
}

func (s *Service) handleDeleteScheduled(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	if err := s.q.DeleteScheduledMessage(c.Request.Context(), db.DeleteScheduledMessageParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.Status(http.StatusNoContent)
}
