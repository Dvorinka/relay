package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

// web/dist holds the built SPA (copied from apps/web/dist in CI). Only a stub
// index.html is committed so plain `go build` still compiles — release builds
// ship the real bundle and enable "work offline" on the connect screen.
//
//go:embed web
var webFS embed.FS

func main() {
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
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			Theme:                windows.SystemDefault,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
