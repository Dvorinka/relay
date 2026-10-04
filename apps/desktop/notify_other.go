//go:build !windows

package main

import "errors"

// The real Windows toast lives in notify_windows.go; elsewhere the call is
// unreachable — Notify's GOOS switch only routes here on windows.
func notifyWindows(_, _ string) error {
	return errors.New("windows toasts are windows-only")
}
