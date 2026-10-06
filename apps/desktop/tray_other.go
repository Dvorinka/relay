//go:build !windows

package main

// Tray support ships on Windows first — that's where "close to background"
// otherwise leaves the app invisible with no way back besides relaunching.
// Linux status-notifier support is possible but needs appindicator; macOS
// keeps its own dock conventions. Stubs keep the call sites platform-free.
func (a *App) startTray() {}
func (a *App) stopTray()  {}
