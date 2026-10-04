// Package workspaces: workspace CRUD plus membership and role checks.
// Every handler passes through RequireAuth upstream; role gates live here.
package workspaces

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"
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

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.GET("/workspaces", s.handleList)
	g.POST("/workspaces", s.handleCreate)
	g.GET("/workspaces/:id", s.memberOnly, s.handleGet)
	g.GET("/workspaces/:id/members", s.memberOnly, s.handleMembers)
	g.POST("/workspaces/:id/invite", s.adminOnly, s.handleInvite)
}

// --- role gates ---

func (s *Service) memberOnly(c *gin.Context) {
	if role := s.roleOf(c); role == "" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	c.Next()
}

func (s *Service) adminOnly(c *gin.Context) {
	role := s.roleOf(c)
	if role != "owner" && role != "admin" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "owner or admin role required")
		return
	}
	c.Next()
}

// roleOf returns the caller's role in :id's workspace, "" when absent.
func (s *Service) roleOf(c *gin.Context) string {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return ""
	}
	role, err := s.q.GetWorkspaceRole(c.Request.Context(), db.GetWorkspaceRoleParams{
		WorkspaceID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil {
		return ""
	}
	return role
}

// --- handlers ---

func (s *Service) handleList(c *gin.Context) {
	rows, err := s.q.ListWorkspacesForUser(c.Request.Context(), auth.CurrentUser(c).ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, w := range rows {
		out = append(out, workspaceJSON(w.ID, w.Name, w.Slug, w.AvatarKey, w.CreatedAt, w.Role))
	}
	c.JSON(http.StatusOK, gin.H{"workspaces": out})
}

func (s *Service) handleCreate(c *gin.Context) {
	var req struct {
		Name string `json:"name" binding:"required"`
		Slug string `json:"slug"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if len(req.Name) > 80 || req.Name == "" {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "name must be 1-80 characters")
		return
	}
	slug := req.Slug
	if slug == "" {
		slug = s.uniqueSlug(c, slugify(req.Name))
	} else if !slugPattern.MatchString(slug) {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "slug must match ^[a-z0-9-]{2,40}$")
		return
	}
	ws, err := s.q.CreateWorkspace(c.Request.Context(), db.CreateWorkspaceParams{Name: req.Name, Slug: slug})
	if err != nil {
		if isUniqueViolation(err) {
			httpx.Error(c, http.StatusConflict, "slug_taken", "slug already in use")
			return
		}
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	user := auth.CurrentUser(c)
	if err := s.q.AddWorkspaceMember(c.Request.Context(), db.AddWorkspaceMemberParams{
		WorkspaceID: ws.ID, UserID: user.ID, Role: "owner",
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": ws.ID.String(), "name": ws.Name, "slug": ws.Slug,
		"created_at": ws.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	})
}

func (s *Service) handleGet(c *gin.Context) {
	id, _ := httpx.PathUUID(c, "id") // memberOnly already validated
	ws, err := s.q.GetWorkspaceByID(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "workspace not found")
		return
	}
	role, _ := s.q.GetWorkspaceRole(c.Request.Context(), db.GetWorkspaceRoleParams{
		WorkspaceID: id, UserID: auth.CurrentUser(c).ID,
	})
	c.JSON(http.StatusOK, workspaceJSON(ws.ID, ws.Name, ws.Slug, ws.AvatarKey, ws.CreatedAt, role))
}

func (s *Service) handleMembers(c *gin.Context) {
	id, _ := httpx.PathUUID(c, "id")
	rows, err := s.q.ListWorkspaceMembers(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, m := range rows {
		out = append(out, gin.H{
			"role": m.Role,
			"user": auth.UserOut(db.GetUserByIDRow{
				ID: m.ID, Email: m.Email, Name: m.Name, NameColor: m.NameColor,
				AvatarKey: m.AvatarKey, CreatedAt: m.CreatedAt,
			}),
		})
	}
	c.JSON(http.StatusOK, gin.H{"members": out})
}

var ErrNoSuchUser = errors.New("no account with that email")

func (s *Service) handleInvite(c *gin.Context) {
	id, _ := httpx.PathUUID(c, "id")
	var req struct {
		Email string `json:"email" binding:"required"`
		Role  string `json:"role"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	role := req.Role
	if role == "" {
		role = "member"
	}
	if role != "member" && role != "admin" && role != "owner" {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "role must be owner, admin, or member")
		return
	}
	user, err := s.q.GetUserByEmail(c.Request.Context(), strings.ToLower(strings.TrimSpace(req.Email)))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", ErrNoSuchUser.Error())
		return
	}
	if err := s.q.AddWorkspaceMember(c.Request.Context(), db.AddWorkspaceMemberParams{
		WorkspaceID: id, UserID: user.ID, Role: role,
	}); err != nil {
		if isUniqueViolation(err) {
			httpx.Error(c, http.StatusConflict, "already_member", "user is already a member")
			return
		}
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"role": role,
		"user": auth.UserOut(db.GetUserByIDRow{
			ID: user.ID, Email: user.Email, Name: user.Name, NameColor: user.NameColor,
			AvatarKey: user.AvatarKey, CreatedAt: user.CreatedAt,
		}),
	})
}

// --- helpers ---

func workspaceJSON(id pgtype.UUID, name, slug string, avatarKey pgtype.Text, createdAt pgtype.Timestamptz, role string) gin.H {
	var avatar *string
	if avatarKey.Valid {
		a := "/api/files/" + avatarKey.String
		avatar = &a
	}
	return gin.H{
		"id": id.String(), "name": name, "slug": slug, "role": role,
		"avatar_url": avatar,
		"created_at": createdAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
}

var slugPattern = regexp.MustCompile(`^[a-z0-9-]{2,40}$`)
var nonSlugChars = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	s = nonSlugChars.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-")
	s = strings.Trim(s, "-")
	if len(s) < 2 {
		s = "ws"
	}
	if len(s) > 36 {
		s = s[:36]
	}
	return s
}

func (s *Service) uniqueSlug(c *gin.Context, base string) string {
	for i := 0; i < 5; i++ {
		candidate := base + "-" + randSuffix()
		if exists, err := s.q.WorkspaceSlugExists(c.Request.Context(), candidate); err == nil && !exists {
			return candidate
		}
	}
	return base + "-" + randSuffix() + randSuffix()
}

func randSuffix() string {
	b := make([]byte, 3)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
