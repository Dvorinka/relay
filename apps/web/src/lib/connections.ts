// Saved server connections. The active session stays in net.* — this store
// remembers OTHER servers the user signed into, so the rail can list their
// projects alongside the current ones and a click can hop servers.
// jarvis: ceiling — live SSE/notifications only follow the active server;
// a foreign project click swaps the session and reloads.
import { createClient } from "@relay/api-client";
import { createSignal } from "solid-js";
import { net } from "./net";

export interface SavedConnection {
  id: string;
  url: string; // origin, no trailing slash
  label: string; // display name — hostname by default
  token: string; // bearer returned by /api/auth/login on that server
}

const K = "relay.connections";

function read(): SavedConnection[] {
  try {
    const v = JSON.parse(localStorage.getItem(K) ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (c): c is SavedConnection =>
        !!c && typeof c === "object" &&
        typeof (c as SavedConnection).url === "string" &&
        typeof (c as SavedConnection).token === "string",
    );
  } catch {
    return [];
  }
}

const [connections, setConnections] = createSignal<SavedConnection[]>(read());
export { connections };

function write(list: SavedConnection[]) {
  localStorage.setItem(K, JSON.stringify(list));
  setConnections(list);
}

function labelFor(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Upsert after a successful login; skips same-origin (cookie) sessions. */
export function rememberConnection(url: string, token: string) {
  const u = url.replace(/\/+$/, "");
  if (!u || !token) return;
  const cur = read();
  const existing = cur.findIndex((c) => c.url === u);
  const entry: SavedConnection = {
    id: existing >= 0 ? cur[existing]!.id : crypto.randomUUID(),
    url: u,
    label: existing >= 0 ? cur[existing]!.label : labelFor(u),
    token,
  };
  if (existing >= 0) cur[existing] = entry;
  else cur.push(entry);
  write(cur);
}

export function forgetConnection(id: string) {
  write(read().filter((c) => c.id !== id));
}

export function renameConnection(id: string, label: string) {
  write(
    read().map((c) => (c.id === id ? { ...c, label: label || labelFor(c.url) } : c)),
  );
}

/** Saved servers other than the one this session currently talks to. */
export function foreignConnections(): SavedConnection[] {
  const cur = net.serverUrl();
  return connections().filter((c) => c.url !== cur);
}

/** Hop to a saved server: swap the persisted session and reload onto the
 * target route. The SPA boots onto the new server's session cookie/bearer. */
export function activateConnection(c: SavedConnection, path: string) {
  net.connect(c.url, c.token);
  location.href = path;
}

/** Fetch a foreign server's project list; null when unreachable/unauthed. */
export async function foreignProjects(c: SavedConnection) {
  try {
    const { projects } = await createClient(c.url, c.token).listProjects();
    return projects;
  } catch {
    return null;
  }
}

// Deterministic accent per server for rail badges — hash the URL into a hue.
export function connectionHue(url: string): number {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0;
  return h % 360;
}
