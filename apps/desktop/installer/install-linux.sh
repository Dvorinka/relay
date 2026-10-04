#!/bin/sh
# Per-user install: binary, icon, and a launcher entry that works from the
# app grid (absolute Exec — DEs don't guarantee ~/.local/bin on PATH).
# Run from apps/desktop after `wails build`.
set -eu

src="$(cd "$(dirname "$0")/.." && pwd)"
web="$src/../web"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
bin="$HOME/.local/bin"
apps="$data/applications"
icons="$data/icons/hicolor"

mkdir -p "$bin" "$apps" "$icons/scalable/apps" "$icons/1024x1024/apps"
cp "$src/build/bin/relay-desktop" "$bin/relay-desktop"
# Ship the CLI with the desktop install when it was built alongside —
# `wails build ... && go build -o build/bin/relay-cli ../../cmd/relay-cli`.
# Absent is fine: the desktop app doesn't need it.
if [ -f "$src/build/bin/relay-cli" ]; then
	cp "$src/build/bin/relay-cli" "$bin/relay-cli"
fi
# Scalable SVG (crisp at every size) plus the raster fallback.
cp "$web/public/favicon.svg" "$icons/scalable/apps/relay.svg"
cp "$src/build/appicon.png" "$icons/1024x1024/apps/relay.png"

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
[ -f "$bin/relay-cli" ] && echo "CLI on PATH as: relay-cli"
