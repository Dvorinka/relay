//go:build windows

package main

import (
	"os"
	"path/filepath"
	"sync"

	toast "git.sr.ht/~jackmordaunt/go-toast/v2"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

var registerAppID sync.Once

// installToastCallback makes clicking a toast restore the window — without
// it activation is swallowed and hidden-mode alerts lead nowhere.
func installToastCallback(a *App) {
	toast.SetActivationCallback(func(_ string, _ []toast.UserData) {
		if a.ctx != nil {
			wailsruntime.WindowShow(a.ctx)
			wailsruntime.WindowUnminimise(a.ctx)
		}
	})
}

// notifyWindows raises a real Windows toast — title, body, IM sound, Action
// Center entry. WebView2 never displays the DOM Notification API, so the SPA
// routes through this bound method. The AppID is registered in HKCU first so
// the toast groups under "Relay" with the exe icon; the COM push works
// unpackaged, with a PowerShell fallback when COM is unavailable.
func notifyWindows(title, body string) error {
	var appIDErr error
	registerAppID.Do(func() {
		data := toast.AppData{AppID: "Relay"}
		if exe, err := os.Executable(); err == nil {
			if abs, err := filepath.Abs(exe); err == nil {
				data.IconPath = abs
				data.ActivationExe = abs
			}
		}
		appIDErr = toast.SetAppData(data)
	})
	n := toast.Notification{
		AppID: "Relay",
		Title: title,
		Body:  body,
		// Silent — the webview plays the user's picked sound; the toast's
		// own chime would double it.
		Audio: toast.Silent,
	}
	if exe, err := os.Executable(); err == nil {
		if abs, err := filepath.Abs(exe); err == nil {
			n.Icon = abs
		}
	}
	err := n.Push()
	if appIDErr != nil && err != nil {
		return appIDErr
	}
	return err
}
