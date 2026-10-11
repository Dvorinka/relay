// Server reachability. One fetch wrapper (resilientFetch) drives everything:
// it stamps each origin up/down from real request outcomes, writes GET bodies
// to the IDB cache, and serves the cached copy when the server is down —
// the UI keeps last-known data instead of emptying, and ServerBanner shows
// the outage. A backoff probe loop per down origin flips it back up (and
// fires onServerUp) the moment /api/health answers again.
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { cacheGet, cachePut, kvDel, kvGet, kvPut } from "./cache";
import { bytesToB64 } from "./desktop";
import { localStore } from "./localdb";

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

// Drain bookkeeping: one pass per origin at a time. A send that arrives
// mid-drain (or carries an "att:" placeholder) awaits the pass, rewrites
// from resolvedPlaceholders, or re-queues so ordering survives.
const inflightDrains = new Map<string, Promise<boolean>>();

function ensureDrain(origin: string): Promise<boolean> {
  const cur = inflightDrains.get(origin);
  if (cur) return cur;
  const p = drainOutbox(origin).finally(() => {
    inflightDrains.delete(origin);
  });
  inflightDrains.set(origin, p);
  return p;
}

export function markUp(rawUrl: string): void {
  const origin = originOf(rawUrl);
  const was = states[origin];
  if (was === "up") return;
  setStates(origin, "up");
  // Replay queued mutations first — listeners refetch and should see the
  // server state after the outbox has landed. "unknown" counts too: a
  // persisted outbox must drain after a reload, not just a down→up flap.
  // A clean reload with an empty queue skips the resync entirely.
  void ensureDrain(origin).then((didWork) => {
    if (was !== "down" && !didWork) return;
    for (const cb of upListeners) cb(origin);
  });
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
//   replay provably can't duplicate: PUT/PATCH/DELETE are idempotent by
//   method, and POSTs must carry a client_msg_id the server dedupes on.
//   Anything else keeps the old fail-and-report behaviour.
// - Only string bodies queue here. FormData can't round-trip storage, so
//   attachment uploads park through enqueueUpload instead — file bytes in
//   the blobs store, replayed as base64 JSON.
export class QueuedError extends Error {
  constructor() {
    super("Server unreachable — change queued, sends on reconnect");
    this.name = "queued";
  }
}

export function isQueuedError(e: unknown): boolean {
  return e instanceof QueuedError || (e instanceof Error && e.name === "queued");
}

export interface OutboxEntry {
  id: string;
  origin: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  // Upload entries carry no JSON body — the file bytes live in the blobs
  // store under blobId and replay as {name,data} base64 JSON (the shape
  // every upload endpoint accepts; multipart can't round-trip storage).
  // `placeholder` is the synthesized attachment id handed to the caller;
  // drain rewrites it in later entries' bodies once the upload lands.
  blobId?: string;
  filename?: string;
  placeholder?: string;
}

const OUTBOX_KEY = "outbox:v1";
const OUTBOX_CAP = 100;
let outboxSeq = 0;
// The full queue as a signal so views can render what is parked — a bare
// count can't drive the "queued message" lane.
const [outboxEntries, setOutboxEntries] = createSignal<OutboxEntry[]>([]);
export { outboxEntries };
export function outboxPending(): number {
  return outboxEntries().length;
}
void refreshOutbox();

async function refreshOutbox(): Promise<void> {
  setOutboxEntries(await outboxList());
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
  setOutboxEntries(list);
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

// --- Queued uploads ---------------------------------------------------------
// File bytes can't live in the JSON outbox — they park in the blobs store.
// The entry id doubles as the synthesized attachment id ("att:…") so a
// queued postMessage can reference it before the real upload exists; drain
// substitutes the server id in later bodies.

const memBlobs = new Map<string, Blob>(); // IDB-less fallback (tests, private mode)

async function putUploadBlob(blobId: string, blob: Blob): Promise<void> {
  try {
    await localStore.putBlob(blobId, blob);
  } catch {
    memBlobs.set(blobId, blob);
  }
}

async function uploadBlob(blobId: string): Promise<Blob | undefined> {
  try {
    return await localStore.getBlob(blobId);
  } catch {
    return memBlobs.get(blobId);
  }
}

async function dropUploadBlob(blobId: string): Promise<void> {
  memBlobs.delete(blobId);
  try {
    await localStore.delBlob(blobId);
  } catch {
    /* IDB already gone — nothing to drop */
  }
}

/** Park a file upload while the server is down. Returns the placeholder
 *  attachment id ("att:<entryId>") for callers to reference, or null when
 *  the queue is full. Replay posts {"name","data"} JSON — accepted on every
 *  upload endpoint and immune to the desktop webview's multipart drops. */
export async function enqueueUpload(
  url: string,
  file: File | Blob,
  filename: string,
  init?: RequestInit,
): Promise<string | null> {
  const list = await outboxList();
  if (list.length >= OUTBOX_CAP) return null;
  const id = `att:${Date.now()}-${outboxSeq++}`;
  const blobId = `outbox-blob:${id}`;
  await putUploadBlob(blobId, file);
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? {}).forEach((v, k) => {
    headers[k] = v;
  });
  list.push({
    id,
    origin: originOf(url),
    url,
    method: "POST",
    headers,
    blobId,
    filename,
    placeholder: id,
  });
  await outboxSave(list);
  return id;
}

/** Drop one queued change (the × on a queued message/upload). Blob-backed
 *  entries take their parked file with them. */
export async function removeOutboxEntry(id: string): Promise<void> {
  const list = await outboxList();
  const entry = list.find((e) => e.id === id);
  if (entry?.blobId) void dropUploadBlob(entry.blobId);
  await outboxSave(list.filter((e) => e.id !== id));
}

// Placeholder attachment ids that already replayed, this session. A send
// fired while its upload was still parked rewrites from this map before
// it hits the wire — no dangling "att:…" reference reaches the server.
const resolvedPlaceholders = new Map<string, string>();

function rewriteResolved(body: string): string {
  if (!body.includes('"att:')) return body;
  for (const [ph, real] of resolvedPlaceholders) {
    body = body.replaceAll(`"${ph}"`, `"${real}"`);
  }
  return body;
}

function bodyPlaceholders(body: string): string[] {
  return [...body.matchAll(/"(att:[^"]+)"/g)].map((m) => m[1] ?? "");
}

function parkedPlaceholders(): Set<string> {
  const s = new Set<string>();
  for (const e of outboxEntries()) if (e.placeholder) s.add(e.placeholder);
  return s;
}

// An "att:" id that can never resolve — its upload entry was discarded or
// failed — is stripped from attachment_ids so the message sends minus that
// file instead of 4xx-ing on a dead reference.
function stripDeadPlaceholders(body: string): string {
  try {
    const parsed = JSON.parse(body) as { attachment_ids?: unknown };
    if (!Array.isArray(parsed.attachment_ids)) return body;
    parsed.attachment_ids = parsed.attachment_ids.filter(
      (x) => typeof x === "string" && !x.startsWith("att:"),
    );
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

// Replay in order. Any answered request (<500, even a rejection) consumed
// the change — drop it. A 5xx or transport error means the server is still
// sick: stop and leave the rest queued for the next recovery. Returns true
// when it actually attempted entries — callers use that to decide whether
// views need reconciling.
async function drainOutbox(origin: string): Promise<boolean> {
  const list = await outboxList();
  if (!list.some((e) => e.origin === origin)) return false;
  const keep: OutboxEntry[] = [];
  let stopped = false;
  for (const e of list) {
    if (stopped || e.origin !== origin) {
      keep.push(e);
      continue;
    }
    try {
      let body = e.body;
      let headers = e.headers;
      if (e.blobId) {
        const blob = await uploadBlob(e.blobId);
        if (!blob) throw new Error("upload payload gone");
        body = JSON.stringify({
          name: e.filename ?? "file",
          data: bytesToB64(await blob.arrayBuffer()),
        });
        headers = { ...e.headers, "Content-Type": "application/json" };
      } else if (body !== undefined) {
        // Quoted needle — placeholders only appear as JSON string values.
        // Anything unresolved here is dead (its upload already consumed or
        // discarded): strip it rather than 4xx the whole replay.
        body = stripDeadPlaceholders(rewriteResolved(body));
      }
      const res = await fetch(e.url, { method: e.method, headers, body });
      if (res.status >= 500) {
        stopped = true;
        keep.push(e);
        continue;
      }
      if (e.blobId) {
        void dropUploadBlob(e.blobId);
        if (res.ok && e.placeholder) {
          const att = (await res.json().catch(() => null)) as {
            id?: string;
          } | null;
          if (att?.id) resolvedPlaceholders.set(e.placeholder, att.id);
        }
      }
    } catch {
      stopped = true;
      keep.push(e);
    }
  }
  await outboxSave(keep);
  // Replay died mid-pass — the origin isn't really back. Marking it down
  // restarts the probe loop so the remainder drains on real recovery.
  if (stopped) markDown(origin);
  return list.length !== keep.length;
}

export async function clearOutbox(): Promise<void> {
  const list = await outboxList();
  for (const e of list) if (e.blobId) void dropUploadBlob(e.blobId);
  resolvedPlaceholders.clear();
  await outboxSave([]);
}

// --- Queued reads for the UI -------------------------------------------------

export interface QueuedMessage {
  entryId: string;
  body: string;
  attachmentIds: string[];
  parentId?: string;
  tags: string[];
}

/** POST /messages entries parked for one conversation — the pending lane
 *  the conversation view renders so a queued send never looks lost. */
export function queuedMessages(conversationId: string): QueuedMessage[] {
  const suffix = `/api/conversations/${conversationId}/messages`;
  const out: QueuedMessage[] = [];
  for (const e of outboxEntries()) {
    if (e.method !== "POST" || !e.url.endsWith(suffix) || !e.body) continue;
    try {
      const b = JSON.parse(e.body) as {
        body?: string;
        attachment_ids?: string[];
        parent_id?: string;
        tags?: string[];
      };
      out.push({
        entryId: e.id,
        body: b.body ?? "",
        attachmentIds: b.attachment_ids ?? [],
        parentId: b.parent_id,
        tags: b.tags ?? [],
      });
    } catch {
      /* unparseable entry — skip */
    }
  }
  return out;
}

/** The parked file behind an "att:…" placeholder — lets the queued lane
 *  show a real preview instead of an attachment count. */
export async function queuedUploadBlob(
  placeholderId: string,
): Promise<{ blob: Blob; filename: string } | undefined> {
  const e = outboxEntries().find((x) => x.placeholder === placeholderId);
  if (!e?.blobId) return undefined;
  const blob = await uploadBlob(e.blobId);
  return blob ? { blob, filename: e.filename ?? "file" } : undefined;
}

// replaySafe decides whether a request that just failed (and may or may
// not have reached the server) can be re-sent without side effects.
// PUT/PATCH/DELETE write an end state — replaying lands the same result.
// POST is only safe when the body carries client_msg_id, which the server
// dedupes per conversation.
function replaySafe(method: string, init?: RequestInit): boolean {
  if (method === "PUT" || method === "PATCH" || method === "DELETE") {
    return true;
  }
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
// Ephemeral writes that must not park: a replayed typing ping shows phantom
// "typing…", a replayed read receipt can swallow unreads that arrived during
// the outage. They fail like any parked change (callers swallow it) but
// leave nothing behind.
function ephemeral(url: string): boolean {
  return url.endsWith("/typing") || url.endsWith("/read");
}

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
  const origin = originOf(url);
  const key = method === "GET" ? cacheKey(url, init) : "";
  // Already known down: mutations queue instead of dying on the wire (auth
  // calls excluded — a queued login firing later would be confusing).
  if (method !== "GET" && states[origin] === "down" && !url.includes("/api/auth/")) {
    if (ephemeral(url)) throw new QueuedError();
    if (await enqueueOutbox(url, method, init)) throw new QueuedError();
  }
  // The request rides on an "att:" placeholder — a parked upload's stand-in
  // id. Wait for any running drain so the upload lands first, then swap in
  // the real id. Still parked: queue behind the upload and let the drain
  // order them. Never resolving (discarded upload): strip and send.
  if (
    method !== "GET" &&
    typeof init?.body === "string" &&
    init.body.includes('"att:')
  ) {
    await inflightDrains.get(origin);
    let body = rewriteResolved(init.body);
    const leftovers = bodyPlaceholders(body);
    if (leftovers.length > 0) {
      const parked = parkedPlaceholders();
      if (leftovers.some((id) => parked.has(id))) {
        if (
          (await enqueueOutbox(url, method, { ...init, body })) &&
          states[origin] !== "down"
        ) {
          void ensureDrain(origin);
        }
        throw new QueuedError();
      }
      body = stripDeadPlaceholders(body);
    }
    init = { ...init, body };
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
