package webhooks

// Inbound hooks — the mirror image of subscriptions: external services
// POST to /api/hooks/<token> and Relay drops the payload into a project's
// conversation as a message. Tokens are random 48-byte secrets; only the
// sha256 is stored.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/Dvorinka/relay/internal/attachments"
	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/conversations"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"go.uber.org/zap"
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
// credential. Beyond {message|text|body}, support-intake fields are
// accepted: "from" attributes an external sender, "subject" heads the
// message, "key" threads follow-ups under the first post with that key,
// and "attachments" (base64) rides the standard storage pipeline. The
// message lands tagged ["webhook", hook-name, "from:…", "key:…"].
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
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, s.bodyCap())
	var req struct {
		Message     string `json:"message"`
		Text        string `json:"text"`
		Body        string `json:"body"`
		From        string `json:"from"`
		Subject     string `json:"subject"`
		Key         string `json:"key"`
		Attachments []struct {
			Name        string `json:"name"`
			ContentType string `json:"content_type"`
			Data        string `json:"data"`
		} `json:"attachments"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid JSON body (64KiB + attachments max)")
		return
	}
	body := req.Message
	if body == "" {
		body = req.Text
	}
	if body == "" {
		body = req.Body
	}
	from := oneLine(req.From, 200)
	subject := oneLine(req.Subject, 200)
	key := oneLine(req.Key, 200)
	body = strings.TrimSpace(body)
	if body == "" {
		body = subject
		subject = ""
	}
	if body == "" || len(body) > conversations.MaxMessageBodyChars {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "message is required and must not be too large")
		return
	}
	if len(req.Attachments) > 5 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "at most 5 attachments per post")
		return
	}
	if len(req.Attachments) > 0 && s.Store == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "storage_disabled", "object storage is not configured")
		return
	}
	// Header line: **Alice <a@b.c>** — *subject* — then the body.
	head := ""
	if from != "" {
		head = "**" + from + "**"
		if subject != "" {
			head += " — *" + subject + "*"
		}
	} else if subject != "" {
		head = "**" + subject + "**"
	}
	if head != "" {
		body = head + "\n\n" + body
	}
	if len(body) > conversations.MaxMessageBodyChars {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "message plus subject must not be too large")
		return
	}
	tags := []string{"webhook", hook.Name}
	if from != "" {
		tags = append(tags, "from:"+from)
	}
	var parentID pgtype.UUID
	if key != "" {
		tags = append(tags, "key:"+key)
		if p, err := s.q.GetInboundThreadParent(c.Request.Context(), db.GetInboundThreadParentParams{
			HookID: hook.ID, Key: key,
		}); err == nil {
			parentID = p
		}
	}
	mid, err := s.q.CreateMessage(c.Request.Context(), db.CreateMessageParams{
		ConversationID: hook.ConversationID,
		AuthorUserID:   hook.CreatedBy,
		ParentID:       parentID,
		Body:           body,
		Tags:           tags,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if key != "" && !parentID.Valid {
		_ = s.q.InsertInboundThread(c.Request.Context(), db.InsertInboundThreadParams{
			HookID: hook.ID, Key: key, ParentMessageID: mid,
		})
	}
	attachN := 0
	for i, a := range req.Attachments {
		data, err := base64.StdEncoding.DecodeString(a.Data)
		if err != nil || int64(len(data)) > s.MaxUpload {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "attachment must be base64 under the upload size cap")
			return
		}
		att, err := s.putInboundFile(c, hook, mid, a.Name, a.ContentType, data, i)
		if err != nil {
			s.log.Warn("inbound attachment store failed", zap.Error(err))
			continue // post the message without it rather than lose the report
		}
		if att {
			attachN++
		}
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
	out := gin.H{
		"posted":      true,
		"message_id":  mid.String(),
		"threaded":    parentID.Valid,
		"attachments": attachN,
	}
	if parentID.Valid {
		out["parent_id"] = parentID.String()
	}
	c.JSON(http.StatusAccepted, out)
}

// oneLine squashes metadata fields (from/subject/key) to a single trimmed
// line — they land in tags and the rendered header, so newlines are out.
func oneLine(v string, max int) string {
	v = strings.Join(strings.Fields(v), " ")
	if len(v) > max {
		v = v[:max]
	}
	return v
}

// bodyCap is the request ceiling: 64KiB for text, plus headroom for
// base64 attachments (~1.34× decoded) when storage allows them.
func (s *Service) bodyCap() int64 {
	cap := int64(inboundBodyLimit)
	if s.MaxUpload > 0 {
		cap += s.MaxUpload * 2
	}
	return cap
}

// putInboundFile runs one hook attachment through the same path as a UI
// upload: sniffed type, project-scoped key, attachment row, link.
func (s *Service) putInboundFile(c *gin.Context, hook db.InboundHook, mid pgtype.UUID,
	name, declared string, data []byte, pos int) (bool, error) {
	contentType := attachments.SniffType(data, declared)
	filename := path.Base(strings.TrimSpace(name))
	if filename == "." || filename == "/" || filename == "" {
		filename = "file"
	}
	id := uuid.New()
	key := hook.ProjectID.String() + "/" + id.String()
	if err := s.Store.Put(c.Request.Context(), key, bytes.NewReader(data), int64(len(data)), contentType); err != nil {
		return false, err
	}
	row, err := s.q.CreateAttachment(c.Request.Context(), db.CreateAttachmentParams{
		ID: pgtype.UUID{Bytes: id, Valid: true}, ProjectID: hook.ProjectID,
		UploaderID: hook.CreatedBy, StorageKey: key, Filename: filename,
		ContentType: contentType, SizeBytes: int64(len(data)),
	})
	if err != nil {
		_ = s.Store.Remove(c.Request.Context(), key)
		return false, err
	}
	if _, err = s.q.MarkAttachmentReady(c.Request.Context(), row.ID); err != nil {
		return false, err
	}
	if err = s.q.LinkMessageAttachment(c.Request.Context(), db.LinkMessageAttachmentParams{
		MessageID: mid, AttachmentID: row.ID, Position: int32(pos),
	}); err != nil {
		return false, err
	}
	return true, nil
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
