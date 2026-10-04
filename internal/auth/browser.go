// Browser sign-in flow for the desktop shell: the app mints a code, opens
// {server}/connect?code=... in the system browser, and polls until a
// signed-in user approves it. Approval yields a fresh session token.
package auth

import (
	"encoding/hex"
	"net/http"
	"sync"
	"time"

	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
)

// browserAuthTTL bounds how long a pending code can be approved/polled.
const browserAuthTTL = 10 * time.Minute

// browserAuth is one pending sign-in; token is set when a signed-in user
// approves the code. Consumed on first successful poll.
type browserAuth struct {
	createdAt time.Time
	token     string
}

// browserAuthStore lives in-memory: codes are single-use, expire quickly,
// and restarting the server simply aborts pending sign-ins.
type browserAuthStore struct {
	mu      sync.Mutex
	pending map[string]*browserAuth
}

func newBrowserAuthStore() *browserAuthStore {
	return &browserAuthStore{pending: map[string]*browserAuth{}}
}

// sweep drops expired entries; called on every mutation/read attempt.
func (s *browserAuthStore) sweep() {
	cut := time.Now().Add(-browserAuthTTL)
	for code, req := range s.pending {
		if req.createdAt.Before(cut) {
			delete(s.pending, code)
		}
	}
}

// start registers a fresh pending code.
func (s *browserAuthStore) start(code string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweep()
	s.pending[code] = &browserAuth{createdAt: time.Now()}
}

// approve parks the session token on a live pending code; false when the
// code is unknown or expired.
func (s *browserAuthStore) approve(code, token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweep()
	req, ok := s.pending[code]
	if ok {
		req.token = token
	}
	return ok
}

// poll reports the code's state. An approved code yields its token exactly
// once — the entry is deleted on the first successful read.
func (s *browserAuthStore) poll(code string) (token string, known bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweep()
	req, ok := s.pending[code]
	if !ok {
		return "", false
	}
	if req.token == "" {
		return "", true
	}
	delete(s.pending, code)
	return req.token, true
}

func (s *Service) handleBrowserStart(c *gin.Context) {
	code := hex.EncodeToString(mustRand(10))
	s.browserAuth.start(code)
	c.JSON(http.StatusCreated, gin.H{"code": code, "expires_in": int(browserAuthTTL.Seconds())})
}

// handleBrowserApprove is session-authed: the signed-in browser confirms the
// code and a session token is parked for the desktop poll to pick up.
func (s *Service) handleBrowserApprove(c *gin.Context) {
	var req struct {
		Code string `json:"code" binding:"required"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	s.browserAuth.mu.Lock()
	s.browserAuth.sweep()
	_, ok := s.browserAuth.pending[req.Code]
	s.browserAuth.mu.Unlock()
	if !ok {
		httpx.Error(c, http.StatusNotFound, "not_found", "code expired or unknown")
		return
	}
	token, err := s.createSession(c.Request.Context(), CurrentUser(c).ID, c.ClientIP(), c.Request.UserAgent())
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if !s.browserAuth.approve(req.Code, token) {
		httpx.Error(c, http.StatusNotFound, "not_found", "code expired or unknown")
		return
	}
	c.Status(http.StatusNoContent)
}

// handleBrowserPoll hands the parked token to the desktop shell once, then
// forgets the code entirely.
func (s *Service) handleBrowserPoll(c *gin.Context) {
	token, known := s.browserAuth.poll(c.Query("code"))
	if !known {
		httpx.Error(c, http.StatusNotFound, "not_found", "code expired or unknown")
		return
	}
	if token == "" {
		c.JSON(http.StatusOK, gin.H{"status": "pending"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "approved", "token": token})
}
