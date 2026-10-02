package mentions

import (
	"testing"
)

func TestExtractKinds(t *testing.T) {
	body := "hey @user:john-smith and @agent:reviewer — this touches AT-1 and " +
		"owner/repo#42, plus @file:src/main.go and @gh:o/r:README.md"
	refs := Extract(body)
	want := map[string]string{
		"john-smith":       "user",
		"reviewer":         "agent",
		"AT-1":             "issue",
		"owner/repo#42":    "gh",
		"src/main.go":      "file",
		"gh:o/r:README.md": "file",
	}
	got := map[string]string{}
	for _, r := range refs {
		got[r.Ref] = r.Kind
	}
	for ref, kind := range want {
		if got[ref] != kind {
			t.Errorf("ref %q: got kind %q, want %q (all: %v)", ref, got[ref], kind, refs)
		}
	}
	if len(refs) != len(want) {
		t.Errorf("got %d refs, want %d: %v", len(refs), len(want), refs)
	}
}

func TestExtractNoFalsePositiveInsideFile(t *testing.T) {
	// KEY-1 inside a path is a filename, not an issue.
	refs := Extract("look at @file:notes/AT-1.md")
	for _, r := range refs {
		if r.Kind == "issue" {
			t.Fatalf("file path leak into issues: %v", refs)
		}
	}
}

func TestExtractDedupeAndEmails(t *testing.T) {
	refs := Extract("AT-1 AT-1 AT-1, mail me@x.com, not#an-issue")
	count := 0
	for _, r := range refs {
		if r.Kind == "issue" {
			count++
		}
		if r.Ref == "x.com" {
			t.Fatalf("email leak: %v", refs)
		}
	}
	if count != 1 {
		t.Fatalf("dedupe failed: %v", refs)
	}
}

func TestBareMention(t *testing.T) {
	refs := Extract("ping @tdvorak when done")
	found := false
	for _, r := range refs {
		if r.Kind == "mention" && r.Ref == "tdvorak" {
			found = true
		}
	}
	if !found {
		t.Fatalf("bare @name not extracted: %v", refs)
	}
	// prefixed tokens must not double-fire as bare mentions
	for _, r := range Extract("@agent:bot go") {
		if r.Kind == "mention" {
			t.Fatalf("prefixed token emitted as bare mention")
		}
	}
}
