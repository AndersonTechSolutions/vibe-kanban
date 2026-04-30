/**
 * Service Worker for Vibe Kanban Web Push (Tier 2 fallback).
 *
 * Receives VAPID-signed push events from the server and shows OS-level
 * notifications even when the kanban tab is closed or backgrounded —
 * escaping the inactive-tab throttling that capped Tier 1.
 *
 * Payload shape (matches `crates/remote/src/push/types.rs::PushPayload`):
 *   { title, body, tag, deeplink_path? }
 */

const SW_VERSION = "1.0.0";
const PUSH_SUBSCRIBE_PATH = "/v1/push/subscribe";

self.addEventListener("install", (event) => {
  // Take over immediately on first install. Existing tabs keep their
  // controller until they navigate or reload.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Push event: parse the JSON payload and show an OS notification.
 *
 * Per spec, no focused-client suppression — `visibilityState`/`hasFocus()`
 * proved unreliable across browsers, so we always show. The `tag` field
 * collapses repeat fan-outs of the same notification id client-side.
 */
self.addEventListener("push", (event) => {
  if (!event.data) {
    console.warn("[VK SW] push event with no data");
    return;
  }

  let payload;
  try {
    payload = event.data.json();
  } catch (err) {
    console.error("[VK SW] failed to parse push payload", err);
    return;
  }

  const title = payload.title || "Vibe Kanban";
  const body = payload.body || "You have a new notification";
  const tag = payload.tag || undefined;
  const deeplinkPath = payload.deeplink_path || "/notifications";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: "/favicon.png",
      badge: "/favicon.png",
      data: { deeplink_path: deeplinkPath },
    }),
  );
});

/**
 * Notification click: focus an existing window matching the deeplink,
 * else open a new one.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const path = data.deeplink_path || "/notifications";

  event.waitUntil(handleNotificationClick(path));
});

async function handleNotificationClick(path) {
  const targetUrl = new URL(path, self.registration.scope).href;

  const allClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  // Prefer a client already showing this exact URL.
  for (const client of allClients) {
    if (client.url === targetUrl && "focus" in client) {
      return client.focus();
    }
  }

  // Then any client on the same origin — focus it and navigate.
  for (const client of allClients) {
    try {
      const clientUrl = new URL(client.url);
      const scopeUrl = new URL(self.registration.scope);
      if (clientUrl.origin === scopeUrl.origin && "navigate" in client) {
        await client.focus();
        return client.navigate(targetUrl);
      }
    } catch {
      // Bad URL — ignore.
    }
  }

  // Finally, open a fresh window.
  if (self.clients.openWindow) {
    return self.clients.openWindow(targetUrl);
  }
}

/**
 * pushsubscriptionchange: most often fires when the browser rotates
 * the underlying subscription (Chrome on push service rotation, Safari
 * on key rotation). Re-subscribe on the same registration and POST the
 * new subscription back to the server so future pushes land.
 *
 * Note: this fires WITHOUT auth context (the SW has no JWT). Our
 * backend's `/v1/push/subscribe` is gated by `require_session`, so this
 * call will fail with 401 unless an active session cookie or token is
 * sent. For v1 we attempt it best-effort with `credentials: "include"`
 * (the browser will send any same-origin cookies) and rely on the next
 * page load's hook to re-subscribe if this 401s. Logging only — no
 * user-visible failure.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handleSubscriptionChange(event));
});

async function handleSubscriptionChange(event) {
  try {
    const oldKey = event.oldSubscription?.options?.applicationServerKey;
    if (!oldKey) {
      console.warn(
        "[VK SW] pushsubscriptionchange without applicationServerKey; skipping",
      );
      return;
    }

    const newSubscription =
      event.newSubscription ||
      (await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: oldKey,
      }));

    const json = newSubscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      console.warn("[VK SW] new subscription missing required fields");
      return;
    }

    await fetch(PUSH_SUBSCRIBE_PATH, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      }),
    });
  } catch (err) {
    console.error("[VK SW] pushsubscriptionchange failed", err);
  }
}

console.log("[VK SW] loaded version", SW_VERSION);
