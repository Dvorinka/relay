// Server reachability. One fetch wrapper (resilientFetch) drives everything:
// it stamps each origin up/down from real request outcomes, writes GET bodies
// to the IDB cache, and serves the cached copy when the server is down —
// the UI keeps last-known data instead of emptying, and ServerBanner shows
// the outage. A backoff probe loop per down origin flips it back up (and
// fires onServerUp) the moment /api/health answers again.
import { createStore } from "solid-js/store";
import { cacheGet, cachePut } from "./cache";

export type ServerState = "up" | "down" | "unknown";

const [states, setStates] = createStore<Record<string, ServerState>>({});
const upListeners = new Set<(origin: string) => void>();

export function originOf(rawUrl: string): string {
  try {
    const base =
      typeof location !== "undefined" ? location.href : "http://localhost/";
    return new URL(rawUrl, base).origin;
  } catch {
    return rawUrl;
  }
}

export function serverState(rawUrl: string): ServerState {
  return states[originOf(rawUrl)] ?? "unknown";
}

export function onServerUp(cb: (origin: string) => void): () => void {
  upListeners.add(cb);
  return () => {
    upListeners.delete(cb);
  };
}

export function markDown(rawUrl: string): void {
  const origin = originOf(rawUrl);
  if (states[origin] === "down") return;
  setStates(origin, "down");
  void probeLoop(origin);
}

export function markUp(rawUrl: string): void {
  const origin = originOf(rawUrl);
  const was = states[origin];
  if (was === "up") return;
  setStates(origin, "up");
  if (was === "down") for (const cb of upListeners) cb(origin);
}

async function probe(origin: string): Promise<boolean> {
  try {
    const r = await fetch(origin + "/api/health", { cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

const probing = new Set<string>();

// Down-server probe: 5s, 10s, 20s … capped at 60s until health answers.
async function probeLoop(origin: string): Promise<void> {
  if (probing.has(origin)) return;
  probing.add(origin);
  try {
    let delay = 5000;
    while (states[origin] === "down") {
      await new Promise((r) => setTimeout(r, delay));
      if (states[origin] !== "down") break;
      if (await probe(origin)) {
        markUp(origin);
        break;
      }
      delay = Math.min(delay * 2, 60000);
    }
  } finally {
    probing.delete(origin);
  }
}

// Watch a server nobody actively talks to (local mode's remembered server,
// foreign rail connections): a slow poll keeps its state fresh so the UI
// can say when it comes back.
const watching = new Set<string>();

export function watchServer(rawUrl: string): void {
  const origin = originOf(rawUrl);
  if (watching.has(origin)) return;
  watching.add(origin);
  void (async () => {
    for (;;) {
      if (await probe(origin)) markUp(origin);
      else markDown(origin);
      await new Promise((r) => setTimeout(r, 20000));
    }
  })();
}

// The banner's "Retry now" — one immediate probe.
export async function probeNow(rawUrl: string): Promise<boolean> {
  const ok = await probe(originOf(rawUrl));
  if (ok) markUp(rawUrl);
  return ok;
}

// Cache keys are per-principal: the bearer token distinguishes sessions on
// the same origin, and net.disconnect() clears everything on sign-out.
function cacheKey(url: string, init?: RequestInit): string {
  const auth =
    new Headers(init?.headers ?? {}).get("Authorization") ?? "";
  return `${auth}|${url}`;
}

function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Drop-in fetch for createClient. Any response <500 means the server is
// alive (a 401 is a healthy server); transport failures and 5xx mark it
// down. GETs write their body to the cache on success and read it back on
// failure — mutating calls never see stale data.
export async function resilientFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const key = method === "GET" ? cacheKey(url, init) : "";
  try {
    const res = await fetch(input, init);
    if (res.status >= 500) {
      markDown(url);
      if (method === "GET") {
        const hit = await cacheGet(key);
        if (hit !== undefined) return jsonResponse(hit);
      }
      return res;
    }
    markUp(url);
    if (method === "GET" && res.ok) {
      void cachePut(key, await res.clone().text());
    }
    return res;
  } catch (err) {
    markDown(url);
    if (method === "GET") {
      const hit = await cacheGet(key);
      if (hit !== undefined) return jsonResponse(hit);
    }
    throw err;
  }
}
