//go:build linux

package main

import (
	_ "embed"
	"runtime"

	systray "fyne.io/systray"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Linux twin of tray_windows.go — same menu, different icon format and
// mechanism: fyne/systray speaks StatusNotifierItem over D-Bus (pure Go via
// godbus). KDE/wlroots show it natively; GNOME needs an AppIndicator
// extension — without one systray.Run simply never surfaces an icon, which
// fails harmlessly (the app is still reachable via its window/dock).
//
//go:embed build/appicon.png
var trayIcon []byte

func (a *App) startTray() {
	if !a.trayStarted.CompareAndSwap(false, true) {
		return
	}
	go func() {
		runtime.LockOSThread()
		systray.Run(a.trayReady, func() {})
	}()
}

func (a *App) stopTray() {
	if a.trayStarted.CompareAndSwap(true, false) {
		systray.Quit()
	}
}

func (a *App) trayReady() {
	systray.SetIcon(trayIcon)
	systray.SetTooltip("Relay")
	systray.SetOnTapped(a.showWindow)
	open := systray.AddMenuItem("Open Relay", "Restore the Relay window")
	systray.AddSeparator()
	updates := systray.AddMenuItem(
		"Check for updates",
		"Check GitHub for a newer Relay release",
	)
	systray.AddSeparator()
	quit := systray.AddMenuItem("Quit Relay", "Exit Relay")
	go func() {
		for {
			select {
			case <-open.ClickedCh:
				a.showWindow()
			case <-updates.ClickedCh:
				a.showWindow()
				if a.ctx != nil {
					wailsruntime.EventsEmit(a.ctx, "relay:check-updates")
				}
			case <-quit.ClickedCh:
				a.Quit()
			}
		}
	}()
}

// showWindow restores a hidden/minimised window — same path the
// single-instance relaunch takes.
func (a *App) showWindow() {
	if a.ctx == nil {
		return
	}
	wailsruntime.WindowShow(a.ctx)
	wailsruntime.WindowUnminimise(a.ctx)
}
