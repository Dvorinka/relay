//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// Freedesktop autostart: a .desktop entry in ~/.config/autostart is honored
// by GNOME, KDE, XFCE and friends. Removing the file disables it.
func autostartPath() (string, error) {
	cfg, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cfg, "autostart", "relay.desktop"), nil
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
	entry := fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=Relay
Comment=Relay desktop client
Exec=%q
Terminal=false
X-GNOME-Autostart-enabled=true
`, abs)
	return os.WriteFile(p, []byte(entry), 0o644)
}
