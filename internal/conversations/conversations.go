// Package conversations: project channels and messages. Access rule per
// spec: any member of the containing workspace. MessageJSON is the shared
// wire shape (also used by the projects overview feed).
package conversations

import (
	"net/http"
	"strconv"

	"github.com/Dvorinka/relay/internal/attachments"
	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

type Service struct {
	q   *db.Queries
	log *zap.Logger
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
	msgs := make([]gin.H, 0, len(rows))
	// newest-first page -> reverse for chronological order
	for i := len(rows) - 1; i >= 0; i-- {
		m := rows[i]
		msgs = append(msgs, MessageJSON(m.ID, m.ConversationID, m.Body, m.CreatedAt, m.EditedAt,
			m.AuthorUserID, m.AuthorAgentID, m.AuthorName, m.AuthorAvatar, atts[m.ID.String()]))
	}
	c.JSON(http.StatusOK, gin.H{"messages": msgs, "has_more": hasMore})
}

func (s *Service) handlePostMessage(c *gin.Context) {
	conv := c.MustGet(ctxConversation).(db.Conversation)
	var req struct {
		Body          string   `json:"body" binding:"required"`
		AttachmentIDs []string `json:"attachment_ids"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if len(req.Body) == 0 || len(req.Body) > 20000 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "body must be 1-20000 characters")
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
	c.JSON(http.StatusCreated, MessageJSON(m.ID, m.ConversationID, m.Body, m.CreatedAt, m.EditedAt,
		m.AuthorUserID, m.AuthorAgentID, m.AuthorName, m.AuthorAvatar, atts[m.ID.String()]))
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

// MessageJSON renders one message for the API. Author is a user/agent pair;
// exactly one side is set (DB check constraint).
func MessageJSON(id, convID pgtype.UUID, body string, createdAt, editedAt pgtype.Timestamptz,
	authorUserID, authorAgentID pgtype.UUID, authorName string, authorAvatar pgtype.Text, atts []gin.H) gin.H {
	kind := "user"
	authorID := authorUserID
	if authorAgentID.Valid {
		kind = "agent"
		authorID = authorAgentID
	}
	var avatar *string
	if authorAvatar.Valid {
		v := "/api/files/" + authorAvatar.String
		avatar = &v
	}
	var edited *string
	if editedAt.Valid {
		v := editedAt.Time.Format("2006-01-02T15:04:05Z07:00")
		edited = &v
	}
	return gin.H{
		"id": id.String(), "conversation_id": convID.String(),
		"author": gin.H{
			"kind": kind, "id": authorID.String(),
			"name": authorName, "avatar_url": avatar,
		},
		"body":        body,
		"attachments": nonEmpty(atts),
		"created_at":  createdAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		"edited_at":   edited,
	}
}

func nonEmpty(l []gin.H) []gin.H {
	if l == nil {
		return []gin.H{}
	}
	return l
}
