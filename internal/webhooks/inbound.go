package webhooks

// Inbound hooks — the mirror image of subscriptions: external services
// POST to /api/hooks/<token> and Relay drops the payload into a project's
// conversation as a message. Tokens are random 48-byte secrets; only the
// sha256 is stored.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/conversations"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	inboundBodyLimit = 64 << 10 // 64KiB — alerts and diffs fit easily
	inboundRate      = 30       // posts per minute per token
)

// inLimiter is a dead-simple per-token sliding window — hooks see spiky CI
// traffic, not sustained load; no library needed.
type inLimiter struct {
	mu    sync.Mutex
	epoch map[string]int64
	count map[string]int
}

func newInLimiter() *inLimiter {
	return &inLimiter{epoch: map[string]int64{}, count: map[string]int{}}
}

func (l *inLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	win := time.Now().Unix() / 60
	if l.epoch[key] != win {
		l.epoch[key] = win
		l.count[key] = 0
	}
	l.count[key]++
	return l.count[key] <= inboundRate
}

var inboundLimiter = newInLimiter()

func newHookToken() (string, string, error) {
	raw := make([]byte, 48)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token := "rlh_" + hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(sum[:]), nil
}

func hookHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// handleHookList returns a project's inbound hooks — token hash never
// leaves the server; only a prefix hint.
func (s *Service) handleHookList(c *gin.Context) {
	pid := c.MustGet("relay.project_id").(pgtype.UUID)
	rows, err := s.q.ListInboundHooks(c.Request.Context(), pid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, h := range rows {
		out = append(out, hookJSON(h, ""))
	}
	c.JSON(http.StatusOK, gin.H{"hooks": out})
}

// handleHookCreate makes a token and returns the full webhook URL once.
// Targets a channel (or the main project conversation).
func (s *Service) handleHookCreate(c *gin.Context) {
	pid := c.MustGet("relay.project_id").(pgtype.UUID)
	var req struct {
		Name           string `json:"name"`
		ConversationID string `json:"conversation_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "name is required")
		return
	}
	convID, err := uuid.Parse(req.ConversationID)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "conversation_id is required")
		return
	}
	conv, err := s.q.GetConversationByID(c.Request.Context(),
		pgtype.UUID{Bytes: convID, Valid: true})
	if err != nil || conv.ProjectID != pid ||
		(conv.Kind != "channel" && conv.Kind != "project") {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "conversation must be a channel in this project")
		return
	}
	token, hash, err := newHookToken()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	hook, err := s.q.CreateInboundHook(c.Request.Context(), db.CreateInboundHookParams{
		ProjectID: pid, ConversationID: conv.ID,
		Name: strings.TrimSpace(req.Name), TokenHash: hash,
		CreatedBy: auth.CurrentUser(c).ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"hook":  hookJSON(hook, token),
		"url":   s.publicURL + "/api/hooks/" + token,
		"token": token,
	})
}

// hookGate resolves :id -> inbound hook; membership required. Mirrors
// webhookGate.
func (s *Service) hookGate(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		c.Abort()
		return
	}
	row, err := s.q.GetInboundHookForUser(c.Request.Context(), db.GetInboundHookForUserParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "hook not found")
		c.Abort()
		return
	}
	c.Set("relay.hook", row)
	c.Next()
}

func (s *Service) hookAdmin(c *gin.Context) {
	s.hookGate(c)
	if c.IsAborted() {
		return
	}
	row := c.MustGet("relay.hook").(db.GetInboundHookForUserRow)
	role, _ := s.userRole(c, row.WorkspaceID)
	if role != "owner" && role != "admin" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "workspace admin required")
		c.Abort()
		return
	}
	c.Next()
}

func (s *Service) handleHookUpdate(c *gin.Context) {
	row := c.MustGet("relay.hook").(db.GetInboundHookForUserRow)
	var req struct {
		Name    *string `json:"name"`
		Enabled *bool   `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	var name pgtype.Text
	if req.Name != nil && strings.TrimSpace(*req.Name) != "" {
		name = pgtype.Text{String: strings.TrimSpace(*req.Name), Valid: true}
	}
	var enabled pgtype.Bool
	if req.Enabled != nil {
		enabled = pgtype.Bool{Bool: *req.Enabled, Valid: true}
	}
	hook, err := s.q.UpdateInboundHook(c.Request.Context(), db.UpdateInboundHookParams{
		ID: row.ID, Name: name, Enabled: enabled,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"hook": hookJSON(hook, "")})
}

func (s *Service) handleHookRotate(c *gin.Context) {
	row := c.MustGet("relay.hook").(db.GetInboundHookForUserRow)
	token, hash, err := newHookToken()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	hook, err := s.q.RotateInboundHook(c.Request.Context(), db.RotateInboundHookParams{
		ID: row.ID, TokenHash: hash,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"hook":  hookJSON(hook, token),
		"url":   s.publicURL + "/api/hooks/" + token,
		"token": token,
	})
}

func (s *Service) handleHookDelete(c *gin.Context) {
	row := c.MustGet("relay.hook").(db.GetInboundHookForUserRow)
	if err := s.q.DeleteInboundHook(c.Request.Context(), row.ID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.Status(http.StatusNoContent)
}

// handleInbound is the public delivery endpoint. Token in the path is the
// credential; payload {message|text|body} becomes a channel message from
// the hook's creator, tagged ["webhook", name] so the UI can badge it.
func (s *Service) handleInbound(c *gin.Context) {
	token := c.Param("token")
	if !strings.HasPrefix(token, "rlh_") || len(token) > 128 {
		httpx.Error(c, http.StatusNotFound, "not_found", "hook not found")
		return
	}
	if !inboundLimiter.allow(hookHash(token)) {
		httpx.Error(c, http.StatusTooManyRequests, "rate_limited", "too many posts — try again in a minute")
		return
	}
	hook, err := s.q.GetInboundHookByTokenHash(c.Request.Context(), hookHash(token))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "hook not found")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, inboundBodyLimit)
	var req struct {
		Message string `json:"message"`
		Text    string `json:"text"`
		Body    string `json:"body"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid JSON body (64KiB max)")
		return
	}
	body := req.Message
	if body == "" {
		body = req.Text
	}
	if body == "" {
		body = req.Body
	}
	body = strings.TrimSpace(body)
	if body == "" || len(body) > conversations.MaxMessageBodyChars {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "message is required and must not be too large")
		return
	}
	mid, err := s.q.CreateMessage(c.Request.Context(), db.CreateMessageParams{
		ConversationID: hook.ConversationID,
		AuthorUserID:   hook.CreatedBy,
		Body:           body,
		Tags:           []string{"webhook", hook.Name},
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	_ = s.q.TouchInboundHook(c.Request.Context(), hook.ID)
	if s.Bus != nil {
		if m, err := s.q.GetMessageByID(c.Request.Context(), mid); err == nil {
			out := conversations.MessageJSON(conversations.MessageView{
				ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
				Body: m.Body, Mentions: m.Mentions, Tags: m.Tags, Silent: m.Silent,
				CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
				AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
				AuthorKindSnapshot: m.AuthorKindSnapshot,
				AuthorName:         m.AuthorName, AuthorAvatar: m.AuthorAvatar,
			})
			pid, _ := uuid.FromBytes(hook.ProjectID.Bytes[:])
			s.Bus.Publish(events.Event{Type: "message.created", ProjectID: pid,
				Data: map[string]any{"conversation_id": m.ConversationID.String(), "message": out}})
		}
	}
	c.JSON(http.StatusAccepted, gin.H{"posted": true, "message_id": mid.String()})
}

func hookJSON(h db.InboundHook, token string) gin.H {
	out := gin.H{
		"id":              h.ID.String(),
		"name":            h.Name,
		"project_id":      h.ProjectID.String(),
		"conversation_id": h.ConversationID.String(),
		"enabled":         h.Enabled,
		"token_hint":      h.TokenHash[:8],
		"created_at":      h.CreatedAt,
	}
	if h.LastUsedAt.Valid {
		out["last_used_at"] = h.LastUsedAt.Time
	}
	if token != "" {
		out["token"] = token
	}
	return out
}
