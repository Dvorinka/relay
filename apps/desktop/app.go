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
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const configName = "relay-desktop.json"

type Config struct {
	ServerURL string `json:"server_url"`
	// Offline serves the embedded SPA ("This device" workspace) instead of
	// proxying a server.
	Offline bool `json:"offline"`
	// RunInBackground keeps the process alive when the window closes so SSE
	// stays connected and mention/reply toasts keep arriving. Relaunching
	// the exe (single-instance) shows the window again.
	RunInBackground bool `json:"run_in_background"`
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
	cfg      *Config
	ctx      context.Context
	handler  atomic.Value // stores http.Handler; swapped when a URL is saved
	quitting atomic.Bool  // set by Quit — lets OnBeforeClose distinguish "close window" from "exit app"
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	if a.cfg.ServerURL != "" {
		wailsruntime.WindowSetTitle(ctx, "Relay")
	}
	installToastCallback(a)
	// Cold start from a relay:// link — the SPA listens for this event and
	// routes to it (registered by the OS scheme handler at install time).
	if link := deepLinkArg(os.Args[1:]); link != "" {
		a.emitDeepLink(link)
	}
}

// emitDeepLink hands a relay:// URL to the webview. The SPA may not have
// finished loading, so emit after a short delay as well — listeners attach
// during boot and wails queues nothing.
func (a *App) emitDeepLink(raw string) {
	if a.ctx == nil {
		return
	}
	wailsruntime.EventsEmit(a.ctx, "relay:deeplink", raw)
	go func() {
		time.Sleep(1200 * time.Millisecond)
		wailsruntime.EventsEmit(a.ctx, "relay:deeplink", raw)
	}()
}

// Version reports the binary's release tag ("dev" on plain builds). Bound as
// window.go.main.App.Version so update checks compare the thing that actually
// gets reinstalled — not the SPA bundle, which can come from the server.
func (a *App) Version() string {
	return version
}

// Platform reports runtime.GOOS — bound so the SPA can offer self-update only
// where the Go side implements it.
func (a *App) Platform() string {
	return runtime.GOOS
}

// SelfUpdate downloads the release asset for this platform and installs it.
// Bound as window.go.main.App.SelfUpdate(tag). Windows runs the NSIS setup
// silent — it taskkills this process, reinstalls, and relaunches via
// /SELFUPDATE. Linux swaps the binary in place and re-execs. The SPA only
// offers the button on supported platforms.
func (a *App) SelfUpdate(tag string) error {
	tag = strings.TrimSpace(tag)
	if !tagRe.MatchString(tag) {
		return errors.New("invalid release tag")
	}
	ver := strings.TrimPrefix(tag, "v")
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	const repo = "https://github.com/Dvorinka/relay/releases/download"
	switch runtime.GOOS {
	case "windows":
		tmp := filepath.Join(os.TempDir(), "Relay-Setup-"+ver+".exe")
		if err := downloadFile(tmp, repo+"/"+tag+"/Relay-Setup-"+ver+".exe"); err != nil {
			return err
		}
		// /S silent + /SELFUPDATE: the installer kills this exe, installs, and
		// its .onInstSuccess relaunches us — fully unattended.
		if err := exec.Command(tmp, "/S", "/SELFUPDATE").Start(); err != nil {
			return err
		}
	case "linux":
		tmp := exe + ".new"
		// Versioned assets shipped from v1.0.36; older releases use the
		// unversioned name — try both so the transition release updates.
		if err := downloadFile(tmp, repo+"/"+tag+"/relay-desktop-"+ver+"-linux-amd64"); err != nil {
			if err := downloadFile(tmp, repo+"/"+tag+"/relay-desktop-linux-amd64"); err != nil {
				return err
			}
		}
		if err := os.Chmod(tmp, 0o755); err != nil {
			return err
		}
		// Rename over a running binary is legal on Linux; the old inode stays
		// mapped until the process exits.
		if err := os.Rename(tmp, exe); err != nil {
			return err
		}
		// A direct Start() races the single-instance lock: the child sees us
		// still running, forwards its args to the dying process, and exits —
		// nothing left running. Wait for our exit before re-execing.
		wait := fmt.Sprintf(
			"while kill -0 %d 2>/dev/null; do sleep 0.2; done; exec '%s'",
			os.Getpid(), strings.ReplaceAll(exe, "'", `'\''`))
		if err := exec.Command("sh", "-c", wait).Start(); err != nil {
			return err
		}
	default:
		return fmt.Errorf("self-update not supported on %s", runtime.GOOS)
	}
	a.Quit()
	return nil
}

var tagRe = regexp.MustCompile(`^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)

// downloadFile streams a release asset to disk. GitHub release downloads 302
// to the CDN — the default client follows redirects.
func downloadFile(dst, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" {
		return errors.New("refusing non-https download")
	}
	resp, err := http.Get(rawURL)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, io.LimitReader(resp.Body, 512<<20)); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// Quit is bound on window.go.main.App — the only way out while
// run_in_background is on (every other close path just hides the window).
func (a *App) Quit() {
	a.quitting.Store(true)
	if a.ctx != nil {
		wailsruntime.Quit(a.ctx)
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
	mux.HandleFunc("/~desktop-autostart", a.autostart)
	mux.HandleFunc("/~desktop-background", a.background)
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

// ServerConfig exposes the shell's configured server to the SPA. A bound
// method rather than a fetch path because the SPA's service worker can
// intercept same-origin fetches on wails.localhost — the proxied SPA clears
// localStorage relay.serverUrl, so browser sign-in needs this to learn the
// real URL it should open in the system browser.
func (a *App) ServerConfig() map[string]any {
	return map[string]any{
		"server_url": a.cfg.ServerURL,
		"offline":    a.cfg.Offline,
	}
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

// autostart reports and toggles launch-at-login for the Settings page.
// GET returns {enabled, supported}; POST ?enabled=1|0 writes the per-OS
// mechanism (HKCU Run key on Windows, freedesktop entry on Linux,
// LaunchAgent on macOS) and returns the same shape.
func (a *App) autostart(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		if err := setAutostart(r.URL.Query().Get("enabled") == "1"); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	on, err := autostartEnabled()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"enabled":   on,
		"supported": true,
	})
}

// background reports/toggles close-to-background mode: the desktop's answer
// to "push when the app is closed". With it on, closing the window hides it
// instead of quitting — the SSE stream stays connected and toasts keep
// arriving. Relaunching the app hits the single-instance lock and re-shows
// the window. GET returns {enabled}; POST ?enabled=1|0 persists the flag.
func (a *App) background(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		a.cfg.RunInBackground = r.URL.Query().Get("enabled") == "1"
		if err := a.cfg.save(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"enabled": a.cfg.RunInBackground,
	})
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

// Notify raises an OS notification from the SPA — the webview's
// Notification API doesn't exist under WebKitGTK and WebView2 toasts only
// honor the same permission flow, so foreground alerts cross the bridge.
// Bound as window.go.main.App.Notify.
func (a *App) Notify(title, body string) error {
	title = strings.TrimSpace(title)
	if title == "" {
		return errors.New("title required")
	}
	if len(title) > 200 {
		title = title[:200]
	}
	if len(body) > 500 {
		body = body[:500]
	}
	switch runtime.GOOS {
	case "linux":
		if path, err := exec.LookPath("notify-send"); err == nil {
			return exec.Command(path, "-a", "Relay", title, body).Run()
		}
	case "darwin":
		if path, err := exec.LookPath("osascript"); err == nil {
			script := fmt.Sprintf(`display notification %q with title %q`, body, title)
			return exec.Command(path, "-e", script).Run()
		}
	case "windows":
		// WebView2 never displays the DOM Notification API — a real toast
		// goes through COM via go-toast (see notify_windows.go).
		return notifyWindows(title, body)
	}
	return errors.New("no notification facility on this platform")
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
	if q.Get("server_url") == "" && q.Get("offline") == "" {
		// Read path: the proxied SPA can't see the configured server (its
		// localStorage relay.serverUrl is cleared by the choice bridge), so
		// flows that need the real URL — browser sign-in opens it in the
		// system browser — ask the shell for it.
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"server_url": a.cfg.ServerURL,
			"offline":    a.cfg.Offline,
		})
		return
	}
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
	// Local mode is always offered; without the embedded SPA bundle the button
	// explains why it's disabled instead of vanishing silently.
	offline := `<button type="button" disabled
	  title="Local mode needs a build that embeds the web app — release builds include it">
	  Work offline — this device only</button>
	<small>Local mode needs a bundled web app — release builds include one.</small>`
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
  .wrap>button:disabled{opacity:.45;cursor:not-allowed}
  small{color:#9c9fa7}
</style>
<div class="wrap">
<form method="get" action="/">
  <h2>Connect to a Relay server</h2>
  <input name="server_url" placeholder="https://relay.example.com" autofocus required>
  <button>Connect</button>
  <small>Self-hosted URL — or http://localhost:8080 while developing.
  After connecting, sign in in the app or through your browser.</small>
</form>
%s
</div>`, offline)
}
