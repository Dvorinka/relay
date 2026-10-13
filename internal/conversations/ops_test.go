package conversations

// OpsSummarize — the pure fold behind GET /conversations/:id/ops and the
// MCP ops_summary tool. Covers service-state ordering, day bucketing, and
// per-kind counts; rows here are synthetic (no DB).

import (
	"testing"
	"time"

	"github.com/Dvorinka/relay/internal/db"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
)

func metaRow(at time.Time, meta string) db.OpsStatusEventsRow {
	return db.OpsStatusEventsRow{
		ID:        pgtype.UUID{Bytes: [16]byte{1}, Valid: true},
		CreatedAt: pgtype.Timestamptz{Time: at, Valid: true},
		Meta:      []byte(meta),
	}
}

func TestOpsSummarize(t *testing.T) {
	now := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	rows := []db.OpsStatusEventsRow{
		// api went down earlier today, recovered later — latest wins
		metaRow(now.Add(-3*time.Hour),
			`{"kind":"status","service":"api","state":"down","latency_ms":0}`),
		metaRow(now.Add(-time.Hour),
			`{"kind":"status","service":"api","state":"up","latency_ms":84,"env":"prod"}`),
		// web is down and stays down — sorts first (worst state)
		metaRow(now.Add(-2*time.Hour),
			`{"kind":"status","service":"web","state":"down","latency_ms":900}`),
		// an error post with a level — counts under kinds, not services
		metaRow(now.Add(-30*time.Minute),
			`{"kind":"error","service":"web","level":"error","release":"v1.2.3"}`),
		// a 2-day-old degraded reading for the strip
		metaRow(now.Add(-49*time.Hour),
			`{"kind":"status","service":"api","state":"degraded"}`),
		// garbage meta is skipped, not fatal
		metaRow(now.Add(-time.Hour), `not json`),
	}

	out := OpsSummarize(rows, now)

	svcs, ok := out["services"].([]gin.H)
	if !ok || len(svcs) != 2 {
		t.Fatalf("services: %v", out["services"])
	}
	if svcs[0]["service"] != "web" || svcs[0]["state"] != "down" {
		t.Fatalf("worst service should sort first: %v", svcs[0])
	}
	if svcs[0]["latency_ms"] != int64(900) {
		t.Fatalf("latency lost: %v", svcs[0])
	}
	if svcs[1]["service"] != "api" || svcs[1]["state"] != "up" ||
		svcs[1]["env"] != "prod" {
		t.Fatalf("api should be latest-state up: %v", svcs[1])
	}

	days, ok := out["days"].([]gin.H)
	if !ok || len(days) != 30 {
		t.Fatalf("days must be a dense 30-entry strip: %v", len(days))
	}
	// today is the last entry; it contains up+down+degraded — down wins
	if days[29]["worst"] != "down" {
		t.Fatalf("today's worst should be down: %v", days[29])
	}
	// two days ago saw the api degraded event
	if days[27]["worst"] != "degraded" || days[27]["events"] != int64(1) {
		t.Fatalf("day-2 bucket wrong: %v", days[27])
	}
	// a silent day reports no_data
	if days[10]["worst"] != "no_data" || days[10]["events"] != int64(0) {
		t.Fatalf("empty day should be no_data: %v", days[10])
	}

	kinds, _ := out["kinds"].(map[string]int64)
	if kinds["status"] != 4 || kinds["error"] != 1 {
		t.Fatalf("kind counts wrong: %v", kinds)
	}
	if out["last_event_at"] == nil {
		t.Fatalf("last_event_at unset")
	}
}

func TestOpsSummarizeEmpty(t *testing.T) {
	out := OpsSummarize(nil, time.Now().UTC())
	if n := len(out["services"].([]gin.H)); n != 0 {
		t.Fatalf("empty input should give no services: %v", out["services"])
	}
	if len(out["days"].([]gin.H)) != 30 {
		t.Fatalf("strip must still render 30 days")
	}
	if out["last_event_at"] != nil {
		t.Fatalf("no events -> nil last_event_at")
	}
}
