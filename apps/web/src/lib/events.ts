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
        for (const h of handlers) h(e);
      } catch {
        /* malformed frame — ignore */
      }
    });
    bridgeBound = true;
  }
  pump.subscribe(token);
  bridged = true;
  return true;
}

function connect() {
  source?.close();
  bridged = false;
  // Local mode has no server at all — nothing to subscribe to.
  if (net.isLocal()) return;
  const token = net.token();
  if (connectBridge(token)) return;
  const base = net.serverUrl();
  const url = `${base}/api/events${token ? `?access_token=${encodeURIComponent(token)}` : ""}`;
  const es = new EventSource(url);
  source = es;
  es.onopen = () => {
    attempts = 0;
  };
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as RelayEvent;
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
  return () => {
    handlers.delete(h);
    if (handlers.size === 0) {
      source?.close();
      source = undefined;
      if (retry) clearTimeout(retry);
      if (bridged) {
        bridged = false;
        desktopEventPump()?.stop();
      }
    }
  };
}
