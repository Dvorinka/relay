// Package auth implements Relay's email+password identity: argon2id
// hashing, opaque session cookies, password reset, and rate limiting.
package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/Dvorinka/relay/internal/config"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

const SessionCookie = "relay_session"

type Service struct {
	q      *db.Queries
	cfg    config.Config
	log    *zap.Logger
	mailer Mailer
}

func NewService(cfg config.Config, log *zap.Logger, pool *pgxpool.Pool, mailer Mailer) *Service {
	return &Service{q: db.New(pool), cfg: cfg, log: log, mailer: mailer}
}

func (s *Service) sessionTTL() time.Duration {
	return time.Duration(s.cfg.SessionTTLHours) * time.Hour
}

// Credentials is what the API returns from register/login/session.
type Credentials struct {
	User       db.GetUserByIDRow
	Workspaces []db.ListWorkspacesForUserRow
}

var ErrEmailTaken = errors.New("email already registered")

func (s *Service) Register(ctx context.Context, email, password, name, ip, ua string) (Credentials, string, error) {
	var creds Credentials
	email = strings.TrimSpace(strings.ToLower(email))
	name = strings.TrimSpace(name)
	if _, err := mail.ParseAddress(email); err != nil {
		return creds, "", errors.New("invalid email")
	}
	if len(password) < 10 {
		return creds, "", errors.New("password must be at least 10 characters")
	}
	if name == "" {
		return creds, "", errors.New("name is required")
	}

	hash, err := hashPassword(password)
	if err != nil {
		return creds, "", err
	}
	user, err := s.q.CreateUser(ctx, db.CreateUserParams{Email: email, PasswordHash: hash, Name: name})
	if err != nil {
		if isUniqueViolation(err) {
			return creds, "", ErrEmailTaken
		}
		return creds, "", err
	}

	// First-run workspace: every account gets one so the app is never empty.
	ws, err := s.q.CreateWorkspace(ctx, db.CreateWorkspaceParams{
		Name: name + "'s workspace",
		Slug: s.uniqueSlug(ctx, slugify(name)),
	})
	if err == nil {
		err = s.q.AddWorkspaceMember(ctx, db.AddWorkspaceMemberParams{
			WorkspaceID: ws.ID, UserID: user.ID, Role: "owner",
		})
	}
	if err != nil {
		return creds, "", err
	}

	token, err := s.createSession(ctx, user.ID, ip, ua)
	if err != nil {
		return creds, "", err
	}
	creds.User = db.GetUserByIDRow{ID: user.ID, Email: user.Email, Name: user.Name, CreatedAt: user.CreatedAt}
	creds.Workspaces, _ = s.q.ListWorkspacesForUser(ctx, user.ID)
	return creds, token, nil
}

var ErrBadCredentials = errors.New("invalid email or password")

func (s *Service) Login(ctx context.Context, email, password, ip, ua string) (Credentials, string, error) {
	var creds Credentials
	row, err := s.q.GetUserByEmail(ctx, strings.ToLower(strings.TrimSpace(email)))
	if err != nil {
		return creds, "", ErrBadCredentials
	}
	ok, err := verifyPassword(password, row.PasswordHash)
	if err != nil || !ok {
		return creds, "", ErrBadCredentials
	}
	token, err := s.createSession(ctx, row.ID, ip, ua)
	if err != nil {
		return creds, "", err
	}
	creds.User = db.GetUserByIDRow{ID: row.ID, Email: row.Email, Name: row.Name, AvatarKey: row.AvatarKey}
	creds.Workspaces, _ = s.q.ListWorkspacesForUser(ctx, row.ID)
	return creds, token, nil
}

// Session builds the Credentials payload for an already-authenticated user.
func (s *Service) Session(ctx context.Context, user db.GetUserByIDRow) (Credentials, error) {
	ws, err := s.q.ListWorkspacesForUser(ctx, user.ID)
	return Credentials{User: user, Workspaces: ws}, err
}

func (s *Service) createSession(ctx context.Context, userID pgtype.UUID, ip, ua string) (string, error) {
	raw, hash, err := newToken()
	if err != nil {
		return "", err
	}
	expires := pgtype.Timestamptz{Time: time.Now().Add(s.sessionTTL()), Valid: true}
	if _, err := s.q.CreateSession(ctx, db.CreateSessionParams{
		UserID: userID, TokenHash: hash, ExpiresAt: expires, Ip: ip, UserAgent: ua,
	}); err != nil {
		return "", err
	}
	return raw, nil
}

func (s *Service) Logout(ctx context.Context, rawToken string) error {
	return s.q.DeleteSession(ctx, hashToken(rawToken))
}

// ForgotPassword always succeeds from the caller's view - whether the email
// exists must not be observable.
func (s *Service) ForgotPassword(ctx context.Context, email string) error {
	row, err := s.q.GetUserByEmail(ctx, strings.ToLower(strings.TrimSpace(email)))
	if err != nil {
		return nil
	}
	raw, hash, err := newToken()
	if err != nil {
		return err
	}
	if err := s.q.CreatePasswordResetToken(ctx, db.CreatePasswordResetTokenParams{
		UserID: row.ID, TokenHash: hash,
	}); err != nil {
		return err
	}
	link := strings.TrimRight(s.cfg.PublicURL, "/") + "/reset?token=" + raw
	return s.mailer.Send(ctx, row.Email, "Reset your Relay password",
		"Open this link to set a new password (valid 1 hour):\n\n"+link)
}

func (s *Service) ResetPassword(ctx context.Context, token, password string) error {
	if len(password) < 10 {
		return errors.New("password must be at least 10 characters")
	}
	row, err := s.q.GetPasswordResetUser(ctx, hashToken(token))
	if err != nil {
		return errors.New("invalid or expired reset link")
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	if err := s.q.UpdateUserPassword(ctx, db.UpdateUserPasswordParams{ID: row.ID, PasswordHash: hash}); err != nil {
		return err
	}
	if err := s.q.UsePasswordResetToken(ctx, row.TokenID); err != nil {
		return err
	}
	// A reset implies compromise is possible: revoke every session.
	return s.q.DeleteAllSessions(ctx, row.ID)
}

// ChangePassword keeps the current session alive, revokes the rest.
func (s *Service) ChangePassword(ctx context.Context, userID pgtype.UUID, tokenHash, current, next string) error {
	if len(next) < 10 {
		return errors.New("password must be at least 10 characters")
	}
	user, err := s.q.GetUserByID(ctx, userID)
	if err != nil {
		return err
	}
	full, err := s.q.GetUserByEmail(ctx, user.Email)
	if err != nil {
		return err
	}
	ok, err := verifyPassword(current, full.PasswordHash)
	if err != nil {
		return err
	}
	if !ok {
		return ErrBadCredentials
	}
	hash, err := hashPassword(next)
	if err != nil {
		return err
	}
	if err := s.q.UpdateUserPassword(ctx, db.UpdateUserPasswordParams{ID: userID, PasswordHash: hash}); err != nil {
		return err
	}
	return s.q.DeleteOtherSessions(ctx, db.DeleteOtherSessionsParams{UserID: userID, TokenHash: tokenHash})
}

// --- helpers ---

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

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

func (s *Service) uniqueSlug(ctx context.Context, base string) string {
	for i := 0; i < 5; i++ {
		candidate := fmt.Sprintf("%s-%s", base, randSuffix())
		if exists, err := s.q.WorkspaceSlugExists(ctx, candidate); err == nil && !exists {
			return candidate
		}
	}
	return base + "-" + hex.EncodeToString(mustRand(8))
}

func randSuffix() string {
	return hex.EncodeToString(mustRand(3))
}

func mustRand(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}
