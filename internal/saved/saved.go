// Package saved implements the personal "save for later" message list —
// distinct from pins, which are shared with the whole conversation.
package saved

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/conversations"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
)

type Service struct {
	q   *db.Queries
	log *zap.Logger
}

func NewService(log *zap.Logger, pool *pgxpool.Pool) *Service {
	return &Service{q: db.New(pool), log: log}
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.GET("/me/saved", s.handleList)
	g.PUT("/messages/:id/save", s.messageGate, s.handleSave)
	g.DELETE("/messages/:id/save", s.messageGate, s.handleUnsave)
}

// messageGate allows save/unsave only on messages the caller can see —
// same membership check the conversation routes run.
func (s *Service) messageGate(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		c.Abort()
		return
	}
	convID, err := s.q.GetMessageConversation(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "message not found")
		c.Abort()
		return
	}
	if _, err := s.q.GetConversationForUser(c.Request.Context(), db.GetConversationForUserParams{
		ID: convID, UserID: auth.CurrentUser(c).ID,
	}); err != nil {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		c.Abort()
		return
	}
	c.Set("relay.saved_message", id)
	c.Next()
}

func (s *Service) handleSave(c *gin.Context) {
	id := c.MustGet("relay.saved_message").(pgtype.UUID)
	if err := s.q.SaveMessage(c.Request.Context(), db.SaveMessageParams{
		UserID: auth.CurrentUser(c).ID, MessageID: id,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Service) handleUnsave(c *gin.Context) {
	id := c.MustGet("relay.saved_message").(pgtype.UUID)
	if err := s.q.UnsaveMessage(c.Request.Context(), db.UnsaveMessageParams{
		UserID: auth.CurrentUser(c).ID, MessageID: id,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Service) handleList(c *gin.Context) {
	rows, err := s.q.ListSavedMessages(c.Request.Context(), auth.CurrentUser(c).ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		m := conversations.MessageJSON(conversations.MessageView{
			ID: r.ID, ConversationID: r.ConversationID, ParentID: r.ParentID,
			Body: r.Body, Mentions: r.Mentions, Tags: r.Tags, Silent: r.Silent,
			CreatedAt: r.CreatedAt, EditedAt: r.EditedAt,
			AuthorUserID: r.AuthorUserID, AuthorAgentID: r.AuthorAgentID,
			AuthorKindSnapshot: r.AuthorKindSnapshot,
			AuthorName:         r.AuthorName, AuthorAvatar: r.AuthorAvatar,
			ParentAuthorName: r.ParentAuthorName, ParentBody: r.ParentBody,
			ParentDeleted: r.ParentDeleted,
			ThreadID:      r.ThreadID, ThreadTitle: r.ThreadTitle,
			ThreadReplyCount: r.ThreadReplyCount,
			PinnedAt:         r.PinnedAt,
			ForwardedFrom:    r.ForwardedFrom, FwdConversationID: r.FwdConversationID,
			FwdProjectID: r.FwdProjectID, FwdAuthorName: r.FwdAuthorName,
		})
		m["project_id"] = r.ProjectID.String()
		m["project_name"] = r.ProjectName
		m["saved_at"] = r.SavedAt.Time.Format("2006-01-02T15:04:05Z07:00")
		out = append(out, m)
	}
	c.JSON(http.StatusOK, gin.H{"messages": out})
}
