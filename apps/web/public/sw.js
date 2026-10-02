// Relay service worker — push notifications only. Deliberately no fetch
// handler: the app shell stays a plain network app; push arrives even when
// no tab is open.
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
