package webhooks

import (
	"encoding/json"
	"fmt"
	"testing"
)

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

func TestBuildOpsMeta(t *testing.T) {
	lat := int64(84)
	// structured fields land; kind-only posts stay untagged (kind lives
	// in tags already — meta exists for data)
	m := buildOpsMeta("status", opsFields{
		Service: "api", State: "up", LatencyMs: &lat, Env: "prod",
		URL: "https://grafana/d/api", Fields: map[string]any{"region": "eu"},
		At: "2026-10-12T08:00:00Z",
	})
	var got map[string]any
	if err := json.Unmarshal(m, &got); err != nil {
		t.Fatalf("meta not json: %v", err)
	}
	if got["service"] != "api" || got["state"] != "up" ||
		got["latency_ms"] != float64(84) || got["env"] != "prod" {
		t.Fatalf("meta missing fields: %v", got)
	}
	if fl, _ := got["fields"].(map[string]any); fl["region"] != "eu" {
		t.Fatalf("fields not carried: %v", got["fields"])
	}
	if got["at"] != "2026-10-12T08:00:00Z" {
		t.Fatalf("at not normalized: %v", got["at"])
	}

	// nothing structured -> nil (kind alone doesn't make an ops post)
	if m := buildOpsMeta("bug", opsFields{}); m != nil {
		t.Fatalf("kind-only meta should be nil, got %s", m)
	}
	// invalid at is dropped, not fatal
	m = buildOpsMeta("status", opsFields{Service: "api", State: "down", At: "not-a-time"})
	if !json.Valid(m) {
		t.Fatalf("bad at produced invalid meta")
	}
	var g2 map[string]any
	_ = json.Unmarshal(m, &g2)
	if _, ok := g2["at"]; ok {
		t.Fatalf("invalid at should be dropped: %v", g2)
	}
	// negative/garbage latency clamps instead of flowing through
	neg := int64(-5)
	m = buildOpsMeta("status", opsFields{Service: "api", State: "up", LatencyMs: &neg})
	var g3 map[string]any
	_ = json.Unmarshal(m, &g3)
	if g3["latency_ms"] != float64(0) {
		t.Fatalf("negative latency not clamped: %v", g3)
	}
	// fields over the cap die with the meta rather than bloating the row
	big := map[string]any{}
	for i := 0; i < 40; i++ {
		big[fmt.Sprintf("k%02d", i)] = string(make([]byte, 400))
	}
	if buildOpsMeta("status", opsFields{Service: "api", State: "up", Fields: big}) != nil {
		t.Fatalf("oversized meta should return nil")
	}
}
