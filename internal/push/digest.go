package push

// Digest mode: with users.digest_enabled on, Notify parks payloads in
// push_digests instead of delivering. A periodic sweep bundles each user's
// pending rows into one summary push. The preference endpoints live in
// the workspaces service; this file is the queue's consumer.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"go.uber.org/zap"
)

// DigestFlushInterval is how often parked notifications bundle up.
const DigestFlushInterval = 30 * time.Minute

// StartDigestSweep bundles pending digests until ctx ends.
func (s *Service) StartDigestSweep(ctx context.Context) {
	t := time.NewTicker(DigestFlushInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.flushDigests(ctx)
		}
	}
}

func (s *Service) flushDigests(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			s.log.Warn("digest sweep aborted")
		}
	}()
	rows, err := s.q.ListPendingDigests(ctx)
	if err != nil {
		s.log.Error("digest sweep failed", zap.Error(err))
		return
	}
	byUser := map[[16]byte][]db.PushDigest{}
	var order []db.PushDigest
	for _, r := range rows {
		if _, ok := byUser[r.UserID.Bytes]; !ok {
			order = append(order, r)
		}
		byUser[r.UserID.Bytes] = append(byUser[r.UserID.Bytes], r)
	}
	for _, u := range order {
		pend := byUser[u.UserID.Bytes]
		if len(pend) == 0 {
			continue
		}
		latest := pend[0]
		bodyText := fmt.Sprintf("%d notification", len(pend))
		if len(pend) != 1 {
			bodyText += "s"
		}
		bodyText += " — " + latest.Title
		if latest.Body != "" {
			bodyText += ": " + latest.Body
		}
		url := latest.Url
		if url == "" {
			url = "/app"
		}
		body, _ := json.Marshal(Payload{
			Title: "Relay digest",
			Body:  bodyText,
			URL:   url,
			Tag:   "digest-" + time.Now().UTC().Format("200601021504"),
		})
		s.deliver(ctx, u.UserID, body)
		if err := s.q.MarkDigestsFlushed(ctx, u.UserID); err != nil {
			s.log.Error("digest flush mark failed", zap.Error(err))
		}
	}
}

// handleGetDigest reports the caller's digest preference.
func (s *Service) handleGetDigest(c *gin.Context) {
	on, err := s.q.UserDigestEnabled(c.Request.Context(), auth.CurrentUser(c).ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"digest_enabled": on})
}

// SetDigest updates the caller's digest preference.
func (s *Service) SetDigest(c *gin.Context) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if _, err := s.q.SetUserDigest(c.Request.Context(), db.SetUserDigestParams{
		ID: auth.CurrentUser(c).ID, DigestEnabled: req.Enabled,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"digest_enabled": req.Enabled})
}
