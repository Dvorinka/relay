# relay-desktop

Native desktop shell for Relay — a Wails v2 app that wraps a WebView
(WebView2 on Windows, WebKitGTK on Linux) around your Relay server.

## Design

The shell is deliberately thin: every request the webview makes flows
through a reverse proxy inside the app to the configured server
(`RELAY_URL` env or the once-per-machine setup screen, persisted to
`~/.config/relay/relay-desktop.json` / `%APPDATA%\relay\relay-desktop.json`).

Because the UI is proxied, the desktop client is never stale — it always
serves whatever the server serves, session cookies stay same-origin, and
no CORS configuration is needed.

The app embeds no UI assets. `AssetServer.Handler` receives every request —
deliberately: an embedded `index.html` would win the asset server's
file-first lookup and shadow `/` forever.

## Build

```bash
# Linux (needs libgtk-3-dev + libwebkit2gtk)
wails build

# Windows from Linux/macOS (needs mingw-w64)
wails build -platform windows/amd64 -o relay-desktop.exe
```

## Windows installer

`installer/relay.nsi` builds a per-user NSIS setup wizard — Start Menu and
desktop shortcuts, Add/Remove Programs entry, uninstaller, and an evergreen
WebView2 bootstrap when the runtime is absent. No admin rights required.

```bash
# needs nsis (apt install nsis); paths resolve relative to the .nsi file,
# so pass absolute -DEXE/-DOUTFILE
makensis -DVERSION=1.0.0 -DVI_VERSION=1.0.0.0 \
  -DEXE=/abs/path/relay-desktop-windows-amd64.exe \
  -DOUTFILE=/abs/path/Relay-Setup-1.0.0.exe \
  installer/relay.nsi
```

The release workflow produces `Relay-Setup-<version>.exe` alongside the raw
`relay-desktop-windows-amd64.exe` on every `v*` tag.

## Linux install

`installer/install-linux.sh` does a per-user install — binary to
`~/.local/bin`, icon, and a `relay.desktop` entry whose `Exec=` is an
absolute path so the app grid launch does not depend on a shell `PATH`:

```bash
wails build && ./installer/install-linux.sh
```

The binary sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` at startup unless the
variable is already defined — WebKitGTK's dmabuf renderer paints a black
window on some Wayland/GPU stacks. Export the variable with any value
(e.g. `0`) before launching to opt out.

## Code signing

Unsigned installers get hard-blocked by **Smart App Control** on fresh
Windows 11 installs ("Device Guard policy" / Enterprise signing level) —
this is a real wall, not a SmartScreen warning. Releases must be signed.

`scripts/sign-windows.sh` signs any PE in place via `osslsigncode`
(cert from `SIGNING_CERT_PFX` / `SIGNING_CERT_PASSWORD` env). Sign the exe
before packaging, then pass `-DSIGNCMD` so NSIS also signs the generated
uninstaller and the installer itself (`!finalize` / `!uninstfinalize`):

```bash
SIGNING_CERT_PFX=cert.pfx SIGNING_CERT_PASSWORD=*** ./scripts/sign-windows.sh \
  build/bin/relay-desktop-windows-amd64.exe
makensis -DSIGNCMD="bash $PWD/../../scripts/sign-windows.sh" ...
```

Release CI signs automatically when the `SIGNING_CERT_B64` (base64 PKCS#12)
and `SIGNING_CERT_PASSWORD` repo secrets are set. For a publicly trusted
chain use an OV/EV code-signing cert or Azure Trusted Signing — self-signed
certs only satisfy machines where the cert was manually added to
`LocalMachine\Root` + `TrustedPublisher`.

Icon assets (`build/appicon.png`, `build/windows/icon.ico`,
`build/windows/info.json`) are committed; `build/bin/` is generated and
ignored. The mark renders from `assets/brand/kit/relay-mark-accent-app-icon.svg`.

## Deferred

- System tray & global screenshot hotkey — need OS-specific hooks that
  don't fit the thin-shell model; revisit with a tray lib after 1.0.
- Native desktop notifications — the webview hosts the remote bundle, so
  the Wails JS bridge isn't injected; a small bundled JS snippet or the
  WebView2 notification API is the upgrade path.
- `relay://` deep links — needs platform registration (documented in
  docs/DESKTOP.md when it lands).
