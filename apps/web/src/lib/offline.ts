// Server reachability. One fetch wrapper (resilientFetch) drives everything:
// it stamps each origin up/down from real request outcomes, writes GET bodies
// to the IDB cache, and serves the cached copy when the server is down —
// the UI keeps last-known data instead of emptying, and ServerBanner shows
// the outage. A backoff probe loop per down origin flips it back up (and
// fires onServerUp) the moment /api/health answers again.
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { cacheGet, cachePut, kvDel, kvGet, kvPut } from "./cache";

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
  if (was === "down") {
    // Replay queued mutations first — listeners refetch and should see the
    // server state after the outbox has landed.
    void drainOutbox(origin).then(() => {
      for (const cb of upListeners) cb(origin);
    });
  }
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

// --- Mutation outbox -------------------------------------------------------
// Once an origin is marked down, non-GET requests are queued instead of
// fired into the void, then replayed FIFO the moment the server answers
// again. Deliberate bounds:
// - The request that *marks* the origin down also queues — but only when
//   replay provably can't duplicate: PUT/DELETE are idempotent by method,
//   and POSTs must carry a client_msg_id the server dedupes on. Anything
//   else keeps the old fail-and-report behaviour.
// - Only string bodies queue. FormData uploads can't round-trip through
//   storage; they fail immediately like before.
export class QueuedError extends Error {
  constructor() {
    super("Server unreachable — change queued, sends on reconnect");
    this.name = "queued";
  }
}

export function isQueuedError(e: unknown): boolean {
  return e instanceof QueuedError || (e instanceof Error && e.name === "queued");
}

interface OutboxEntry {
  id: string;
  origin: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const OUTBOX_KEY = "outbox:v1";
const OUTBOX_CAP = 100;
let outboxSeq = 0;
const [outboxPending, setOutboxPending] = createSignal(0);
export { outboxPending };
void refreshOutboxCount();

async function refreshOutboxCount(): Promise<void> {
  setOutboxPending((await outboxList()).length);
}

async function outboxList(): Promise<OutboxEntry[]> {
  try {
    return JSON.parse((await kvGet(OUTBOX_KEY)) ?? "[]") as OutboxEntry[];
  } catch {
    return [];
  }
}

async function outboxSave(list: OutboxEntry[]): Promise<void> {
  if (list.length === 0) await kvDel(OUTBOX_KEY);
  else await kvPut(OUTBOX_KEY, JSON.stringify(list));
  setOutboxPending(list.length);
}

async function enqueueOutbox(
  url: string,
  method: string,
  init?: RequestInit,
): Promise<boolean> {
  if (init?.body !== undefined && typeof init.body !== "string") return false;
  const list = await outboxList();
  if (list.length >= OUTBOX_CAP) return false;
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? {}).forEach((v, k) => {
    headers[k] = v;
  });
  list.push({
    id: `${Date.now()}-${outboxSeq++}`,
    origin: originOf(url),
    url,
    method,
    headers,
    body: init?.body as string | undefined,
  });
  await outboxSave(list);
  return true;
}

// Replay in order. Any answered request (<500, even a rejection) consumed
// the change — drop it. A 5xx or transport error means the server is still
// sick: stop and leave the rest queued for the next recovery.
async function drainOutbox(origin: string): Promise<void> {
  const list = await outboxList();
  if (!list.some((e) => e.origin === origin)) return;
  const keep: OutboxEntry[] = [];
  let stopped = false;
  for (const e of list) {
    if (stopped || e.origin !== origin) {
      keep.push(e);
      continue;
    }
    try {
      const res = await fetch(e.url, {
        method: e.method,
        headers: e.headers,
        body: e.body,
      });
      if (res.status >= 500) {
        stopped = true;
        keep.push(e);
      }
    } catch {
      stopped = true;
      keep.push(e);
    }
  }
  await outboxSave(keep);
}

export async function clearOutbox(): Promise<void> {
  await outboxSave([]);
}

// replaySafe decides whether a request that just failed (and may or may
// not have reached the server) can be re-sent without side effects.
// PUT/DELETE replace or remove — replaying lands the same end state. POST
// is only safe when the body carries client_msg_id, which the server
// dedupes per conversation.
function replaySafe(method: string, init?: RequestInit): boolean {
  if (method === "PUT" || method === "DELETE") return true;
  if (method !== "POST") return false;
  try {
    const body: unknown = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    );
    return (
      typeof body === "object" &&
      body !== null &&
      typeof (body as { client_msg_id?: unknown }).client_msg_id ===
        "string" &&
      (body as { client_msg_id: string }).client_msg_id.length > 0
    );
  } catch {
    return false;
  }
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
  // Already known down: mutations queue instead of dying on the wire (auth
  // calls excluded — a queued login firing later would be confusing).
  if (
    method !== "GET" &&
    states[originOf(url)] === "down" &&
    !url.includes("/api/auth/")
  ) {
    if (await enqueueOutbox(url, method, init)) throw new QueuedError();
  }
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
    // The failure that flipped the origin down may never have left the
    // device — or landed a beat before the drop. Queue it when replay
    // can't double the effect; callers see the same QueuedError flow as
    // any other parked mutation.
    if (
      !url.includes("/api/auth/") &&
      replaySafe(method, init) &&
      (await enqueueOutbox(url, method, init))
    ) {
      throw new QueuedError();
    }
    throw err;
  }
}
