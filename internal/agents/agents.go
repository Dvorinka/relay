// Package agents: agent identities, per-project scoped grants, and MCP
// token lifecycle. Management is session-auth; owner/admin for mutations.
// The MCP endpoint itself lives in internal/mcp.
package agents

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// Scopes is the canonical grant vocabulary, enforced by a DB check.
var Scopes = map[string]bool{
	"project:read": true, "message:read": true, "message:write": true,
	"attachment:read": true, "issue:read": true, "issue:write": true,
}

type Service struct {
	q   *db.Queries
	log *zap.Logger
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
}

// --- gates ---

const (
	ctxAgent     = "relay.agent"
	ctxWorkspace = "relay.agent_workspace"
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

func (s *Service) handleCreate(c *gin.Context) {
	wsID := c.MustGet(ctxWorkspace).(pgtype.UUID)
	var req struct {
		Name        string `json:"name" binding:"required"`
		Description string `json:"description"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if len(req.Name) == 0 || len(req.Name) > 60 || len(req.Description) > 500 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "name 1-60 chars, description <= 500")
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
		Description: req.Description, CreatedBy: auth.CurrentUser(c).ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
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
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if !httpx.BindJSON(c, &req) {
		return
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
	row, err := s.q.UpdateAgent(c.Request.Context(), params)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, agentJSON(row, s.grantJSONs(c, row.ID), lastSeenFor(c, s.q, row.ID)))
}

func (s *Service) handleDelete(c *gin.Context) {
	a := currentAgent(c)
	_ = s.q.RevokeAgentTokens(c.Request.Context(), a.ID)
	if err := s.q.DeleteAgent(c.Request.Context(), a.ID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
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
	return gin.H{
		"id": a.ID.String(), "workspace_id": a.WorkspaceID.String(),
		"name": a.Name, "slug": a.Slug, "description": a.Description,
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
		Description: r.Description, AvatarKey: r.AvatarKey, CreatedBy: r.CreatedBy,
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
