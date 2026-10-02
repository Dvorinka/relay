package webhooks

import "testing"

func TestMatchEvent(t *testing.T) {
	cases := []struct {
		patterns []string
		typ      string
		want     bool
	}{
		{[]string{"*"}, "issue.created", true},
		{[]string{"issue.*"}, "issue.created", true},
		{[]string{"issue.*"}, "issue.updated", true},
		{[]string{"issue.*"}, "todo.created", false},
		{[]string{"issue.*"}, "issuexyz.created", false},
		{[]string{"issue.created"}, "issue.created", true},
		{[]string{"issue.created"}, "issue.updated", false},
		{[]string{"review.*", "issue.created"}, "review.responded", true},
		{[]string{}, "issue.created", false},
	}
	for i, c := range cases {
		if got := matchEvent(c.patterns, c.typ); got != c.want {
			t.Errorf("case %d: matchEvent(%v, %q) = %v, want %v", i, c.patterns, c.typ, got, c.want)
		}
	}
}

func TestValidURL(t *testing.T) {
	for _, u := range []string{
		"https://agent.example.com/hook",
		"http://localhost:9000/events",
	} {
		if !validURL(u) {
			t.Errorf("validURL(%q) = false", u)
		}
	}
	for _, u := range []string{
		"", "ftp://x.com", "https://", "not-a-url", "https://" + string(make([]byte, 500)),
	} {
		if validURL(u) {
			t.Errorf("validURL(%q) = true", u)
		}
	}
}

func TestValidEvents(t *testing.T) {
	for _, list := range [][]string{
		{"*"},
		{"issue.*"},
		{"issue.created", "review.responded"},
		{"issue.*", "todo.created"},
	} {
		if !validEvents(list) {
			t.Errorf("validEvents(%v) = false", list)
		}
	}
	for _, list := range [][]string{
		{},
		{"bogus.event"},
		{"bogus.*"},
		{"issue.created", "nope"},
	} {
		if validEvents(list) {
			t.Errorf("validEvents(%v) = true", list)
		}
	}
}
