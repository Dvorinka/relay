package mcpserver

import (
	"strings"
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

func TestRetryAfterMs(t *testing.T) {
	s := &Service{
		windows: map[[16]byte]time.Time{},
		counts:  map[[16]byte]int{},
	}
	var id pgtype.UUID
	id.Bytes[15] = 9
	id.Valid = true
	// untouched token: no window, nothing to wait for
	if got := s.retryAfterMs(id); got != 0 {
		t.Fatalf("retryAfterMs before window = %d", got)
	}
	if !s.allow(id) {
		t.Fatal("allow refused first request")
	}
	got := s.retryAfterMs(id)
	if got <= 0 || got > 60_000 {
		t.Fatalf("retryAfterMs = %d, want (0, 60000]", got)
	}
}

// toolAnns is the fix for mcp-go's destructive-by-default annotation: reads
// must be readOnly+non-destructive, deletes destructive, github_* openWorld.
func TestToolAnns(t *testing.T) {
	cases := []struct {
		name                             string
		readOnly, destructive, openWorld bool
	}{
		{"get_messages", true, false, false},
		{"search_messages", true, false, false},
		{"activity", true, false, false},
		{"list_unread", true, false, false},
		{"inbox", true, false, false},
		{"await_message", true, false, false},
		{"await_review", true, false, false},
		{"whoami", true, false, false},
		{"todo_list", true, false, false},
		{"ops_summary", true, false, false},
		{"github_list_prs", true, false, true},
		{"github_merge_pr", false, false, true},
		{"send_message", false, false, false},
		{"reply", false, false, false},
		{"edit_message", false, false, false},
		{"idea_to_issue", false, false, false}, // transform, not a delete
		{"todo_sync", false, true, false},      // deletes rows the caller omits
		{"delete_message", false, true, false},
		{"delete_brief", false, true, false},
		{"delete_idea", false, true, false},
		{"todo_delete", false, true, false},
	}
	for _, tc := range cases {
		a := toolAnns(tc.name)
		if got := a.ReadOnlyHint != nil && *a.ReadOnlyHint; got != tc.readOnly {
			t.Errorf("%s readOnlyHint = %v, want %v", tc.name, got, tc.readOnly)
		}
		if got := a.DestructiveHint != nil && *a.DestructiveHint; got != tc.destructive {
			t.Errorf("%s destructiveHint = %v, want %v", tc.name, got, tc.destructive)
		}
		if got := a.OpenWorldHint != nil && *a.OpenWorldHint; got != tc.openWorld {
			t.Errorf("%s openWorldHint = %v, want %v", tc.name, got, tc.openWorld)
		}
	}
	// every registered annotation sets all three hints — mcp-go's defaults
	// must never leak through
	for name := range readOnlyTools {
		a := toolAnns(name)
		if a.ReadOnlyHint == nil || a.DestructiveHint == nil || a.OpenWorldHint == nil {
			t.Errorf("%s has an unset hint: %+v", name, a)
		}
	}
}

func TestExcerpt(t *testing.T) {
	short, tr := excerpt("hello world", 200)
	if tr || short != "hello world" {
		t.Fatalf("short excerpt = %q tr=%v", short, tr)
	}
	long := strings.Repeat("x", 300)
	ex, tr := excerpt(long, 200)
	if !tr || len([]rune(ex)) != 201 || !strings.HasSuffix(ex, "…") {
		t.Fatalf("long excerpt len=%d tr=%v", len([]rune(ex)), tr)
	}
	// whitespace collapses before measuring
	ws, tr := excerpt("a  b\n\nc", 200)
	if ws != "a b c" || tr {
		t.Fatalf("whitespace excerpt = %q tr=%v", ws, tr)
	}
}
