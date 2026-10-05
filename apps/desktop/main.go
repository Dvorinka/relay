package main

import (
	"context"
	"embed"
	"log"
	"os"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// web/dist holds the built SPA (copied from apps/web/dist in CI). Only a stub
// index.html is committed so plain `go build` still compiles — release builds
// ship the real bundle and enable "work offline" on the connect screen.
//
//go:embed web
var webFS embed.FS

// version is stamped by release CI (-ldflags "-X main.version=vX.Y.Z"); a
// plain `go build` reports "dev" and can't be compared for update checks.
var version = "dev"

// deepLinkArg returns the first relay:// URL in argv, if any — Windows and
// Linux pass it as the lone argument when the OS opens a registered scheme.
func deepLinkArg(args []string) string {
	for _, arg := range args {
		if strings.HasPrefix(arg, "relay://") {
			return arg
		}
	}
	return ""
}

func main() {
	// WebKitGTK's dmabuf renderer paints a black window on some
	// Wayland/GPU combinations; fall back unless the user opted out.
	if _, ok := os.LookupEnv("WEBKIT_DISABLE_DMABUF_RENDERER"); !ok {
		_ = os.Setenv("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
	}
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	app := &App{cfg: cfg}
	app.handler.Store(app.buildHandler())

	err = wails.Run(&options.App{
		Title:  "Relay",
		Width:  1280,
		Height: 800,
		AssetServer: &assetserver.Options{
			// No embedded assets: an embedded index.html wins the AssetServer's
			// file-first lookup and shadows "/" (the "Loading…" placeholder bug).
			// With Assets unset every webview request reaches the app — API calls
			// proxy to the configured server, everything else gets the setup page.
			Handler: app,
		},
		Bind:             []any{app},
		BackgroundColour: &options.RGBA{R: 10, G: 10, B: 11, A: 255},
		OnStartup:        app.startup,
		// Close-to-background: with run_in_background on, closing the window
		// hides it — notifications keep working. Single-instance relaunch is
		// how the user brings the window back (double-clicking the exe).
		// App.Quit() sets the flag first so it can still exit for real.
		OnBeforeClose: func(ctx context.Context) bool {
			if app.cfg.RunInBackground && !app.quitting.Load() {
				wailsruntime.WindowHide(ctx)
				return true
			}
			return false
		},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "dev.tdvorak.relay",
			OnSecondInstanceLaunch: func(data options.SecondInstanceData) {
				if app.ctx != nil {
					wailsruntime.WindowShow(app.ctx)
					wailsruntime.WindowUnminimise(app.ctx)
					wailsruntime.WindowSetAlwaysOnTop(app.ctx, true)
					wailsruntime.WindowSetAlwaysOnTop(app.ctx, false)
					// A relay:// launch against a running instance delivers
					// the URL here instead of a fresh argv.
					if link := deepLinkArg(data.Args); link != "" {
						app.emitDeepLink(link)
					}
				}
			},
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			Theme:                windows.SystemDefault,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
