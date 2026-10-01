package mcpserver

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestHasScope(t *testing.T) {
	granted := []string{"project:read", "message:read"}
	if !hasScope(granted, "message:read") {
		t.Fatal("granted scope rejected")
	}
	if hasScope(granted, "issue:write") {
		t.Fatal("ungated scope allowed")
	}
	if hasScope(nil, "project:read") {
		t.Fatal("nil grant allowed")
	}
}

func TestRateLimitWindow(t *testing.T) {
	s := &Service{
		windows: map[[16]byte]time.Time{},
		counts:  map[[16]byte]int{},
	}
	var id pgtype.UUID
	id.Bytes[15] = 1
	id.Valid = true
	for i := 0; i < requestsPerMinute; i++ {
		if !s.allow(id) {
			t.Fatalf("request %d under limit rejected", i+1)
		}
	}
	if s.allow(id) {
		t.Fatal("request over the limit allowed")
	}
	// a different token has its own window
	var other pgtype.UUID
	other.Bytes[15] = 2
	other.Valid = true
	if !s.allow(other) {
		t.Fatal("other token shared the rate-limit window")
	}
}
