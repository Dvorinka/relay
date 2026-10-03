package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
