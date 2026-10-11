package github

import (
	"strings"
	"testing"
)

// The marker gate is the whole safety story: prose that mentions a bug
// must never file, explicit markers always must.
func TestAutoFileMarker(t *testing.T) {
	fire := []string{
		"bug: login crashes on safari",
		"BUG: everything is broken",
		"issue: deploys hang at step 3",
		"enhancement: dark mode for settings",
		"feature: export board to csv",
		"feature request: keyboard shortcuts",
		"feature-request offline mode",
		"suggestion: pin the dev panel",
		"proposal: merge the two queues",
		"/bug broken layout",
		"/enhancement add filters",
		"  bug: leading whitespace is fine",
	}
	for _, s := range fire {
		rest := strings.TrimSpace(autoFileMarker.ReplaceAllString(s, ""))
		if rest == "" || rest == s {
			t.Fatalf("expected marker in %q", s)
		}
	}
	pass := []string{
		"the bug we saw yesterday is back",
		"features: nice work on the new rail",
		"this is a known issue: workaround exists", // marker not at start
		"bugs: plural keyword is prose",
		"bugfixes are shipping tomorrow",
		"bug report",         // no colon/dash
		"bug : spaced colon", // punctuation must hug the keyword
		"hey /bug can you check",
		"can we /issue this",
		"",
		"see https://x.dev/bug:123",
	}
	for _, s := range pass {
		if autoFileMarker.MatchString(s) {
			t.Fatalf("unexpected marker match in %q", s)
		}
	}
}

func TestFirstLineOf(t *testing.T) {
	if got := firstLineOf("short title\n\nlong body", 100); got != "short title" {
		t.Fatalf("first line: %q", got)
	}
	long := strings.Repeat("x", 120)
	if got := firstLineOf(long, 100); len([]rune(got)) != 100 || !strings.HasSuffix(got, "…") {
		t.Fatalf("truncation: %d runes, suffix=%q", len([]rune(got)), got[len(got)-3:])
	}
	if got := firstLineOf("  padded  ", 100); got != "padded" {
		t.Fatalf("trim: %q", got)
	}
}
