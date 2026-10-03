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
debug-signed APK attached to the release. Debug-signed APKs install on
any device but can't be updated over an existing install with a
different signature — for store distribution use EAS:

```bash
npx eas-cli build --platform android --profile production
```

requires an Expo account (`EXPO_TOKEN` or `eas login`).

Local build:

```bash
npx expo prebuild --platform android --no-install
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```
