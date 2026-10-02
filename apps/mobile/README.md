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
- **Projects** — list with pull-to-refresh
- **Conversation** — messages, agent badges, inline images, attachment
  picker (`+`), 4s polling refresh
- **Issues** — status chips; tap a status to advance the issue
- **Work list** — agent-managed todos for the project

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

```bash
npx eas-cli build --platform android --profile production
```

requires an Expo account (`EXPO_TOKEN` or `eas login`).
