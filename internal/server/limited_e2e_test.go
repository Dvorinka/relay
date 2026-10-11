package server

// Limited hosted tier (RELAY_LIMITED): the free instance stores no files at
// all — UI uploads, avatars, and hook payloads all refuse storage, while the
// rest of the API keeps working. Runs against real Postgres; skipped without
// RELAY_TEST_DATABASE_URL.

import (
	"fmt"
	"testing"

	"github.com/Dvorinka/relay/internal/config"
)

func TestLimitedUploadsDisabled(t *testing.T) {
	c, _, _, projID := e2eSetupCfg(t, "limited", func(cfg *config.Config) {
		cfg.Limited = true
		cfg.StorageMaxUploadMiB = 25
	})

	// Health advertises the tier and that uploads are off entirely.
	code, h := c.call("GET", "/api/health", "")
	if code != 200 {
		t.Fatalf("health: %d %v", code, h)
	}
	limits, _ := h["limits"].(map[string]any)
	if h["limited"] != true || limits["uploads"] != false {
		t.Fatalf("health should report limited + uploads off: %v", h)
	}

	// The UI upload path refuses with a clear code — multipart and base64
	// JSON hit the same gate.
	code, up := c.call("POST", "/api/projects/"+projID+"/attachments",
		`{"name":"a.png","data":"aGVsbG8="}`)
	if code != 403 || up["error"].(map[string]any)["code"] != "uploads_disabled" {
		t.Fatalf("limited upload should be 403 uploads_disabled: %d %v", code, up)
	}

	// Avatars ride the same storage — refused too.
	code, av := c.call("PUT", "/api/me/avatar",
		`{"name":"a.png","data":"aGVsbG8="}`)
	if code != 403 || av["error"].(map[string]any)["code"] != "uploads_disabled" {
		t.Fatalf("limited avatar should be 403 uploads_disabled: %d %v", code, av)
	}

	// Inbound-hook reports still land — files drop, the report keeps its
	// text, and the response counts what was dropped.
	code, ch := c.call("POST", "/api/projects/"+projID+"/channels",
		`{"name":"support"}`)
	if code != 201 && code != 200 {
		t.Fatalf("channel: %d %v", code, ch)
	}
	chanID := ch["channel"].(map[string]any)["id"].(string)
	code, hook := c.call("POST", "/api/projects/"+projID+"/hooks",
		fmt.Sprintf(`{"name":"intake","conversation_id":%q}`, chanID))
	if code != 201 {
		t.Fatalf("hook: %d %v", code, hook)
	}
	hookObj, _ := hook["hook"].(map[string]any)
	tok, _ := hook["token"].(string)
	if tok == "" && hookObj != nil {
		tok, _ = hookObj["token"].(string)
	}
	code, r := c.call("POST", "/api/hooks/"+tok,
		`{"from":"a@b.c","body":"report text","attachments":[{"name":"app.log","data":"aGVsbG8="}]}`)
	if code != 202 {
		t.Fatalf("limited intake post should still 202: %d %v", code, r)
	}
	if r["attachments"] != float64(0) || r["attachments_dropped"] != float64(1) {
		t.Fatalf("expected attachments 0 + dropped 1: %v", r)
	}
}
