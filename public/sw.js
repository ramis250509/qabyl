// Qabyl push service worker — handles Web Push delivery on iOS/Android/Desktop.
// Intentionally minimal: NO app-shell caching, no offline behavior — only push.

async function notifyClients(event, details) {
  try {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) client.postMessage({ source: "qabyl-sw", event, details: details || null, ts: Date.now() });
  } catch (_) {}
}

self.addEventListener("install", (event) => {
  // Activate immediately so an old worker can't swallow new push events.
  event.waitUntil(notifyClients("install"));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    await notifyClients("activate", { scope: self.registration.scope });
  })());
});

// Web Push handler.
// IMPORTANT: mobile OSes kill the worker ~3-5s after the page is backgrounded
// unless `event.waitUntil(promise)` is called SYNCHRONOUSLY with a promise
// that resolves AFTER showNotification(). Any async work / try-catch must be
// inside that single waited promise.
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      await notifyClients("push-received", { hasData: !!event.data });
      let data = {};
      try {
        if (event.data) {
          try {
            data = event.data.json();
          } catch (_) {
            const text = event.data.text();
            data = { title: "Qabyl", body: text || "" };
          }
        }
      } catch (_) {
        data = {};
      }

      const title = (data && data.title) || "Qabyl";
      const body = (data && data.body) || "";
      const url = (data && data.url) || "/admin/notifications";
      const tag = (data && (data.tag || data.id)) || `qabyl-${Date.now()}`;
      const icon = (data && data.icon) || "/icon-192.png";
      const badge = (data && data.badge) || "/icon-192.png";

      try {
        await self.registration.showNotification(title, {
          body,
          tag,
          icon,
          badge,
          data: { url, ...(data && data.data ? data.data : {}) },
          renotify: true,
          requireInteraction: false,
          vibrate: [80, 40, 80],
          timestamp: (data && data.timestamp) || Date.now(),
        });
        await notifyClients("notification-shown", { title, tag });
      } catch (_) {
        // Last-resort fallback so iOS doesn't mark this push as silent
        // (which can revoke the push subscription after a few violations).
        try {
          await self.registration.showNotification("Qabyl", {
            body: "",
            tag: `qabyl-${Date.now()}`,
            icon: "/icon-192.png",
            badge: "/icon-192.png",
          });
          await notifyClients("notification-fallback-shown");
        } catch (_) {}
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl =
    (event.notification.data && event.notification.data.url) || "/admin/notifications";

  event.waitUntil(
    (async () => {
      try {
        const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        // Prefer an existing window already on the target URL.
        for (const client of all) {
          if (client.url.includes(targetUrl) && "focus" in client) {
            return client.focus();
          }
        }
        // Otherwise focus any open window and navigate it.
        for (const client of all) {
          if ("focus" in client) {
            try { await client.navigate(targetUrl); } catch (_) {}
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      } catch (_) {}
    })(),
  );
});
