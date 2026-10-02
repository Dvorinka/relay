package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The whole job of the shell is: webview hits app:// origin, API calls land
// on the configured server with cookies and bodies intact.
func TestProxyForwardsAPI(t *testing.T) {
	var gotPath, gotCookie, gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotCookie = r.Header.Get("Cookie")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Set-Cookie", "relay_session=abc; HttpOnly")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	app := &App{cfg: &Config{ServerURL: upstream.URL}}
	app.handler.Store(app.buildHandler())

	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(`{"email":"a"}`))
	req.Header.Set("Cookie", "relay_session=xyz")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	app.ServeHTTP(rr, req)

	if gotPath != "/api/auth/login" || gotCookie != "relay_session=xyz" || gotBody != `{"email":"a"}` {
		t.Fatalf("proxy dropped data: path=%s cookie=%s body=%s", gotPath, gotCookie, gotBody)
	}
	if !strings.Contains(rr.Header().Get("Set-Cookie"), "relay_session=abc") {
		t.Fatal("upstream Set-Cookie not relayed to webview")
	}
}

func TestSetupPageWhenUnconfigured(t *testing.T) {
	app := &App{cfg: &Config{}}
	app.handler.Store(app.buildHandler())
	rr := httptest.NewRecorder()
	app.ServeHTTP(rr, httptest.NewRequest("GET", "/", nil))
	if !strings.Contains(rr.Body.String(), "server_url") {
		t.Fatal("expected the connect form")
	}
}
