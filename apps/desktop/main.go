package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

// Wails needs a frontend asset tree even though the real UI streams through
// the proxy — this ships a placeholder index.html only.
//
//go:embed frontend/dist
var assets embed.FS

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	app := &App{cfg: cfg}

	err = wails.Run(&options.App{
		Title:  "Relay",
		Width:  1280,
		Height: 800,
		AssetServer: &assetserver.Options{
			Assets: assets,
			// Everything the webview requests flows through the app: API
			// calls are proxied to the configured server, all else gets the
			// setup page until a server exists.
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
