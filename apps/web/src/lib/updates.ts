// App + server version display and the "check for updates" flow. The app
// version is stamped at build time (__APP_VERSION__, release tag); the
// server reports its own via /health. Update checks hit the GitHub releases
// API and are cached briefly to stay under rate limits.
import { createSignal } from "solid-js";
import {
  desktopPlatform,
  desktopSelfUpdate,
  desktopVersion,
  isDesktop,
  onCheckUpdates,
} from "./desktop";
import { net } from "./net";

export const appVersion: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

const [serverVersion, setServerVersion] = createSignal<string | null>(null);
const [latest, setLatest] = createSignal<string | null>(null);
const [checking, setChecking] = createSignal(false);
const [checked, setChecked] = createSignal(false);
const [checkError, setCheckError] = createSignal(false);

// What update checks compare against: inside the desktop shell the binary's
// own tag (the thing the installer replaces); in a plain browser the SPA's
// stamped version, which IS the server build.
const [clientVersion, setClientVersion] = createSignal(appVersion);
const [platform, setPlatform] = createSignal<DesktopPlatformLike>(null);
const [installing, setInstalling] = createSignal(false);
const [installError, setInstallError] = createSignal<string | null>(null);
type DesktopPlatformLike = "windows" | "linux" | "darwin" | null;

// "Install updates automatically" — persisted; on by default so a desktop
// install self-maintains. The actual install only ever runs at startup:
// SelfUpdate kills the process and relaunches, so mid-session installs would
// lose open work. Running it at boot lands the new version before the user
// touches anything.
const AUTO_KEY = "relay.updates.auto";
const [autoUpdate, setAutoUpdateSig] = createSignal(
  localStorage.getItem(AUTO_KEY) !== "0",
);
export function useAutoUpdate() {
  return autoUpdate;
}
export function setAutoUpdate(on: boolean) {
  setAutoUpdateSig(on);
  localStorage.setItem(AUTO_KEY, on ? "1" : "0");
}

if (isDesktop()) {
  void desktopVersion().then((v) => {
    if (v) setClientVersion(v);
  });
  void desktopPlatform().then(async (p) => {
    setPlatform(p);
    if (!canSelfUpdate()) return;
    if (autoUpdate()) {
      await checkForUpdates();
      // resolves only on failure — a successful install exits the process
      // and the new build relaunches
      if (updateAvailable()) void installUpdate();
    }
    // long-lived desktop windows surface a badge without a manual check;
    // installing still waits for the next launch
    setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000);
    // tray → "Check for updates" lights the same badge/flow
    onCheckUpdates(() => void checkForUpdates());
  });
}

const RELEASES_URL =
  "https://api.github.com/repos/Dvorinka/relay/releases/latest";
export const RELEASES_PAGE = "https://github.com/Dvorinka/relay/releases/latest";
const CACHE_KEY = "relay.latestRelease";
const CACHE_MS = 5 * 60 * 1000;

export function useVersion() {
  return { appVersion, serverVersion, clientVersion };
}

export function useUpdates() {
  return {
    latest,
    checking,
    checked,
    checkError,
    updateAvailable,
    canSelfUpdate,
    installing,
    installError,
    installUpdate,
  };
}

// Self-update exists where the Go side implements it: Windows (silent NSIS)
// and Linux (binary swap). macOS isn't shipped.
export function canSelfUpdate(): boolean {
  const p = platform();
  return p === "windows" || p === "linux";
}

// installUpdate runs the shell's self-update. It never resolves on success —
// the process exits and the new version relaunches — so callers just reflect
// "installing" until the window vanishes.
export async function installUpdate() {
  const tag = latest();
  if (!tag || installing() || !canSelfUpdate()) return;
  setInstalling(true);
  setInstallError(null);
  try {
    await desktopSelfUpdate(tag);
  } catch (e) {
    setInstalling(false);
    setInstallError(e instanceof Error ? e.message : "update failed");
  }
}

/** Fetch the connected server's build version. No-op in local mode. */
export async function loadServerVersion() {
  if (net.isLocal()) {
    setServerVersion(null);
    return;
  }
  try {
    const r = await fetch(`${net.serverUrl()}/api/health`);
    if (!r.ok) throw new Error();
    const j = (await r.json()) as { version?: string };
    setServerVersion(j.version ?? null);
  } catch {
    setServerVersion(null);
  }
}

export function parseTag(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when the fetched latest release is newer than the client build. */
export function updateAvailable(): boolean {
  const l = latest();
  if (!l) return false;
  const a = parseTag(clientVersion());
  const b = parseTag(l);
  if (!a || !b) return false; // dev builds can't be compared
  for (let i = 0; i < 3; i++) {
    if (b[i]! > a[i]!) return true;
    if (b[i]! < a[i]!) return false;
  }
  return false;
}

/** Query GitHub for the newest release. Cached for 5 minutes. */
export async function checkForUpdates() {
  if (checking()) return;
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const { tag, at } = JSON.parse(cached) as { tag: string; at: number };
      if (Date.now() - at < CACHE_MS) {
        setLatest(tag);
        setChecked(true);
        return;
      }
    } catch {
      /* stale cache */
    }
  }
  setChecking(true);
  setCheckError(false);
  try {
    const r = await fetch(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error();
    const j = (await r.json()) as { tag_name?: string };
    if (!j.tag_name) throw new Error();
    setLatest(j.tag_name);
    setChecked(true);
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ tag: j.tag_name, at: Date.now() }),
    );
  } catch {
    setCheckError(true);
    setChecked(true);
  } finally {
    setChecking(false);
  }
}
