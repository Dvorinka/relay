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
let watchdog: ReturnType<typeof setInterval> | undefined;
let visBound = false;

function noteFrame() {
  lastFrame = Date.now();
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
      if (net.isLocal()) return;
      if (Date.now() - lastFrame > HEARTBEAT_MISS_MS) connect();
    }, 15_000);
  }
  if (!visBound) {
    visBound = true;
    document.addEventListener("visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        !net.isLocal() &&
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
        for (const h of handlers) h(e);
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
      for (const h of handlers) h(e);
    } catch {
      /* malformed frame — ignore */
    }
  };
  es.onerror = () => {
    es.close();
    // backoff: 1s, 2s, 4s … capped at 30s
    const delay = Math.min(30000, 1000 * 2 ** attempts++);
    retry = setTimeout(connect, delay);
  };
}

// emitLocal feeds a synthetic event to subscribers. Local mode has no SSE;
// the adapter uses this for updates a live view needs (e.g. a thread's
// reply count on the parent message).
export function emitLocal(e: RelayEvent) {
  for (const h of handlers) h(e);
}

export function subscribe(h: Handler): () => void {
  handlers.add(h);
  if (!source && !bridged) connect();
  startWatchdog();
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
