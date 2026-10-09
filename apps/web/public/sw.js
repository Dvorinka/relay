// Relay service worker — push notifications plus app-shell caching so the
// SPA still boots when the server is unreachable (desktop and mobile shells
// then offer "work locally", which is client-side). API calls always go to
// the network: a dead server must fail them, not serve stale data.

const SHELL_CACHE = "relay-shell-v1";

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

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
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
