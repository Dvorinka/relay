// Package avatars: image upload for user and agent logos, plus the
// authenticated reader behind /api/files/. Avatar keys live under the
// "avatars/" prefix; the reader serves only that prefix so attachment
// objects stay behind their project-scoped presign endpoint.
package avatars

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/Dvorinka/relay/internal/storage"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// Logos stay small and square; 2 MiB leaves generous headroom.
const maxBytes = 2 << 20

const prefix = "avatars/"

var imageTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
}

// extensionFor maps stored content types back to filenames for downloads.
func extensionFor(contentType string) string {
	switch strings.TrimSuffix(contentType, ";") {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	}
	return ""
}

type Service struct {
	q     *db.Queries
	store *storage.Store
	log   *zap.Logger
}

func NewService(log *zap.Logger, pool *pgxpool.Pool, store *storage.Store) *Service {
	return &Service{q: db.New(pool), store: store, log: log}
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.PUT("/me/avatar", s.handleUserAvatar)
	g.PUT("/agents/:id/avatar", s.handleAgentAvatar)
	g.PUT("/projects/:id/icon", s.handleProjectIcon)
	g.POST("/projects/:id/icon/github", s.handleProjectIconFromGithub)
	g.PUT("/workspaces/:id/icon", s.handleWorkspaceIcon)
	g.GET("/files/*key", s.handleFile)
}

// readUpload pulls and validates the multipart "file" field. Replies on
// failure; the caller returns early when ok is false.
func (s *Service) readUpload(c *gin.Context) (data []byte, contentType string, ok bool) {
	if s.store == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "storage_disabled", "object storage is not configured")
		return nil, "", false
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
	fh, err := c.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "too_large", "avatar exceeds the 2 MiB cap")
			return nil, "", false
		}
		httpx.Error(c, http.StatusBadRequest, "bad_request", "multipart field \"file\" required")
		return nil, "", false
	}
	f, err := fh.Open()
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "unreadable file")
		return nil, "", false
	}
	defer func() { _ = f.Close() }()
	data, err = io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil || int64(len(data)) > maxBytes {
		httpx.Error(c, http.StatusRequestEntityTooLarge, "too_large", "avatar exceeds the 2 MiB cap")
		return nil, "", false
	}
	ct, _, _ := strings.Cut(http.DetectContentType(data), ";")
	ct = strings.TrimSpace(ct)
	if !imageTypes[ct] {
		httpx.Error(c, http.StatusBadRequest, "unsupported_type", "avatars accept png, jpeg, gif or webp images")
		return nil, "", false
	}
	return data, ct, true
}

func (s *Service) put(c *gin.Context, key string, data []byte, ct string) bool {
	if err := s.store.Put(c.Request.Context(), key, bytes.NewReader(data), int64(len(data)), ct); err != nil {
		s.log.Error("avatar put failed", zap.Error(err))
		httpx.Error(c, http.StatusInternalServerError, "internal", "upload failed")
		return false
	}
	return true
}

func (s *Service) handleUserAvatar(c *gin.Context) {
	data, ct, ok := s.readUpload(c)
	if !ok {
		return
	}
	u := auth.CurrentUser(c)
	key := prefix + "u/" + u.ID.String()
	if !s.put(c, key, data, ct) {
		return
	}
	row, err := s.q.UpdateUserAvatar(c.Request.Context(), db.UpdateUserAvatarParams{
		ID: u.ID, AvatarKey: pgtype.Text{String: key, Valid: true},
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": row.ID.String(), "email": row.Email, "name": row.Name, "avatar_url": "/api/files/" + key})
}

func (s *Service) handleAgentAvatar(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	role, err := s.q.AgentWorkspaceRole(c.Request.Context(), db.AgentWorkspaceRoleParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil || (role != "owner" && role != "admin") {
		httpx.Error(c, http.StatusForbidden, "forbidden", "owner or admin role required")
		return
	}
	data, ct, ok := s.readUpload(c)
	if !ok {
		return
	}
	key := prefix + "a/" + id.String()
	if !s.put(c, key, data, ct) {
		return
	}
	if _, err := s.q.UpdateAgentAvatar(c.Request.Context(), db.UpdateAgentAvatarParams{
		ID: id, AvatarKey: pgtype.Text{String: key, Valid: true},
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id.String(), "avatar_url": "/api/files/" + key})
}

// handleProjectIcon sets a project's image icon. Any workspace member may
// change it, matching PATCH /projects/:id.
func (s *Service) handleProjectIcon(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	role, err := s.q.ProjectWorkspaceRole(c.Request.Context(), db.ProjectWorkspaceRoleParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil || role == "" {
		httpx.Error(c, http.StatusNotFound, "not_found", "project not found")
		return
	}
	data, ct, ok := s.readUpload(c)
	if !ok {
		return
	}
	key := prefix + "p/" + id.String()
	if !s.put(c, key, data, ct) {
		return
	}
	if _, err := s.q.SetProjectAvatarKey(c.Request.Context(), db.SetProjectAvatarKeyParams{
		ID: id, AvatarKey: pgtype.Text{String: key, Valid: true},
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id.String(), "icon_url": "/api/files/" + key})
}

// handleProjectIconFromGithub adopts the first linked repo's GitHub owner
// avatar as the project icon — the Superset-style "use the org picture"
// path. github.com/<owner>.png redirects to the real avatar and works for
// orgs and users alike.
func (s *Service) handleProjectIconFromGithub(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	role, err := s.q.ProjectWorkspaceRole(c.Request.Context(), db.ProjectWorkspaceRoleParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil || role == "" {
		httpx.Error(c, http.StatusNotFound, "not_found", "project not found")
		return
	}
	if s.store == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "storage_disabled", "object storage is not configured")
		return
	}
	repos, err := s.q.ListProjectRepos(c.Request.Context(), id)
	if err != nil || len(repos) == 0 {
		httpx.Error(c, http.StatusBadRequest, "no_repo", "link a GitHub repository first")
		return
	}
	owner := repos[0].Owner
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet,
		"https://github.com/"+url.PathEscape(owner)+".png", nil)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		httpx.Error(c, http.StatusBadGateway, "github_error", "could not reach github.com")
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		httpx.Error(c, http.StatusBadGateway, "github_error", "github returned "+resp.Status)
		return
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil || int64(len(data)) > maxBytes {
		httpx.Error(c, http.StatusBadGateway, "github_error", "unreadable avatar response")
		return
	}
	ct, _, _ := strings.Cut(http.DetectContentType(data), ";")
	ct = strings.TrimSpace(ct)
	if !imageTypes[ct] {
		httpx.Error(c, http.StatusBadGateway, "github_error", "github did not return an image")
		return
	}
	key := prefix + "p/" + id.String()
	if !s.put(c, key, data, ct) {
		return
	}
	if _, err := s.q.SetProjectAvatarKey(c.Request.Context(), db.SetProjectAvatarKeyParams{
		ID: id, AvatarKey: pgtype.Text{String: key, Valid: true},
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id.String(), "icon_url": "/api/files/" + key})
}

// handleWorkspaceIcon sets the workspace's image icon; owner/admin only,
// same gate as agent avatars.
func (s *Service) handleWorkspaceIcon(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	role, err := s.q.GetWorkspaceRole(c.Request.Context(), db.GetWorkspaceRoleParams{
		WorkspaceID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil || (role != "owner" && role != "admin") {
		httpx.Error(c, http.StatusForbidden, "forbidden", "owner or admin role required")
		return
	}
	data, ct, ok := s.readUpload(c)
	if !ok {
		return
	}
	key := prefix + "w/" + id.String()
	if !s.put(c, key, data, ct) {
		return
	}
	if _, err := s.q.SetWorkspaceAvatarKey(c.Request.Context(), db.SetWorkspaceAvatarKeyParams{
		ID: id, AvatarKey: pgtype.Text{String: key, Valid: true},
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id.String(), "avatar_url": "/api/files/" + key})
}

// handleFile streams avatar objects only. Attachment keys stay behind
// their project-scoped download endpoint; anything outside the prefix is
// a 404 rather than an authorization puzzle. Streaming (not presign
// redirect) keeps avatars same-origin, which LAN/insecure origins require.
func (s *Service) handleFile(c *gin.Context) {
	if s.store == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "storage_disabled", "object storage is not configured")
		return
	}
	key := strings.TrimPrefix(c.Param("key"), "/")
	if !strings.HasPrefix(key, prefix) || strings.Contains(key, "..") {
		httpx.Error(c, http.StatusNotFound, "not_found", "file not found")
		return
	}
	obj, err := s.store.Get(c.Request.Context(), key)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "file not found")
		return
	}
	defer func() { _ = obj.Close() }()
	st, err := obj.Stat()
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "file not found")
		return
	}
	c.Header("Content-Type", st.ContentType)
	c.Header("Cache-Control", "private, max-age=300")
	if c.Query("download") != "" {
		name := path.Base(key)
		if ext := extensionFor(st.ContentType); ext != "" {
			name += ext
		}
		c.Header("Content-Disposition", "attachment; filename=\""+name+"\"")
	}
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, obj)
}
