// Package agents: agent identities, per-project scoped grants, and MCP
// token lifecycle. Management is session-auth; owner/admin for mutations.
// The MCP endpoint itself lives in internal/mcp.
package agents

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
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
	"go.uber.org/zap"
)

// Scopes is the canonical grant vocabulary, enforced by a DB check.
var Scopes = map[string]bool{
	"project:read": true, "message:read": true, "message:write": true,
	"attachment:read": true, "attachment:write": true,
	"issue:read": true, "issue:write": true,
	"review:read": true, "review:write": true, "file:read": true,
	"brief:read": true, "brief:write": true,
}

// ReviewModes is the valid set for agents.review_mode: 'gate' makes the
// agent wait for a human verdict on each submitted review; 'notify' posts
// the review for information only.
var ReviewModes = map[string]bool{"notify": true, "gate": true}

// DefaultInviteScopes is the scope set a fresh agent gets when an invite
// doesn't name a narrower one.
var DefaultInviteScopes = []string{
	"project:read", "message:read", "message:write",
	"attachment:read", "attachment:write",
	"issue:read", "issue:write", "review:read", "review:write",
	"file:read", "brief:read", "brief:write",
}

type Service struct {
	q   *db.Queries
	log *zap.Logger
	// Bus publishes domain events for SSE subscribers. Optional.
	Bus *events.Hub
}

// publishAgentChanged fans an "agent.changed" event out to every project in
// the workspace — events are project-scoped, and every workspace member is a
// member of at least its projects, so this reaches the whole settings page.
func (s *Service) publishAgentChanged(ctx context.Context, wsID pgtype.UUID, agentID pgtype.UUID, action string) {
	if s.Bus == nil {
		return
	}
	projects, err := s.q.ListWorkspaceProjectIDs(ctx, wsID)
	if err != nil {
		s.log.Warn("agent.changed fan-out", zap.Error(err))
		return
	}
	for _, pid := range projects {
		s.Bus.Publish(events.Event{
			Type:      "agent.changed",
			ProjectID: pid.Bytes,
			Data: map[string]any{
				"agent_id": agentID.String(),
				"action":   action,
			},
		})
	}
}

func NewService(log *zap.Logger, pool *pgxpool.Pool) *Service {
	return &Service{q: db.New(pool), log: log}
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.GET("/workspaces/:id/agents", s.memberOnly, s.handleList)
	g.POST("/workspaces/:id/agents", s.adminOnly, s.handleCreate)
	g.GET("/agents/:id", s.agentMemberOnly, s.handleGet)
	g.PATCH("/agents/:id", s.agentAdminOnly, s.handleUpdate)
	g.DELETE("/agents/:id", s.agentAdminOnly, s.handleDelete)
	g.PUT("/agents/:id/projects/:projectId", s.agentAdminOnly, s.handleGrant)
	g.DELETE("/agents/:id/projects/:projectId", s.agentAdminOnly, s.handleRevokeGrant)
	g.POST("/agents/:id/tokens", s.agentAdminOnly, s.handleMintToken)
	g.DELETE("/agents/:id/tokens/:tokenId", s.agentAdminOnly, s.handleRevokeToken)
	g.POST("/workspaces/:id/agent-invites", s.adminOnly, s.handleCreateInvite)
	g.GET("/workspaces/:id/agent-invites", s.adminOnly, s.handleListInvites)
	g.DELETE("/workspaces/:id/agent-invites/:inviteId", s.adminOnly, s.handleDeleteInvite)
	g.GET("/projects/:id/agents", s.projectMemberOnly, s.handleListProjectAgents)
}

// projectMemberOnly gates on the project's workspace membership — same
// rule as the rest of the project-scoped surface.
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
	c.Set(ctxProject, p.ID)
	c.Next()
}

// RegisterPublicRoutes exposes invite redemption - the agent calls it without
// a session; the rli_ token is the credential.
func (s *Service) RegisterPublicRoutes(g *gin.RouterGroup) {
	g.POST("/agent-invites/redeem", s.handleRedeemInvite)
}

// --- gates ---

const (
	ctxAgent     = "relay.agent"
	ctxWorkspace = "relay.agent_workspace"
	ctxProject   = "relay.agent_project"
)

func (s *Service) memberOnly(c *gin.Context) { s.wsGate(c, false) }
func (s *Service) adminOnly(c *gin.Context)  { s.wsGate(c, true) }

func (s *Service) wsGate(c *gin.Context, admin bool) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	role, err := s.q.GetWorkspaceRole(c.Request.Context(), db.GetWorkspaceRoleParams{
		WorkspaceID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil || role == "" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	if admin && role != "owner" && role != "admin" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "owner or admin role required")
		return
	}
	c.Set(ctxWorkspace, id)
	c.Next()
}

func (s *Service) agentMemberOnly(c *gin.Context) { s.agentGate(c, false) }
func (s *Service) agentAdminOnly(c *gin.Context)  { s.agentGate(c, true) }

func (s *Service) agentGate(c *gin.Context, admin bool) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	role, err := s.q.AgentWorkspaceRole(c.Request.Context(), db.AgentWorkspaceRoleParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil || role == "" {
		if _, err2 := s.q.GetAgentByID(c.Request.Context(), id); err2 == nil {
			httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		} else {
			httpx.Error(c, http.StatusNotFound, "not_found", "agent not found")
		}
		return
	}
	if admin && role != "owner" && role != "admin" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "owner or admin role required")
		return
	}
	a, err := s.q.GetAgentByID(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "agent not found")
		return
	}
	c.Set(ctxAgent, a)
	c.Next()
}

func currentAgent(c *gin.Context) db.Agent {
	return c.MustGet(ctxAgent).(db.Agent)
}

// --- handlers ---

func (s *Service) handleList(c *gin.Context) {
	wsID := c.MustGet(ctxWorkspace).(pgtype.UUID)
	rows, err := s.q.ListAgentsForWorkspace(c.Request.Context(), wsID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, a := range rows {
		out = append(out, agentJSON(agentFromListRow(a), nil, a.LastSeenAt))
	}
	c.JSON(http.StatusOK, gin.H{"agents": out})
}

// handleListProjectAgents lists the agents granted on a project so they
// appear alongside the human members in the project rail.
func (s *Service) handleListProjectAgents(c *gin.Context) {
	projectID := c.MustGet(ctxProject).(pgtype.UUID)
	rows, err := s.q.ListProjectAgents(c.Request.Context(), projectID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, agentJSON(db.Agent{
			ID: r.ID, WorkspaceID: r.WorkspaceID, Name: r.Name, Slug: r.Slug,
			Description: r.Description, AvatarKey: r.AvatarKey, ReviewMode: r.ReviewMode,
			GrantAll: r.GrantAll, GrantScopes: r.EffectiveScopes,
			CreatedAt: r.CreatedAt,
		}, nil, lastSeenFor(c, s.q, r.ID)))
	}
	c.JSON(http.StatusOK, gin.H{"agents": out})
}

func (s *Service) handleCreate(c *gin.Context) {
	wsID := c.MustGet(ctxWorkspace).(pgtype.UUID)
	var req struct {
		Name        string `json:"name" binding:"required"`
		Description string `json:"description"`
		ReviewMode  string `json:"review_mode"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if len(req.Name) == 0 || len(req.Name) > 60 || len(req.Description) > 500 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "name 1-60 chars, description <= 500")
		return
	}
	if req.ReviewMode == "" {
		req.ReviewMode = "notify"
	}
	if !ReviewModes[req.ReviewMode] {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "review_mode must be notify or gate")
		return
	}
	slug := slugify(req.Name)
	if slug == "" {
		slug = "agent"
	}
	for i := 0; ; i++ {
		candidate := slug
		if i > 0 {
			candidate = slug + "-" + strconv.Itoa(i+1)
		}
		exists, err := s.q.AgentSlugExists(c.Request.Context(), db.AgentSlugExistsParams{
			WorkspaceID: wsID, Slug: candidate,
		})
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		if !exists {
			slug = candidate
			break
		}
	}
	row, err := s.q.CreateAgent(c.Request.Context(), db.CreateAgentParams{
		WorkspaceID: wsID, Name: req.Name, Slug: slug,
		Description: req.Description, ReviewMode: req.ReviewMode,
		CreatedBy: auth.CurrentUser(c).ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.publishAgentChanged(c.Request.Context(), wsID, row.ID, "created")
	c.JSON(http.StatusCreated, agentJSON(row, nil, pgtype.Timestamptz{}))
}

func (s *Service) handleGet(c *gin.Context) {
	a := currentAgent(c)
	grants := s.grantJSONs(c, a.ID)
	tokens, err := s.q.ListMcpTokens(c.Request.Context(), a.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	toks := make([]gin.H, 0, len(tokens))
	for _, t := range tokens {
		toks = append(toks, tokenJSON(t))
	}
	c.JSON(http.StatusOK, gin.H{"agent": agentJSON(a, grants, lastSeenFor(c, s.q, a.ID)), "tokens": toks})
}

func (s *Service) handleUpdate(c *gin.Context) {
	a := currentAgent(c)
	var req struct {
		Name        *string  `json:"name"`
		Description *string  `json:"description"`
		ReviewMode  *string  `json:"review_mode"`
		GrantAll    *bool    `json:"grant_all"`
		GrantScopes []string `json:"grant_scopes"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if req.GrantAll != nil {
		scopes := req.GrantScopes
		if *req.GrantAll {
			if len(scopes) == 0 {
				scopes = DefaultInviteScopes
			}
			for _, sc := range scopes {
				if !Scopes[sc] {
					httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown scope: "+sc)
					return
				}
			}
		}
		row, err := s.q.SetAgentGrantAll(c.Request.Context(), db.SetAgentGrantAllParams{
			ID: a.ID, GrantAll: *req.GrantAll, GrantScopes: scopes,
		})
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		a = row
	}
	params := db.UpdateAgentParams{ID: a.ID}
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if len(n) == 0 || len(n) > 60 {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "name 1-60 chars")
			return
		}
		params.Name = pgtype.Text{String: n, Valid: true}
	}
	if req.Description != nil {
		if len(*req.Description) > 500 {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "description <= 500")
			return
		}
		params.Description = pgtype.Text{String: *req.Description, Valid: true}
	}
	if req.ReviewMode != nil {
		if !ReviewModes[*req.ReviewMode] {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "review_mode must be notify or gate")
			return
		}
		params.ReviewMode = pgtype.Text{String: *req.ReviewMode, Valid: true}
	}
	row, err := s.q.UpdateAgent(c.Request.Context(), params)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.publishAgentChanged(c.Request.Context(), row.WorkspaceID, row.ID, "updated")
	c.JSON(http.StatusOK, agentJSON(row, s.grantJSONs(c, row.ID), lastSeenFor(c, s.q, row.ID)))
}

func (s *Service) handleDelete(c *gin.Context) {
	a := currentAgent(c)
	_ = s.q.RevokeAgentTokens(c.Request.Context(), a.ID)
	if err := s.q.DeleteAgent(c.Request.Context(), a.ID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	// Other open clients drop the row live instead of hitting 404 on a stale
	// entry (the "agent not found" report).
	s.publishAgentChanged(c.Request.Context(), a.WorkspaceID, a.ID, "deleted")
	c.Status(http.StatusNoContent)
}

func (s *Service) handleGrant(c *gin.Context) {
	a := currentAgent(c)
	pid, ok := httpx.PathUUID(c, "projectId")
	if !ok {
		return
	}
	var req struct {
		Scopes []string `json:"scopes" binding:"required"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if len(req.Scopes) == 0 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "at least one scope required")
		return
	}
	for _, sc := range req.Scopes {
		if !Scopes[sc] {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown scope: "+sc)
			return
		}
	}
	same, err := s.q.ProjectInAgentWorkspace(c.Request.Context(), db.ProjectInAgentWorkspaceParams{
		AgentID: a.ID, ProjectID: pid,
	})
	if err != nil || !same {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "project is not in the agent's workspace")
		return
	}
	row, err := s.q.UpsertAgentGrant(c.Request.Context(), db.UpsertAgentGrantParams{
		AgentID: a.ID, ProjectID: pid, Scopes: req.Scopes,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.publishAgentChanged(c.Request.Context(), a.WorkspaceID, a.ID, "updated")
	c.JSON(http.StatusOK, grantJSON(row.AgentID, row.ProjectID, row.ProjectKey, row.ProjectName, row.Scopes, ""))
}

func (s *Service) handleRevokeGrant(c *gin.Context) {
	a := currentAgent(c)
	pid, ok := httpx.PathUUID(c, "projectId")
	if !ok {
		return
	}
	if err := s.q.DeleteAgentGrant(c.Request.Context(), db.DeleteAgentGrantParams{
		AgentID: a.ID, ProjectID: pid,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.publishAgentChanged(c.Request.Context(), a.WorkspaceID, a.ID, "updated")
	c.Status(http.StatusNoContent)
}

// handleMintToken returns the plaintext token exactly once.
func (s *Service) handleMintToken(c *gin.Context) {
	a := currentAgent(c)
	var req struct {
		Name        string `json:"name" binding:"required"`
		ExpiresDays *int   `json:"expires_days"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if len(strings.TrimSpace(req.Name)) == 0 || len(req.Name) > 60 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "name 1-60 chars")
		return
	}
	var expires pgtype.Timestamptz
	if req.ExpiresDays != nil {
		if *req.ExpiresDays < 1 || *req.ExpiresDays > 365 {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "expires_days 1-365")
			return
		}
		expires = pgtype.Timestamptz{
			Time: time.Now().Add(time.Duration(*req.ExpiresDays) * 24 * time.Hour), Valid: true,
		}
	}
	token, hash, err := mintToken()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	row, err := s.q.CreateMcpToken(c.Request.Context(), db.CreateMcpTokenParams{
		AgentID: a.ID, TokenHash: hash, Name: req.Name, ExpiresAt: expires,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := tokenJSON(db.ListMcpTokensRow{
		ID: row.ID, AgentID: row.AgentID, Name: row.Name,
		LastUsedAt: row.LastUsedAt, ExpiresAt: row.ExpiresAt, CreatedAt: row.CreatedAt,
	})
	out["token"] = token
	c.JSON(http.StatusCreated, out)
}

// mintToken returns the one-time plaintext token (rly_ + 32 random bytes,
// base64url) and the sha256 hash persisted in place of it.
func mintToken() (string, []byte, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	token := "rly_" + base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	return token, sum[:], nil
}

func (s *Service) handleRevokeToken(c *gin.Context) {
	a := currentAgent(c)
	tid, ok := httpx.PathUUID(c, "tokenId")
	if !ok {
		return
	}
	if err := s.q.RevokeMcpToken(c.Request.Context(), db.RevokeMcpTokenParams{
		ID: tid, AgentID: a.ID,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.Status(http.StatusNoContent)
}

// --- invites ---

// handleCreateInvite mints a one-shot rli_ token an agent redeems itself.
// project_ids empty = every workspace project at redeem time; scopes empty =
// DefaultInviteScopes. The plaintext token is returned exactly once.
func (s *Service) handleCreateInvite(c *gin.Context) {
	wsID := c.MustGet(ctxWorkspace).(pgtype.UUID)
	var req struct {
		ProjectIDs   []string `json:"project_ids"`
		Scopes       []string `json:"scopes"`
		ExpiresHours *int     `json:"expires_hours"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	hours := 72
	if req.ExpiresHours != nil {
		if *req.ExpiresHours < 1 || *req.ExpiresHours > 168 {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "expires_hours 1-168")
			return
		}
		hours = *req.ExpiresHours
	}
	scopes := req.Scopes
	if len(scopes) == 0 {
		scopes = DefaultInviteScopes
	}
	for _, sc := range scopes {
		if !Scopes[sc] {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "unknown scope: "+sc)
			return
		}
	}
	ids := make([]pgtype.UUID, 0, len(req.ProjectIDs))
	for _, raw := range req.ProjectIDs {
		var id pgtype.UUID
		if err := id.Scan(raw); err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid project id: "+raw)
			return
		}
		ids = append(ids, id)
	}
	if len(ids) > 0 {
		allowed, err := s.q.ListWorkspaceProjectIDs(c.Request.Context(), wsID)
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		set := map[pgtype.UUID]bool{}
		for _, p := range allowed {
			set[p] = true
		}
		for _, p := range ids {
			if !set[p] {
				httpx.Error(c, http.StatusBadRequest, "bad_request", "project not in this workspace")
				return
			}
		}
	}
	token, hash, err := mintInviteToken()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	row, err := s.q.CreateAgentInvite(c.Request.Context(), db.CreateAgentInviteParams{
		WorkspaceID: wsID,
		TokenHash:   hash,
		ProjectIds:  ids,
		Scopes:      scopes,
		ExpiresAt: pgtype.Timestamptz{
			Time: time.Now().Add(time.Duration(hours) * time.Hour), Valid: true,
		},
		CreatedBy: auth.CurrentUser(c).ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := inviteJSON(row, "", "")
	out["token"] = token
	s.publishAgentChanged(c.Request.Context(), wsID, pgtype.UUID{}, "invites")
	c.JSON(http.StatusCreated, out)
}

func (s *Service) handleListInvites(c *gin.Context) {
	wsID := c.MustGet(ctxWorkspace).(pgtype.UUID)
	rows, err := s.q.ListAgentInvites(c.Request.Context(), wsID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, inviteJSON(db.AgentInvite{
			ID: r.ID, WorkspaceID: r.WorkspaceID, ProjectIds: r.ProjectIds,
			Scopes: r.Scopes, ExpiresAt: r.ExpiresAt, UsedBy: r.UsedBy,
			CreatedBy: r.CreatedBy, CreatedAt: r.CreatedAt,
		}, r.UsedByName.String, r.CreatedByName.String))
	}
	c.JSON(http.StatusOK, gin.H{"invites": out})
}

func (s *Service) handleDeleteInvite(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "inviteId")
	if !ok {
		return
	}
	inv, err := s.q.GetAgentInviteByID(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "invite not found")
		return
	}
	if err := s.q.DeleteAgentInvite(c.Request.Context(), id); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.publishAgentChanged(c.Request.Context(), inv.WorkspaceID, pgtype.UUID{}, "invites")
	c.Status(http.StatusNoContent)
}

// handleRedeemInvite is the agent's self-registration: it presents the rli_
// token plus its own identity and gets back a working rly_ MCP token. The
// plaintext token appears exactly once in this response.
func (s *Service) handleRedeemInvite(c *gin.Context) {
	var req struct {
		Token       string `json:"token" binding:"required"`
		Name        string `json:"name" binding:"required"`
		Description string `json:"description"`
		ReviewMode  string `json:"review_mode"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if len(req.Name) == 0 || len(req.Name) > 60 || len(req.Description) > 500 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "name 1-60 chars, description <= 500")
		return
	}
	if req.ReviewMode == "" {
		req.ReviewMode = "notify"
	}
	if !ReviewModes[req.ReviewMode] {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "review_mode must be notify or gate")
		return
	}
	sum := sha256.Sum256([]byte(req.Token))
	inv, err := s.q.GetAgentInviteByHash(c.Request.Context(), sum[:])
	if err != nil {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invite is invalid, used, or expired")
		return
	}
	slug := slugify(req.Name)
	if slug == "" {
		slug = "agent"
	}
	for i := 0; ; i++ {
		candidate := slug
		if i > 0 {
			candidate = slug + "-" + strconv.Itoa(i+1)
		}
		exists, err := s.q.AgentSlugExists(c.Request.Context(), db.AgentSlugExistsParams{
			WorkspaceID: inv.WorkspaceID, Slug: candidate,
		})
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		if !exists {
			slug = candidate
			break
		}
	}
	agent, err := s.q.CreateAgent(c.Request.Context(), db.CreateAgentParams{
		WorkspaceID: inv.WorkspaceID, Name: req.Name, Slug: slug,
		Description: req.Description, ReviewMode: req.ReviewMode,
		CreatedBy: inv.CreatedBy,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	// project_ids empty = workspace-wide grant that also covers projects
	// created later (grant_all); explicit lists stay per-project rows.
	if len(inv.ProjectIds) == 0 {
		if _, err := s.q.SetAgentGrantAll(c.Request.Context(), db.SetAgentGrantAllParams{
			ID: agent.ID, GrantAll: true, GrantScopes: inv.Scopes,
		}); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
	} else {
		for _, pid := range inv.ProjectIds {
			if _, err := s.q.UpsertAgentGrant(c.Request.Context(), db.UpsertAgentGrantParams{
				AgentID: agent.ID, ProjectID: pid, Scopes: inv.Scopes,
			}); err != nil {
				httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
				return
			}
		}
	}
	token, hash, err := mintToken()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if _, err := s.q.CreateMcpToken(c.Request.Context(), db.CreateMcpTokenParams{
		AgentID: agent.ID, TokenHash: hash, Name: "self-registered",
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if _, err := s.q.RedeemAgentInvite(c.Request.Context(), db.RedeemAgentInviteParams{
		ID: inv.ID, UsedBy: agent.ID,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.publishAgentChanged(c.Request.Context(), inv.WorkspaceID, agent.ID, "created")
	scheme := "http"
	if c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	base := scheme + "://" + c.Request.Host
	c.JSON(http.StatusCreated, gin.H{
		"agent":   agentJSON(agent, s.grantJSONs(c, agent.ID), pgtype.Timestamptz{}),
		"token":   token,
		"mcp_url": base + "/mcp",
		"api_url": base + "/api",
	})
}

// mintInviteToken mirrors mintToken but prefixes rli_ so ops can tell invite
// tokens from live MCP tokens at a glance.
func mintInviteToken() (string, []byte, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	token := "rli_" + base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	return token, sum[:], nil
}

func inviteJSON(r db.AgentInvite, usedByName, createdByName string) gin.H {
	var used any
	if r.UsedBy.Valid {
		used = gin.H{"agent_id": r.UsedBy.String(), "name": usedByName}
	}
	projs := make([]string, 0, len(r.ProjectIds))
	for _, p := range r.ProjectIds {
		projs = append(projs, p.String())
	}
	return gin.H{
		"id": r.ID.String(), "project_ids": projs, "scopes": r.Scopes,
		"expires_at": r.ExpiresAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		"used_by":    used,
		"created_by": createdByName,
		"created_at": r.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
}

// --- wire shapes ---

func (s *Service) grantJSONs(c *gin.Context, agentID pgtype.UUID) []gin.H {
	rows, err := s.q.ListAgentGrants(c.Request.Context(), agentID)
	if err != nil {
		return []gin.H{}
	}
	out := make([]gin.H, 0, len(rows))
	for _, g := range rows {
		out = append(out, grantJSON(g.AgentID, g.ProjectID, g.ProjectKey, g.ProjectName, g.Scopes, ""))
	}
	return out
}

func grantJSON(_, projectID pgtype.UUID, pkey, pname string, scopes []string, _ string) gin.H {
	if scopes == nil {
		scopes = []string{}
	}
	return gin.H{
		"project_id": projectID.String(), "project_key": pkey,
		"project_name": pname, "scopes": scopes,
	}
}

// agentJSON renders an agent; grants may be nil for list views. lastSeen is
// the newest mcp_tokens.last_used_at - never fabricated, null when unseen.
func agentJSON(a db.Agent, grants []gin.H, lastSeen pgtype.Timestamptz) gin.H {
	if grants == nil {
		grants = []gin.H{}
	}
	var seen *string
	if lastSeen.Valid {
		v := lastSeen.Time.Format("2006-01-02T15:04:05Z07:00")
		seen = &v
	}
	var avatar any
	if a.AvatarKey.Valid {
		avatar = "/api/files/" + a.AvatarKey.String
	}
	scopes := a.GrantScopes
	if scopes == nil {
		scopes = []string{}
	}
	return gin.H{
		"id": a.ID.String(), "workspace_id": a.WorkspaceID.String(),
		"name": a.Name, "slug": a.Slug, "description": a.Description,
		"avatar_url": avatar, "review_mode": a.ReviewMode,
		"grant_all": a.GrantAll, "grant_scopes": scopes,
		"grants": grants, "last_seen_at": seen,
		"created_at": a.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
}

func lastSeenFor(c *gin.Context, q *db.Queries, agentID pgtype.UUID) pgtype.Timestamptz {
	t, err := q.AgentLastSeen(c.Request.Context(), agentID)
	if err != nil {
		return pgtype.Timestamptz{}
	}
	return t
}

func agentFromListRow(r db.ListAgentsForWorkspaceRow) db.Agent {
	return db.Agent{
		ID: r.ID, WorkspaceID: r.WorkspaceID, Name: r.Name, Slug: r.Slug,
		Description: r.Description, AvatarKey: r.AvatarKey, ReviewMode: r.ReviewMode,
		GrantAll: r.GrantAll, GrantScopes: r.GrantScopes,
		CreatedBy: r.CreatedBy,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func tokenJSON(t db.ListMcpTokensRow) gin.H {
	var last, exp *string
	if t.LastUsedAt.Valid {
		v := t.LastUsedAt.Time.Format("2006-01-02T15:04:05Z07:00")
		last = &v
	}
	if t.ExpiresAt.Valid {
		v := t.ExpiresAt.Time.Format("2006-01-02T15:04:05Z07:00")
		exp = &v
	}
	return gin.H{
		"id": t.ID.String(), "name": t.Name,
		"last_used_at": last, "expires_at": exp,
		"created_at": t.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
}

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	lastDash := true // trims a leading dash
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if ok {
			b.WriteRune(r)
			lastDash = false
		} else if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}
