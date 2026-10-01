package config

import "testing"

func TestLoadRequiresDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("AUTH_SECRET", "x")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for missing DATABASE_URL")
	}
}

func TestLoadDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("AUTH_SECRET", "x")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != ":8080" {
		t.Fatalf("ListenAddr = %q, want :8080", cfg.ListenAddr)
	}
}
