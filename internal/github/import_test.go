package github

import "testing"

func TestIssueStatus(t *testing.T) {
	if got := issueStatus("closed"); got != "done" {
		t.Fatalf("closed -> %q", got)
	}
	if got := issueStatus("open"); got != "todo" {
		t.Fatalf("open -> %q", got)
	}
}

func TestPRStatus(t *testing.T) {
	cases := []struct {
		state  string
		merged bool
		draft  bool
		want   string
	}{
		{"closed", true, false, "done"},
		{"closed", false, false, "cancelled"},
		{"open", false, true, "todo"},
		{"open", false, false, "review"},
	}
	for _, tc := range cases {
		if got := prStatus(tc.state, tc.merged, tc.draft); got != tc.want {
			t.Fatalf("prStatus(%q,%v,%v) = %q, want %q", tc.state, tc.merged, tc.draft, got, tc.want)
		}
	}
}
