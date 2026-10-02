// Package conversations: project channels and messages. Access rule per
// spec: any member of the containing workspace. MessageJSON is the shared
// wire shape (also used by the projects overview feed).
package conversations

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/Dvorinka/relay/internal/attachments"
	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/Dvorinka/relay/internal/push"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

type Service struct {
	q   *db.Queries
	log *zap.Logger
	// Bus publishes domain events for SSE subscribers. Optional.
	Bus *events.Hub
	// Push fans out web-push notifications on mentions/replies. Optional.
	Push *push.Service
}

func NewService(log *zap.Logger, pool *pgxpool.Pool) *Service {
	return &Service{q: db.New(pool), log: log}
}

// RegisterRoutes wires /conversations/:id/messages, /messages/:id/read and
// /projects/:id/conversation. All are session-authed upstream; membership
// in the containing workspace is enforced per route here.
func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.GET("/projects/:id/conversation", s.projectMemberOnly, s.handleProjectConversation)
	g.GET("/conversations/:id/messages", s.memberOnly, s.handleListMessages)
	g.POST("/conversations/:id/messages", s.memberOnly, s.handlePostMessage)
	g.PATCH("/messages/:id", s.handleEditMessage)
	g.PUT("/messages/:id/reactions", s.handleToggleReaction)
	g.POST("/messages/:id/read", s.handleMarkRead)
}

// --- access gate ---

const ctxConversation = "relay.conversation"

// memberOnly resolves :id -> conversation and confirms the caller belongs
// to its workspace. Unknown id -> 404; wrong workspace -> 403.
func (s *Service) memberOnly(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	conv, err := s.q.GetConversationForUser(c.Request.Context(), db.GetConversationForUserParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil {
		// join miss is ambiguous: distinguish existence for a truthful status
		var exists bool
		if _, err2 := s.q.GetConversationByID(c.Request.Context(), id); err2 == nil {
			exists = true
		}
		if exists {
			httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		} else {
			httpx.Error(c, http.StatusNotFound, "not_found", "conversation not found")
		}
		return
	}
	c.Set(ctxConversation, conv)
	c.Next()
}

// projectMemberOnly gates /projects/:id/* routes in this package:
// the caller must be a member of the project's workspace.
func (s *Service) projectMemberOnly(c *gin.Context) {
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
	c.Set(ctxProjectRow, p)
	c.Next()
}

const ctxProjectRow = "relay.project_row"

// --- handlers ---

func (s *Service) handleProjectConversation(c *gin.Context) {
	p := c.MustGet(ctxProjectRow).(db.GetProjectForUserRow)
	conv, err := s.q.GetProjectConversation(c.Request.Context(), p.ID)
	if err != nil {
		// first access creates the channel
		conv, err = s.q.CreateProjectConversation(c.Request.Context(), p.ID)
		if err != nil {
			// lost the create race - read again
			conv, err = s.q.GetProjectConversation(c.Request.Context(), p.ID)
		}
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, conversationJSON(conv))
}

func (s *Service) handleListMessages(c *gin.Context) {
	conv := c.MustGet(ctxConversation).(db.Conversation)
	limit := 50
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}
	var before pgtype.UUID
	if v := c.Query("before"); v != "" {
		if err := before.Scan(v); err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid before cursor")
			return
		}
	}
	// one extra row decides has_more
	rows, err := s.q.ListMessages(c.Request.Context(), db.ListMessagesParams{
		ConversationID: conv.ID, Before: before, Lim: int32(limit + 1),
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	hasMore := len(rows) > limit
	rows = rows[:min(len(rows), limit)]
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, m := range rows {
		ids = append(ids, m.ID)
	}
	atts := s.attachmentsFor(c, ids)
	rxns := s.reactionsFor(c, ids)
	read := s.agentReadSet(c, ids)
	msgs := make([]gin.H, 0, len(rows))
	// newest-first page -> reverse for chronological order
	for i := len(rows) - 1; i >= 0; i-- {
		m := rows[i]
		msgs = append(msgs, MessageJSON(MessageView{
			ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
			Body: m.Body, CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
			AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
			AuthorName: m.AuthorName, AuthorAvatar: m.AuthorAvatar,
			ParentAuthorName: m.ParentAuthorName, ParentBody: m.ParentBody,
			ParentDeleted: m.ParentDeleted,
			Attachments:   atts[m.ID.String()],
			Reactions:     rxns[m.ID.String()],
			AgentRead:     read[m.ID.String()],
		}))
	}
	c.JSON(http.StatusOK, gin.H{"messages": msgs, "has_more": hasMore})
}

func (s *Service) handlePostMessage(c *gin.Context) {
	conv := c.MustGet(ctxConversation).(db.Conversation)
	var req struct {
		Body          string   `json:"body"`
		AttachmentIDs []string `json:"attachment_ids"`
		ParentID      string   `json:"parent_id"`
	}
	if !httpx.BindJSON(c, &req) {
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
	if len(req.Body) > 20000 || (len(req.Body) == 0 && len(req.AttachmentIDs) == 0) {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "body must be <= 20000 characters; an empty body needs at least one attachment")
		return
	}
	if len(req.AttachmentIDs) > 20 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "at most 20 attachments per message")
		return
	}
	ids, bad := parseUUIDs(req.AttachmentIDs)
	if bad {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid attachment id")
		return
	}
	if len(ids) > 0 {
		n, err := s.q.CountUsableAttachmentsInProject(c.Request.Context(),
			db.CountUsableAttachmentsInProjectParams{ProjectID: conv.ProjectID, Ids: ids})
		if err != nil || int(n) != len(ids) {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown or pending attachment id")
			return
		}
	}
	user := auth.CurrentUser(c)
	id, err := s.q.CreateMessage(c.Request.Context(), db.CreateMessageParams{
		ConversationID: conv.ID, AuthorUserID: user.ID, Body: req.Body,
		ParentID: parent,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	for i, aid := range ids {
		if err := s.q.LinkMessageAttachment(c.Request.Context(), db.LinkMessageAttachmentParams{
			MessageID: id, AttachmentID: aid, Position: int32(i),
		}); err != nil {
			s.log.Error("link attachment failed", zap.Error(err))
		}
	}
	m, err := s.q.GetMessageByID(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	// send == read
	_ = s.q.MarkMessageRead(c.Request.Context(), db.MarkMessageReadParams{MessageID: m.ID, UserID: user.ID})
	atts := s.attachmentsFor(c, []pgtype.UUID{m.ID})
	out := MessageJSON(MessageView{
		ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
		Body: m.Body, CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
		AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
		AuthorName: m.AuthorName, AuthorAvatar: m.AuthorAvatar,
		ParentAuthorName: m.ParentAuthorName, ParentBody: m.ParentBody,
		ParentDeleted: m.ParentDeleted,
		Attachments:   atts[m.ID.String()],
	})
	if s.Bus != nil {
		pid, _ := uuid.FromBytes(conv.ProjectID.Bytes[:])
		s.Bus.Publish(events.Event{Type: "message.created", ProjectID: pid,
			Data: map[string]any{"conversation_id": m.ConversationID.String(), "message": out}})
	}
	if s.Push != nil {
		s.Push.NotifyMessage(conv.ProjectID, user.ID, req.Body, m.ID,
			"/app/p/"+conv.ProjectID.String(), m.AuthorName)
	}
	c.JSON(http.StatusCreated, out)
}

// handleEditMessage lets the author rewrite a message's body - but only
// while no agent has read it. Once any agent's read receipt exists the
// message is immutable from the UI's perspective: 409 message_locked.
func (s *Service) handleEditMessage(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	user := auth.CurrentUser(c)
	var req struct {
		Body string `json:"body"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if n := len(strings.TrimSpace(req.Body)); n == 0 || len(req.Body) > 20000 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "body must be 1-20000 characters")
		return
	}
	if _, err := s.q.GetMessageForUser(c.Request.Context(), db.GetMessageForUserParams{
		ID: id, UserID: user.ID,
	}); err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	locked, err := s.q.MessageReadByAgent(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if locked {
		httpx.Error(c, http.StatusConflict, "message_locked", "an agent has read this message; it can no longer be edited")
		return
	}
	if _, err := s.q.UpdateMessageBody(c.Request.Context(), db.UpdateMessageBodyParams{
		ID: id, AuthorUserID: user.ID, Body: req.Body,
	}); err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "only the author can edit a message")
		return
	}
	m, err := s.q.GetMessageByID(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := MessageJSON(MessageView{
		ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
		Body: m.Body, CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
		AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
		AuthorName: m.AuthorName, AuthorAvatar: m.AuthorAvatar,
		ParentAuthorName: m.ParentAuthorName, ParentBody: m.ParentBody,
		ParentDeleted: m.ParentDeleted,
		Attachments:   s.attachmentsFor(c, []pgtype.UUID{m.ID})[m.ID.String()],
		Reactions:     s.reactionsFor(c, []pgtype.UUID{m.ID})[m.ID.String()],
	})
	if s.Bus != nil {
		if pid, err := s.q.ResolveConversationProject(c.Request.Context(), m.ConversationID); err == nil {
			p, _ := uuid.FromBytes(pid.Bytes[:])
			s.Bus.Publish(events.Event{Type: "message.updated", ProjectID: p,
				Data: map[string]any{"conversation_id": m.ConversationID.String(), "message": out}})
		}
	}
	c.JSON(http.StatusOK, out)
}

// handleToggleReaction flips the caller's emoji on a message: absent ->
// added, present -> removed. The updated aggregate goes out over SSE.
func (s *Service) handleToggleReaction(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	user := auth.CurrentUser(c)
	var req struct {
		Emoji string `json:"emoji"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	emoji := strings.TrimSpace(req.Emoji)
	if emoji == "" || len(emoji) > 32 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "emoji required (<= 32 chars)")
		return
	}
	if _, err := s.q.GetMessageForUser(c.Request.Context(), db.GetMessageForUserParams{
		ID: id, UserID: user.ID,
	}); err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	removed, err := s.q.RemoveReactionUser(c.Request.Context(), db.RemoveReactionUserParams{
		MessageID: id, UserID: user.ID, Emoji: emoji,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if removed == 0 {
		if err := s.q.AddReactionUser(c.Request.Context(), db.AddReactionUserParams{
			MessageID: id, UserID: user.ID, Emoji: emoji,
		}); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
	}
	rxns := s.reactionsFor(c, []pgtype.UUID{id})[id.String()]
	payload := map[string]any{
		"message_id": id.String(), "reactions": nonEmpty(rxns),
	}
	if s.Bus != nil {
		if conv, err := s.q.GetConversationByID(c.Request.Context(),
			conversationIDFor(c, s.q, id)); err == nil {
			pid, _ := uuid.FromBytes(conv.ProjectID.Bytes[:])
			payload["conversation_id"] = conv.ID.String()
			s.Bus.Publish(events.Event{Type: "reaction.updated", ProjectID: pid, Data: payload})
		}
	}
	c.JSON(http.StatusOK, gin.H{"reactions": nonEmpty(rxns)})
}

// conversationIDFor resolves a message's conversation id for routing.
func conversationIDFor(c *gin.Context, q *db.Queries, messageID pgtype.UUID) pgtype.UUID {
	m, err := q.GetMessageByID(c.Request.Context(), messageID)
	if err != nil {
		return pgtype.UUID{}
	}
	return m.ConversationID
}

func (s *Service) handleMarkRead(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	user := auth.CurrentUser(c)
	if _, err := s.q.GetMessageForUser(c.Request.Context(), db.GetMessageForUserParams{
		ID: id, UserID: user.ID,
	}); err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	if err := s.q.MarkMessageRead(c.Request.Context(), db.MarkMessageReadParams{
		MessageID: id, UserID: user.ID,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.Status(http.StatusNoContent)
}

// attachmentsFor batches attachment rows for a page of messages, keyed by
// message id. Missing/failed lookups degrade to empty lists.
func (s *Service) attachmentsFor(c *gin.Context, ids []pgtype.UUID) map[string][]gin.H {
	out := make(map[string][]gin.H, len(ids))
	if len(ids) == 0 {
		return out
	}
	rows, err := s.q.ListAttachmentsForMessages(c.Request.Context(), ids)
	if err != nil {
		return out
	}
	for _, r := range rows {
		mid := r.MessageID.String()
		out[mid] = append(out[mid], attachments.JSON(db.Attachment{
			ID: r.ID, ProjectID: r.ProjectID, Filename: r.Filename,
			ContentType: r.ContentType, SizeBytes: r.SizeBytes, CreatedAt: r.CreatedAt,
		}))
	}
	return out
}

func parseUUIDs(raw []string) ([]pgtype.UUID, bool) {
	ids := make([]pgtype.UUID, 0, len(raw))
	for _, s := range raw {
		var u pgtype.UUID
		if err := u.Scan(s); err != nil {
			return nil, true
		}
		ids = append(ids, u)
	}
	return ids, false
}

// reactionsFor batches reaction aggregates for a page of messages, keyed
// by message id. The caller's id feeds "mine" on each emoji bucket.
func (s *Service) reactionsFor(c *gin.Context, ids []pgtype.UUID) map[string][]gin.H {
	out := make(map[string][]gin.H, len(ids))
	if len(ids) == 0 {
		return out
	}
	rows, err := s.q.ListReactionsForMessages(c.Request.Context(), ids)
	if err != nil {
		return out
	}
	me := auth.CurrentUser(c).ID
	type bucket struct {
		count int
		mine  bool
		names []string
	}
	byMsg := make(map[string]map[string]*bucket)
	order := make(map[string][]string)
	for _, r := range rows {
		mid := r.MessageID.String()
		bm, ok := byMsg[mid]
		if !ok {
			bm = map[string]*bucket{}
			byMsg[mid] = bm
		}
		b, ok := bm[r.Emoji]
		if !ok {
			b = &bucket{}
			bm[r.Emoji] = b
			order[mid] = append(order[mid], r.Emoji)
		}
		b.count++
		if len(b.names) < 8 {
			b.names = append(b.names, r.ReactorName)
		}
		if r.UserID == me {
			b.mine = true
		}
	}
	for mid, bm := range byMsg {
		list := make([]gin.H, 0, len(bm))
		for _, emoji := range order[mid] {
			b := bm[emoji]
			list = append(list, gin.H{
				"emoji": emoji, "count": b.count, "mine": b.mine, "names": b.names,
			})
		}
		out[mid] = list
	}
	return out
}

// agentReadSet returns the subset of ids at least one agent has read -
// those messages are edit-locked.
func (s *Service) agentReadSet(c *gin.Context, ids []pgtype.UUID) map[string]bool {
	out := make(map[string]bool, len(ids))
	if len(ids) == 0 {
		return out
	}
	rows, err := s.q.AgentReadMessageIDs(c.Request.Context(), ids)
	if err != nil {
		return out
	}
	for _, id := range rows {
		out[id.String()] = true
	}
	return out
}

// --- wire shapes ---

// ConversationJSON renders a conversation for the API.
func ConversationJSON(conv db.Conversation) gin.H {
	return conversationJSON(conv)
}

func conversationJSON(conv db.Conversation) gin.H {
	var issueID *string
	if conv.IssueID.Valid {
		v := conv.IssueID.String()
		issueID = &v
	}
	return gin.H{
		"id": conv.ID.String(), "project_id": conv.ProjectID.String(),
		"kind": conv.Kind, "issue_id": issueID,
		"created_at": conv.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
}

// MessageView is the render input for MessageJSON; the sqlc row types all
// carry the same field names, so callers map one in per query variant.
type MessageView struct {
	ID, ConversationID, ParentID pgtype.UUID
	Body                         string
	CreatedAt, EditedAt          pgtype.Timestamptz
	AuthorUserID, AuthorAgentID  pgtype.UUID
	AuthorName                   string
	AuthorAvatar                 pgtype.Text
	ParentAuthorName             string
	ParentBody                   pgtype.Text
	ParentDeleted                pgtype.Bool
	Attachments                  []gin.H
	Reactions                    []gin.H
	AgentRead                    bool
}

// MessageJSON renders one message for the API. Author is a user/agent pair;
// exactly one side is set (DB check constraint).
func MessageJSON(v MessageView) gin.H {
	kind := "user"
	authorID := v.AuthorUserID
	if v.AuthorAgentID.Valid {
		kind = "agent"
		authorID = v.AuthorAgentID
	}
	var avatar *string
	if v.AuthorAvatar.Valid {
		a := "/api/files/" + v.AuthorAvatar.String
		avatar = &a
	}
	var edited *string
	if v.EditedAt.Valid {
		e := v.EditedAt.Time.Format("2006-01-02T15:04:05Z07:00")
		edited = &e
	}
	var parent *gin.H
	if v.ParentID.Valid {
		p := gin.H{
			"id":      v.ParentID.String(),
			"author":  v.ParentAuthorName,
			"deleted": v.ParentDeleted.Bool,
		}
		if v.ParentDeleted.Bool {
			p["preview"] = ""
		} else {
			b := v.ParentBody.String
			if len([]rune(b)) > 160 {
				b = string([]rune(b)[:160]) + "…"
			}
			p["preview"] = b
		}
		parent = &p
	}
	return gin.H{
		"id": v.ID.String(), "conversation_id": v.ConversationID.String(),
		"author": gin.H{
			"kind": kind, "id": authorID.String(),
			"name": v.AuthorName, "avatar_url": avatar,
		},
		"body":        v.Body,
		"parent":      parent,
		"attachments": nonEmpty(v.Attachments),
		"reactions":   nonEmpty(v.Reactions),
		"created_at":  v.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		"edited_at":   edited,
		"agent_read":  v.AgentRead,
	}
}

func nonEmpty(l []gin.H) []gin.H {
	if l == nil {
		return []gin.H{}
	}
	return l
}
