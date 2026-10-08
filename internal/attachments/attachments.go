// Package attachments: file upload to S3-compatible storage and presigned
// download. Uploads are project-scoped; access follows workspace membership
// like every other project resource.
package attachments

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"strings"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/avatars"
	"github.com/Dvorinka/relay/internal/config"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/Dvorinka/relay/internal/storage"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// All file types are accepted for upload. Markup-capable types (HTML,
// SVG, XML, script) stay inert because both download paths serve them
// with Content-Disposition: attachment — see storage.InlineSafe.

type Service struct {
	q     *db.Queries
	store *storage.Store
	max   int64
	log   *zap.Logger
}

func NewService(log *zap.Logger, pool *pgxpool.Pool, store *storage.Store, cfg config.Config) *Service {
	return &Service{q: db.New(pool), store: store, max: cfg.StorageMaxUploadMiB << 20, log: log}
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.POST("/projects/:id/attachments", s.projectMemberOnly, s.handleUpload)
	g.GET("/projects/:id/attachments/:attachmentId/url", s.projectMemberOnly, s.handleURL)
	g.GET("/projects/:id/attachments/:attachmentId/download", s.projectMemberOnly, s.handleDownload)
}

// RegisterAgentRoutes mounts the bearer-token download endpoint for MCP
// agents. It resolves rly_ tokens itself — session auth never touches it.
// get_attachment hands this path back as download_url so agents can fetch
// bytes straight to disk instead of decoding base64 out of a tool result.
func (s *Service) RegisterAgentRoutes(g *gin.RouterGroup) {
	g.GET("/agent/attachments/:id/download", s.handleAgentDownload)
}

// --- access gate ---

const ctxProject = "relay.project"

// projectMemberOnly confirms the caller belongs to the project's workspace.
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
	c.Set(ctxProject, p)
	c.Next()
}

// --- handlers ---

func (s *Service) handleUpload(c *gin.Context) {
	if s.store == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "storage_disabled", "object storage is not configured")
		return
	}
	p := c.MustGet(ctxProject).(db.GetProjectForUserRow)

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, s.max+s.max/2)
	var data []byte
	var filename, declaredType string
	if strings.HasPrefix(c.GetHeader("Content-Type"), "application/json") {
		// Base64 JSON transport — the desktop app's WebKitGTK webview can
		// drop multipart bodies, so its upload bridge sends the file this
		// way instead.
		var req struct {
			Name string `json:"name"`
			Data string `json:"data"`
		}
		if err := json.NewDecoder(c.Request.Body).Decode(&req); err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		d, err := base64.StdEncoding.DecodeString(req.Data)
		if err != nil || int64(len(d)) > s.max {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "too_large", "file exceeds the upload size cap")
			return
		}
		data, filename = d, req.Name
	} else {
		fh, err := c.FormFile("file")
		if err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				httpx.Error(c, http.StatusRequestEntityTooLarge, "too_large", "file exceeds the upload size cap")
				return
			}
			httpx.Error(c, http.StatusBadRequest, "bad_request", "multipart field \"file\" required")
			return
		}
		if fh.Size > s.max {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "too_large", "file exceeds the upload size cap")
			return
		}
		f, err := fh.Open()
		if err != nil {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "unreadable file")
			return
		}
		defer func() { _ = f.Close() }()

		data, err = io.ReadAll(io.LimitReader(f, s.max+1))
		if err != nil || int64(len(data)) > s.max {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "too_large", "file exceeds the upload size cap")
			return
		}
		filename, declaredType = fh.Filename, fh.Header.Get("Content-Type")
	}
	contentType := SniffType(data, declaredType)
	filename = path.Base(filename)
	if filename == "." || filename == "/" || filename == "" {
		filename = "file"
	}

	id := uuid.New()
	key := p.ID.String() + "/" + id.String()
	if err := s.store.Put(c.Request.Context(), key, bytes.NewReader(data), int64(len(data)), contentType); err != nil {
		s.log.Error("storage put failed", zap.Error(err))
		httpx.Error(c, http.StatusInternalServerError, "internal", "upload failed")
		return
	}

	row, err := s.q.CreateAttachment(c.Request.Context(), db.CreateAttachmentParams{
		ID:        pgtype.UUID{Bytes: id, Valid: true},
		ProjectID: p.ID, UploaderID: auth.CurrentUser(c).ID,
		StorageKey: key, Filename: filename,
		ContentType: contentType, SizeBytes: int64(len(data)),
	})
	if err != nil {
		_ = s.store.Remove(c.Request.Context(), key)
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	row, err = s.q.MarkAttachmentReady(c.Request.Context(), row.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusCreated, JSON(row))
}

func (s *Service) handleURL(c *gin.Context) {
	if s.store == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "storage_disabled", "object storage is not configured")
		return
	}
	p := c.MustGet(ctxProject).(db.GetProjectForUserRow)
	aid, ok := httpx.PathUUID(c, "attachmentId")
	if !ok {
		return
	}
	a, err := s.q.GetAttachmentInProjectForUser(c.Request.Context(), db.GetAttachmentInProjectForUserParams{
		ID: aid, ProjectID: p.ID, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "attachment not found")
		return
	}
	url, err := s.store.PresignGet(c.Request.Context(), a.StorageKey, a.Filename, a.ContentType)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.Redirect(http.StatusFound, url)
}

// handleDownload streams the object through the API. Same-origin, so it
// works wherever the app is browsed from - unlike the presigned URL, which
// requires the client to reach the storage host directly.
func (s *Service) handleDownload(c *gin.Context) {
	if s.store == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "storage_disabled", "object storage is not configured")
		return
	}
	p := c.MustGet(ctxProject).(db.GetProjectForUserRow)
	aid, ok := httpx.PathUUID(c, "attachmentId")
	if !ok {
		return
	}
	a, err := s.q.GetAttachmentInProjectForUser(c.Request.Context(), db.GetAttachmentInProjectForUserParams{
		ID: aid, ProjectID: p.ID, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "attachment not found")
		return
	}
	s.streamObject(c, a.StorageKey, a.Filename, a.ContentType)
}

// handleAgentDownload streams an attachment to an MCP agent. Bearer rly_
// token (Authorization header or access_token query — EventSource-style
// clients cannot set headers), then the attachment:read scope on the
// attachment's project. Same origin as /mcp, so it works wherever the
// agent's transport works — unlike presigned storage URLs.
func (s *Service) handleAgentDownload(c *gin.Context) {
	// Authenticate before the storage check — an unauthenticated caller
	// shouldn't learn whether storage is configured.
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
	ag, err := s.q.GetTokenAgent(c.Request.Context(), sum[:])
	if err != nil {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or revoked token")
		return
	}
	aid, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	ctx := c.Request.Context()
	pid, err := s.q.ResolveAttachmentProject(ctx, aid)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "attachment not found")
		return
	}
	scopes, err := s.q.AgentScopeForProject(ctx, db.AgentScopeForProjectParams{
		ProjectID: pid, AgentID: ag.ID,
	})
	has := false
	for _, sc := range scopes {
		if sc == "attachment:read" {
			has = true
		}
	}
	if err != nil || !has {
		httpx.Error(c, http.StatusForbidden, "forbidden", "missing scope: attachment:read")
		return
	}
	a, err := s.q.GetAttachmentByID(ctx, aid)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "attachment not found")
		return
	}
	if s.store == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "storage_disabled", "object storage is not configured")
		return
	}
	s.streamObject(c, a.StorageKey, a.Filename, a.ContentType)
}

// streamObject serves one stored object with a download disposition — or
// inline for inert raster images — shared by the session and agent routes.
func (s *Service) streamObject(c *gin.Context, key, filename, contentType string) {
	obj, err := s.store.Get(c.Request.Context(), key)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	defer func() { _ = obj.Close() }()
	if _, err := obj.Stat(); err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "file missing from storage")
		return
	}
	kind := "attachment"
	if storage.InlineSafe(contentType) {
		kind = "inline"
	}
	safe := strings.NewReplacer("\\", "_", "\"", "_").Replace(filename)
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", kind+"; filename=\""+safe+"\"")
	c.Header("Cache-Control", "private, max-age=60")
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, obj)
}

// --- helpers ---

// SniffType resolves the effective content type for an upload: the
// detected type wins, falling back to the declared one. Every type is
// accepted; active markup (HTML/SVG) is kept inert by attachment
// disposition on both download paths. Exported for the MCP upload path.
func SniffType(data []byte, declared string) string {
	sniffed := avatars.SniffImageType(data)
	ct, _, _ := strings.Cut(sniffed, ";")
	ct = strings.TrimSpace(ct)
	if ct == "application/octet-stream" && declared != "" {
		ct, _, _ = strings.Cut(declared, ";")
		ct = strings.TrimSpace(ct)
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	return ct
}

// SweepOrphans deletes staged uploads that never linked to a message — an
// abandoned draft leaves both a row and a storage object. Rows older than a
// day with no message_attachments entry are fair game; storage is removed
// first so a failed delete doesn't orphan the object invisibly.
func (s *Service) SweepOrphans(ctx context.Context) {
	rows, err := s.q.ListOrphanAttachments(ctx)
	if err != nil {
		s.log.Warn("attachment sweep failed", zap.Error(err))
		return
	}
	for _, r := range rows {
		if err := s.store.Remove(ctx, r.StorageKey); err != nil {
			s.log.Warn("attachment sweep storage remove", zap.String("key", r.StorageKey), zap.Error(err))
			continue // keep the row — retry next cycle
		}
		_ = s.q.DeleteAttachment(ctx, r.ID)
	}
	if len(rows) > 0 {
		s.log.Info("swept orphan attachments", zap.Int("count", len(rows)))
	}
}

// JSON renders one attachment for the API.
func JSON(a db.Attachment) gin.H {
	return gin.H{
		"id":           a.ID.String(),
		"project_id":   a.ProjectID.String(),
		"filename":     a.Filename,
		"content_type": a.ContentType,
		"size_bytes":   a.SizeBytes,
		"created_at":   a.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		// bearer-authenticated fetch — works anywhere the rly_ token does
		"download_url": "/api/agent/attachments/" + a.ID.String() + "/download",
	}
}
