package mcpserver

import (
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Dvorinka/relay/internal/db"
)

func TestBucketReactions(t *testing.T) {
	mk := func(emoji, name string) db.ListReactionsForMessagesRow {
		return db.ListReactionsForMessagesRow{Emoji: emoji, ReactorName: name}
	}
	if got := bucketReactions(nil); len(got) != 0 {
		t.Fatalf("nil rows should give [], got %v", got)
	}
	rows := []db.ListReactionsForMessagesRow{
		mk("👀", "alice"), mk("✅", "bob"), mk("👀", "carol"),
	}
	got := bucketReactions(rows)
	if len(got) != 2 {
		t.Fatalf("want 2 buckets, got %d", len(got))
	}
	if got[0]["emoji"] != "👀" || got[0]["count"] != 2 || got[0]["mine"] != false {
		t.Fatalf("first bucket wrong: %v", got[0])
	}
	names, _ := json.Marshal(got[0]["names"])
	if string(names) != `["alice","carol"]` {
		t.Fatalf("names wrong: %s", names)
	}
	if got[1]["emoji"] != "✅" {
		t.Fatalf("emoji order should follow first appearance: %v", got[1])
	}
}

func TestMapReaders(t *testing.T) {
	if got := mapReaders(nil); len(got) != 0 {
		t.Fatalf("nil rows should give [], got %v", got)
	}
	rows := []db.AgentReadersForMessagesRow{
		{AgentID: pgtype.UUID{Bytes: [16]byte{1}, Valid: true}, Name: "bot"},
	}
	got := mapReaders(rows)
	if len(got) != 1 {
		t.Fatalf("want 1 reader, got %d", len(got))
	}
	r := got[0]
	if r["name"] != "bot" {
		t.Fatalf("reader shape wrong: %v", r)
	}
	if av, _ := r["avatar_url"].(*string); av != nil {
		t.Fatalf("absent avatar should be nil: %v", r)
	}
	if _, ok := r["read_at"].(string); !ok {
		t.Fatalf("read_at should be an RFC3339 string: %v", r)
	}
	// wire shape must carry every MessageView key the SPA reads
	for _, k := range []string{"id", "name", "avatar_url", "read_at"} {
		if _, ok := r[k]; !ok {
			t.Fatalf("missing key %q in %v", k, r)
		}
	}
}
