//go:build windows

package main

import (
	_ "embed"

	"github.com/getlantern/systray"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// The tray icon is the visible handle for a backgrounded Relay: with
// run_in_background on, closing the window hides it and the icon lives in
// the hidden-icons overflow — "Show" restores the window, "Quit" exits for
// real (App.Quit flips app.quitting so OnBeforeClose lets it through).
//
//go:embed build/windows/icon.ico
var trayIcon []byte

func (a *App) startTray() {
	if !a.trayStarted.CompareAndSwap(false, true) {
		return
	}
	// Register (not Run): the webview's message pump services the tray's
	// window on this thread; Register parks its own loop on a goroutine.
	go systray.Register(a.trayReady, func() {})
}

func (a *App) stopTray() {
	if a.trayStarted.CompareAndSwap(true, false) {
		systray.Quit()
	}
}

func (a *App) trayReady() {
	systray.SetIcon(trayIcon)
	systray.SetTooltip("Relay")
	show := systray.AddMenuItem("Show Relay", "Restore the Relay window")
	quit := systray.AddMenuItem("Quit Relay", "Exit Relay")
	go func() {
		for {
			select {
			case <-show.ClickedCh:
				a.showWindow()
			case <-quit.ClickedCh:
				a.Quit()
			}
		}
	}()
}

// showWindow restores a hidden/minimised window — same dance the
// single-instance relaunch does.
func (a *App) showWindow() {
	if a.ctx == nil {
		return
	}
	wailsruntime.WindowShow(a.ctx)
	wailsruntime.WindowUnminimise(a.ctx)
	wailsruntime.WindowSetAlwaysOnTop(a.ctx, true)
	wailsruntime.WindowSetAlwaysOnTop(a.ctx, false)
}
