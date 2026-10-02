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
	"strings"

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

// handleFile streams avatar objects only. Attachment keys stay behind
// their project-scoped presign endpoint; anything outside the prefix is
// a 404 rather than an authorization puzzle.
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
	url, err := s.store.PresignGet(c.Request.Context(), key, "avatar", "image/png")
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "file not found")
		return
	}
	c.Redirect(http.StatusFound, url)
}
