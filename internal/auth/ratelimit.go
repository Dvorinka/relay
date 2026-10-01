package auth

import (
	"net/http"
	"strconv"

	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// RateLimit returns middleware enforcing a Postgres fixed-window counter:
// `limit` hits per `windowSecs` per key (bucket name + client IP).
// ponytail: fixed window, per-account exponential backoff if abuse shows up.
func (s *Service) RateLimit(name string, limit, windowSecs int) gin.HandlerFunc {
	return func(c *gin.Context) {
		key := name + ":" + c.ClientIP()
		count, err := s.q.RateLimitHit(c.Request.Context(), db.RateLimitHitParams{
			Key:        key,
			WindowSecs: int32(windowSecs),
		})
		if err != nil {
			s.log.Error("rate limit check failed", zap.Error(err))
			c.Next() // limiter failure must not take auth down
			return
		}
		if count > int32(limit) {
			c.Header("Retry-After", strconv.Itoa(windowSecs))
			httpx.Error(c, http.StatusTooManyRequests, "rate_limited", "too many attempts, try again later")
			return
		}
		c.Next()
	}
}
