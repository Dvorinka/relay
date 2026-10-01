package server

import (
	"net/http/httptest"
	"testing"

	"github.com/Dvorinka/relay/internal/config"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// The SPA fallback must not shadow /api routes; with no bundle present the
// router should 404 unknown paths cleanly.
func TestNoBundle_NoRoute404(t *testing.T) {
	t.Parallel()
	h := New(config.Config{StaticDir: t.TempDir()}, zap.NewNop(), &pgxpool.Pool{}, "test")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/nope", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
