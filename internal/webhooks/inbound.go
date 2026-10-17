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
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"strconv"
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
	inboundReadRate  = 120      // message pulls per minute — chat widgets poll
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

func (l *inLimiter) allow(key string, max int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	win := time.Now().Unix() / 60
	if l.epoch[key] != win {
		l.epoch[key] = win
		l.count[key] = 0
	}
	l.count[key]++
	return l.count[key] <= max
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
		Kind           string `json:"kind"`
		HeaderTemplate string `json:"header_template"`
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
		CreatedBy:      auth.CurrentUser(c).ID,
		Kind:           oneLine(req.Kind, 40),
		HeaderTemplate: strings.TrimSpace(req.HeaderTemplate),
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
		Name           *string `json:"name"`
		Enabled        *bool   `json:"enabled"`
		Kind           *string `json:"kind"`
		HeaderTemplate *string `json:"header_template"`
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
	var kind pgtype.Text
	if req.Kind != nil {
		kind = pgtype.Text{String: oneLine(*req.Kind, 40), Valid: true}
	}
	var tpl pgtype.Text
	if req.HeaderTemplate != nil {
		tpl = pgtype.Text{String: strings.TrimSpace(*req.HeaderTemplate), Valid: true}
	}
	hook, err := s.q.UpdateInboundHook(c.Request.Context(), db.UpdateInboundHookParams{
		ID: row.ID, Name: name, Enabled: enabled,
		Kind: kind, HeaderTemplate: tpl,
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
	if !inboundLimiter.allow("w:"+hookHash(token), inboundRate) {
		httpx.Error(c, http.StatusTooManyRequests, "rate_limited", "too many posts — try again in a minute")
		return
	}
	hook, err := s.q.GetInboundHookByTokenHash(c.Request.Context(), hookHash(token))
	if err != nil || !hook.Enabled {
		httpx.Error(c, http.StatusNotFound, "not_found", "hook not found")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, s.bodyCap())
	var req struct {
		Message     string         `json:"message"`
		Text        string         `json:"text"`
		Body        string         `json:"body"`
		From        string         `json:"from"`
		Subject     string         `json:"subject"`
		Key         string         `json:"key"`
		Kind        string         `json:"kind"`
		Service     string         `json:"service"`
		State       string         `json:"state"`
		LatencyMs   *int64         `json:"latency_ms"`
		Level       string         `json:"level"`
		Env         string         `json:"env"`
		Release     string         `json:"release"`
		URL         string         `json:"url"`
		Fields      map[string]any `json:"fields"`
		At          string         `json:"at"`
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
	// kind = the platform's own report type (bug, feature, status, error, …)
	// — free-form. Payload wins over the hook's default.
	kind := oneLine(req.Kind, 40)
	if kind == "" {
		kind = hook.Kind
	}
	// Structured ops payload — monitoring state, error level, arbitrary
	// labelled fields. Lands on messages.meta; ops channels aggregate it.
	meta := buildOpsMeta(kind, opsFields{
		Service:   oneLine(req.Service, 120),
		State:     strings.ToLower(oneLine(req.State, 24)),
		LatencyMs: req.LatencyMs,
		Level:     strings.ToLower(oneLine(req.Level, 16)),
		Env:       oneLine(req.Env, 60),
		Release:   oneLine(req.Release, 120),
		URL:       oneLine(req.URL, 500),
		Fields:    req.Fields,
		At:        oneLine(req.At, 60),
	})
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
	if len(req.Attachments) > 0 && s.Store == nil && !s.Limited {
		httpx.Error(c, http.StatusServiceUnavailable, "storage_disabled", "object storage is not configured")
		return
	}
	// Header: a per-hook header_template wins ({from}/{subject}/{kind}/
	// {key} placeholders); otherwise `kind` **from** — *subject*.
	var head string
	if hook.HeaderTemplate != "" {
		head = renderHookHead(hook.HeaderTemplate, from, subject, kind, key)
	} else {
		if kind != "" {
			head = "`" + kind + "`"
		}
		if from != "" {
			if head != "" {
				head += " "
			}
			head += "**" + from + "**"
			if subject != "" {
				head += " — *" + subject + "*"
			}
		} else if subject != "" {
			if head != "" {
				head += " "
			}
			head += "**" + subject + "**"
		}
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
	if kind != "" {
		tags = append(tags, "kind:"+kind)
	}
	var parentID, threadID pgtype.UUID
	if key != "" {
		tags = append(tags, "key:"+key)
		if p, err := s.q.GetInboundThreadParent(c.Request.Context(), db.GetInboundThreadParentParams{
			HookID: hook.ID, Key: key,
		}); err == nil {
			parentID = p
			// A ticket is a dedicated sub-chat: a thread conversation
			// rooted at the first post. Follow-ups land inside it.
			if t, err := s.q.GetThreadByParentMessage(c.Request.Context(), p); err == nil {
				threadID = t.ID
			}
		}
	}
	convID := hook.ConversationID
	msgParent := parentID
	if threadID.Valid {
		convID = threadID
		msgParent = pgtype.UUID{} // flat inside the ticket's sub-chat
	}
	mid, err := s.q.CreateMessage(c.Request.Context(), db.CreateMessageParams{
		ConversationID: convID,
		AuthorUserID:   hook.CreatedBy,
		ParentID:       msgParent,
		Body:           body,
		Tags:           tags,
		Meta:           meta,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if key != "" && !parentID.Valid {
		_ = s.q.InsertInboundThread(c.Request.Context(), db.InsertInboundThreadParams{
			HookID: hook.ID, Key: key, ParentMessageID: mid,
		})
		// First post under this key opens the ticket's sub-chat —
		// expires_at NULL so support tickets outlive the 5-day default.
		title := subject
		if title == "" {
			title = from
		}
		if title == "" {
			title = key
		}
		if t, err := s.q.CreateThread(c.Request.Context(), db.CreateThreadParams{
			ProjectID:       hook.ProjectID,
			ParentMessageID: mid,
			Title:           pgtype.Text{String: oneLine(title, 80), Valid: title != ""},
			CreatedByUser:   hook.CreatedBy,
		}); err == nil {
			threadID = t.ID
			if s.Bus != nil {
				pid, _ := uuid.FromBytes(hook.ProjectID.Bytes[:])
				s.Bus.Publish(events.Event{Type: "thread.created", ProjectID: pid,
					Data: map[string]any{
						"conversation_id":   hook.ConversationID.String(),
						"parent_message_id": mid.String(),
						"thread":            map[string]any{"id": t.ID.String(), "title": title},
					}})
			}
		}
	}
	attachN, droppedN := 0, 0
	for i, a := range req.Attachments {
		data, err := base64.StdEncoding.DecodeString(a.Data)
		if err != nil || int64(len(data)) > s.MaxUpload {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "attachment must be base64 under the upload size cap")
			return
		}
		att, err := s.putInboundFile(c, hook, mid, a.Name, a.ContentType, data, i)
		if err != nil {
			s.log.Warn("inbound attachment store failed", zap.Error(err))
			droppedN++
			continue // post the message without it rather than lose the report
		}
		if att {
			attachN++
		} else {
			droppedN++
		}
	}
	_ = s.q.TouchInboundHook(c.Request.Context(), hook.ID)
	if s.Bus != nil {
		if m, err := s.q.GetMessageByID(c.Request.Context(), mid); err == nil {
			out := conversations.MessageJSON(conversations.MessageView{
				ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
				Body: m.Body, Mentions: m.Mentions, Tags: m.Tags, Meta: m.Meta, Silent: m.Silent,
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
		"posted":          true,
		"message_id":      mid.String(),
		"conversation_id": convID.String(),
		"threaded":        parentID.Valid,
		"attachments":     attachN,
	}
	if droppedN > 0 {
		out["attachments_dropped"] = droppedN
	}
	if parentID.Valid {
		out["parent_id"] = parentID.String()
	}
	if threadID.Valid {
		out["thread_id"] = threadID.String()
	}
	c.JSON(http.StatusAccepted, out)
}

// handleInboundMessages is the read half of a "chat"-mode intake channel:
// the platform polls it to pull Relay-side replies back to the customer.
// Same path token as POST. Gated to intake_mode='chat' — receive-only
// channels return 403 intake_read_disabled. ?key scopes to one ticket
// thread (root + inline replies); ?after is the polling cursor.
func (s *Service) handleInboundMessages(c *gin.Context) {
	token := c.Param("token")
	if !strings.HasPrefix(token, "rlh_") || len(token) > 128 {
		httpx.Error(c, http.StatusNotFound, "not_found", "hook not found")
		return
	}
	if !inboundLimiter.allow("r:"+hookHash(token), inboundReadRate) {
		httpx.Error(c, http.StatusTooManyRequests, "rate_limited", "too many reads — try again in a minute")
		return
	}
	hook, err := s.q.GetInboundHookByTokenHash(c.Request.Context(), hookHash(token))
	if err != nil || !hook.Enabled {
		httpx.Error(c, http.StatusNotFound, "not_found", "hook not found")
		return
	}
	conv, err := s.q.GetConversationByID(c.Request.Context(), hook.ConversationID)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "channel not found")
		return
	}
	if conv.IntakeMode != "chat" {
		httpx.Error(c, http.StatusForbidden, "intake_read_disabled",
			"this channel is receive-only — switch it to live chat to pull replies")
		return
	}
	var after pgtype.UUID
	if a := c.Query("after"); a != "" {
		id, err := uuid.Parse(a)
		if err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "after must be a message id")
			return
		}
		after = pgtype.UUID{Bytes: id, Valid: true}
	}
	// ?key scopes to one ticket sub-chat: the root post in the channel
	// plus the thread conversation it opened. Legacy tickets whose
	// replies predate sub-chats fall back to inline replies.
	listConv := hook.ConversationID
	var root, rootFilter pgtype.UUID
	if key := oneLine(c.Query("key"), 200); key != "" {
		p, err := s.q.GetInboundThreadParent(c.Request.Context(), db.GetInboundThreadParentParams{
			HookID: hook.ID, Key: key,
		})
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"messages": []any{}})
			return
		}
		root = p
		if t, err := s.q.GetThreadByParentMessage(c.Request.Context(), p); err == nil {
			listConv = t.ID
		} else {
			rootFilter = p
		}
	}
	lim := int32(50)
	if l, err := strconv.Atoi(c.Query("limit")); err == nil && l > 0 && l <= 200 {
		lim = int32(l)
	}
	var rows []db.ListHookChannelMessagesRow
	if root.Valid && !after.Valid {
		head, _ := s.q.ListHookChannelMessages(c.Request.Context(), db.ListHookChannelMessagesParams{
			ConversationID: hook.ConversationID, Root: root, Lim: 1,
		})
		rows = head
	}
	rest, err := s.q.ListHookChannelMessages(c.Request.Context(), db.ListHookChannelMessagesParams{
		ConversationID: listConv,
		After:          after,
		Root:           rootFilter,
		Lim:            lim,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	rows = append(rows, rest...)
	// Attachments ride presigned GET URLs when storage is configured —
	// the token holder can fetch the bytes without a Relay session.
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, m := range rows {
		ids = append(ids, m.ID)
	}
	attByMsg := map[pgtype.UUID][]db.ListAttachmentsForMessagesRow{}
	if len(ids) > 0 {
		if atts, err := s.q.ListAttachmentsForMessages(c.Request.Context(), ids); err == nil {
			for _, a := range atts {
				attByMsg[a.MessageID] = append(attByMsg[a.MessageID], a)
			}
		}
	}
	out := make([]gin.H, 0, len(rows))
	for _, m := range rows {
		viaHook := false
		for _, t := range m.Tags {
			if t == "webhook" {
				viaHook = true
				break
			}
		}
		msg := gin.H{
			"id":          m.ID.String(),
			"body":        m.Body,
			"author_name": m.AuthorName,
			"author_kind": m.AuthorKindSnapshot,
			"tags":        m.Tags,
			"via_hook":    viaHook,
			"created_at":  m.CreatedAt,
		}
		if len(m.Meta) > 0 {
			var meta any
			if json.Unmarshal(m.Meta, &meta) == nil {
				msg["meta"] = meta
			}
		}
		// Lift intake metadata out of the tag list for convenience.
		for _, t := range m.Tags {
			switch {
			case strings.HasPrefix(t, "from:"):
				msg["from"] = t[len("from:"):]
			case strings.HasPrefix(t, "key:"):
				msg["key"] = t[len("key:"):]
			case strings.HasPrefix(t, "kind:"):
				msg["kind"] = t[len("kind:"):]
			}
		}
		if m.ParentID.Valid {
			msg["parent_id"] = m.ParentID.String()
		}
		var atts []gin.H
		for _, a := range attByMsg[m.ID] {
			att := gin.H{
				"id":           a.ID.String(),
				"name":         a.Filename,
				"content_type": a.ContentType,
				"size_bytes":   a.SizeBytes,
			}
			if s.Store != nil {
				if u, err := s.Store.PresignGet(c.Request.Context(), a.StorageKey, a.Filename, a.ContentType); err == nil {
					att["url"] = u
				}
			}
			atts = append(atts, att)
		}
		if len(atts) > 0 {
			msg["attachments"] = atts
		}
		out = append(out, msg)
	}
	c.JSON(http.StatusOK, gin.H{"messages": out})
}

// renderHookHead expands a hook's header template. Empty result is fine —
// the body then stands alone.
func renderHookHead(tpl, from, subject, kind, key string) string {
	r := strings.NewReplacer(
		"{from}", from, "{subject}", subject, "{kind}", kind, "{key}", key,
	)
	return strings.TrimSpace(r.Replace(tpl))
}

// opsFields is the structured part of an inbound payload. Any monitoring,
// CI, error-tracking or homegrown tool can POST these; Relay stores them
// verbatim (validated + size-capped) so ops channels and cards can render
// them without Relay knowing the sender's schema.
type opsFields struct {
	Service   string
	State     string
	LatencyMs *int64
	Level     string
	Env       string
	Release   string
	URL       string
	Fields    map[string]any
	At        string
}

const opsMetaCap = 8 << 10 // 8KiB — stacks belong in body, meta stays lean

// buildOpsMeta assembles the jsonb meta blob. Nil when the post carries no
// structured data at all (kind alone doesn't make a message "ops").
func buildOpsMeta(kind string, f opsFields) []byte {
	m := map[string]any{}
	if kind != "" {
		m["kind"] = kind
	}
	if f.Service != "" {
		m["service"] = f.Service
	}
	if f.State != "" {
		m["state"] = f.State
	}
	if f.LatencyMs != nil {
		v := *f.LatencyMs
		if v < 0 {
			v = 0
		}
		if v > 86400000 { // a day in ms — beyond that it's a bug upstream
			v = 86400000
		}
		m["latency_ms"] = v
	}
	if f.Level != "" {
		m["level"] = f.Level
	}
	if f.Env != "" {
		m["env"] = f.Env
	}
	if f.Release != "" {
		m["release"] = f.Release
	}
	if f.URL != "" {
		m["url"] = f.URL
	}
	if f.At != "" {
		if ts, err := time.Parse(time.RFC3339, f.At); err == nil {
			m["at"] = ts.UTC().Format(time.RFC3339)
		}
	}
	if len(f.Fields) > 0 {
		fl := map[string]string{}
		for k, v := range f.Fields {
			if len(fl) >= 24 {
				break
			}
			k = oneLine(k, 40)
			if k == "" {
				continue
			}
			fl[k] = oneLine(fmt.Sprintf("%v", v), 200)
		}
		if len(fl) > 0 {
			m["fields"] = fl
		}
	}
	if len(m) == 0 || (len(m) == 1 && kind != "") {
		return nil
	}
	b, err := json.Marshal(m)
	if err != nil || len(b) > opsMetaCap {
		return nil
	}
	return b
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
	if s.Limited {
		// Hosted tier stores no files — drop the payload but keep the report.
		return false, nil
	}
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
		"kind":            h.Kind,
		"header_template": h.HeaderTemplate,
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
