// Single EventSource for the app. Components subscribe to domain events;
// the server filters by workspace membership, so every event received is
// actionable for this user.
export interface RelayEvent {
  type: string;
  project_id: string;
  data?: Record<string, unknown>;
}

import { net } from "./net";
import { desktopEventPump } from "./desktop";
import { onServerUp } from "./offline";

type Handler = (e: RelayEvent) => void;

const handlers = new Set<Handler>();
let source: EventSource | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let attempts = 0;
let bridgeBound = false;
let bridged = false;

// The server sends a heartbeat data frame every 25s. A half-open TCP
// connection (NAT/proxy drop, tunnel restart) produces silence without an
// error event, so liveness is measured on received frames — three missed
// beats triggers a reconnect.
const HEARTBEAT_MISS_MS = 75_000;
let lastFrame = Date.now();
let everConnected = false;
// A 401 is permanent until the session changes — retrying it just spams
// the network tab on the login screen. Probed once per failure burst.
let authBlocked = false;
let authProbe: Promise<boolean> | undefined;
let watchdog: ReturnType<typeof setInterval> | undefined;
let visBound = false;
let upBound = false;

function noteFrame() {
  lastFrame = Date.now();
}

// One misbehaving subscriber must not kill the loop for the rest — without
// isolation a throw here is caught by the caller's frame parse and reads as
// "malformed frame", silently dropping the event for every later handler.
function dispatch(e: RelayEvent) {
  for (const h of handlers) {
    try {
      h(e);
    } catch (err) {
      console.error("[events] subscriber threw", err);
    }
  }
}

// The stream was down long enough to possibly miss frames — give the
// reconnect a beat to land, then tell views to reconcile (refetch the
// message tail, unread counts, …) via a synthetic event.
function resyncSoon() {
  setTimeout(() => emitLocal({ type: "stream.resync", project_id: "" }), 1500);
}

function startWatchdog() {
  if (!watchdog) {
    watchdog = setInterval(() => {
      if (net.isLocal() || authBlocked) return;
      if (Date.now() - lastFrame <= HEARTBEAT_MISS_MS) return;
      connect();
      // The stream may be unrecoverable — a desktop shell without the SSE
      // bridge, or a proxy that buffers EventSource to death. Reconcile
      // over REST each tick so a dead stream can't freeze the UI until a
      // reload. A 401 stays blocked so the login screen does not retry.
      emitLocal({ type: "stream.resync", project_id: "" });
    }, 15_000);
  }
  if (!visBound) {
    visBound = true;
    document.addEventListener("visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        !net.isLocal() &&
        !authBlocked &&
        Date.now() - lastFrame > HEARTBEAT_MISS_MS
      ) {
        connect();
      }
    });
  }
}

// Inside the desktop shell, EventSource through the wails asset proxy is
// dead — the response buffers until close and SSE never closes. The Go side
// pumps /api/events and re-emits frames as the "relay:sse" runtime event;
// wiring it here keeps one dispatch path. false when the bridge is absent
// (browser, old shell, or a tokenless cookie session).
function connectBridge(token: string): boolean {
  if (!token) return false;
  const pump = desktopEventPump();
  const rt = (
    window as unknown as {
      runtime?: { EventsOn?: (n: string, cb: (d: string) => void) => void };
    }
  ).runtime;
  if (!pump || typeof rt?.EventsOn !== "function") return false;
  if (!bridgeBound) {
    rt.EventsOn("relay:sse", (data) => {
      if (typeof data !== "string") return;
      try {
        const e = JSON.parse(data) as RelayEvent;
        noteFrame();
        dispatch(e);
      } catch {
        /* malformed frame — ignore */
      }
    });
    bridgeBound = true;
  }
  pump.subscribe(token);
  bridged = true;
  everConnected = true;
  noteFrame();
  return true;
}

function connect() {
  const wasConnected = everConnected;
  authBlocked = false;
  source?.close();
  bridged = false;
  if (retry) {
    clearTimeout(retry);
    retry = undefined;
  }
  // Local mode has no server at all — nothing to subscribe to.
  if (net.isLocal()) return;
  const token = net.token();
  if (connectBridge(token)) {
    // The pump reports no open event — assume up; the watchdog verifies.
    if (wasConnected) resyncSoon();
    return;
  }
  const base = net.serverUrl();
  const url = `${base}/api/events${token ? `?access_token=${encodeURIComponent(token)}` : ""}`;
  const es = new EventSource(url);
  source = es;
  es.onopen = () => {
    attempts = 0;
    everConnected = true;
    noteFrame();
    if (wasConnected) resyncSoon();
  };
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as RelayEvent;
      noteFrame();
      dispatch(e);
    } catch {
      /* malformed frame — ignore */
    }
  };
  es.onerror = () => {
    es.close();
    if (source === es) source = undefined;
    // No token means auth is cookie-only or absent — one cheap probe
    // distinguishes "session expired/absent" (stop) from a network blip
    // (back off and retry).
    if (!token) {
      authProbe ??= fetch(`${base}/api/auth/session`)
        .then((r) => r.ok)
        .catch(() => true) // probe unreachable: treat as blip, keep retrying
        .finally(() => {
          authProbe = undefined;
        });
      void authProbe.then((authed) => {
        if (!authed) {
          authBlocked = true;
          return;
        }
        scheduleRetry();
      });
      return;
    }
    scheduleRetry();
  };
}

// backoff: 1s, 2s, 4s … capped at 30s
function scheduleRetry() {
  if (authBlocked) return;
  const delay = Math.min(30000, 1000 * 2 ** attempts++);
  retry = setTimeout(connect, delay);
}

// emitLocal feeds a synthetic event to subscribers. Local mode has no SSE;
// the adapter uses this for updates a live view needs (e.g. a thread's
// reply count on the parent message).
export function emitLocal(e: RelayEvent) {
  dispatch(e);
}

export function subscribe(h: Handler): () => void {
  handlers.add(h);
  if (!source && !bridged) connect();
  startWatchdog();
  // Server recovered mid-session: queued mutations have replayed by now —
  // tell views to reconcile so the replayed entities (and anything missed
  // on the dead stream) appear without a reload.
  if (!upBound) {
    upBound = true;
    onServerUp((origin) => {
      if (!net.isLocal() && origin === (net.serverUrl() || location.origin)) {
        resyncSoon();
      }
    });
  }
  return () => {
    handlers.delete(h);
    if (handlers.size === 0) {
      source?.close();
      source = undefined;
      if (retry) clearTimeout(retry);
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = undefined;
      }
      if (bridged) {
        bridged = false;
        desktopEventPump()?.stop();
      }
    }
  };
}
