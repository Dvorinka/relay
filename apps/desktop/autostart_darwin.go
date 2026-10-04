//go:build darwin

package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// launchd per-user agent: ~/Library/LaunchAgents with RunAtLoad is the
// sanctioned way to start a GUI app on login without entitlements.
func autostartPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", "dev.relay.app.plist"), nil
}

func autostartEnabled() (bool, error) {
	p, err := autostartPath()
	if err != nil {
		return false, err
	}
	_, err = os.Stat(p)
	if os.IsNotExist(err) {
		return false, nil
	}
	return err == nil, err
}

func setAutostart(on bool) error {
	p, err := autostartPath()
	if err != nil {
		return err
	}
	if !on {
		err = os.Remove(p)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	abs, err := filepath.Abs(exe)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.relay.app</string>
  <key>ProgramArguments</key>
  <array><string>%s</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`, abs)
	return os.WriteFile(p, []byte(plist), 0o644)
}
