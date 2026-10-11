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

	// Intake mode rides the channel PATCH and round-trips in the JSON —
	// including the legacy boolean shim and the value validation.
	if code, bad := c.call("PATCH", "/api/channels/"+chanID, `{"intake_mode":"bogus"}`); code != 400 {
		t.Fatalf("bad intake_mode: %d %v", code, bad)
	}
	code, up := c.call("PATCH", "/api/channels/"+chanID, `{"intake":true}`)
	if code != 200 {
		t.Fatalf("intake patch: %d %v", code, up)
	}
	if up["channel"].(map[string]any)["intake_mode"] != "receive" {
		t.Fatalf("legacy intake bool did not map to receive: %v", up)
	}

	// The hook carries a default report kind — payloads can override it.
	code, hook := c.call("POST", "/api/projects/"+projID+"/hooks",
		fmt.Sprintf(`{"name":"acme-intake","conversation_id":%q,"kind":"bug"}`, chanID))
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
	// The first keyed post opens the ticket's sub-chat — a thread
	// conversation rooted at the report.
	threadID, _ := r1["thread_id"].(string)
	if threadID == "" {
		t.Fatalf("keyed post did not open a sub-chat: %v", r1)
	}

	// Follow-up with the same key lands inside the sub-chat — and carries
	// its own kind, overriding the hook's default.
	code, r2 := post(`{"from":"Alice <alice@acme.com>","key":"ticket-42",` +
		`"kind":"feature","body":"totals are wrong too — tax missing"}`)
	if code != 202 {
		t.Fatalf("follow-up: %d %v", code, r2)
	}
	if r2["threaded"] != true || r2["parent_id"] != m1 || r2["thread_id"] != threadID {
		t.Fatalf("follow-up not in the sub-chat: %v", r2)
	}

	// Verify the rendered shape: header line, tags, thread affordance.
	code, lst := c.call("GET", "/api/conversations/"+chanID+"/messages", "")
	if code != 200 {
		t.Fatalf("messages: %d", code)
	}
	var first map[string]any
	for _, m := range lst["messages"].([]any) {
		mm := m.(map[string]any)
		if mm["id"] == m1 {
			first = mm
		}
	}
	if first == nil {
		t.Fatalf("intake root missing: %v", lst)
	}
	if th, _ := first["thread"].(map[string]any); th == nil || th["id"] != threadID {
		t.Fatalf("root missing its sub-chat affordance: %v", first["thread"])
	}
	// The follow-up lives in the sub-chat conversation, not the channel.
	code, tlst := c.call("GET", "/api/conversations/"+threadID+"/messages", "")
	if code != 200 {
		t.Fatalf("thread messages: %d", code)
	}
	var follow map[string]any
	for _, m := range tlst["messages"].([]any) {
		mm := m.(map[string]any)
		if mm["id"] == r2["message_id"].(string) {
			follow = mm
		}
	}
	if follow == nil {
		t.Fatalf("follow-up not in sub-chat: %v", tlst)
	}
	// The inherited hook kind labels the head; the payload kind overrode
	// it on the follow-up.
	want := "`bug` **Alice <alice@acme.com>** — *PDF renders blank*\n\n" +
		"invoice #1042 downloads as an empty pdf"
	if first["body"] != want {
		t.Fatalf("body = %q, want %q", first["body"], want)
	}
	if follow["body"] != "`feature` **Alice <alice@acme.com>**\n\ntotals are wrong too — tax missing" {
		t.Fatalf("follow-up body = %q", follow["body"])
	}
	hasTag := func(m map[string]any, tag string) bool {
		for _, tg := range m["tags"].([]any) {
			if tg.(string) == tag {
				return true
			}
		}
		return false
	}
	for _, tag := range []string{"webhook", "acme-intake", "from:Alice <alice@acme.com>", "key:ticket-42", "kind:bug"} {
		if !hasTag(first, tag) {
			t.Fatalf("missing tag %q in %v", tag, first["tags"])
		}
	}
	if follow["parent"] != nil {
		t.Fatalf("in-thread follow-up should be flat, got parent %v", follow["parent"])
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

	// --- receive-only vs chat mode -------------------------------------
	// Receive mode: the token is write-only — pulls are refused.
	code, rd := c.call("GET", "/api/hooks/"+hookToken+"/messages", "")
	errObj, _ := rd["error"].(map[string]any)
	if code != 403 || errObj["code"] != "intake_read_disabled" {
		t.Fatalf("receive-mode read: %d %v", code, rd)
	}

	// Chat mode: the same token can pull the channel back.
	code, _ = c.call("PATCH", "/api/channels/"+chanID, `{"intake_mode":"chat"}`)
	if code != 200 {
		t.Fatalf("chat patch: %d", code)
	}
	// A human answers inside the ticket's sub-chat — the platform pulls
	// whatever is posted there; the channel stays staff-side.
	code, rep := c.call("POST", "/api/conversations/"+threadID+"/messages",
		`{"body":"looking into it now"}`)
	if code != 201 && code != 200 {
		t.Fatalf("staff reply: %d %v", code, rep)
	}

	get := func(qs string) (int, map[string]any) {
		return c.call("GET", "/api/hooks/"+hookToken+"/messages"+qs, "")
	}
	code, rd = get("?key=ticket-42")
	if code != 200 {
		t.Fatalf("chat read: %d %v", code, rd)
	}
	msgs := rd["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("key-scoped read got %d messages, want 3: %v", len(msgs), msgs)
	}
	// Oldest first: root, then the hook follow-up, then the staff reply.
	last := msgs[2].(map[string]any)
	if last["body"] != "looking into it now" || last["via_hook"] != false {
		t.Fatalf("staff reply shape wrong: %v", last)
	}
	if msgs[0].(map[string]any)["via_hook"] != true {
		t.Fatalf("inbound post not marked via_hook: %v", msgs[0])
	}
	// Intake metadata is lifted out of tags for the platform.
	m0 := msgs[0].(map[string]any)
	if m0["from"] != "Alice <alice@acme.com>" || m0["key"] != "ticket-42" || m0["kind"] != "bug" {
		t.Fatalf("lifted fields wrong: %v", m0)
	}

	// A per-hook header template replaces the default head line.
	code, _ = c.call("PATCH", "/api/inbound-hooks/"+hookObj["id"].(string),
		`{"header_template":"[{kind}] {from} » {subject}"}`)
	if code != 200 {
		t.Fatalf("template patch: %d", code)
	}
	code, r4 := post(`{"from":"Bob <bob@acme.com>","kind":"incident",` +
		`"subject":"payments down","body":"all card charges 502ing"}`)
	if code != 202 {
		t.Fatalf("templated post: %d %v", code, r4)
	}
	code, lst = c.call("GET", "/api/conversations/"+chanID+"/messages", "")
	if code != 200 {
		t.Fatalf("messages2: %d", code)
	}
	var templ map[string]any
	for _, m := range lst["messages"].([]any) {
		mm := m.(map[string]any)
		if mm["id"] == r4["message_id"].(string) {
			templ = mm
		}
	}
	if templ == nil ||
		templ["body"] != "[incident] Bob <bob@acme.com> » payments down\n\nall card charges 502ing" {
		t.Fatalf("templated body = %v", templ)
	}

	// ?after paginates: nothing newer than the newest message (Bob's).
	code, rd = get("?after=" + r4["message_id"].(string))
	if code != 200 || len(rd["messages"].([]any)) != 0 {
		t.Fatalf("after cursor: %d %v", code, rd)
	}
	// …and after the staff reply, only Bob's post is newer.
	code, rd = get("?key=ticket-42&after=" + last["id"].(string))
	if code != 200 || len(rd["messages"].([]any)) != 0 {
		t.Fatalf("key+after cursor: %d %v", code, rd)
	}
	// Unknown key is an empty thread, not an error.
	code, rd = get("?key=nope")
	if code != 200 || len(rd["messages"].([]any)) != 0 {
		t.Fatalf("unknown key: %d %v", code, rd)
	}
	if code, _ = get("?after=not-a-uuid"); code != 400 {
		t.Fatalf("bad after: %d", code)
	}

	// A disabled hook is dead on both paths.
	hookID := hookObj["id"].(string)
	code, _ = c.call("PATCH", "/api/inbound-hooks/"+hookID, `{"enabled":false}`)
	if code != 200 {
		t.Fatalf("disable: %d", code)
	}
	if code, _ = post(`{"body":"still alive?"}`); code != 404 {
		t.Fatalf("disabled hook post: %d", code)
	}
	if code, _ = get(""); code != 404 {
		t.Fatalf("disabled hook read: %d", code)
	}
}
