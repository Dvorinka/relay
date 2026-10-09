// Relay service worker — push notifications plus app-shell caching so the
// SPA still boots when the server is unreachable (desktop and mobile shells
// then offer "work locally", which is client-side). JSON API calls always go
// to the network: a dead server must fail them, not serve stale data. The
// exception is immutable media — avatars/icons live under /api/files/<key>
// and attachments under the download route, and keys rotate when the image
// changes, so a cache-first copy can never go stale.

const SHELL_CACHE = "relay-shell-v1";
const MEDIA_CACHE = "relay-media-v1";
const MEDIA_CAP = 200;

function isShellAsset(url) {
  return (
    url.pathname.startsWith("/assets/") ||
    url.pathname === "/favicon.svg" ||
    url.pathname === "/manifest.webmanifest"
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

function isMediaPath(url) {
  return (
    url.pathname.startsWith("/api/files/") ||
    /\/attachments\/[^/]+\/download$/.test(url.pathname)
  );
}

function trimMedia(cache) {
  return cache.keys().then((keys) => {
    let p = Promise.resolve();
    while (keys.length > MEDIA_CAP) {
      const oldest = keys.shift();
      p = p.then(() => cache.delete(oldest));
    }
    return p;
  });
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== MEDIA_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Sign-out clears the media cache alongside the app's JSON cache — the next
// session must not see a previous principal's avatars or attachments.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "relay-clear-media") {
    event.waitUntil(caches.delete(MEDIA_CACHE));
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Immutable media — cache-first, checked before the origin gate so
  // cross-origin <img> loads (desktop/cross-origin SPA pulling straight from
  // the server) are covered too. An opaque response can't be inspected, but
  // a missing file 404s the same whether cached or not.
  if (isMediaPath(url)) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then((c) =>
        c.match(request).then(
          (hit) =>
            hit ||
            fetch(request).then((res) => {
              if (res.ok || res.type === "opaque") {
                const copy = res.clone();
                c.put(request, copy).then(() => trimMedia(c));
              }
              return res;
            }),
        ),
      ),
    );
    return;
  }

  if (url.origin !== location.origin) return;
  // API, SSE, and shell-bridge endpoints never touch the cache.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/~")) {
    return;
  }

  // Navigations are network-first so deploys take effect immediately; the
  // cached copy only serves when the server is down or answers an error
  // page (a dead Cloudflare tunnel returns HTTP 530, not a network error).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (!res.ok) throw new Error(`http ${res.status}`);
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit || Response.error())),
    );
    return;
  }

  // Hashed build assets are immutable — cache-first, filled from network.
  if (isShellAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Relay", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Relay";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag,
      data: { url: data.url || "/" },
      icon: "/favicon.svg",
      badge: "/favicon.svg",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url;
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        for (const client of list) {
          if ("focus" in client) {
            client.postMessage({ type: "push-navigate", url });
            return client.focus();
          }
        }
        return clients.openWindow(url || "/");
      }),
  );
});
