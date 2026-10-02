package main

import (
	"strings"
	"testing"
)

func TestTruncate(t *testing.T) {
	if got := truncate("hello", 10); got != "hello" {
		t.Fatalf("truncate grew the string: %q", got)
	}
	if got := truncate("hello world", 5); got != "hello…" {
		t.Fatalf("truncate: %q", got)
	}
	// multi-byte: ellipsis counts as one rune
	if got := truncate("héllo wörld", 5); !strings.HasPrefix(got, "héllo") {
		t.Fatalf("truncate broke UTF-8: %q", got)
	}
}

func TestCompletionScripts(t *testing.T) {
	for _, sh := range []string{"bash", "zsh", "fish"} {
		out := completionScript(sh)
		if !strings.Contains(out, "projects") || !strings.Contains(out, "say") {
			t.Fatalf("%s completion missing commands", sh)
		}
	}
}

func TestStrHelpers(t *testing.T) {
	m := anyMap{"key": "MNT-1", "n": float64(3)}
	if str(m, "key") != "MNT-1" || str(m, "missing") != "" {
		t.Fatal("str")
	}
	if num(m["n"]) != 3 {
		t.Fatal("num")
	}
	if len(list(m, "items")) != 0 {
		t.Fatal("list on missing key")
	}
}
