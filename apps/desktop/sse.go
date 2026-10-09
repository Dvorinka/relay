package main

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// sseIdleTimeout bounds how long a single read may block waiting for the
// next line. The server emits heartbeat data frames every 25s, so silence
// beyond this means the stream is silently dead — reconnect.
var sseIdleTimeout = 90 * time.Second

// Server-sent events do not reach the webview: the asset-server proxy hands
// the response to WebView2/WebKitGTK as a buffered stream, so EventSource
// never fires onmessage (the connection never closes). Live updates instead
// ride the wails event bus — SubscribeEvents runs the SSE client in Go and
// re-emits every data frame as "relay:sse".

var (
	sseMu     sync.Mutex
	sseCancel context.CancelFunc
)

// SubscribeEvents starts (or restarts) the SSE pump with the SPA's session
// token. Bound as window.go.main.App.SubscribeEvents; called by events.ts
// whenever the web client would open an EventSource.
func (a *App) SubscribeEvents(token string) {
	sseMu.Lock()
	defer sseMu.Unlock()
	if sseCancel != nil {
		sseCancel()
		sseCancel = nil
	}
	if a.ctx == nil || a.cfg.ServerURL == "" || token == "" {
		return
	}
	ctx, cancel := context.WithCancel(a.ctx)
	sseCancel = cancel
	emit := func(data string) {
		wailsruntime.EventsEmit(a.ctx, "relay:sse", data)
	}
	go a.pumpEvents(ctx, token, emit)
}

// StopEvents cancels the pump — called when the SPA drops all subscribers
// (logout, workspace switch). Bound as window.go.main.App.StopEvents.
func (a *App) StopEvents() {
	sseMu.Lock()
	defer sseMu.Unlock()
	if sseCancel != nil {
		sseCancel()
		sseCancel = nil
	}
}

func (a *App) pumpEvents(
	ctx context.Context,
	token string,
	emit func(string),
) {
	target := strings.TrimRight(a.cfg.ServerURL, "/") +
		"/api/events?access_token=" + url.QueryEscape(token)
	backoff := time.Second
	for ctx.Err() == nil {
		connected := a.streamEvents(ctx, target, emit)
		if connected {
			backoff = time.Second
		} else {
			backoff = min(backoff*2, 30*time.Second)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
	}
}

// streamEvents reads one SSE connection to its end; the bool reports whether
// the server accepted the stream (so reconnect backoff only grows on real
// failures, not clean mid-stream EOFs).
func (a *App) streamEvents(
	ctx context.Context,
	target string,
	emitFn func(string),
) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return false
	}
	// Grab the conn so reads get an idle deadline — a half-open stream
	// (NAT/proxy drop, tunnel restart) blocks ReadString forever, and only
	// ctx cancellation would ever unblock it.
	var conn net.Conn
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) { conn = info.Conn },
	}))
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	br := bufio.NewReaderSize(resp.Body, 64<<10)
	defer func() {
		if conn != nil {
			// Clear the deadline so a keep-alive-reused conn isn't poisoned.
			_ = conn.SetReadDeadline(time.Time{})
		}
	}()
	var data strings.Builder
	dispatch := func() {
		if data.Len() == 0 {
			return
		}
		emitFn(data.String())
		data.Reset()
	}
	for {
		if conn != nil {
			_ = conn.SetReadDeadline(time.Now().Add(sseIdleTimeout))
		}
		line, err := br.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimRight(line, "\r\n")
			switch {
			case line == "":
				dispatch()
			case strings.HasPrefix(line, "data:"):
				if data.Len() > 0 {
					data.WriteByte('\n')
				}
				data.WriteString(strings.TrimPrefix(line[5:], " "))
			default:
				// event:, id:, retry:, comments — the SPA only consumes data.
			}
		}
		if err != nil {
			dispatch()
			return true
		}
	}
}
