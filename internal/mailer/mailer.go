// Package mailer sends transactional email over SMTP and emails a
// channel's alert list on new messages. Configuration comes from the
// in-app smtp_settings row first, SMTP_* env vars as the fallback —
// no config at all means the log mailer stays in place.
package mailer

import (
	"context"
	"crypto/tls"
	"fmt"
	"mime"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/config"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/Dvorinka/relay/internal/secrets"
)

type Service struct {
	log    *zap.Logger
	pool   *pgxpool.Pool
	q      *db.Queries
	secret string
	pub    string
	cfg    smtpConfig // env fallback, resolved once at boot
}

type smtpConfig struct {
	host, port         string
	username, password string
	fromAddr, fromName string
	source             string // "db" | "env"
}

func NewService(cfg config.Config, log *zap.Logger, pool *pgxpool.Pool) *Service {
	return &Service{
		log:    log,
		pool:   pool,
		q:      db.New(pool),
		secret: cfg.AuthSecret,
		pub:    strings.TrimRight(cfg.PublicURL, "/"),
		cfg: smtpConfig{
			host:     os.Getenv("SMTP_HOST"),
			port:     getEnv("SMTP_PORT", "587"),
			username: os.Getenv("SMTP_USER"),
			password: os.Getenv("SMTP_PASS"),
			fromAddr: getEnv("SMTP_FROM", os.Getenv("SMTP_USER")),
			fromName: os.Getenv("SMTP_FROM_NAME"),
			source:   "env",
		},
	}
}

func getEnv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func (s *Service) RegisterRoutes(priv *gin.RouterGroup) {
	g := priv.Group("/settings/smtp", s.adminOnly)
	g.GET("", s.handleGetSMTP)
	g.PUT("", s.handlePutSMTP)
	g.POST("/test", s.handleTestSMTP)
}

// Send satisfies auth.Mailer: real SMTP when configured, a log line
// otherwise — the auth flows (magic links) work either way.
func (s *Service) Send(ctx context.Context, to, subject, body string) error {
	cfg, ok := s.resolve(ctx)
	if !ok {
		s.log.Info("mail (log mailer)", zap.String("to", to),
			zap.String("subject", subject), zap.String("body", body))
		return nil
	}
	return s.send(ctx, cfg, []string{to}, subject, body)
}

func (s *Service) adminOnly(c *gin.Context) {
	uid := auth.CurrentUser(c).ID
	var ok bool
	// smtp_settings is a deployment-global singleton (one row, no
	// workspace column), so management requires *owner* of the FIRST
	// workspace — the deployment operator's. An owner of any other
	// workspace must not read or rotate the shared relay credentials;
	// on a multi-user instance every registrant owns their own
	// workspace. Matches the trust model documented in the OpenAPI
	// for /settings/smtp.
	err := s.pool.QueryRow(c.Request.Context(),
		`select exists(select 1 from workspace_members wm
			where wm.user_id=$1 and wm.role='owner'
			  and wm.workspace_id = (select id from workspaces order by created_at limit 1))`,
		uid).Scan(&ok)
	if err != nil || !ok {
		httpx.Error(c, http.StatusForbidden, "forbidden", "workspace owner required")
		c.Abort()
		return
	}
	c.Next()
}

// headerSafe strips CR/LF so user-controlled names (author display
// names, from_name) can never inject mail headers at compose time.
func headerSafe(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' {
			return -1
		}
		return r
	}, s)
}

// resolve reads the DB row first, falling back to env. The second return
// reports whether any usable config exists at all.
func (s *Service) resolve(ctx context.Context) (smtpConfig, bool) {
	row, err := s.q.GetSMTPSettings(ctx)
	if err == nil && row.Host != "" && row.Enabled {
		cfg := smtpConfig{
			host: row.Host, port: strconv.Itoa(int(row.Port)),
			username: row.Username, fromAddr: row.FromAddr,
			fromName: row.FromName, source: "db",
		}
		if len(row.PasswordEnc) > 0 {
			if p, err := secrets.Open(row.PasswordEnc, s.authSecret()); err == nil {
				cfg.password = string(p)
			} else {
				s.log.Warn("stored smtp password undecryptable — AUTH_SECRET rotated?", zap.Error(err))
			}
		}
		return cfg, true
	}
	if s.cfg.host != "" {
		return s.cfg, true
	}
	return smtpConfig{}, false
}

func (s *Service) authSecret() string { return s.secret }

func (s *Service) handleGetSMTP(c *gin.Context) {
	cfg, ok := s.resolve(c.Request.Context())
	if !ok {
		c.JSON(http.StatusOK, gin.H{"smtp": gin.H{"configured": false}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"smtp": gin.H{
		"configured":   true,
		"source":       cfg.source,
		"host":         cfg.host,
		"port":         cfg.port,
		"username":     cfg.username,
		"from_address": cfg.fromAddr,
		"from_name":    cfg.fromName,
		"has_password": cfg.password != "",
	}})
}

func (s *Service) handlePutSMTP(c *gin.Context) {
	var req struct {
		Host        string `json:"host"`
		Port        int    `json:"port"`
		Username    string `json:"username"`
		Password    string `json:"password"`
		FromAddress string `json:"from_address"`
		FromName    string `json:"from_name"`
		Enabled     *bool  `json:"enabled"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	req.Host = strings.TrimSpace(req.Host)
	req.FromAddress = strings.TrimSpace(req.FromAddress)
	if req.Host == "" || req.Port <= 0 || req.FromAddress == "" {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "host, port and from_address are required")
		return
	}
	if _, err := mail.ParseAddress(req.FromAddress); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "from_address is not a valid email")
		return
	}
	if strings.ContainsAny(req.FromName, "\r\n") {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "from_name must not contain line breaks")
		return
	}
	var pwEnc []byte
	if req.Password != "" {
		var err error
		if pwEnc, err = secrets.Seal([]byte(req.Password), s.authSecret()); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	row, err := s.q.UpsertSMTPSettings(c.Request.Context(), db.UpsertSMTPSettingsParams{
		Host: req.Host, Port: int32(req.Port), Username: req.Username,
		PasswordEnc: pwEnc, FromAddr: req.FromAddress,
		FromName: req.FromName, Enabled: enabled,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.log.Info("smtp settings updated", zap.String("host", row.Host), zap.Int("port", int(row.Port)))
	c.JSON(http.StatusOK, gin.H{"smtp": gin.H{"configured": true, "source": "db"}})
}

func (s *Service) handleTestSMTP(c *gin.Context) {
	var req struct {
		To string `json:"to"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	to := strings.TrimSpace(req.To)
	if _, err := mail.ParseAddress(to); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "valid 'to' address required")
		return
	}
	cfg, ok := s.resolve(c.Request.Context())
	if !ok {
		httpx.Error(c, http.StatusBadRequest, "not_configured", "configure SMTP first — in-app or SMTP_* env")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	if err := s.send(ctx, cfg, []string{to},
		"Relay SMTP test",
		"This is a test email from your Relay server.\n\n"+s.pub); err != nil {
		s.log.Warn("smtp test failed", zap.Error(err))
		httpx.Error(c, http.StatusBadGateway, "smtp_error", err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"sent": true})
}

// Start subscribes to the event hub and emails each channel's alert list
// on new messages. Silent/system posts never mail.
func (s *Service) Start(ctx context.Context, hub *events.Hub) {
	_, ch := hub.Subscribe()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-ch:
				if !ok {
					return
				}
				if e.Type == "message.created" {
					s.notify(e)
				}
			}
		}
	}()
}

func (s *Service) notify(e events.Event) {
	convID, _ := e.Data["conversation_id"].(string)
	msg, _ := e.Data["message"].(map[string]any)
	if convID == "" || msg == nil {
		return
	}
	if silent, _ := msg["silent"].(bool); silent {
		return
	}
	cid, err := uuid.Parse(convID)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conv, err := s.q.GetConversationByID(ctx, pgtype.UUID{Bytes: cid, Valid: true})
	if err != nil || len(conv.EmailAlerts) == 0 {
		return
	}
	cfg, ok := s.resolve(ctx)
	if !ok {
		return
	}
	author, _ := msg["author"].(map[string]any)
	name, _ := author["name"].(string)
	if name == "" {
		name = "someone"
	}
	chanName := conv.Title.String
	if chanName == "" {
		chanName = "project chat"
	}
	body, _ := msg["body"].(string)
	const previewRunes = 800
	if n := len([]rune(body)); n > previewRunes {
		body = string([]rune(body)[:previewRunes]) + "…"
	}
	link := s.pub + "/app/p/" + e.ProjectID.String()
	switch conv.Kind {
	case "channel":
		link += "/c/" + convID
	case "thread":
		link += "?thread=" + convID
	}
	subject := fmt.Sprintf("[Relay] #%s — %s", chanName, name)
	text := fmt.Sprintf("%s wrote in #%s:\n\n%s\n\nOpen in Relay: %s",
		name, chanName, body, link)
	if err := s.send(ctx, cfg, conv.EmailAlerts, subject, text); err != nil {
		s.log.Warn("channel alert mail failed", zap.String("channel", chanName), zap.Error(err))
	}
}

// send delivers one plain-text mail. Port 465 implies implicit TLS;
// everything else goes STARTTLS, which is *required* whenever SMTP
// credentials are configured — a relay that strips the STARTTLS
// advertisement fails closed instead of leaking the password.
func (s *Service) send(ctx context.Context, cfg smtpConfig, to []string, subject, body string) error {
	addr := cfg.host + ":" + cfg.port
	from := cfg.fromAddr
	if cfg.fromName != "" {
		from = fmt.Sprintf("%s <%s>", mime.QEncoding.Encode("utf-8", headerSafe(cfg.fromName)), cfg.fromAddr)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\nTo: %s\r\nSubject: %s\r\n", from,
		strings.Join(to, ", "), mime.QEncoding.Encode("utf-8", headerSafe(subject)))
	b.WriteString("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n")
	b.WriteString(body)
	raw := []byte(b.String())

	// Bounded dial and conversation: a dead or stalling relay must not
	// hang the caller (or the channel-alert goroutine).
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	var conn net.Conn
	var err error
	if cfg.port == "465" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr,
			&tls.Config{ServerName: cfg.host, MinVersion: tls.VersionTLS12})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	client, err := smtp.NewClient(conn, cfg.host)
	if err != nil {
		_ = conn.Close()
		return err
	}
	defer func() { _ = client.Close() }()
	if cfg.port != "465" {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: cfg.host, MinVersion: tls.VersionTLS12}); err != nil {
				return err
			}
		} else if cfg.username != "" {
			return fmt.Errorf("smtp STARTTLS not offered — refusing to send credentials in cleartext")
		}
	}
	if cfg.username != "" {
		if err := client.Auth(smtp.PlainAuth("", cfg.username, cfg.password, cfg.host)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := client.Mail(cfg.fromAddr); err != nil {
		return err
	}
	for _, rcpt := range to {
		if err := client.Rcpt(rcpt); err != nil {
			return err
		}
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(raw); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return client.Quit()
}
