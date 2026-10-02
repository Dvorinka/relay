// Connection state: which backend the SPA talks to.
// - "" serverUrl means same-origin (the SPA was served by a relay server).
// - local mode means "This device": no server, all data in localStorage via
//   lib/local.ts. Sync pushes the local store to a real server on demand.
import { createClient } from "@relay/api-client";

const K_URL = "relay.serverUrl";
const K_TOKEN = "relay.token";
const K_LOCAL = "relay.local";

export const net = {
  serverUrl: (): string => localStorage.getItem(K_URL) ?? "",
  token: (): string => localStorage.getItem(K_TOKEN) ?? "",
  isLocal: (): boolean => localStorage.getItem(K_LOCAL) === "1",

  /** Persist a server connection ("" = same origin). Clears local mode. */
  connect(serverUrl: string, token: string) {
    localStorage.setItem(K_URL, serverUrl.replace(/\/+$/, ""));
    localStorage.setItem(K_TOKEN, token);
    localStorage.removeItem(K_LOCAL);
  },

  enterLocal() {
    localStorage.setItem(K_LOCAL, "1");
    localStorage.removeItem(K_TOKEN);
  },

  /** Drop connection state entirely (sign out of a remote server). */
  disconnect() {
    localStorage.removeItem(K_TOKEN);
    localStorage.removeItem(K_LOCAL);
    // keep serverUrl so the login form stays prefilled
  },

  /** Client bound to the current connection. */
  client() {
    return createClient(net.serverUrl(), net.token() || undefined);
  },
};
