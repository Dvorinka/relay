// Package mail picks the transactional mailer for a deployment: Resend's
// HTTPS API when RESEND_API_KEY is set (the hosted free tier — no SMTP
// relay needed), plain SMTP when SMTP_HOST is set (self-hosters), and the
// log mailer otherwise so dev keeps printing reset links.
package mail

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/smtp"
	"time"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/config"
	"go.uber.org/zap"
)

// New resolves the mailer from config. Order matters: Resend wins when both
// are set — the hosted instance sets only RESEND_API_KEY.
func New(cfg config.Config, log *zap.Logger) auth.Mailer {
	if cfg.ResendAPIKey != "" {
		return resend{key: cfg.ResendAPIKey, from: cfg.ResendFrom, log: log}
	}
	if cfg.SMTPHost != "" {
		return smtpMailer{cfg: cfg, log: log}
	}
	return auth.NewLogMailer(log)
}

// --- Resend (api.resend.com) ---

type resend struct {
	key, from string
	log       *zap.Logger
}

func (m resend) Send(ctx context.Context, to, subject, body string) error {
	payload, err := json.Marshal(map[string]any{
		"from":    m.from,
		"to":      []string{to},
		"subject": subject,
		"text":    body,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.resend.com/emails", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+m.key)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		m.log.Warn("resend send failed", zap.Int("status", res.StatusCode), zap.String("body", string(b)))
		return fmt.Errorf("resend: %s", res.Status)
	}
	return nil
}

// --- env SMTP (self-hosters) ---

type smtpMailer struct {
	cfg config.Config
	log *zap.Logger
}

func (m smtpMailer) Send(ctx context.Context, to, subject, body string) error {
	addr := net.JoinHostPort(m.cfg.SMTPHost, m.cfg.SMTPPort)
	dialer := net.Dialer{Timeout: 10 * time.Second}
	var conn net.Conn
	var err error
	if m.cfg.SMTPPort == "465" {
		conn, err = tls.DialWithDialer(&dialer, "tcp", addr,
			&tls.Config{ServerName: m.cfg.SMTPHost}) //nolint:gosec // host-pinned
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return err
	}
	// Bound the whole SMTP conversation — a dead relay must never hang a
	// request handler.
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	client, err := smtp.NewClient(conn, m.cfg.SMTPHost)
	if err != nil {
		_ = conn.Close()
		return err
	}
	defer func() { _ = client.Close() }()
	if ok, _ := client.Extension("STARTTLS"); ok && m.cfg.SMTPPort != "465" {
		if err := client.StartTLS(&tls.Config{ServerName: m.cfg.SMTPHost}); err != nil { //nolint:gosec
			return err
		}
	}
	if m.cfg.SMTPUser != "" {
		if err := client.Auth(smtp.PlainAuth("", m.cfg.SMTPUser,
			m.cfg.SMTPPass, m.cfg.SMTPHost)); err != nil {
			return err
		}
	}
	if err := client.Mail(m.cfg.SMTPFrom); err != nil {
		return err
	}
	if err := client.Rcpt(to); err != nil {
		return err
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	msg := "From: " + m.cfg.SMTPFrom + "\r\nTo: " + to +
		"\r\nSubject: " + subject + "\r\n\r\n" + body
	if _, err := w.Write([]byte(msg)); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return client.Quit()
}
