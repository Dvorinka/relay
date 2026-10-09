// Read-through cache for server GET responses. The resilient fetch wrapper
// (offline.ts) writes every successful GET body here keyed by auth+URL, and
// serves it when the server is unreachable — the chat, project lists, and
// session don't vanish during an outage.
import { localStore } from "./localdb";

const PREFIX = "httpcache:";
const INDEX = "httpcache:index";
const CAP = 400;


// IndexedDB can be unavailable (private mode, file:// edge cases, tests) —
// every read/write falls back to an in-memory map so the cache degrades to
// "works until reload" instead of breaking the fetch path.
const mem = new Map<string, string>();
let idbBroken = false;

export async function kvGet(key: string): Promise<string | undefined> {
  if (idbBroken) return mem.get(key);
  try {
    return await localStore.get<string>(key);
  } catch {
    idbBroken = true;
    return mem.get(key);
  }
}

export async function kvPut(key: string, value: string): Promise<void> {
  mem.set(key, value);
  if (idbBroken) return;
  try {
    await localStore.put(key, value);
  } catch {
    idbBroken = true;
  }
}

export async function kvDel(key: string): Promise<void> {
  mem.delete(key);
  if (idbBroken) return;
  try {
    await localStore.del(key);
  } catch {
    idbBroken = true;
  }
}

async function index(): Promise<string[]> {
  try {
    return JSON.parse((await kvGet(INDEX)) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export async function cacheGet(key: string): Promise<string | undefined> {
  return kvGet(PREFIX + key);
}

export async function cachePut(key: string, body: string): Promise<void> {
  await kvPut(PREFIX + key, body);
  // FIFO cap: the index lives in the same kv store; evict oldest first.
  const idx = await index();
  if (idx.includes(key)) return;
  idx.push(key);
  while (idx.length > CAP) {
    const evicted = idx.shift();
    if (evicted) await kvDel(PREFIX + evicted);
  }
  await kvPut(INDEX, JSON.stringify(idx));
}

// Sign-out / server switch drops every cached body — a different user or
// server must never see another principal's stale responses. The service
// worker keeps avatars/attachments in its own media cache; clear that too.
export async function clearApiCache(): Promise<void> {
  for (const key of await index()) await kvDel(PREFIX + key);
  await kvDel(INDEX);
  mem.clear();
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    void navigator.serviceWorker
      .getRegistration()
      .then((r) =>
        r?.active?.postMessage({ type: "relay-clear-media" }),
      )
      .catch(() => {});
  }
}
