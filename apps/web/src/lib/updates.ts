// App + server version display and the "check for updates" flow. The app
// version is stamped at build time (__APP_VERSION__, release tag); the
// server reports its own via /health. Update checks hit the GitHub releases
// API and are cached briefly to stay under rate limits.
import { createSignal } from "solid-js";
import { net } from "./net";

export const appVersion: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

const [serverVersion, setServerVersion] = createSignal<string | null>(null);
const [latest, setLatest] = createSignal<string | null>(null);
const [checking, setChecking] = createSignal(false);
const [checked, setChecked] = createSignal(false);
const [checkError, setCheckError] = createSignal(false);

const RELEASES_URL =
  "https://api.github.com/repos/Dvorinka/relay/releases/latest";
export const RELEASES_PAGE = "https://github.com/Dvorinka/relay/releases/latest";
const CACHE_KEY = "relay.latestRelease";
const CACHE_MS = 5 * 60 * 1000;

export function useVersion() {
  return { appVersion, serverVersion };
}

export function useUpdates() {
  return { latest, checking, checked, checkError, updateAvailable };
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

function parseTag(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when the fetched latest release is newer than this build. */
export function updateAvailable(): boolean {
  const l = latest();
  if (!l) return false;
  const a = parseTag(appVersion);
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
