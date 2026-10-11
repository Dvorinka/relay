package server

// Support intake over inbound hooks: {from,subject,key,attachments} —
// sender attribution, ticket threading via key, and the storage gate for
// file payloads. Runs against real Postgres; skipped without
// RELAY_TEST_DATABASE_URL.

import (
	"fmt"
	"testing"
)

func TestInboundIntake(t *testing.T) {
	c, _, _, projID := e2eSetup(t, "intake")

	// A per-customer support channel + hook on it.
	code, ch := c.call("POST", "/api/projects/"+projID+"/channels",
		`{"name":"support-acme"}`)
	if code != 201 && code != 200 {
		t.Fatalf("channel: %d %v", code, ch)
	}
	chanID := ch["channel"].(map[string]any)["id"].(string)
	code, hook := c.call("POST", "/api/projects/"+projID+"/hooks",
		fmt.Sprintf(`{"name":"acme-intake","conversation_id":%q}`, chanID))
	if code != 201 {
		t.Fatalf("hook: %d %v", code, hook)
	}
	hookObj, _ := hook["hook"].(map[string]any)
	tok, _ := hook["token"].(string)
	if tok == "" && hookObj != nil {
		tok, _ = hookObj["token"].(string)
	}
	if tok == "" {
		t.Fatalf("hook response has no token: %v", hook)
	}
	hookToken := tok
	post := func(payload string) (int, map[string]any) {
		return c.call("POST", "/api/hooks/"+hookToken, payload)
	}

	// First report: attribution + subject + ticket key.
	code, r1 := post(`{"from":"Alice <alice@acme.com>","subject":"PDF renders blank",` +
		`"body":"invoice #1042 downloads as an empty pdf","key":"ticket-42"}`)
	if code != 202 {
		t.Fatalf("intake post: %d %v", code, r1)
	}
	if r1["threaded"] != false {
		t.Fatalf("first post threaded: %v", r1)
	}
	m1 := r1["message_id"].(string)

	// Follow-up with the same key threads under the first.
	code, r2 := post(`{"from":"Alice <alice@acme.com>","key":"ticket-42",` +
		`"body":"totals are wrong too — tax missing"}`)
	if code != 202 {
		t.Fatalf("follow-up: %d %v", code, r2)
	}
	if r2["threaded"] != true || r2["parent_id"] != m1 {
		t.Fatalf("follow-up not threaded: %v", r2)
	}

	// Verify the rendered shape: header line, tags, parent link.
	code, lst := c.call("GET", "/api/conversations/"+chanID+"/messages", "")
	if code != 200 {
		t.Fatalf("messages: %d", code)
	}
	var first, follow map[string]any
	for _, m := range lst["messages"].([]any) {
		mm := m.(map[string]any)
		if mm["id"] == m1 {
			first = mm
		}
		if mm["id"] == r2["message_id"].(string) {
			follow = mm
		}
	}
	if first == nil || follow == nil {
		t.Fatalf("intake messages missing: %v", lst)
	}
	want := "**Alice <alice@acme.com>** — *PDF renders blank*\n\n" +
		"invoice #1042 downloads as an empty pdf"
	if first["body"] != want {
		t.Fatalf("body = %q, want %q", first["body"], want)
	}
	hasTag := func(m map[string]any, tag string) bool {
		for _, tg := range m["tags"].([]any) {
			if tg.(string) == tag {
				return true
			}
		}
		return false
	}
	for _, tag := range []string{"webhook", "acme-intake", "from:Alice <alice@acme.com>", "key:ticket-42"} {
		if !hasTag(first, tag) {
			t.Fatalf("missing tag %q in %v", tag, first["tags"])
		}
	}
	if p, _ := follow["parent"].(map[string]any); p == nil || p["id"] != m1 {
		t.Fatalf("follow parent = %v, want %s", follow["parent"], m1)
	}

	// Attachments need object storage — the fixture has none, so the
	// furthest reachable verdict is 503 storage_disabled.
	code, r3 := post(`{"body":"with a log","attachments":[{"name":"app.log","data":"aGVsbG8="}]}`)
	if code != 503 {
		t.Fatalf("attachment post: %d %v", code, r3)
	}

	// Empty and junk payloads still fail fast.
	if code, _ = post(`{"body":""}`); code != 400 {
		t.Fatalf("empty post: %d", code)
	}
	if code, _ = c.call("POST", "/api/hooks/rlh_deadbeef", `{"body":"x"}`); code != 404 {
		t.Fatalf("bad token: %d", code)
	}
}
