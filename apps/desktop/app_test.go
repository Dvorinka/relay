package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"testing/fstest"

	"github.com/wailsapp/wails/v2/pkg/assetserver"
	assetserveropts "github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// stubRuntime satisfies assetserver.RuntimeAssets — the bridge JS is unused
// in tests but the AssetServer requires the interface.
type stubRuntime struct{}

func (stubRuntime) DesktopIPC() []byte       { return nil }
func (stubRuntime) WebsocketIPC() []byte     { return nil }
func (stubRuntime) RuntimeDesktopJS() []byte { return nil }

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
		_, _ = w.Write([]byte(`{"ok":true}`))
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

// Regression for the "Loading…" hang: embedded placeholder assets won the
// AssetServer's file-first lookup and shadowed "/", so the proxy handler never
// ran. Drive the real AssetServer to prove "/" reaches the app handler.
func TestAssetServerRoutesToApp(t *testing.T) {
	app := &App{cfg: &Config{}}
	app.handler.Store(app.buildHandler())

	srv, err := assetserver.NewAssetServer("", assetserveropts.Options{Handler: app}, false, nil, stubRuntime{})
	if err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, httptest.NewRequest("GET", "/", nil))
	body := rr.Body.String()
	if strings.Contains(body, "Loading") {
		t.Fatal("placeholder shadowed the handler — regression of the Loading… bug")
	}
	if !strings.Contains(body, "server_url") {
		t.Fatal("expected the connect form via the app handler")
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

// Offline mode: embedded SPA serves files, unknown client-side routes fall
// back to index.html, and /api/* never gets HTML.
func TestOfflineSPARouting(t *testing.T) {
	dist := fstest.MapFS{
		"index.html":       {Data: []byte("<html>relay app</html>")},
		"assets/app.js":    {Data: []byte("console.log(1)")},
		"assets/style.css": {Data: []byte("body{}")},
	}
	h := spaHandler(dist)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/", nil))
	if !strings.Contains(rr.Body.String(), "relay app") {
		t.Fatal("index.html not served at /")
	}

	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/assets/app.js", nil))
	if rr.Body.String() != "console.log(1)" {
		t.Fatal("static asset not served")
	}

	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/projects/abc/chat", nil))
	if !strings.Contains(rr.Body.String(), "relay app") {
		t.Fatal("client route did not fall back to index.html")
	}

	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/health", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for /api/*, got %d", rr.Code)
	}
}

// Stub builds (no real bundle embedded) must refuse offline mode rather
// than dead-end the user on a broken page.
func TestOfflineRejectedWhenBundleMissing(t *testing.T) {
	app := &App{cfg: &Config{}}
	app.handler.Store(app.buildHandler())
	req := httptest.NewRequest("POST", "/", strings.NewReader("offline=1"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rr := httptest.NewRecorder()
	app.ServeHTTP(rr, req)
	if rr.Code == http.StatusOK && !offlineAvailable() {
		t.Fatal("accepted offline mode without a bundled SPA")
	}
}

// The connect form submits as a plain GET (WebKitGTK can drop POST bodies):
// /?server_url=… persists the choice, swaps the handler, and redirects to /.
func TestSetupPageGetChoice(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("upstream app"))
	}))
	defer upstream.Close()

	app := &App{cfg: &Config{}}
	app.handler.Store(app.buildHandler())

	rr := httptest.NewRecorder()
	app.ServeHTTP(rr, httptest.NewRequest("GET", "/?server_url="+upstream.URL, nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected bridge page after choice, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "removeItem('relay.local')") {
		t.Fatalf("bridge page must clear local-mode flag for server connect, got %q", rr.Body.String())
	}
	if app.cfg.ServerURL != upstream.URL || app.cfg.Offline {
		t.Fatalf("choice not applied: %+v", app.cfg)
	}

	rr = httptest.NewRecorder()
	app.ServeHTTP(rr, httptest.NewRequest("GET", "/", nil))
	if rr.Body.String() != "upstream app" {
		t.Fatalf("expected proxied app after connect, got %q", rr.Body.String())
	}
}

// The SPA syncs the shell config when it changes mode itself (connect from
// local mode, or "Work locally" while connected): 204 on apply, 400 on bad
// input, and the handler hot-swaps to match.
func TestDesktopConfigFromSPA(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("upstream app"))
	}))
	defer upstream.Close()

	app := &App{cfg: &Config{Offline: true}}
	app.handler.Store(app.buildHandler())

	rr := httptest.NewRecorder()
	app.ServeHTTP(rr, httptest.NewRequest("GET",
		"/~desktop-config?server_url="+upstream.URL+"&offline=0", nil))
	if rr.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rr.Code)
	}
	if app.cfg.ServerURL != upstream.URL || app.cfg.Offline {
		t.Fatalf("config not applied: %+v", app.cfg)
	}

	rr = httptest.NewRecorder()
	app.ServeHTTP(rr, httptest.NewRequest("GET", "/", nil))
	if rr.Body.String() != "upstream app" {
		t.Fatalf("expected proxy after config sync, got %q", rr.Body.String())
	}

	rr = httptest.NewRecorder()
	app.ServeHTTP(rr, httptest.NewRequest("GET", "/~desktop-config?server_url=&offline=0", nil))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("empty server_url: got %d", rr.Code)
	}
}

func TestDesktopOpen(t *testing.T) {
	app := &App{cfg: &Config{ServerURL: "http://relay.test"}}
	app.handler.Store(app.buildHandler())

	cases := []struct {
		query string
		want  int
	}{
		{"u=https%3A%2F%2Fgithub.com%2Fapps%2Fx", http.StatusNoContent},
		{"u=/api/github/manifest-page%3Fm%3Dabc", http.StatusNoContent}, // resolves against server
		{"u=javascript%3Aalert(1)", http.StatusBadRequest},
		{"u=ftp%3A%2F%2Fx.test", http.StatusBadRequest},
		{"u=%2F%2Fevil.test", http.StatusBadRequest}, // scheme-relative must not become https
		{"", http.StatusBadRequest},
	}
	for _, tc := range cases {
		rr := httptest.NewRecorder()
		app.ServeHTTP(rr, httptest.NewRequest("GET", "/~desktop-open?"+tc.query, nil))
		if rr.Code != tc.want {
			t.Errorf("?%s: got %d, want %d", tc.query, rr.Code, tc.want)
		}
	}

	// Root-relative URL with no configured server must not resolve.
	app2 := &App{cfg: &Config{}}
	app2.handler.Store(app2.buildHandler())
	rr := httptest.NewRecorder()
	app2.ServeHTTP(rr, httptest.NewRequest("GET", "/~desktop-open?u=/api/x", nil))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("relative URL without server: got %d", rr.Code)
	}
}
