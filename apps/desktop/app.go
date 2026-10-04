package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync/atomic"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const configName = "relay-desktop.json"

type Config struct {
	ServerURL string `json:"server_url"`
	// Offline serves the embedded SPA ("This device" workspace) instead of
	// proxying a server.
	Offline bool `json:"offline"`
}

func configPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "relay", configName), nil
}

func loadConfig() (*Config, error) {
	cfg := &Config{ServerURL: os.Getenv("RELAY_URL")}
	if cfg.ServerURL != "" {
		return cfg, nil
	}
	path, err := configPath()
	if err != nil {
		return cfg, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg, nil
	}
	_ = json.Unmarshal(raw, cfg)
	return cfg, nil
}

func (c *Config) save() error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(path, raw, 0o600)
}

// App is the Wails-bound application object.
type App struct {
	cfg     *Config
	ctx     context.Context
	handler atomic.Value // stores http.Handler; swapped when a URL is saved
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	if a.cfg.ServerURL != "" {
		wailsruntime.WindowSetTitle(ctx, "Relay")
	}
}

// ServeHTTP dispatches through whatever handler is current — the setup page
// or the full proxy. Bound methods are exposed on window.go.main.App.
func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.handler.Load().(http.Handler).ServeHTTP(w, r)
}

func (a *App) buildHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/~desktop-open", a.openExternal)
	mux.HandleFunc("/~desktop-config", a.configFromSPA)
	switch {
	case a.cfg.Offline:
		mux.Handle("/", spaHandler(webDist()))
	case a.cfg.ServerURL == "":
		mux.Handle("/", http.HandlerFunc(a.setupPage))
	default:
		target, _ := url.Parse(strings.TrimRight(a.cfg.ServerURL, "/"))
		proxy := &httputil.ReverseProxy{
			Rewrite: func(r *httputil.ProxyRequest) {
				r.SetURL(target)
				r.Out.Host = target.Host
			},
			// SSE (GET /api/events) needs immediate flushing.
			FlushInterval: -1,
		}
		mux.Handle("/", proxy)
	}
	return mux
}

// openExternal hands a URL to the OS browser. The SPA calls this for flows
// that need the user's real browser session (GitHub App registration needs a
// GitHub login the webview doesn't have). Absolute http(s) URLs open as-is;
// a root-relative path resolves against the configured server. Registered on
// every handler mode so the call works pre-connect and in offline mode too.
func (a *App) openExternal(w http.ResponseWriter, r *http.Request) {
	u := r.URL.Query().Get("u")
	if strings.HasPrefix(u, "/") && !strings.HasPrefix(u, "//") {
		if a.cfg.ServerURL == "" {
			http.Error(w, "no server configured", http.StatusBadRequest)
			return
		}
		u = strings.TrimRight(a.cfg.ServerURL, "/") + u
	}
	parsed, err := url.Parse(u)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		http.Error(w, "bad url", http.StatusBadRequest)
		return
	}
	if a.ctx != nil {
		go wailsruntime.BrowserOpenURL(a.ctx, u)
	}
	w.WriteHeader(http.StatusNoContent)
}

type proxyResult struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// ProxyRequest issues an authenticated request to the configured server from
// Go's HTTP stack, bound as window.go.main.App.ProxyRequest. WebKitGTK's
// scheme handler can silently drop request bodies, so the SPA routes uploads
// and other body-bearing calls across this bridge instead of fetch(). Only
// /api/ paths reach the server, and the SPA's token goes out as a Bearer
// header (the bound method runs outside the webview's cookie jar).
func (a *App) ProxyRequest(method, reqPath, contentType, bodyB64, token string) (proxyResult, error) {
	if a.cfg.ServerURL == "" {
		return proxyResult{}, errors.New("no server configured")
	}
	if !strings.HasPrefix(reqPath, "/api/") {
		return proxyResult{}, errors.New("only /api paths may be proxied")
	}
	var body io.Reader
	if bodyB64 != "" {
		raw, err := base64.StdEncoding.DecodeString(bodyB64)
		if err != nil || len(raw) > 64<<20 {
			return proxyResult{}, errors.New("invalid request body")
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(a.ctx, method,
		strings.TrimRight(a.cfg.ServerURL, "/")+reqPath, body)
	if err != nil {
		return proxyResult{}, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return proxyResult{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return proxyResult{}, err
	}
	return proxyResult{Status: resp.StatusCode, Body: string(raw)}, nil
}

func webDist() fs.FS {
	dist, err := fs.Sub(webFS, "web/dist")
	if err != nil {
		return nil
	}
	return dist
}

// spaHandler serves the embedded web bundle; unmatched paths fall back to
// index.html for client-side routing. Local mode ("This device") is a
// client-side adapter — it never calls the network, but 404 /api/* anyway
// so a stray fetch can't eat an HTML page as JSON.
func spaHandler(dist fs.FS) http.Handler {
	if dist == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "web bundle missing from this build", http.StatusInternalServerError)
		})
	}
	files := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		p := path.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if p != "." {
			if f, err := dist.Open(p); err == nil {
				_ = f.Close()
				files.ServeHTTP(w, r)
				return
			}
		}
		r2 := new(http.Request)
		*r2 = *r
		r2.URL = new(url.URL)
		*r2.URL = *r.URL
		r2.URL.Path = "/"
		files.ServeHTTP(w, r2)
	})
}

// offlineAvailable reports whether the binary carries the real SPA bundle
// (release/CI builds) or just the committed dev stub.
func offlineAvailable() bool {
	st, err := fs.Stat(webFS, "web/dist/assets")
	return err == nil && st.IsDir()
}

// configFromSPA lets the running SPA sync the shell config when it changes
// mode itself — "Connect & sign in" from local mode (server_url=…) and
// "Work locally" from a connected session (offline=1). Without it
// relay-desktop.json still says the old mode on next launch, and
// /~desktop-open can't resolve root-relative URLs. 204 on success so the
// SPA can tell it apart from a real server's SPA fallback (200 HTML). GET
// only: WebKitGTK can drop POST bodies.
func (a *App) configFromSPA(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if err := a.applyChoice(q.Get("server_url"), q.Get("offline") == "1"); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// applyChoice persists the connect-screen choice and hot-swaps the handler.
func (a *App) applyChoice(serverURL string, offline bool) error {
	if offline {
		if !offlineAvailable() {
			return fmt.Errorf("offline bundle not included in this build")
		}
		a.cfg.ServerURL = ""
		a.cfg.Offline = true
	} else {
		raw := strings.TrimSpace(serverURL)
		if !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
			raw = "https://" + raw
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return fmt.Errorf("invalid server URL")
		}
		a.cfg.ServerURL = strings.TrimRight(u.String(), "/")
		a.cfg.Offline = false
	}
	if err := a.cfg.save(); err != nil {
		return fmt.Errorf("could not save config: %s", err)
	}
	a.handler.Store(a.buildHandler())
	return nil
}

// serveChoiceBridge runs between applying a connect-screen choice and the
// reload into the app. The SPA reads its mode from localStorage on this same
// origin (net.ts: relay.local / relay.token / relay.serverUrl), so the bridge
// aligns it: offline mirrors enterLocal(); connect mirrors a clean same-origin
// session — no local flag, no stale token, no stale serverUrl — so the SPA
// talks through the proxy instead of booting a leftover local workspace or
// calling an old URL cross-origin.
func serveChoiceBridge(w http.ResponseWriter, offline bool) {
	script := `localStorage.removeItem('relay.local');localStorage.removeItem('relay.token');localStorage.setItem('relay.serverUrl','')`
	if offline {
		script = `localStorage.setItem('relay.local','1');localStorage.removeItem('relay.token')`
	}
	w.Header().Set("Content-Type", "text/html")
	_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Relay</title>
<script>try{%s}catch(e){}location.replace('/')</script>
<noscript><meta http-equiv="refresh" content="0;url=/"></noscript>
<p style="font:14px system-ui;color:#9c9fa7;padding:2rem">Continuing…</p>`, script)
}

// setupPage is the once-per-machine "which server?" screen — or "work
// offline", which serves the embedded SPA and its "This device" workspace.
// Choices are accepted via POST and via GET query params: WebKitGTK's scheme
// handler can drop POST bodies, so the page prefers plain navigation.
func (a *App) setupPage(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		_ = r.ParseForm()
		offline := r.PostForm.Get("offline") == "1"
		if err := a.applyChoice(r.PostForm.Get("server_url"), offline); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		serveChoiceBridge(w, offline)
		return
	}
	if q := r.URL.Query(); q.Has("server_url") || q.Get("offline") == "1" {
		offline := q.Get("offline") == "1"
		if err := a.applyChoice(q.Get("server_url"), offline); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// Bridge page, not a bare redirect: the SPA keys local/server mode on
		// this origin's localStorage, so align it before reloading to a clean
		// URL (also keeps the choice from replaying on refresh).
		serveChoiceBridge(w, offline)
		return
	}
	offline := ""
	if offlineAvailable() {
		offline = `<button type="button" onclick="location.search='?offline=1'">Work offline — this device only</button>`
	}
	w.Header().Set("Content-Type", "text/html")
	_, _ = fmt.Fprintf(w, `<!doctype html>
<meta charset="utf-8">
<title>Relay — connect</title>
<style>
  body{background:#0a0a0b;color:#e9e9eb;font:14px/1.5 system-ui;display:flex;
       align-items:center;justify-content:center;min-height:100vh;margin:0}
  .wrap{display:flex;flex-direction:column;gap:10px;width:320px}
  form{display:flex;flex-direction:column;gap:10px}
  h2{margin:0;font-size:18px}
  input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #232427}
  input{background:#131416;color:#e9e9eb}
  button{background:#06b6d4;color:#062a30;font-weight:600;border:0;cursor:pointer}
  .wrap>button{background:transparent;color:#9c9fa7;border-color:#232427}
  small{color:#9c9fa7}
</style>
<div class="wrap">
<form method="get" action="/">
  <h2>Connect to a Relay server</h2>
  <input name="server_url" placeholder="https://relay.example.com" autofocus required>
  <button>Connect</button>
  <small>Self-hosted URL — or http://localhost:8080 while developing.</small>
</form>
%s
</div>`, offline)
}
