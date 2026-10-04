# Relay for Android

Expo (React Native) client for Relay — projects, conversations with
image attachments, issues, and the agent work list.

## Requirements

- Node 20+, `npx expo` (bundled)
- For emulator testing: Android SDK with an AVD
- For a physical device: Expo Go from the Play Store, or a dev build

## Run

```bash
npm install
npx expo start --host localhost
# press `a` to open on a connected Android device/emulator (Expo Go),
# or `w` for the web build
```

On an emulator, the app defaults to `http://10.0.2.2:8080` — the host
machine's loopback where a local Relay backend listens. On a physical
device, enter your Relay server URL on the login screen
(e.g. `https://relay.example.com`).

## Screens

- **Login** — server URL + email/password (session cookie auth)
- **Projects** — list with pull-to-refresh, unread + pending-review badges,
  header links to Inbox and Settings
- **Inbox** — reviews awaiting your verdict (tap through to approve or
  request changes) plus @mentions
- **Conversation** — grouped timeline with avatars, day separators, reply
  strips, reaction pills, `(edited)` markers, markdown (bold/italic/code/
  fenced blocks), inline images, staged attachments (`+`), long-press
  action sheet (reply / react / edit — edit locks once an agent has read
  the message), 4s polling refresh
- **Offline outbox** — sends that fail without connectivity queue in
  AsyncStorage (text + local image picks) and drain on the next successful
  poll; queued items render as dashed cards above the timeline. Unlike
  desktop/web local mode, this is a send-only queue — full offline mode is
  intentionally not on mobile.
- **Issues** — status-colored chips; tap a status to advance the issue
- **Reviews** — pending-first review cards with approve / request-changes
  (note required) verdicts
- **Work list** — agent-managed todos for the project
- **Settings** — appearance override (System / Light / Dark, persisted),
  account, server URL, sign out

## Auth model

The app uses the same session cookie as the web app — sign in with a
regular Relay account. Because React Native's cookie jar does not
reliably survive force-stops, `src/lib/api.ts` captures `Set-Cookie` on
login, persists it in AsyncStorage, and reattaches it on every request
(including image loads).

## Notifications & deep links

`relay://` is registered as the app scheme. Push notifications are not
wired — they need an EAS project + FCM credentials; deep-link routes are
a router `Linking` mapping once URLs are defined. Tracked in `ROADMAP.md`
Phase 10 notes.

## Production build

Every `v*` tag builds `relay-android.apk` in CI (`release.yml` → `apk`
job): `expo prebuild` generates `android/`, then Gradle assembles a
**release** APK with the JS bundle embedded — it installs and runs
standalone, no Metro.

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
