package agents

import (
	"crypto/sha256"
	"strings"
	"testing"
)

func TestMintTokenFormat(t *testing.T) {
	token, hash, err := mintToken()
	if err != nil {
		t.Fatalf("mintToken: %v", err)
	}
	if !strings.HasPrefix(token, "rly_") {
		t.Fatalf("token missing rly_ prefix: %q", token)
	}
	// 32 random bytes -> 43 base64url chars + 4-char prefix
	if len(token) != 47 {
		t.Fatalf("unexpected token length %d", len(token))
	}
	if len(hash) != sha256.Size {
		t.Fatalf("hash length %d, want %d", len(hash), sha256.Size)
	}
	sum := sha256.Sum256([]byte(token))
	if string(hash) != string(sum[:]) {
		t.Fatal("stored hash is not sha256(token)")
	}
}

func TestMintTokenUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 64 {
		token, _, err := mintToken()
		if err != nil {
			t.Fatalf("mintToken: %v", err)
		}
		if seen[token] {
			t.Fatal("duplicate token generated")
		}
		seen[token] = true
	}
}
