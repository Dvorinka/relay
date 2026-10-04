// Package attachments: file upload to S3-compatible storage and presigned
// download. Uploads are project-scoped; access follows workspace membership
// like every other project resource.
package attachments

import (
	"bytes"
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

// allowlist holds sniffed MIME types we accept. HTML/SVG are deliberately
// absent: stored files must stay inert when viewed.
var allowlist = map[string]bool{
	"image/png":       true,
	"image/jpeg":      true,
	"image/gif":       true,
	"image/webp":      true,
	"image/avif":      true,
	"image/bmp":       true,
	"image/x-icon":    true,
	"application/pdf": true,
	"text/plain":      true,
	"application/zip": true,
}

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
	contentType, ok := sniffType(data, declaredType)
	if !ok {
		httpx.Error(c, http.StatusBadRequest, "unsupported_type",
			"file type not allowed; images, pdf, text and zip are accepted")
		return
	}
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
	obj, err := s.store.Get(c.Request.Context(), a.StorageKey)
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
	if strings.HasPrefix(a.ContentType, "image/") {
		kind = "inline"
	}
	safe := strings.NewReplacer("\\", "_", "\"", "_").Replace(a.Filename)
	c.Header("Content-Type", a.ContentType)
	c.Header("Content-Disposition", kind+"; filename=\""+safe+"\"")
	c.Header("Cache-Control", "private, max-age=60")
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, obj)
}

// --- helpers ---

// sniffType returns the detected content type. When sniffing yields
// octet-stream the client's declared type is consulted instead; either way
// the result must be allowlisted.
func sniffType(data []byte, declared string) (string, bool) {
	sniffed := avatars.SniffImageType(data)
	ct, _, _ := strings.Cut(sniffed, ";")
	ct = strings.TrimSpace(ct)
	if ct == "application/octet-stream" && declared != "" {
		ct, _, _ = strings.Cut(declared, ";")
		ct = strings.TrimSpace(ct)
	}
	return ct, allowlist[ct]
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
	}
}
