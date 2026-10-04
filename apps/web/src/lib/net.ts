// Connection state: which backend the SPA talks to.
// - "" serverUrl means same-origin (the SPA was served by a relay server).
// - local mode means "This device": no server, all data in localStorage via
//   lib/local.ts. Sync pushes the local store to a real server on demand.
import { createClient } from "@relay/api-client";
import { createSignal } from "solid-js";

const K_URL = "relay.serverUrl";
const K_TOKEN = "relay.token";
const K_LOCAL = "relay.local";

// A signal so <Show when={net.isLocal()}> re-renders on transitions —
// a bare localStorage read never re-evaluates and the LOCAL badge would
// linger until reload.
const [isLocal, setIsLocal] = createSignal(
  localStorage.getItem(K_LOCAL) === "1",
);

export const net = {
  serverUrl: (): string => localStorage.getItem(K_URL) ?? "",
  token: (): string => localStorage.getItem(K_TOKEN) ?? "",
  isLocal,

  /** Persist a server connection ("" = same origin). Clears local mode. */
  connect(serverUrl: string, token: string) {
    localStorage.setItem(K_URL, serverUrl.replace(/\/+$/, ""));
    localStorage.setItem(K_TOKEN, token);
    localStorage.removeItem(K_LOCAL);
    setIsLocal(false);
  },

  enterLocal() {
    localStorage.setItem(K_LOCAL, "1");
    localStorage.removeItem(K_TOKEN);
    setIsLocal(true);
  },

  /** Drop connection state entirely (sign out of a remote server). */
  disconnect() {
    localStorage.removeItem(K_TOKEN);
    localStorage.removeItem(K_LOCAL);
    setIsLocal(false);
    // keep serverUrl so the login form stays prefilled
  },

  /** Client bound to the current connection. */
  client() {
    return createClient(net.serverUrl(), net.token() || undefined);
  },
};

/** Resolve an API media path ("/api/files/…", attachment downloads) for
 *  <img>/<a href>. Bare requests can't send an Authorization header, so
 *  token sessions (desktop, cross-origin SPA) carry ?access_token= like the
 *  SSE fallback. Cookie-authed same-origin sessions are unaffected either
 *  way; blob: data from local mode passes through untouched. */
export function mediaURL(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  let abs = u;
  if (u.startsWith("/api/")) {
    // root-relative API paths must point at the configured server, not the
    // page origin (the desktop shell serves the SPA from wails.localhost)
    const base = net.serverUrl();
    abs = base ? base + u : u;
  }
  const token = net.token();
  if (!token || !abs.includes("/api/")) return abs;
  const sep = abs.includes("?") ? "&" : "?";
  return `${abs}${sep}access_token=${encodeURIComponent(token)}`;
}
