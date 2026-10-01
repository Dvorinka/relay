package auth

import (
	"net/http"
	"time"

	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
)

const (
	ctxUser      = "relay.user"
	ctxTokenHash = "relay.token_hash"
)

// RequireAuth resolves the session cookie to a user and rejects misses.
// Sliding expiry: the session row is touched at most once per 5 minutes.
func (s *Service) RequireAuth(c *gin.Context) {
	raw, err := c.Cookie(SessionCookie)
	if err != nil || raw == "" {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	hash := hashToken(raw)
	row, err := s.q.GetSessionUser(c.Request.Context(), hash)
	if err != nil {
		s.clearCookie(c)
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "session expired")
		return
	}
	if time.Since(row.LastSeenAt.Time) > 5*time.Minute {
		_ = s.q.TouchSession(c.Request.Context(), db.TouchSessionParams{
			TokenHash: hash, TtlSecs: int32(s.sessionTTL().Seconds()),
		})
	}
	c.Set(ctxUser, db.GetUserByIDRow{
		ID: row.ID, Email: row.Email, Name: row.Name,
		AvatarKey: row.AvatarKey, CreatedAt: row.CreatedAt,
	})
	c.Set(ctxTokenHash, hash)
	c.Next()
}

// CurrentUser is the middleware's output - handlers call this, never the DB.
func CurrentUser(c *gin.Context) db.GetUserByIDRow {
	v, _ := c.Get(ctxUser)
	u, _ := v.(db.GetUserByIDRow)
	return u
}

func (s *Service) setCookie(c *gin.Context, rawToken string) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     SessionCookie,
		Value:    rawToken,
		Path:     "/",
		MaxAge:   int(s.sessionTTL().Seconds()),
		HttpOnly: true,
		Secure:   !s.cfg.InsecureDev,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Service) clearCookie(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     SessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   !s.cfg.InsecureDev,
		SameSite: http.SameSiteLaxMode,
	})
}
