import { invoke } from '@tauri-apps/api/core';
import {
  getBrowserNotificationPermission,
  isBrowserNotificationsSupported,
} from '@/shared/lib/browserNotifications';
import { isTauriApp } from '@/shared/lib/platform';
import { router } from '@web/app/router';

interface NotificationPayload {
  id: string;
  title: string;
  body: string;
  deeplinkPath?: string;
}

export async function showSystemNotification(
  notification: NotificationPayload
): Promise<void> {
  if (isTauriApp()) {
    try {
      await invoke('show_system_notification', {
        title: notification.title,
        body: notification.body,
        deeplinkPath: notification.deeplinkPath,
      });
    } catch (error) {
      console.error(
        `Failed to show system notification for group ${notification.id}:`,
        error
      );
    }
    return;
  }

  // Browser fallback — uses the Web Notification API. This only works
  // while the tab is alive; for "alert me when the browser is closed",
  // a Service Worker + Web Push subscription is required (separate work).
  //
  // No visibility / focus gating: `document.visibilityState` and
  // `document.hasFocus()` both behave unreliably across browsers
  // (Arc in particular) — they can stay "visible"/`true` even when the
  // user has focused a different OS app. Always firing is mildly noisier
  // (duplicate alert when the user is on the page) but never silently
  // drops a real notification.
  if (!isBrowserNotificationsSupported()) {
    return;
  }
  if (getBrowserNotificationPermission() !== 'granted') {
    return;
  }

  try {
    const browserNotification = new window.Notification(notification.title, {
      body: notification.body,
      tag: notification.id,
      icon: '/favicon.png',
    });
    if (notification.deeplinkPath) {
      const path = notification.deeplinkPath;
      browserNotification.onclick = (event) => {
        event.preventDefault();
        try {
          window.focus();
        } catch {
          // Some browsers forbid `window.focus()` from a notification
          // click handler on certain platforms — safe to ignore.
        }
        router.navigate({ to: path as '/' });
        browserNotification.close();
      };
    }
  } catch (error) {
    console.error(
      `Failed to show browser notification for group ${notification.id}:`,
      error
    );
  }
}
