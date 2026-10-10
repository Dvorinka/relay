// Package conversations: project channels and messages. Access rule per
// spec: any member of the containing workspace. MessageJSON is the shared
// wire shape (also used by the projects overview feed).
package conversations

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Dvorinka/relay/internal/attachments"
	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/Dvorinka/relay/internal/mentions"
	"github.com/Dvorinka/relay/internal/push"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// MaxMessageBodyChars is the shared body ceiling for messages across the
// REST API, inbound hooks and MCP tools — high enough that pasted logs and
// MIME dumps don't trip it, bounded so a single request stays sane.
const MaxMessageBodyChars = 1_000_000

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
	g.GET("/projects/:id/mentionables", s.projectMemberOnly, s.handleMentionables)
	g.GET("/conversations/:id/messages", s.memberOnly, s.handleListMessages)
	g.POST("/conversations/:id/typing", s.memberOnly, s.handleTyping)
	g.POST("/conversations/:id/messages", s.memberOnly, s.handlePostMessage)
	g.PATCH("/messages/:id", s.handleEditMessage)
	g.GET("/messages/:id/edits", s.handleListEdits)
	g.DELETE("/messages/:id", s.handleDeleteMessage)
	g.POST("/messages/:id/thread", s.handleCreateThread)
	g.PATCH("/conversations/:id/expiry", s.memberOnly, s.handleSetExpiry)
	g.GET("/projects/:id/threads", s.projectMemberOnly, s.handleListThreads)
	g.GET("/projects/:id/channels", s.projectMemberOnly, s.handleListChannels)
	g.POST("/projects/:id/channels", s.projectMemberOnly, s.handleCreateChannel)
	g.PATCH("/channels/:id", s.memberOnly, s.handleUpdateChannel)
	g.DELETE("/channels/:id", s.memberOnly, s.handleDeleteChannel)
	g.POST("/messages/:id/forward", s.handleForwardMessage)
	g.PUT("/messages/:id/pin", s.handlePinMessage)
	g.DELETE("/messages/:id/pin", s.handlePinMessage)
	g.GET("/conversations/:id/pins", s.memberOnly, s.handleListPins)
	g.PUT("/messages/:id/reactions", s.handleToggleReaction)
	g.POST("/messages/:id/read", s.handleMarkRead)
	g.POST("/conversations/:id/read", s.memberOnly, s.handleMarkConversationRead)
	g.DELETE("/conversations/:id/messages", s.memberOnly, s.handleClearConversation)
	s.registerScheduledRoutes(g)
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
	// expired threads are gone as far as clients are concerned
	if conv.ExpiresAt.Valid && !conv.ExpiresAt.Time.After(time.Now()) {
		httpx.Error(c, http.StatusNotFound, "not_found", "conversation expired")
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

// handleTyping publishes an ephemeral "typing" event — nothing touches the
// database. Clients hold the entry for ~4s and let it expire; senders
// throttle to one POST every few seconds while keys fall.
func (s *Service) handleTyping(c *gin.Context) {
	conv := c.MustGet(ctxConversation).(db.Conversation)
	u := auth.CurrentUser(c)
	if s.Bus != nil {
		pid, _ := uuid.FromBytes(conv.ProjectID.Bytes[:])
		s.Bus.Publish(events.Event{Type: "typing", ProjectID: pid,
			Data: map[string]any{
				"conversation_id": conv.ID.String(),
				"user":            map[string]any{"id": u.ID.String(), "name": u.Name},
			}})
	}
	c.Status(http.StatusNoContent)
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
	var tag pgtype.Text
	if v := strings.ToLower(strings.TrimSpace(c.Query("tag"))); v != "" {
		tag = pgtype.Text{String: v, Valid: true}
	}
	// one extra row decides has_more
	rows, err := s.q.ListMessages(c.Request.Context(), db.ListMessagesParams{
		ConversationID: conv.ID, Before: before, Tag: tag, Lim: int32(limit + 1),
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
	atts := s.attachmentsFor(c.Request.Context(), ids)
	rxns := s.reactionsFor(c, ids)
	readBy := s.readByFor(c, ids)
	msgs := make([]gin.H, 0, len(rows))
	// newest-first page -> reverse for chronological order
	for i := len(rows) - 1; i >= 0; i-- {
		m := rows[i]
		readers := readBy[m.ID.String()]
		msgs = append(msgs, MessageJSON(MessageView{
			ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
			Body: m.Body, Mentions: m.Mentions, Tags: m.Tags, Silent: m.Silent, CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
			AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
			AuthorKindSnapshot: m.AuthorKindSnapshot,
			AuthorName:         m.AuthorName, AuthorAvatar: m.AuthorAvatar,
			ParentAuthorName: m.ParentAuthorName, ParentBody: m.ParentBody,
			ParentDeleted: m.ParentDeleted,
			ThreadID:      m.ThreadID, ThreadTitle: m.ThreadTitle,
			ThreadReplyCount: m.ThreadReplyCount,
			PinnedAt:         m.PinnedAt,
			ForwardedFrom:    m.ForwardedFrom, FwdConversationID: m.FwdConversationID,
			FwdProjectID: m.FwdProjectID, FwdAuthorName: m.FwdAuthorName,
			Attachments: atts[m.ID.String()],
			Reactions:   rxns[m.ID.String()],
			AgentRead:   len(readers) > 0,
			ReadBy:      readers,
		}))
	}
	resp := gin.H{"messages": msgs, "has_more": hasMore}
	// First page only: the "New" divider boundary — the oldest message this
	// user hasn't read. The client snapshots it before bulk-marking the
	// conversation read, so the divider survives the session.
	if !before.Valid {
		if uid, err := s.q.FirstUnreadMessageID(c.Request.Context(), db.FirstUnreadMessageIDParams{
			ConversationID: conv.ID, AuthorUserID: auth.CurrentUser(c).ID,
		}); err == nil && uid.Valid {
			resp["first_unread_id"] = uid.String()
		}
	}
	c.JSON(http.StatusOK, resp)
}

func (s *Service) handlePostMessage(c *gin.Context) {
	conv := c.MustGet(ctxConversation).(db.Conversation)
	var req struct {
		Body          string   `json:"body"`
		AttachmentIDs []string `json:"attachment_ids"`
		ParentID      string   `json:"parent_id"`
		Tags          []string `json:"tags"`
		Silent        bool     `json:"silent"`
		ClientMsgID   string   `json:"client_msg_id"`
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
	if len(req.Body) > MaxMessageBodyChars || (len(req.Body) == 0 && len(req.AttachmentIDs) == 0) {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "body is too large; an empty body needs at least one attachment")
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
	tags, terr := NormalizeTags(req.Tags)
	if terr != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", terr.Error())
		return
	}
	user := auth.CurrentUser(c)
	var clientMsgID pgtype.Text
	if t := strings.TrimSpace(req.ClientMsgID); t != "" && len(t) <= 80 {
		clientMsgID = pgtype.Text{String: t, Valid: true}
	}
	out, _, err := s.createMessage(c.Request.Context(), conv, user.ID,
		req.Body, parent, ids, tags, req.Silent, clientMsgID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	// 201 covers both the fresh insert and a deduped outbox replay —
	// idempotent create semantics keep the response identical.
	c.JSON(http.StatusCreated, out)
}

// createMessage is the shared user-authored insert + fan-out: mentions,
// attachments, read receipt, SSE frame, thread counters, push. The HTTP
// handler and the scheduled-send sweep both run through it.
// deduped=true means client_msg_id matched a stored message — the caller
// returns it without re-emitting events or push.
func (s *Service) createMessage(ctx context.Context, conv db.Conversation,
	authorID pgtype.UUID, body string, parent pgtype.UUID,
	attachmentIDs []pgtype.UUID, tags []string, silent bool,
	clientMsgID pgtype.Text) (out gin.H, deduped bool, err error) {
	refs := s.resolveMentions(ctx, conv.ProjectID, mentions.Extract(body))
	mj, _ := json.Marshal(refs)
	id, err := s.q.CreateMessage(ctx, db.CreateMessageParams{
		ConversationID: conv.ID, AuthorUserID: authorID, Body: body,
		ParentID: parent, Mentions: mj, Tags: tags, Silent: silent,
		ClientMsgID: clientMsgID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) && clientMsgID.Valid {
			// conflict no-op: the first send already inserted this message
			storedID, ferr := s.q.GetMessageIDByClientMsgID(ctx,
				db.GetMessageIDByClientMsgIDParams{
					ConversationID: conv.ID, ClientMsgID: clientMsgID,
				})
			if ferr != nil {
				return nil, false, ferr
			}
			m, ferr := s.q.GetMessageByID(ctx, storedID)
			if ferr != nil {
				return nil, false, ferr
			}
			return s.messageView(ctx, m), true, nil
		}
		return nil, false, err
	}
	for i, aid := range attachmentIDs {
		if err := s.q.LinkMessageAttachment(ctx, db.LinkMessageAttachmentParams{
			MessageID: id, AttachmentID: aid, Position: int32(i),
		}); err != nil {
			s.log.Error("link attachment failed", zap.Error(err))
		}
	}
	m, err := s.q.GetMessageByID(ctx, id)
	if err != nil {
		return nil, false, err
	}
	// send == read
	_ = s.q.MarkMessageRead(ctx, db.MarkMessageReadParams{MessageID: m.ID, UserID: authorID})
	out = s.messageView(ctx, m)
	if s.Bus != nil {
		pid, _ := uuid.FromBytes(conv.ProjectID.Bytes[:])
		s.Bus.Publish(events.Event{Type: "message.created", ProjectID: pid,
			Data: map[string]any{"conversation_id": m.ConversationID.String(), "message": out}})
	}
	if conv.Kind == "thread" {
		// reply count on the parent message's chip moves live
		s.publishThreadEvent(ctx, conv.ID, "thread.updated")
	}
	if s.Push != nil {
		s.Push.NotifyMessage(conv.ProjectID, authorID, body, m.ID,
			"/app/p/"+conv.ProjectID.String(), m.AuthorName,
			mentions.UserIDs(refs))
	}
	return out, false, nil
}

// messageView renders the stored row into the wire shape — extracted from
// createMessage so the dedupe path returns the identical body.
func (s *Service) messageView(ctx context.Context, m db.GetMessageByIDRow) gin.H {
	atts := s.attachmentsFor(ctx, []pgtype.UUID{m.ID})
	return MessageJSON(MessageView{
		ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
		Body: m.Body, Mentions: m.Mentions, Tags: m.Tags, Silent: m.Silent, CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
		AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
		AuthorKindSnapshot: m.AuthorKindSnapshot,
		AuthorName:         m.AuthorName, AuthorAvatar: m.AuthorAvatar,
		ParentAuthorName: m.ParentAuthorName, ParentBody: m.ParentBody,
		ParentDeleted: m.ParentDeleted,
		ThreadID:      m.ThreadID, ThreadTitle: m.ThreadTitle,
		ThreadReplyCount: m.ThreadReplyCount,
		PinnedAt:         m.PinnedAt,
		ForwardedFrom:    m.ForwardedFrom, FwdConversationID: m.FwdConversationID,
		FwdProjectID: m.FwdProjectID, FwdAuthorName: m.FwdAuthorName,
		Attachments: atts[m.ID.String()],
	})
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
		Body          string   `json:"body"`
		AttachmentIDs []string `json:"attachment_ids"` // appended, not replaced
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if n := len(strings.TrimSpace(req.Body)); n == 0 || len(req.Body) > MaxMessageBodyChars {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "body is empty or too large")
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
	attIDs, bad := parseUUIDs(req.AttachmentIDs)
	if bad {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid attachment id")
		return
	}
	if len(attIDs) > 0 {
		existing, err := s.q.CountMessageAttachments(c.Request.Context(), id)
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		if int(existing)+len(attIDs) > 20 {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "at most 20 attachments per message")
			return
		}
		// attachment project must match the message's project
		projectID := s.convProjectID(c, conversationIDFor(c, s.q, id))
		n, err := s.q.CountUsableAttachmentsInProject(c.Request.Context(),
			db.CountUsableAttachmentsInProjectParams{ProjectID: projectID, Ids: attIDs})
		if err != nil || int(n) != len(attIDs) {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown or pending attachment id")
			return
		}
	}
	// Snapshot the outgoing body for the edit-history timeline before it
	// changes hands; written only once the update lands.
	prev, perr := s.q.GetMessageByID(c.Request.Context(), id)
	if _, err := s.q.UpdateMessageBody(c.Request.Context(), db.UpdateMessageBodyParams{
		ID: id, AuthorUserID: user.ID, Body: req.Body,
	}); err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "only the author can edit a message")
		return
	}
	if perr == nil && prev.Body != req.Body {
		_ = s.q.CreateMessageEdit(c.Request.Context(), db.CreateMessageEditParams{
			MessageID: id, Body: prev.Body, EditedBy: user.ID,
		})
	}
	if len(attIDs) > 0 {
		base, _ := s.q.CountMessageAttachments(c.Request.Context(), id)
		for i, aid := range attIDs {
			if err := s.q.LinkMessageAttachment(c.Request.Context(), db.LinkMessageAttachmentParams{
				MessageID: id, AttachmentID: aid, Position: int32(int(base) + i),
			}); err != nil {
				s.log.Error("link attachment failed", zap.Error(err))
			}
		}
	}
	m, err := s.q.GetMessageByID(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	// Mentions shift with the body — re-extract and persist.
	refs := s.resolveMentions(c.Request.Context(), s.convProjectID(c, m.ConversationID),
		mentions.Extract(req.Body))
	if mj, merr := json.Marshal(refs); merr == nil {
		_ = s.q.UpdateMessageMentions(c.Request.Context(),
			db.UpdateMessageMentionsParams{ID: id, Mentions: mj})
		m.Mentions = mj
	}
	out := MessageJSON(MessageView{
		ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
		Body: m.Body, Mentions: m.Mentions, Tags: m.Tags, Silent: m.Silent, CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
		AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
		AuthorKindSnapshot: m.AuthorKindSnapshot,
		AuthorName:         m.AuthorName, AuthorAvatar: m.AuthorAvatar,
		ParentAuthorName: m.ParentAuthorName, ParentBody: m.ParentBody,
		ParentDeleted: m.ParentDeleted,
		ThreadID:      m.ThreadID, ThreadTitle: m.ThreadTitle,
		ThreadReplyCount: m.ThreadReplyCount,
		PinnedAt:         m.PinnedAt,
		ForwardedFrom:    m.ForwardedFrom, FwdConversationID: m.FwdConversationID,
		FwdProjectID: m.FwdProjectID, FwdAuthorName: m.FwdAuthorName,
		Attachments: s.attachmentsFor(c.Request.Context(), []pgtype.UUID{m.ID})[m.ID.String()],
		Reactions:   s.reactionsFor(c, []pgtype.UUID{m.ID})[m.ID.String()],
	})
	s.publishMessageUpdated(c, m.ConversationID, out)
	c.JSON(http.StatusOK, out)
}

// handleDeleteMessage soft-deletes a message (deleted_at). Same rules as
// edit: author only, and locked with 409 message_locked once an agent has
// read it. Replies keep a tombstone via parent_deleted.
func (s *Service) handleDeleteMessage(c *gin.Context) {
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
	locked, err := s.q.MessageReadByAgent(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if locked {
		httpx.Error(c, http.StatusConflict, "message_locked", "an agent has read this message; it can no longer be deleted")
		return
	}
	row, err := s.q.SoftDeleteMessage(c.Request.Context(), db.SoftDeleteMessageParams{
		ID: id, AuthorUserID: user.ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "only the author can delete a message")
		return
	}
	if s.Bus != nil {
		if pid, err := s.q.ResolveConversationProject(c.Request.Context(), row.ConversationID); err == nil {
			p, _ := uuid.FromBytes(pid.Bytes[:])
			s.Bus.Publish(events.Event{Type: "message.deleted", ProjectID: p,
				Data: map[string]any{
					"conversation_id": row.ConversationID.String(),
					"message_id":      id.String(),
				}})
		}
		// a reply removed inside a thread drops the parent's reply count
		if conv, err := s.q.GetConversationByID(c.Request.Context(), row.ConversationID); err == nil && conv.Kind == "thread" {
			s.publishThreadEvent(c.Request.Context(), conv.ID, "thread.updated")
		}
	}
	c.Status(http.StatusNoContent)
}

// handleListEdits returns prior bodies of a message, oldest first — the
// "edited · view history" popover. Same membership gate as reads.
func (s *Service) handleListEdits(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	if _, err := s.q.GetMessageForUser(c.Request.Context(), db.GetMessageForUserParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	}); err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	rows, err := s.q.ListMessageEdits(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, gin.H{
			"body":        r.Body,
			"edited_by":   r.EditedBy.String(),
			"editor_name": r.EditorName.String,
			"edited_at":   r.EditedAt.Time,
		})
	}
	c.JSON(http.StatusOK, gin.H{"edits": out})
}

// messagePayload re-renders one message for responses and SSE frames.
func (s *Service) messagePayload(c *gin.Context, id pgtype.UUID) (gin.H, bool) {
	m, err := s.q.GetMessageByID(c.Request.Context(), id)
	if err != nil {
		return nil, false
	}
	atts := s.attachmentsFor(c.Request.Context(), []pgtype.UUID{m.ID})
	rxns := s.reactionsFor(c, []pgtype.UUID{m.ID})
	readers := s.readByFor(c, []pgtype.UUID{m.ID})[m.ID.String()]
	return MessageJSON(MessageView{
		ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
		Body: m.Body, Mentions: m.Mentions, Tags: m.Tags, Silent: m.Silent, CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
		AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
		AuthorKindSnapshot: m.AuthorKindSnapshot,
		AuthorName:         m.AuthorName, AuthorAvatar: m.AuthorAvatar,
		ParentAuthorName: m.ParentAuthorName, ParentBody: m.ParentBody,
		ParentDeleted: m.ParentDeleted,
		ThreadID:      m.ThreadID, ThreadTitle: m.ThreadTitle,
		ThreadReplyCount: m.ThreadReplyCount,
		PinnedAt:         m.PinnedAt,
		ForwardedFrom:    m.ForwardedFrom, FwdConversationID: m.FwdConversationID,
		FwdProjectID: m.FwdProjectID, FwdAuthorName: m.FwdAuthorName,
		Attachments: atts[m.ID.String()],
		Reactions:   rxns[m.ID.String()],
		AgentRead:   len(readers) > 0,
		ReadBy:      readers,
	}), true
}

// publishMessageUpdated pushes the fresh payload so open clients patch the row.
func (s *Service) publishMessageUpdated(c *gin.Context, convID pgtype.UUID, out gin.H) {
	if s.Bus == nil {
		return
	}
	if pid, err := s.q.ResolveConversationProject(c.Request.Context(), convID); err == nil {
		p, _ := uuid.FromBytes(pid.Bytes[:])
		s.Bus.Publish(events.Event{Type: "message.updated", ProjectID: p,
			Data: map[string]any{"conversation_id": convID.String(), "message": out}})
	}
}

// handlePinMessage toggles pinned_at: PUT pins, DELETE unpins. Any project
// member may pin — Relay has no Manage Messages tier to gate it behind.
func (s *Service) handlePinMessage(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	user := auth.CurrentUser(c)
	if _, err := s.q.GetMessageForUser(c.Request.Context(),
		db.GetMessageForUserParams{ID: id, UserID: user.ID}); err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "message not found")
		return
	}
	var convID pgtype.UUID
	if c.Request.Method == http.MethodPut {
		r, err := s.q.PinMessage(c.Request.Context(), id)
		if err != nil {
			httpx.Error(c, http.StatusNotFound, "not_found", "message not found")
			return
		}
		convID = r.ConversationID
	} else {
		r, err := s.q.UnpinMessage(c.Request.Context(), id)
		if err != nil {
			httpx.Error(c, http.StatusNotFound, "not_found", "message not found")
			return
		}
		convID = r.ConversationID
	}
	out, ok := s.messagePayload(c, id)
	if !ok {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.publishMessageUpdated(c, convID, out)
	c.JSON(http.StatusOK, out)
}

// handleListPins returns the conversation's pinned messages, newest pin first.
func (s *Service) handleListPins(c *gin.Context) {
	conv := c.MustGet(ctxConversation).(db.Conversation)
	rows, err := s.q.ListPinnedMessages(c.Request.Context(), conv.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, m := range rows {
		ids = append(ids, m.ID)
	}
	atts := s.attachmentsFor(c.Request.Context(), ids)
	rxns := s.reactionsFor(c, ids)
	readBy := s.readByFor(c, ids)
	msgs := make([]gin.H, 0, len(rows))
	for _, m := range rows {
		readers := readBy[m.ID.String()]
		msgs = append(msgs, MessageJSON(MessageView{
			ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
			Body: m.Body, Mentions: m.Mentions, Tags: m.Tags, Silent: m.Silent, CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
			AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
			AuthorKindSnapshot: m.AuthorKindSnapshot,
			AuthorName:         m.AuthorName, AuthorAvatar: m.AuthorAvatar,
			ParentAuthorName: m.ParentAuthorName, ParentBody: m.ParentBody,
			ParentDeleted: m.ParentDeleted,
			ThreadID:      m.ThreadID, ThreadTitle: m.ThreadTitle,
			ThreadReplyCount: m.ThreadReplyCount,
			PinnedAt:         m.PinnedAt,
			ForwardedFrom:    m.ForwardedFrom, FwdConversationID: m.FwdConversationID,
			FwdProjectID: m.FwdProjectID, FwdAuthorName: m.FwdAuthorName,
			Attachments: atts[m.ID.String()],
			Reactions:   rxns[m.ID.String()],
			AgentRead:   len(readers) > 0,
			ReadBy:      readers,
		}))
	}
	c.JSON(http.StatusOK, gin.H{"messages": msgs})
}

// handleForwardMessage copies a message into another project's conversation.
// The copy carries forwarded_from so clients can credit the original author;
// attachment links are shared, mentions are stripped (target members differ).
func (s *Service) handleForwardMessage(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	var req struct {
		ProjectID string `json:"project_id"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	var pid pgtype.UUID
	if err := pid.Scan(req.ProjectID); err != nil || !pid.Valid {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid project_id")
		return
	}
	user := auth.CurrentUser(c)
	if _, err := s.q.GetMessageForUser(c.Request.Context(),
		db.GetMessageForUserParams{ID: id, UserID: user.ID}); err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "message not found")
		return
	}
	role, err := s.q.ProjectWorkspaceRole(c.Request.Context(),
		db.ProjectWorkspaceRoleParams{ID: pid, UserID: user.ID})
	if err != nil || role == "" {
		httpx.Error(c, http.StatusNotFound, "not_found", "project not found")
		return
	}
	// The target's channel may not exist yet — conversations create lazily.
	target, err := s.q.GetProjectConversation(c.Request.Context(), pid)
	if err != nil {
		target, err = s.q.CreateProjectConversation(c.Request.Context(), pid)
		if err != nil {
			target, err = s.q.GetProjectConversation(c.Request.Context(), pid)
		}
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	src, err := s.q.GetMessageByID(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "message not found")
		return
	}
	root := src.ForwardedFrom
	if !root.Valid {
		root = src.ID // chains credit the origin, not the previous hop
	}
	newID, err := s.q.CreateMessage(c.Request.Context(), db.CreateMessageParams{
		ConversationID: target.ID, AuthorUserID: user.ID, Body: src.Body,
		ForwardedFrom: root, Tags: src.Tags,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if err := s.q.CopyMessageAttachments(c.Request.Context(),
		db.CopyMessageAttachmentsParams{MessageID: newID, SourceID: src.ID}); err != nil {
		s.log.Error("forward attachments failed", zap.Error(err))
	}
	_ = s.q.MarkMessageRead(c.Request.Context(), db.MarkMessageReadParams{MessageID: newID, UserID: user.ID})
	out, ok := s.messagePayload(c, newID)
	if !ok {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if s.Bus != nil {
		p, _ := uuid.FromBytes(pid.Bytes[:])
		s.Bus.Publish(events.Event{Type: "message.created", ProjectID: p,
			Data: map[string]any{"conversation_id": target.ID.String(), "message": out}})
	}
	c.JSON(http.StatusCreated, gin.H{"message": out})
}

// handleCreateThread opens (or returns) the thread rooted at a message.
// One thread per message; nesting is rejected - a thread's own messages
// cannot seed further threads. Title defaults to the parent's excerpt.
func (s *Service) handleCreateThread(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	user := auth.CurrentUser(c)
	var req struct {
		Title string `json:"title"`
		// ttl_hours: absent → 5-day default, negative → never expires.
		TTLHours *float64 `json:"ttl_hours"`
	}
	if c.Request.Body != nil && c.Request.ContentLength > 0 {
		if !httpx.BindJSON(c, &req) {
			return
		}
	}
	expiresAt, ok := threadTTL(c, req.TTLHours)
	if !ok {
		return
	}
	title := strings.TrimSpace(req.Title)
	if len([]rune(title)) > 120 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "title must be <= 120 characters")
		return
	}
	if _, err := s.q.GetMessageForUser(c.Request.Context(), db.GetMessageForUserParams{
		ID: id, UserID: user.ID,
	}); err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	convID, err := s.q.GetMessageConversation(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "message not found")
		return
	}
	parentConv, err := s.q.GetConversationByID(c.Request.Context(), convID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if parentConv.Kind == "thread" {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "threads cannot be nested")
		return
	}
	if title == "" {
		m, err := s.q.GetMessageByID(c.Request.Context(), id)
		if err == nil {
			title = strings.TrimSpace(m.Body)
			if len([]rune(title)) > 80 {
				title = string([]rune(title)[:80]) + "…"
			}
		}
	}
	if existing, err := s.q.GetThreadByParentMessage(c.Request.Context(), id); err == nil {
		tr, err := s.q.GetThread(c.Request.Context(), existing.ID)
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		c.JSON(http.StatusOK, gin.H{"thread": threadJSON(tr)})
		return
	}
	conv, err := s.q.CreateThread(c.Request.Context(), db.CreateThreadParams{
		ProjectID:       parentConv.ProjectID,
		ParentMessageID: id,
		Title:           pgtype.Text{String: title, Valid: title != ""},
		CreatedByUser:   user.ID,
		ExpiresAt:       expiresAt,
	})
	if err != nil {
		// lost the create race - the other writer's row is the answer
		existing, e2 := s.q.GetThreadByParentMessage(c.Request.Context(), id)
		if e2 != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		conv = existing
	} else {
		s.postThreadNotice(c, parentConv, conv.ID, title, user.ID, pgtype.UUID{})
		if s.Bus != nil {
			s.publishThreadEvent(c.Request.Context(), conv.ID, "thread.created")
		}
	}
	tr, err := s.q.GetThread(c.Request.Context(), conv.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"thread": threadJSON(tr)})
}

// defaultThreadTTL is the lifetime applied when the caller doesn't specify
// ttl_hours. Negative ttl → permanent; the cap is one year.
const defaultThreadTTL = 5 * 24 * time.Hour

// threadTTL maps the caller's ttl_hours to an expires_at: nil → default,
// negative → never (invalid value → false). It writes the error itself.
func threadTTL(c *gin.Context, ttl *float64) (pgtype.Timestamptz, bool) {
	if ttl == nil {
		t := time.Now().Add(defaultThreadTTL)
		return pgtype.Timestamptz{Time: t, Valid: true}, true
	}
	if *ttl < 0 {
		return pgtype.Timestamptz{}, true
	}
	if *ttl == 0 || *ttl > 24*365 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "ttl_hours must be > 0 (or negative for never)")
		return pgtype.Timestamptz{}, false
	}
	t := time.Now().Add(time.Duration(*ttl * float64(time.Hour)))
	return pgtype.Timestamptz{Time: t, Valid: true}, true
}

// handleSetExpiry changes when a thread dies. {"expires_at": "..."} sets an
// absolute instant; null (or "never": true) keeps the thread forever.
func (s *Service) handleSetExpiry(c *gin.Context) {
	conv := c.MustGet(ctxConversation).(db.Conversation)
	if conv.Kind != "thread" {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "only threads expire")
		return
	}
	var req struct {
		ExpiresAt *time.Time `json:"expires_at"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	var at pgtype.Timestamptz
	if req.ExpiresAt != nil {
		at = pgtype.Timestamptz{Time: *req.ExpiresAt, Valid: true}
	}
	if _, err := s.q.SetThreadExpiry(c.Request.Context(), db.SetThreadExpiryParams{
		ID: conv.ID, ExpiresAt: at,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	// A past expires_at is a delete: GetThread filters expired rows, so the
	// re-read misses. Sweep eagerly and confirm instead of 500ing.
	if at.Valid && !at.Time.After(time.Now()) {
		if _, err := s.q.DeleteExpiredThreads(c.Request.Context()); err != nil {
			s.log.Warn("thread sweep failed", zap.Error(err))
		}
		c.JSON(http.StatusOK, gin.H{"thread": nil, "deleted": true})
		return
	}
	tr, err := s.q.GetThread(c.Request.Context(), conv.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"thread": threadJSON(tr)})
}

// SweepExpired deletes expired threads outside the request path — the lazy
// sweep in handleListThreads only runs when someone lists threads, so rows
// could otherwise linger indefinitely.
func (s *Service) SweepExpired(ctx context.Context) {
	if n, err := s.q.DeleteExpiredThreads(ctx); err != nil {
		s.log.Warn("thread sweep failed", zap.Error(err))
	} else if n > 0 {
		s.log.Info("swept expired threads", zap.Int64("count", n))
	}
}

// handleListThreads returns a project's thread index for the Threads view.
// The list doubles as the lazy sweep: expired rows are deleted here so they
// can't accumulate between reads.
func (s *Service) handleListThreads(c *gin.Context) {
	p := c.MustGet(ctxProjectRow).(db.GetProjectForUserRow)
	if n, err := s.q.DeleteExpiredThreads(c.Request.Context()); err != nil {
		s.log.Warn("thread sweep failed", zap.Error(err))
	} else if n > 0 {
		s.log.Debug("swept expired threads", zap.Int64("count", n))
	}
	rows, err := s.q.ListProjectThreads(c.Request.Context(), p.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, gin.H{
			"id":                  r.ID.String(),
			"parent_message_id":   r.ParentMessageID.String(),
			"parent_conversation": r.ParentConversationID.String(),
			"title":               nullText(r.Title),
			"created_by":          r.CreatorName,
			"parent": gin.H{
				"author":  r.ParentAuthorName,
				"preview": r.ParentPreview,
			},
			"reply_count":   r.ReplyCount,
			"last_reply_at": nullTime(r.LastReplyAt),
			"expires_at":    nullTime(r.ExpiresAt),
			"created_at":    r.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	c.JSON(http.StatusOK, gin.H{"threads": out})
}

// --- channels ---
// Channels are persistent named conversations (kind='channel') living beside
// the project's main chat. They ride the generic message routes — membership
// is workspace-wide, matching threads.

func channelJSON(conv db.Conversation) gin.H {
	m := conversationJSON(conv)
	m["name"] = nullText(conv.Title)
	m["agents_blocked"] = conv.AgentsBlocked
	return m
}

// channelName validates the wire name: trimmed, collapsed whitespace,
// 1-60 runes. Returns "" on violation.
func channelName(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) < 1 || len([]rune(s)) > 60 {
		return ""
	}
	return s
}

func (s *Service) handleListChannels(c *gin.Context) {
	p := c.MustGet(ctxProjectRow).(db.GetProjectForUserRow)
	rows, err := s.q.ListChannels(c.Request.Context(), p.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, ch := range rows {
		out = append(out, channelJSON(ch))
	}
	c.JSON(http.StatusOK, gin.H{"channels": out})
}

func (s *Service) handleCreateChannel(c *gin.Context) {
	p := c.MustGet(ctxProjectRow).(db.GetProjectForUserRow)
	var req struct {
		Name string `json:"name"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	name := channelName(req.Name)
	if name == "" {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "channel name must be 1-60 characters")
		return
	}
	conv, err := s.q.CreateChannel(c.Request.Context(), db.CreateChannelParams{
		ProjectID:     p.ID,
		Title:         pgtype.Text{String: name, Valid: true},
		CreatedByUser: auth.CurrentUser(c).ID,
	})
	if err != nil {
		// unique index on (project_id, lower(title)) — conflict reads as a
		// duplicate name rather than a generic failure
		httpx.Error(c, http.StatusConflict, "conflict", "a channel with that name already exists")
		return
	}
	if s.Bus != nil {
		pid, _ := uuid.FromBytes(p.ID.Bytes[:])
		s.Bus.Publish(events.Event{Type: "channel.created", ProjectID: pid,
			Data: map[string]any{"channel": channelJSON(conv)}})
	}
	c.JSON(http.StatusCreated, gin.H{"channel": channelJSON(conv)})
}

// handleUpdateChannel renames a channel and/or toggles agent visibility.
// {"name": "...", "agents_blocked": bool} — either field optional.
func (s *Service) handleUpdateChannel(c *gin.Context) {
	conv := c.MustGet(ctxConversation).(db.Conversation)
	if conv.Kind != "channel" {
		httpx.Error(c, http.StatusNotFound, "not_found", "channel not found")
		return
	}
	var req struct {
		Name          *string `json:"name"`
		AgentsBlocked *bool   `json:"agents_blocked"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if req.Name != nil {
		name := channelName(*req.Name)
		if name == "" {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "channel name must be 1-60 characters")
			return
		}
		if _, err := s.q.RenameChannel(c.Request.Context(), db.RenameChannelParams{
			ID: conv.ID, Title: pgtype.Text{String: name, Valid: true},
		}); err != nil {
			httpx.Error(c, http.StatusConflict, "conflict", "a channel with that name already exists")
			return
		}
	}
	if req.AgentsBlocked != nil {
		if _, err := s.q.SetChannelAgentsBlocked(c.Request.Context(), db.SetChannelAgentsBlockedParams{
			ID: conv.ID, AgentsBlocked: *req.AgentsBlocked,
		}); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
	}
	updated, err := s.q.GetConversationByID(c.Request.Context(), conv.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if s.Bus != nil {
		pid, _ := uuid.FromBytes(conv.ProjectID.Bytes[:])
		s.Bus.Publish(events.Event{Type: "channel.updated", ProjectID: pid,
			Data: map[string]any{"channel": channelJSON(updated)}})
	}
	c.JSON(http.StatusOK, gin.H{"channel": channelJSON(updated)})
}

func (s *Service) handleDeleteChannel(c *gin.Context) {
	conv := c.MustGet(ctxConversation).(db.Conversation)
	if conv.Kind != "channel" {
		httpx.Error(c, http.StatusNotFound, "not_found", "channel not found")
		return
	}
	if _, err := s.q.DeleteChannel(c.Request.Context(), conv.ID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if s.Bus != nil {
		pid, _ := uuid.FromBytes(conv.ProjectID.Bytes[:])
		s.Bus.Publish(events.Event{Type: "channel.deleted", ProjectID: pid,
			Data: map[string]any{"channel_id": conv.ID.String()}})
	}
	c.Status(http.StatusNoContent)
}

// postThreadNotice drops a "started a thread" row into the parent channel so
// the new thread is discoverable from the message stream. The thread id rides
// in mentions (kind=thread) so clients render the title as a link that opens
// the thread, and the row stays readable in plain-text clients.
func (s *Service) postThreadNotice(c *gin.Context, parent db.Conversation, threadID pgtype.UUID, title string, userID, agentID pgtype.UUID) {
	refs, _ := json.Marshal([]gin.H{
		{"kind": "thread", "ref": threadID.String(), "id": threadID.String(), "label": title},
	})
	body := "started a thread"
	if title != "" {
		body += ": " + title
	}
	var id pgtype.UUID
	var err error
	if agentID.Valid {
		id, err = s.q.CreateAgentMessage(c.Request.Context(), db.CreateAgentMessageParams{
			ConversationID: parent.ID, AgentID: agentID, Body: body, Mentions: refs,
		})
	} else {
		id, err = s.q.CreateMessage(c.Request.Context(), db.CreateMessageParams{
			ConversationID: parent.ID, AuthorUserID: userID, Body: body, Mentions: refs,
		})
	}
	if err != nil {
		s.log.Warn("thread notice failed", zap.Error(err))
		return
	}
	m, err := s.q.GetMessageByID(c.Request.Context(), id)
	if err != nil || s.Bus == nil {
		return
	}
	out := MessageJSON(MessageView{
		ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
		Body: m.Body, Mentions: m.Mentions, Tags: m.Tags, Silent: m.Silent, CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
		AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
		AuthorKindSnapshot: m.AuthorKindSnapshot,
		AuthorName:         m.AuthorName, AuthorAvatar: m.AuthorAvatar,
		PinnedAt:      m.PinnedAt,
		ForwardedFrom: m.ForwardedFrom, FwdConversationID: m.FwdConversationID,
		FwdProjectID: m.FwdProjectID, FwdAuthorName: m.FwdAuthorName,
	})
	pid, _ := uuid.FromBytes(parent.ProjectID.Bytes[:])
	s.Bus.Publish(events.Event{Type: "message.created", ProjectID: pid,
		Data: map[string]any{"conversation_id": m.ConversationID.String(), "message": out}})
}

// publishThreadEvent emits a thread.* frame keyed to the parent channel so
// open clients can bump the parent message's thread chip live.
func (s *Service) publishThreadEvent(ctx context.Context, threadID pgtype.UUID, typ string) {
	tr, err := s.q.GetThread(ctx, threadID)
	if err != nil || s.Bus == nil {
		return
	}
	pid, _ := uuid.FromBytes(tr.ProjectID.Bytes[:])
	s.Bus.Publish(events.Event{Type: typ, ProjectID: pid,
		Data: map[string]any{
			"conversation_id":   tr.ParentConversationID.String(),
			"parent_message_id": tr.ParentMessageID.String(),
			"thread":            threadJSON(tr),
		}})
}

// threadJSON renders the thread summary embedded in message payloads and
// thread.* events: id, title, and a live reply count.
func threadJSON(tr db.GetThreadRow) gin.H {
	return gin.H{
		"id": tr.ID.String(), "title": nullText(tr.Title),
		"parent_message_id":   tr.ParentMessageID.String(),
		"parent_conversation": tr.ParentConversationID.String(),
		"reply_count":         tr.ReplyCount,
		"parent": gin.H{
			"author":  tr.ParentAuthorName,
			"preview": tr.ParentPreview,
		},
		"created_by": tr.CreatorName,
		"created_at": tr.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		"expires_at": nullTime(tr.ExpiresAt),
	}
}

func nullText(t pgtype.Text) *string {
	if !t.Valid {
		return nil
	}
	return &t.String
}

func nullTime(t pgtype.Timestamptz) *string {
	if !t.Valid {
		return nil
	}
	s := t.Time.Format("2006-01-02T15:04:05Z07:00")
	return &s
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

// handleMarkConversationRead marks every message in the conversation read —
// the "viewed the channel" action that clears the unread badge.
func (s *Service) handleMarkConversationRead(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	if err := s.q.MarkConversationRead(c.Request.Context(), db.MarkConversationReadParams{
		ConversationID: id, UserID: auth.CurrentUser(c).ID,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.Status(http.StatusNoContent)
}

// handleClearConversation wipes the channel: soft-deletes every message.
// Unlike single-message delete this is a moderation action — owner/admin only,
// and agent-read locks do not apply (the chat itself is being discarded).
func (s *Service) handleClearConversation(c *gin.Context) {
	conv := c.MustGet(ctxConversation).(db.Conversation)
	user := auth.CurrentUser(c)
	pid, err := s.q.ResolveConversationProject(c.Request.Context(), conv.ID)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "conversation not found")
		return
	}
	role, err := s.q.ProjectWorkspaceRole(c.Request.Context(),
		db.ProjectWorkspaceRoleParams{ID: pid, UserID: user.ID})
	if err != nil || (role != "owner" && role != "admin") {
		httpx.Error(c, http.StatusForbidden, "forbidden", "only workspace owners and admins can clear the chat")
		return
	}
	n, err := s.q.ClearConversation(c.Request.Context(), conv.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	// Threads rooted at wiped messages keep their unread rows — reset read
	// state for everyone so /clear actually clears the inbox badge too.
	if err := s.q.ClearReadStateUsers(c.Request.Context(), conv.ID); err != nil {
		s.log.Error("clear read state (users)", zap.Error(err))
	}
	if err := s.q.ClearReadStateAgents(c.Request.Context(), conv.ID); err != nil {
		s.log.Error("clear read state (agents)", zap.Error(err))
	}
	if s.Bus != nil {
		p, _ := uuid.FromBytes(pid.Bytes[:])
		s.Bus.Publish(events.Event{Type: "conversation.cleared", ProjectID: p,
			Data: map[string]any{
				"conversation_id": conv.ID.String(),
				"cleared_by":      user.ID.String(),
			}})
	}
	c.JSON(http.StatusOK, gin.H{"cleared": n})
}

// attachmentsFor batches attachment rows for a page of messages, keyed by
// message id. Missing/failed lookups degrade to empty lists.
func (s *Service) attachmentsFor(ctx context.Context, ids []pgtype.UUID) map[string][]gin.H {
	out := make(map[string][]gin.H, len(ids))
	if len(ids) == 0 {
		return out
	}
	rows, err := s.q.ListAttachmentsForMessages(ctx, ids)
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

// readByFor batches named agent read receipts for a page of messages,
// keyed by message id. Non-empty read_by implies agent_read (the edit
// lock uses the same author exclusion), so callers drop agentReadSet.
func (s *Service) readByFor(c *gin.Context, ids []pgtype.UUID) map[string][]gin.H {
	out := make(map[string][]gin.H, len(ids))
	if len(ids) == 0 {
		return out
	}
	rows, err := s.q.AgentReadersForMessages(c.Request.Context(), ids)
	if err != nil {
		return out
	}
	for _, r := range rows {
		var avatar *string
		if r.AvatarKey.Valid {
			a := "/api/files/" + r.AvatarKey.String
			avatar = &a
		}
		mid := r.MessageID.String()
		out[mid] = append(out[mid], gin.H{
			"id": r.AgentID.String(), "name": r.Name,
			"avatar_url": avatar,
			"read_at":    r.ReadAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		})
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
	Mentions                     []byte
	Tags                         []string
	Silent                       bool
	CreatedAt, EditedAt          pgtype.Timestamptz
	AuthorUserID, AuthorAgentID  pgtype.UUID
	AuthorKindSnapshot           string
	AuthorName                   string
	AuthorAvatar                 pgtype.Text
	ParentAuthorName             string
	ParentBody                   pgtype.Text
	ParentDeleted                pgtype.Bool
	ThreadID                     pgtype.UUID
	ThreadTitle                  pgtype.Text
	ThreadReplyCount             int32
	PinnedAt                     pgtype.Timestamptz
	ForwardedFrom                pgtype.UUID
	FwdConversationID            pgtype.UUID
	FwdProjectID                 pgtype.UUID
	FwdAuthorName                string
	Attachments                  []gin.H
	Reactions                    []gin.H
	AgentRead                    bool
	ReadBy                       []gin.H
}

// MessageJSON renders one message for the API. Author is a user/agent pair;
// exactly one side is set (DB check constraint).
func MessageJSON(v MessageView) gin.H {
	kind := "user"
	authorID := v.AuthorUserID
	if v.AuthorAgentID.Valid {
		kind = "agent"
		authorID = v.AuthorAgentID
	} else if v.AuthorKindSnapshot == "agent" {
		kind = "agent"
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
	var mrefs any
	if len(v.Mentions) > 0 {
		_ = json.Unmarshal(v.Mentions, &mrefs)
	}
	if mrefs == nil {
		mrefs = []any{}
	}
	var thread *gin.H
	if v.ThreadID.Valid {
		thread = &gin.H{
			"id":          v.ThreadID.String(),
			"title":       nullText(v.ThreadTitle),
			"reply_count": v.ThreadReplyCount,
		}
	}
	var pinned *string
	if v.PinnedAt.Valid {
		p := v.PinnedAt.Time.Format("2006-01-02T15:04:05Z07:00")
		pinned = &p
	}
	var forwarded *gin.H
	if v.ForwardedFrom.Valid {
		f := gin.H{
			"message_id":      v.ForwardedFrom.String(),
			"conversation_id": v.FwdConversationID.String(),
			"author":          v.FwdAuthorName,
		}
		if v.FwdProjectID.Valid {
			f["project_id"] = v.FwdProjectID.String()
		}
		forwarded = &f
	}
	var authorIDOut any
	if authorID.Valid {
		authorIDOut = authorID.String()
	}
	return gin.H{
		"id": v.ID.String(), "conversation_id": v.ConversationID.String(),
		"author": gin.H{
			"kind": kind, "id": authorIDOut,
			"name": v.AuthorName, "avatar_url": avatar,
		},
		"body":        v.Body,
		"mentions":    mrefs,
		"tags":        nonEmptyTags(v.Tags),
		"silent":      v.Silent,
		"parent":      parent,
		"thread":      thread,
		"pinned_at":   pinned,
		"forwarded":   forwarded,
		"attachments": nonEmpty(v.Attachments),
		"reactions":   nonEmpty(v.Reactions),
		"created_at":  v.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		"edited_at":   edited,
		"agent_read":  v.AgentRead,
		"read_by":     nonEmpty(v.ReadBy),
	}
}

func nonEmpty(l []gin.H) []gin.H {
	if l == nil {
		return []gin.H{}
	}
	return l
}

func nonEmptyTags(l []string) []string {
	if l == nil {
		return []string{}
	}
	return l
}

var tagRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,23}$`)

// NormalizeTags lowercases, trims, validates and dedupes free-form message
// tags ("frontend", "backend", "visual", "mcp", …). Invalid entries are
// dropped; more than 8 is an error worth reporting.
func NormalizeTags(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, t := range in {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" {
			continue
		}
		if !tagRe.MatchString(t) {
			continue
		}
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	if len(out) > 8 {
		return nil, errors.New("at most 8 tags per message")
	}
	return out, nil
}

func (s *Service) convProjectID(c *gin.Context, convID pgtype.UUID) pgtype.UUID {
	pid, err := s.q.ResolveConversationProject(c.Request.Context(), convID)
	if err != nil {
		return pgtype.UUID{}
	}
	return pid
}

// resolveMentions binds extracted refs to real rows so readers (agents via
// MCP, notifications, UI chips) get ids and URLs, not just text. Refs that
// don't resolve are kept with found=false — the intent still reads.
func (s *Service) resolveMentions(ctx context.Context, projectID pgtype.UUID, refs []mentions.Ref) []mentions.Ref {
	if len(refs) == 0 {
		return []mentions.Ref{}
	}
	wsID, _ := s.q.ProjectWorkspaceID(ctx, projectID)
	for i := range refs {
		r := &refs[i]
		switch r.Kind {
		case "user":
			if u, err := s.q.UserByNameInWorkspace(ctx,
				db.UserByNameInWorkspaceParams{WorkspaceID: wsID, Name: r.Ref}); err == nil {
				r.ID = u.ID.String()
				r.Label = u.Name
				r.Found = true
			}
		case "agent":
			if a, err := s.q.AgentBySlug(ctx,
				db.AgentBySlugParams{WorkspaceID: wsID, Slug: r.Ref}); err == nil {
				r.ID = a.ID.String()
				r.Label = a.Name
				r.Found = true
			}
		case "mention":
			// bare @name: agents take precedence (slugs are unique), then users
			if a, err := s.q.AgentBySlug(ctx,
				db.AgentBySlugParams{WorkspaceID: wsID, Slug: r.Ref}); err == nil {
				r.Kind = "agent"
				r.ID = a.ID.String()
				r.Label = a.Name
				r.Found = true
			} else if u, err := s.q.UserByNameInWorkspace(ctx,
				db.UserByNameInWorkspaceParams{WorkspaceID: wsID, Name: r.Ref}); err == nil {
				r.Kind = "user"
				r.ID = u.ID.String()
				r.Label = u.Name
				r.Found = true
			}
		case "issue":
			if i, err := s.q.IssueByKeyInProject(ctx,
				db.IssueByKeyInProjectParams{ProjectID: projectID, Key: r.Ref}); err == nil {
				r.ID = i.ID.String()
				r.Label = i.Key + " — " + i.Title
				r.Found = true
				if i.GithubUrl.Valid && i.GithubUrl.String != "" {
					r.URL = i.GithubUrl.String
				} else {
					r.URL = "/app/p/" + projectID.String() + "/k/" + i.Key
				}
			}
		}
	}
	return refs
}

// handleMentionables serves the composer's @ menu: workspace members,
// agents, project issues (incl. GitHub-mirrored issues and PRs), and linked
// repos for owner/repo#N refs. One round-trip, cached by the composer.
func (s *Service) handleMentionables(c *gin.Context) {
	p := c.MustGet(ctxProjectRow).(db.GetProjectForUserRow)
	ctx := c.Request.Context()
	wsID, _ := s.q.ProjectWorkspaceID(ctx, p.ID)

	users := []gin.H{}
	if members, err := s.q.ListWorkspaceMembers(ctx, wsID); err == nil {
		for _, m := range members {
			var avatar *string
			if m.AvatarKey.Valid {
				a := "/api/files/" + m.AvatarKey.String
				avatar = &a
			}
			users = append(users, gin.H{
				"id": m.ID.String(), "name": m.Name,
				"avatar_url": avatar,
			})
		}
	}
	agents := []gin.H{}
	if list, err := s.q.ListAgentsMentionable(ctx, wsID); err == nil {
		for _, a := range list {
			agents = append(agents, gin.H{
				"id": a.ID.String(), "name": a.Name, "slug": a.Slug,
				"description": a.Description,
			})
		}
	}
	issues := []gin.H{}
	if list, err := s.q.ListMentionableIssues(ctx, p.ID); err == nil {
		for _, i := range list {
			kind := "issue"
			if i.GithubKind == "pr" {
				kind = "pull_request"
			} else if i.GithubUrl.Valid && i.GithubUrl.String != "" {
				kind = "github_issue"
			}
			url := "/app/p/" + p.ID.String() + "/k/" + i.Key
			if i.GithubUrl.Valid && i.GithubUrl.String != "" {
				url = i.GithubUrl.String
			}
			issues = append(issues, gin.H{
				"id": i.ID.String(), "key": i.Key, "title": i.Title,
				"status": i.Status, "kind": kind, "repo": i.Repo,
				"github_number": i.GithubNumber.Int32, "url": url,
			})
		}
	}
	repos := []string{}
	if list, err := s.q.ListProjectRepos(ctx, p.ID); err == nil {
		for _, r := range list {
			repos = append(repos, r.Owner+"/"+r.Name)
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"users": users, "agents": agents, "issues": issues, "repos": repos,
	})
}
