# Relay for Android

A thin Expo shell that embeds the server's web UI in a WebView — the phone
app is the web app, so UX parity is automatic and every web fix ships to
mobile without a rebuild.

## What it does

- First launch asks for the server URL (e.g. `relay.example.com` — https is
  assumed); stored in AsyncStorage under `relay.serverUrl`.
- Loads the server origin in a `react-native-webview`. Login, chat, issues,
  reviews — everything — is the web UI; the WebView keeps cookies and
  localStorage, so sign-in persists.
- Same-origin links stay inside; everything else (auth providers, external
  links) opens in the system browser.
- Hardware back walks WebView history; pull-to-refresh is enabled.
- `relay://open/<path>` links (scheme `relay` in `app.json`) deep-link into
  the matching web route.

## Native integration

The shell is a real Android app around the WebView, not a PWA:

- **Notifications** — a `Notification` shim is injected into the page; the
  web app's notifications arrive as Android notifications (`POST_NOTIFICATIONS`
  is requested when the web app asks for permission).
- **Downloads** — `onFileDownload` intercepts attachment downloads, fetches
  them natively with the session token, and saves images/video to the
  gallery (`expo-media-library`) or opens the system share sheet
  (`expo-sharing`) for other files.
- **Share target** — the app registers for `ACTION_SEND` (`text/*`,
  `image/*`) and `ACTION_SEND_MULTIPLE` (`image/*`). Sharing a screenshot
  or link to Relay opens a native sheet: pick a project, add a note, and
  the content is uploaded as attachments and posted to the project
  conversation (`expo-share-intent`).
- **Session bridge** — the page posts `relay.token` from localStorage to
  the native layer on every load, so the share sheet and downloader call
  the same REST endpoints the SPA does (`src/lib/relay.ts`).

The old fully-native screens were retired — maintaining a second parallel
client duplicated every feature badly. Remaining gap: background push —
notifications fire only while the app is alive.

## Requirements

- Node 20+, `npx expo` (bundled)
- For emulator testing: Android SDK with an AVD
- For a physical device: a dev build (`react-native-webview` is a native
  module — Expo Go's bundled modules are not enough)

## Run

```bash
npm install
npx expo prebuild --platform android   # generates android/ (CNG)
npx expo run:android                   # dev build on device/emulator
```

On an emulator, enter `http://10.0.2.2:8080` as the server — the host
machine's loopback where a local Relay backend listens.

## Production build

Every `v*` tag builds `relay-android-<ver>.apk` in CI (`release.yml` →
`apk` job): `expo prebuild` generates `android/`, then Gradle assembles a
**release** APK with the JS bundle embedded — it installs and runs
standalone, no Metro. The job builds only `arm64-v8a`
(`reactNativeArchitectures`) — modern phones are all arm64, and compiling
every ABI roughly quadruples Gradle time — and caches Gradle between runs.

### Signing

`plugins/withReleaseSigning.js` adds a `release` signing config at
prebuild time. When `android/app/release.keystore` exists, the release
build is signed with it; otherwise it falls back to the generated debug
key (still installable, but the signature differs per machine — updates
fail over installs signed with another key).

CI decodes the keystore from secrets:

| Secret | Contents |
|---|---|
| `ANDROID_KEYSTORE_B64` | `base64 -w0 release.keystore` output |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password (alias `relay`) |

`RELAY_VERSION_CODE` overrides `versionCode` — CI sets it to
`GITHUB_RUN_NUMBER` so every release upgrades over the previous APK.

To build a signed release locally, drop your keystore at
`android/app/release.keystore` after prebuild and set
`RELAY_KEYSTORE_PASSWORD` (and `RELAY_KEY_ALIAS` if not `relay`):

```bash
npx expo prebuild --platform android --no-install
cp /path/to/release.keystore android/app/release.keystore
cd android && RELAY_KEYSTORE_PASSWORD=… ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

Generate a keystore once and keep it safe — losing it means existing
installs can never be updated:

```bash
keytool -genkeypair -v -keystore release.keystore -alias relay \
  -keyalg RSA -keysize 4096 -validity 10950
```

For Play Store distribution later, use EAS (`npx eas-cli build
--platform android --profile production`, needs `EXPO_TOKEN`).
