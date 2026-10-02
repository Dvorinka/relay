// Single EventSource for the app. Components subscribe to domain events;
// the server filters by workspace membership, so every event received is
// actionable for this user.
export interface RelayEvent {
  type: string;
  project_id: string;
  data?: Record<string, unknown>;
}

type Handler = (e: RelayEvent) => void;

const handlers = new Set<Handler>();
let source: EventSource | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let attempts = 0;

function connect() {
  source?.close();
  const es = new EventSource("/api/events");
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

export function subscribe(h: Handler): () => void {
  handlers.add(h);
  if (!source) connect();
  return () => {
    handlers.delete(h);
    if (handlers.size === 0) {
      source?.close();
      source = undefined;
      if (retry) clearTimeout(retry);
    }
  };
}
