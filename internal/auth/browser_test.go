package auth

import (
	"testing"
	"time"
)

func TestBrowserAuthPollFlow(t *testing.T) {
	s := newBrowserAuthStore()

	s.start("code-1")
	if token, known := s.poll("code-1"); !known || token != "" {
		t.Fatalf("fresh code must poll pending: known=%v token=%q", known, token)
	}
	if _, known := s.poll("nope"); known {
		t.Fatal("unknown code must poll as unknown")
	}
	if !s.approve("code-1", "sess-token") {
		t.Fatal("approve must accept a live code")
	}
	if token, known := s.poll("code-1"); !known || token != "sess-token" {
		t.Fatalf("approved code must yield its token: known=%v token=%q", known, token)
	}
	// Consume-once: the token must not be handed out twice.
	if _, known := s.poll("code-1"); known {
		t.Fatal("consumed code must be forgotten")
	}
	if s.approve("gone", "t") {
		t.Fatal("approve must reject unknown codes")
	}
}

func TestBrowserAuthExpiry(t *testing.T) {
	s := newBrowserAuthStore()
	s.start("old")
	s.pending["old"].createdAt = time.Now().Add(-browserAuthTTL - time.Second)

	if _, known := s.poll("old"); known {
		t.Fatal("expired code must poll as unknown")
	}
	if s.approve("old", "t") {
		t.Fatal("approve must reject expired codes")
	}
}
