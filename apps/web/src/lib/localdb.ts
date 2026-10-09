// IndexedDB persistence for local mode. Two stores: `kv` holds the JSON
// document; `blobs` holds attachment/avatar binaries as Blobs so large
// images never inflate the JSON or hit the ~5MB localStorage ceiling.
// Browsers give IDB a far larger quota (hundreds of MB, persisted).

const DB_NAME = "relay-local";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.onerror = () => reject(t.error);
      }),
  );
}

export const localStore = {
  get: <T>(key: string) =>
    tx<T | undefined>("kv", "readonly", (s) => s.get(key)),
  put: (key: string, value: unknown) =>
    tx("kv", "readwrite", (s) => s.put(value, key)),
  putBlob: (id: string, blob: Blob) =>
    tx("blobs", "readwrite", (s) => s.put(blob, id)),
  getBlob: (id: string) =>
    tx<Blob | undefined>("blobs", "readonly", (s) => s.get(id)),
  delBlob: (id: string) => tx("blobs", "readwrite", (s) => s.delete(id)),
  del: (key: string) => tx("kv", "readwrite", (s) => s.delete(key)),
};

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const [head, body] = dataUrl.split(",", 2);
  const mime = /data:(.*?)(;|$)/.exec(head ?? "")?.[1] || "application/octet-stream";
  if (body == null) return new Blob([], { type: mime });
  if (head!.includes(";base64")) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}
