package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const configName = "relay-desktop.json"

type Config struct {
	ServerURL string `json:"server_url"`
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
	a.handler.Store(a.buildHandler())
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
	if a.cfg.ServerURL == "" {
		mux.Handle("/", http.HandlerFunc(a.setupPage))
		return mux
	}
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
	return mux
}

// setupPage is the once-per-machine "which server?" screen.
func (a *App) setupPage(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		raw := strings.TrimSpace(r.FormValue("server_url"))
		if !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
			raw = "https://" + raw
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			http.Error(w, "invalid server URL", http.StatusBadRequest)
			return
		}
		a.cfg.ServerURL = strings.TrimRight(u.String(), "/")
		if err := a.cfg.save(); err != nil {
			http.Error(w, "could not save config: "+err.Error(), http.StatusInternalServerError)
			return
		}
		a.handler.Store(a.buildHandler())
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintln(w, "ok")
		return
	}
	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, `<!doctype html>
<meta charset="utf-8">
<title>Relay — connect</title>
<style>
  body{background:#0a0a0b;color:#e9e9eb;font:14px/1.5 system-ui;display:flex;
       align-items:center;justify-content:center;min-height:100vh;margin:0}
  form{display:flex;flex-direction:column;gap:10px;width:320px}
  h2{margin:0;font-size:18px}
  input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #232427}
  input{background:#131416;color:#e9e9eb}
  button{background:#06b6d4;color:#062a30;font-weight:600;border:0;cursor:pointer}
  small{color:#9c9fa7}
</style>
<form method="post" onsubmit="event.preventDefault();fetch(location.pathname,{method:'post',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({server_url:this.server_url.value})}).then(r=>r.ok?location.reload():r.text().then(alert))">
  <h2>Connect to a Relay server</h2>
  <input name="server_url" placeholder="https://relay.example.com" autofocus required>
  <button>Connect</button>
  <small>Self-hosted URL — or http://localhost:8080 while developing.</small>
</form>`)
}
