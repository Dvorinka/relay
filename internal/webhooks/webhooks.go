// Package webhooks delivers project events to subscriber URLs. Each
// subscription picks event types (exact names or 'prefix.*' wildcards); the
// worker follows the events hub and POSTs an HMAC-signed JSON envelope.
//
// Signing: X-Relay-Signature-256 carries "sha256=" + HMAC-SHA256(body,
// subscription secret). Receivers verify with the secret shown at creation.
//
// SSRF note: subscription URLs are user-supplied and Relay is self-hosted -
// agents routinely live on localhost, so loopback is allowed. The
// subscription is only creatable by project workspace admins, and the
// response body is never read back, so the blast radius is a POST.
package webhooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// Events a subscription can select. The UI groups these by prefix.
var EventCatalog = []string{
	"message.created",
	"issue.created", "issue.updated",
	"todo.created", "todo.updated",
	"review.created", "review.responded",
	"attachment.created",
}

type Service struct {
	q    *db.Queries
	log  *zap.Logger
	pool *pgxpool.Pool
	hc   *http.Client
	// Bus republishes inbound-hook messages as message.created events so
	// open clients repaint immediately. Optional — nil-safe.
	Bus *events.Hub
	// publicURL is the deployment's external base — managed ("relay:managed")
	// subscriptions point at <publicURL>/api/webhooks/catch/<id>.
	publicURL string

	mu    sync.Mutex
	cache map[pgtype.UUID][]db.WebhookSubscription // project -> subs, short TTL
	exp   map[pgtype.UUID]time.Time
}

func NewService(log *zap.Logger, pool *pgxpool.Pool, publicURL string) *Service {
	return &Service{
		q: db.New(pool), log: log, pool: pool,
		hc:        &http.Client{Timeout: 10 * time.Second},
		publicURL: strings.TrimRight(publicURL, "/"),
		cache:     map[pgtype.UUID][]db.WebhookSubscription{},
		exp:       map[pgtype.UUID]time.Time{},
	}
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup, pub *gin.RouterGroup) {
	g.GET("/projects/:id/webhooks", s.projectGate, s.handleList)
	g.POST("/projects/:id/webhooks", s.projectAdmin, s.handleCreate)
	g.GET("/webhooks/:id", s.webhookGate, s.handleGet)
	g.PATCH("/webhooks/:id", s.webhookAdmin, s.handleUpdate)
	g.DELETE("/webhooks/:id", s.webhookAdmin, s.handleDelete)
	g.GET("/webhooks/:id/deliveries", s.webhookGate, s.handleDeliveries)
	g.POST("/webhooks/:id/test", s.webhookAdmin, s.handleTest)
	// The managed listener endpoint — Relay-hosted sink for generated
	// subscriptions. Unauthenticated; the delivery is already HMAC-signed,
	// and the id being an existing subscription is the gate.
	pub.POST("/webhooks/catch/:id", s.handleCatch)
	// Inbound hooks — token in the path is the credential. Management lives
	// under /inbound-hooks so the wildcard names never collide with
	// /hooks/:token in the same method tree.
	g.GET("/projects/:id/hooks", s.projectGate, s.handleHookList)
	g.POST("/projects/:id/hooks", s.projectAdmin, s.handleHookCreate)
	g.PATCH("/inbound-hooks/:id", s.hookAdmin, s.handleHookUpdate)
	g.POST("/inbound-hooks/:id/rotate", s.hookAdmin, s.handleHookRotate)
	g.DELETE("/inbound-hooks/:id", s.hookAdmin, s.handleHookDelete)
	pub.POST("/hooks/:token", s.handleInbound)
}

// handleCatch is the Relay-managed listener: verify the subscription id
// exists, accept the envelope, return 204. The dispatcher records the
// delivery as usual, so users see real signed deliveries in-app.
func (s *Service) handleCatch(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	if _, err := s.q.GetWebhookByID(c.Request.Context(), id); err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	c.Status(http.StatusNoContent)
}

// --- gates ---

func (s *Service) projectGate(c *gin.Context) {
	pid, ok := httpx.PathUUID(c, "id")
	if !ok {
		c.Abort()
		return
	}
	role, err := s.q.ProjectWorkspaceRole(c.Request.Context(), db.ProjectWorkspaceRoleParams{
		ID: pid, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil || role == "" {
		httpx.Error(c, http.StatusNotFound, "not_found", "project not found")
		c.Abort()
		return
	}
	c.Set("relay.project_id", pid)
	c.Set("relay.role", role)
	c.Next()
}

func (s *Service) projectAdmin(c *gin.Context) {
	s.projectGate(c)
	if c.IsAborted() {
		return
	}
	role, _ := c.Get("relay.role")
	if role != "owner" && role != "admin" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "workspace admin required")
		c.Abort()
		return
	}
	c.Next()
}

// webhookGate resolves :id -> subscription; requires membership on the
// subscription's workspace.
func (s *Service) webhookGate(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		c.Abort()
		return
	}
	row, err := s.q.GetWebhookForUser(c.Request.Context(), db.GetWebhookForUserParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil {
		if _, err2 := s.q.GetWebhookByID(c.Request.Context(), id); err2 == nil {
			httpx.Error(c, http.StatusForbidden, "forbidden", "not a member of this workspace")
		} else {
			httpx.Error(c, http.StatusNotFound, "not_found", "webhook not found")
		}
		c.Abort()
		return
	}
	c.Set("relay.webhook", row)
	c.Next()
}

func (s *Service) webhookAdmin(c *gin.Context) {
	s.webhookGate(c)
	if c.IsAborted() {
		return
	}
	row := c.MustGet("relay.webhook").(db.GetWebhookForUserRow)
	role, _ := s.userRole(c, row.WorkspaceID)
	if role != "owner" && role != "admin" {
		httpx.Error(c, http.StatusForbidden, "forbidden", "workspace admin required")
		c.Abort()
		return
	}
	c.Next()
}

func (s *Service) userRole(c *gin.Context, wsID pgtype.UUID) (string, bool) {
	var role string
	err := s.pool.QueryRow(c.Request.Context(),
		`select role from workspace_members where workspace_id=$1 and user_id=$2`,
		wsID, auth.CurrentUser(c).ID).Scan(&role)
	return role, err == nil
}

// --- REST handlers ---

type createReq struct {
	URL    string   `json:"url"`
	Events []string `json:"events"`
	Active *bool    `json:"active"`
	// RelayManaged creates a Relay-hosted listener instead of an external
	// URL — one click, deliveries land in the Deliveries panel.
	RelayManaged bool `json:"relay_managed"`
}

func validURL(u string) bool {
	if len(u) > 500 {
		return false
	}
	p, err := url.Parse(u)
	return err == nil && (p.Scheme == "https" || p.Scheme == "http") && p.Host != ""
}

func validEvents(list []string) bool {
	if len(list) == 0 || len(list) > 32 {
		return false
	}
	for _, e := range list {
		if e == "*" {
			continue
		}
		if strings.HasSuffix(e, ".*") {
			prefix := strings.TrimSuffix(e, ".*")
			for _, cat := range EventCatalog {
				if strings.HasPrefix(cat, prefix+".") {
					goto next
				}
			}
			return false
		}
		for _, cat := range EventCatalog {
			if e == cat {
				goto next
			}
		}
		return false
	next:
	}
	return true
}

func newSecret() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return "whsec_" + hex.EncodeToString(b)
}

func subJSON(r db.WebhookSubscription, revealSecret bool) gin.H {
	out := gin.H{
		"id": r.ID.String(), "project_id": r.ProjectID.String(),
		"url": r.Url, "events": r.Events, "active": r.Active,
		"created_at": r.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
	if revealSecret {
		out["secret"] = r.Secret
	}
	return out
}

func (s *Service) handleList(c *gin.Context) {
	rows, err := s.q.ListProjectWebhooks(c.Request.Context(), c.MustGet("relay.project_id").(pgtype.UUID))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	// secrets are shown only at creation; list view carries a hint
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		j := subJSON(r, false)
		j["secret_hint"] = "whsec_…" + r.Secret[len(r.Secret)-4:]
		out = append(out, j)
	}
	c.JSON(http.StatusOK, gin.H{"webhooks": out, "catalog": EventCatalog})
}

func (s *Service) handleCreate(c *gin.Context) {
	var req createReq
	if !httpx.BindJSON(c, &req) {
		return
	}
	if req.RelayManaged {
		if s.publicURL == "" {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "server has no public URL configured")
			return
		}
	} else if !validURL(req.URL) {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "url must be http(s) and <= 500 chars")
		return
	}
	if !validEvents(req.Events) {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "events must come from the catalog (exact names or prefix.*)")
		return
	}
	active := true
	if req.Active != nil {
		active = *req.Active
	}
	row, err := s.q.CreateWebhookSubscription(c.Request.Context(), db.CreateWebhookSubscriptionParams{
		ProjectID: c.MustGet("relay.project_id").(pgtype.UUID),
		Url:       req.URL,
		Secret:    newSecret(),
		Events:    req.Events,
		Active:    active,
		CreatedBy: auth.CurrentUser(c).ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if req.RelayManaged {
		// Point at the built-in catch endpoint now that the id exists. The
		// ?events= suffix is cosmetic — it makes the subscribed scopes visible
		// in the URL itself; the catch handler ignores the query.
		catchURL := s.publicURL + "/api/webhooks/catch/" + row.ID.String()
		if len(req.Events) > 0 {
			catchURL += "?events=" + url.QueryEscape(strings.Join(req.Events, ","))
		}
		row, err = s.q.UpdateWebhook(c.Request.Context(), db.UpdateWebhookParams{
			ID:  row.ID,
			Url: pgtype.Text{String: catchURL, Valid: true},
		})
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
	}
	out := subJSON(row, true)
	s.invalidate(row.ProjectID)
	c.JSON(http.StatusCreated, out)
}

func (s *Service) handleGet(c *gin.Context) {
	r := c.MustGet("relay.webhook").(db.GetWebhookForUserRow)
	j := subJSON(rowToSub(r), false)
	j["secret_hint"] = "whsec_…" + r.Secret[len(r.Secret)-4:]
	c.JSON(http.StatusOK, gin.H{"webhook": j})
}

func (s *Service) handleUpdate(c *gin.Context) {
	r := c.MustGet("relay.webhook").(db.GetWebhookForUserRow)
	var req createReq
	if !httpx.BindJSON(c, &req) {
		return
	}
	params := db.UpdateWebhookParams{ID: r.ID}
	if req.URL != "" {
		if !validURL(req.URL) {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "url must be http(s) and <= 500 chars")
			return
		}
		params.Url = pgtype.Text{String: req.URL, Valid: true}
	}
	if req.Events != nil {
		if !validEvents(req.Events) {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "events must come from the catalog")
			return
		}
		params.Events = req.Events
	}
	if req.Active != nil {
		params.Active = pgtype.Bool{Bool: *req.Active, Valid: true}
	}
	row, err := s.q.UpdateWebhook(c.Request.Context(), params)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.invalidate(r.ProjectID)
	c.JSON(http.StatusOK, gin.H{"webhook": subJSON(row, false)})
}

func (s *Service) handleDelete(c *gin.Context) {
	r := c.MustGet("relay.webhook").(db.GetWebhookForUserRow)
	if err := s.q.DeleteWebhook(c.Request.Context(), r.ID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.invalidate(r.ProjectID)
	c.Status(http.StatusNoContent)
}

func (s *Service) handleDeliveries(c *gin.Context) {
	r := c.MustGet("relay.webhook").(db.GetWebhookForUserRow)
	rows, err := s.q.ListWebhookDeliveries(c.Request.Context(), r.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, d := range rows {
		out = append(out, gin.H{
			"id": d.ID.String(), "delivery_id": d.DeliveryID.String(),
			"event_type": d.EventType, "status_code": d.StatusCode,
			"attempts": d.Attempts, "duration_ms": d.DurationMs,
			"success":    d.Success,
			"created_at": d.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	c.JSON(http.StatusOK, gin.H{"deliveries": out})
}

// handleTest fires a synthetic event through the real delivery path.
func (s *Service) handleTest(c *gin.Context) {
	r := c.MustGet("relay.webhook").(db.GetWebhookForUserRow)
	go s.deliver(rowToSub(r), "webhook.test", gin.H{"subscription_id": r.ID.String(), "note": "test delivery"})
	c.JSON(http.StatusAccepted, gin.H{"queued": true})
}

// --- delivery worker ---

// Start follows the events hub until ctx cancels. Called once from main.
func (s *Service) Start(ctx context.Context, hub *events.Hub) {
	subID, ch := hub.Subscribe()
	go func() {
		defer hub.Unsubscribe(subID)
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-ch:
				if !ok {
					return
				}
				s.dispatch(e)
			}
		}
	}()
}

func (s *Service) subsFor(ctx context.Context, projectID pgtype.UUID) []db.WebhookSubscription {
	s.mu.Lock()
	if subs, ok := s.cache[projectID]; ok && time.Now().Before(s.exp[projectID]) {
		s.mu.Unlock()
		return subs
	}
	s.mu.Unlock()
	subs, err := s.q.ActiveWebhooksForProject(ctx, projectID)
	if err != nil {
		s.log.Warn("webhook lookup failed", zap.Error(err))
		return nil
	}
	s.mu.Lock()
	s.cache[projectID] = subs
	s.exp[projectID] = time.Now().Add(10 * time.Second)
	s.mu.Unlock()
	return subs
}

func (s *Service) invalidate(projectID pgtype.UUID) {
	s.mu.Lock()
	delete(s.cache, projectID)
	delete(s.exp, projectID)
	s.mu.Unlock()
}

func matchEvent(patterns []string, typ string) bool {
	for _, p := range patterns {
		if p == "*" || p == typ {
			return true
		}
		if strings.HasSuffix(p, ".*") && strings.HasPrefix(typ, strings.TrimSuffix(p, "*")) {
			return true
		}
	}
	return false
}

func (s *Service) dispatch(e events.Event) {
	pid := pgtype.UUID{Bytes: e.ProjectID, Valid: true}
	for _, sub := range s.subsFor(context.Background(), pid) {
		if matchEvent(sub.Events, e.Type) {
			go s.deliver(sub, e.Type, e.Data)
		}
	}
}

type envelope struct {
	ID         string         `json:"id"`
	Type       string         `json:"type"`
	ProjectID  string         `json:"project_id"`
	OccurredAt string         `json:"occurred_at"`
	Data       map[string]any `json:"data,omitempty"`
}

// deliver posts the event to the subscriber: 3 attempts with 1s/5s backoff,
// then records a delivery row. Delivery bodies are never read back.
func (s *Service) deliver(sub db.WebhookSubscription, eventType string, data map[string]any) {
	deliveryID := uuid.New()
	env := envelope{
		ID: deliveryID.String(), Type: eventType,
		ProjectID:  sub.ProjectID.String(),
		OccurredAt: time.Now().UTC().Format(time.RFC3339),
		Data:       data,
	}
	body, err := json.Marshal(env)
	if err != nil {
		return
	}
	mac := hmac.New(sha256.New, []byte(sub.Secret))
	mac.Write(body)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	var status int
	var attempts int
	var success bool
	start := time.Now()
	for i, backoff := range []time.Duration{0, time.Second, 5 * time.Second} {
		attempts = i + 1
		if backoff > 0 {
			time.Sleep(backoff)
		}
		status, success = s.post(sub.Url, eventType, deliveryID.String(), sig, body)
		if success {
			break
		}
	}
	elapsed := time.Since(start).Milliseconds()

	if _, err := s.q.RecordWebhookDelivery(context.Background(), db.RecordWebhookDeliveryParams{
		SubscriptionID: sub.ID,
		EventType:      eventType,
		Payload:        body,
		StatusCode:     pgtype.Int4{Int32: int32(status), Valid: status != 0},
		Attempts:       int32(attempts),
		DurationMs:     int32(elapsed),
		Success:        success,
	}); err != nil {
		s.log.Warn("record delivery failed", zap.Error(err))
	}
	if !success {
		s.log.Warn("webhook delivery failed",
			zap.String("url", sub.Url), zap.String("event", eventType), zap.Int("status", status))
	}
	// jarvis: cheap bound on the deliveries table
	_ = s.q.TrimWebhookDeliveries(context.Background(), sub.ID)
}

func (s *Service) post(url, eventType, deliveryID, sig string, body []byte) (int, bool) {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Relay-Webhooks/1.0")
	req.Header.Set("X-Relay-Event", eventType)
	req.Header.Set("X-Relay-Delivery", deliveryID)
	req.Header.Set("X-Relay-Signature-256", sig)
	res, err := s.hc.Do(req)
	if err != nil {
		return 0, false
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1024))
	return res.StatusCode, res.StatusCode >= 200 && res.StatusCode < 300
}

// rowToSub adapts the joined GetWebhookForUserRow to WebhookSubscription.
func rowToSub(r db.GetWebhookForUserRow) db.WebhookSubscription {
	return db.WebhookSubscription{
		ID: r.ID, ProjectID: r.ProjectID, Url: r.Url, Secret: r.Secret,
		Events: r.Events, Active: r.Active, CreatedBy: r.CreatedBy,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}
