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
  if (!isBrowserNotificationsSupported()) {
    return;
  }
  if (getBrowserNotificationPermission() !== 'granted') {
    return;
  }

  // If the tab is currently in the foreground, skip the OS notification —
  // the in-app `/notifications` list surfaces the same item without the
  // OS-level toast noise.
  if (
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible'
  ) {
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
