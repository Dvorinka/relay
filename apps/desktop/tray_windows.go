//go:build windows

package main

import (
	_ "embed"
	"fmt"
	"runtime"

	systray "fyne.io/systray"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// The tray icon is the visible handle for a backgrounded Relay: with
// run_in_background on, closing the window hides it and the icon lives in
// the hidden-icons overflow.
//
// Click behaviour: a left click (and therefore a double-click, which is two
// taps) restores the window via SetOnTapped; a right click opens the menu —
// Open Relay / Check for updates / Quit Relay. "Check for updates" emits
// relay:check-updates to the SPA, which runs its GitHub release check and
// lights the update badge; the window comes forward so the result is
// visible. "Quit" exits for real (App.Quit flips app.quitting so
// OnBeforeClose lets it through).
//
//go:embed build/windows/icon.ico
var trayIcon []byte

func (a *App) startTray() {
	if !a.trayStarted.CompareAndSwap(false, true) {
		return
	}
	// The tray window must live on a thread that pumps its messages —
	// Register alone creates it on a goroutine that immediately exits, which
	// leaves a dead icon (shows, never answers clicks). Run = Register +
	// nativeLoop; the locked OS thread keeps the pump alive for good.
	// Ceiling: systray.Quit is once-per-process, so toggling background
	// mode off->on->off leaves a stale icon until restart.
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
	a.trayLive.Store(true)
	systray.SetIcon(trayIcon)
	systray.SetTooltip("Relay")
	systray.SetOnTapped(a.showWindow)
	a.applyUnread()
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

// setTrayUnread reflects the unread count in the tray tooltip. A real
// taskbar overlay icon needs ITaskbarList3::SetOverlayIcon — COM work the
// window-title badge mostly covers; add only if tooltip+title proves too
// subtle in practice.
// jarvis: ceiling is tooltip text, upgrade if unread visibility complaints.
func (a *App) setTrayUnread(n int64) {
	if !a.trayLive.Load() {
		return
	}
	if n <= 0 {
		systray.SetTooltip("Relay")
		return
	}
	systray.SetTooltip(fmt.Sprintf("Relay — %d unread", n))
}

// showWindow restores a hidden/minimised window — same path the
// single-instance relaunch takes. WindowShow already calls
// SetForegroundWindow + SetFocus, so no always-on-top toggle dance: a
// stuck TOPMOST flag is what made the window sit over everything and
// broke alt-tab.
func (a *App) showWindow() {
	if a.ctx == nil {
		return
	}
	wailsruntime.WindowShow(a.ctx)
	wailsruntime.WindowUnminimise(a.ctx)
}
