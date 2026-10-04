#!/bin/sh
# Per-user install: binary, icon, and a launcher entry that works from the
# app grid (absolute Exec — DEs don't guarantee ~/.local/bin on PATH).
# Run from apps/desktop after `wails build`.
set -eu

src="$(cd "$(dirname "$0")/.." && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
bin="$HOME/.local/bin"
apps="$data/applications"
icons="$data/icons/hicolor/256x256/apps"

mkdir -p "$bin" "$apps" "$icons"
cp "$src/build/bin/relay-desktop" "$bin/relay-desktop"
cp "$src/build/appicon.png" "$icons/relay.png"

cat > "$apps/relay.desktop" <<EOF
[Desktop Entry]
Name=Relay
Comment=Relay desktop client
Exec=$bin/relay-desktop
Icon=relay
Type=Application
Categories=Network;Chat;
StartupWMClass=relay-desktop
EOF

command -v update-desktop-database >/dev/null 2>&1 &&
	update-desktop-database "$apps" || true
command -v gtk-update-icon-cache >/dev/null 2>&1 &&
	gtk-update-icon-cache -q "$data/icons/hicolor" 2>/dev/null || true

echo "Installed. Launch 'Relay' from your app grid, or: $bin/relay-desktop"
