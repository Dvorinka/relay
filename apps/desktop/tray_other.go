//go:build !windows && !linux

package main

// Tray support ships on Windows and Linux (StatusNotifierItem over D-Bus).
// macOS keeps its own dock conventions; other platforms get stubs so the
// call sites stay platform-free.
func (a *App) startTray() {}
func (a *App) stopTray()  {}
