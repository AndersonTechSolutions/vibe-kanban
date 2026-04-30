import {
  getBrowserNotificationPermission,
  isBrowserNotificationsSupported,
} from "@/shared/lib/browserNotifications";
import { router } from "@remote/app/router";

interface NotificationPayload {
  id: string;
  title: string;
  body: string;
  deeplinkPath?: string;
}

/**
 * Browser-only system notification dispatcher for the remote/cloud UI.
 *
 * The remote/server build never runs inside Tauri, so there's no native
 * desktop-shell path to consider. For "alert me when the browser is
 * closed" semantics, a Service Worker + Web Push subscription is
 * required (see vibe-kanban-deploy/docs/web-push-design.md).
 *
 * No visibility / focus gating: `document.visibilityState` and
 * `document.hasFocus()` both behave unreliably across browsers
 * (Arc in particular) — they can stay "visible"/`true` even when the
 * user has focused a different OS app. Always firing is mildly noisier
 * (duplicate alert when the user is on the page) but never silently
 * drops a real notification.
 */
export async function showSystemNotification(
  notification: NotificationPayload,
): Promise<void> {
  if (!isBrowserNotificationsSupported()) {
    return;
  }
  if (getBrowserNotificationPermission() !== "granted") {
    return;
  }

  try {
    const browserNotification = new window.Notification(notification.title, {
      body: notification.body,
      tag: notification.id,
      icon: "/favicon.png",
    });
    if (notification.deeplinkPath) {
      const path = notification.deeplinkPath;
      browserNotification.onclick = (event) => {
        event.preventDefault();
        try {
          window.focus();
        } catch {
          // Some platforms forbid window.focus() from a notification
          // click handler — safe to ignore.
        }
        router.navigate({ to: path as "/" });
        browserNotification.close();
      };
    }
  } catch (error) {
    console.error(
      `Failed to show browser notification for group ${notification.id}:`,
      error,
    );
  }
}
