// Package realtime serves the SSE stream and the notification reads
// (unread counts, mentions) that power live UI updates.
package realtime

import (
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/httpx"
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
	priv.GET("/me/activity", s.handleActivity)
	priv.GET("/users/:id/profile", s.handleUserProfile)
}

// RegisterAgentRoutes mounts the agent-facing SSE stream outside session
// auth — it resolves Bearer rly_ tokens itself.
func (s *Service) RegisterAgentRoutes(g *gin.RouterGroup) {
	g.GET("/agent/events", s.handleAgentStream)
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
	rows, err := s.q.UnreadConversations(c.Request.Context(), user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "internal", "message": "internal error"}})
		return
	}
	// unread stays the per-project badge map; conversations breaks it down so
	// the UI can answer *where* the unread messages live.
	out := map[string]int{}
	convs := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out[r.ProjectID.String()] += int(r.Unread)
		item := gin.H{
			"conversation_id": r.ConversationID.String(),
			"project_id":      r.ProjectID.String(),
			"kind":            r.Kind,
			"unread":          int(r.Unread),
		}
		if r.FirstUnreadID.Valid {
			item["first_unread_id"] = r.FirstUnreadID.String()
			// Inbox row detail: who wrote the oldest unread + a short preview.
			if r.FirstUnreadBody != "" {
				snip := r.FirstUnreadBody
				if len([]rune(snip)) > 140 {
					snip = string([]rune(snip)[:140])
				}
				item["snippet"] = snip
				item["author_name"] = r.FirstUnreadAuthor
				item["first_unread_at"] = r.FirstUnreadAt.Time.Format("2006-01-02T15:04:05Z07:00")
			}
		}
		if r.IssueID.Valid {
			item["issue_id"] = r.IssueID.String()
			item["issue_number"] = r.IssueNumber.Int32
			item["issue_title"] = r.IssueTitle.String
		}
		if r.BriefID.Valid {
			item["brief_id"] = r.BriefID.String()
			item["brief_title"] = r.BriefTitle.String
		}
		if r.ParentMessageID.Valid {
			item["parent_message_id"] = r.ParentMessageID.String()
		}
		if r.ConversationTitle.Valid && r.ConversationTitle.String != "" {
			item["title"] = r.ConversationTitle.String
		}
		convs = append(convs, item)
	}
	pending, err := s.q.PendingReviewCounts(c.Request.Context(), user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "internal", "message": "internal error"}})
		return
	}
	rev := map[string]int{}
	for _, r := range pending {
		rev[r.ProjectID.String()] = int(r.Pending)
	}
	c.JSON(http.StatusOK, gin.H{"unread": out, "reviews": rev, "conversations": convs})
}

// handleAgentStream is the agent-facing SSE stream: Bearer rly_ token in the
// Authorization header or access_token query param (EventSource cannot set
// headers). Each event carries a project_id and is gated by the agent's
// effective scope for that project — grant_all or an explicit grant.
func (s *Service) handleAgentStream(c *gin.Context) {
	raw := c.GetHeader("Authorization")
	if strings.HasPrefix(raw, "Bearer ") {
		raw = strings.TrimPrefix(raw, "Bearer ")
	} else if q := c.Query("access_token"); q != "" {
		raw = q
	}
	if !strings.HasPrefix(raw, "rly_") {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "agent bearer token required")
		return
	}
	sum := sha256.Sum256([]byte(raw))
	agent, err := s.q.GetTokenAgent(c.Request.Context(), sum[:])
	if err != nil {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or revoked token")
		return
	}
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
			// scope gate — drop events for projects the agent has no grant on.
			// The query left-joins, so ungranted projects return empty scopes
			// rather than an error; the grant check is the non-empty set.
			pid := pgtype.UUID{Bytes: e.ProjectID, Valid: true}
			scopes, err := s.q.AgentScopeForProject(ctx, db.AgentScopeForProjectParams{
				ProjectID: pid, AgentID: agent.ID,
			})
			if err != nil || len(scopes) == 0 {
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
		if m.AuthorAgentID.Valid || m.AuthorKindSnapshot == "agent" {
			kind = "agent"
		}
		var avatar any
		if m.AuthorAvatar.Valid && m.AuthorAvatar.String != "" {
			avatar = m.AuthorAvatar.String
		}
		item := gin.H{
			"id":                m.ID.String(),
			"body":              m.Body,
			"created_at":        m.CreatedAt.Time,
			"project_id":        m.ProjectID.String(),
			"conversation_id":   m.ConversationID.String(),
			"conversation_kind": m.ConversationKind,
			"is_read":           m.IsRead,
		}
		if m.ConversationKind == "thread" && m.ParentMessageID.Valid {
			item["parent_message_id"] = m.ParentMessageID.String()
			item["parent_conversation_id"] = m.ParentConversationID.String()
		}
		if m.IssueID.Valid {
			item["issue_id"] = m.IssueID.String()
		}
		item["author"] = gin.H{
			"name":   m.AuthorName,
			"avatar": avatar,
			"kind":   kind,
		}
		out = append(out, item)
	}
	c.JSON(http.StatusOK, gin.H{"mentions": out})
}

// handleActivity powers the projects dashboard: open issues and GitHub PRs
// plus the latest messages across every project the user can see — one call,
// no per-project fan-out.
func (s *Service) handleActivity(c *gin.Context) {
	user := auth.CurrentUser(c)
	ctx := c.Request.Context()

	issues := []gin.H{}
	prs := []gin.H{}
	if rows, err := s.q.ListMyOpenIssues(ctx, user.ID); err == nil {
		for _, i := range rows {
			item := gin.H{
				"id": i.ID.String(), "project_id": i.ProjectID.String(),
				"key": i.Key, "title": i.Title, "status": i.Status,
				"priority": i.Priority, "updated_at": i.UpdatedAt.Time,
				"project_key": i.ProjectKey, "project_name": i.ProjectName,
			}
			if i.GithubKind == "pr" {
				prs = append(prs, item)
			} else {
				issues = append(issues, item)
			}
		}
	}

	msgs := []gin.H{}
	if rows, err := s.q.ListMyRecentMessages(ctx, user.ID); err == nil {
		for _, m := range rows {
			msgs = append(msgs, gin.H{
				"id": m.ID.String(), "body": m.Body,
				"created_at":        m.CreatedAt.Time,
				"conversation_id":   m.ConversationID.String(),
				"conversation_kind": m.ConversationKind,
				"project_id":        m.ProjectID.String(),
				"project_key":       m.ProjectKey, "project_name": m.ProjectName,
				"author": gin.H{"name": m.AuthorName, "kind": m.AuthorKind},
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"open_issues": issues, "open_prs": prs, "recent_messages": msgs,
	})
}

// handleUserProfile returns what the caller may see of another user: profile
// fields plus their footprint inside workspaces BOTH parties share. Nothing
// leaks across a workspace the caller isn't in — no shared workspace, 404.
func (s *Service) handleUserProfile(c *gin.Context) {
	user := auth.CurrentUser(c)
	target, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	ctx := c.Request.Context()
	shared, err := s.q.SharedWorkspaces(ctx, db.SharedWorkspacesParams{
		UserID:   user.ID,
		UserID_2: target,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "internal", "message": "internal error"}})
		return
	}
	if len(shared) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "not_found", "message": "user not found"}})
		return
	}
	tu, err := s.q.GetUserByID(ctx, target)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "not_found", "message": "user not found"}})
		return
	}
	issues, _ := s.q.ProfileAssignedIssues(ctx, db.ProfileAssignedIssuesParams{UserID: user.ID, AssigneeID: target})
	recent, _ := s.q.ProfileRecentMessages(ctx, db.ProfileRecentMessagesParams{UserID: user.ID, AuthorUserID: target})
	mentionRows, _ := s.q.ProfileMentionsOf(ctx, db.ProfileMentionsOfParams{UserID: user.ID, ID: target})
	msgCount, _ := s.q.ProfileMessageCount(ctx, db.ProfileMessageCountParams{UserID: user.ID, AuthorUserID: target})

	wss := make([]gin.H, 0, len(shared))
	for _, w := range shared {
		wss = append(wss, gin.H{
			"id": w.ID.String(), "name": w.Name, "slug": w.Slug, "role": w.Role,
		})
	}
	iout := make([]gin.H, 0, len(issues))
	for _, i := range issues {
		iout = append(iout, gin.H{
			"id": i.ID.String(), "project_id": i.ProjectID.String(),
			"key":   i.ProjectKey + "-" + strconv.Itoa(int(i.Number)),
			"title": i.Title, "status": i.Status, "priority": i.Priority,
			"project": i.ProjectName, "updated_at": i.UpdatedAt.Time,
		})
	}
	mout := make([]gin.H, 0, len(recent))
	for _, m := range recent {
		mout = append(mout, gin.H{
			"id": m.ID.String(), "body": m.Body,
			"project_id": m.ProjectID.String(), "project": m.ProjectName,
			"created_at": m.CreatedAt.Time,
		})
	}
	ment := make([]gin.H, 0, len(mentionRows))
	for _, m := range mentionRows {
		kind := "user"
		if m.AuthorIsAgent.Bool {
			kind = "agent"
		}
		ment = append(ment, gin.H{
			"id": m.ID.String(), "body": m.Body,
			"project_id": m.ProjectID.String(),
			"created_at": m.CreatedAt.Time,
			"author":     gin.H{"name": m.AuthorName, "kind": kind},
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"user": gin.H{
			"id": tu.ID.String(), "name": tu.Name, "name_color": tu.NameColor.String,
			"avatar_key": tu.AvatarKey.String, "created_at": tu.CreatedAt.Time,
		},
		"workspaces":      wss,
		"stats":           gin.H{"messages": msgCount, "issues": len(issues)},
		"issues":          iout,
		"recent_messages": mout,
		"mentions":        ment,
	})
}
