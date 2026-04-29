/**
 * Browser-native Notification API helpers.
 *
 * Used as a fallback when the app is running in a regular browser tab
 * rather than the Tauri desktop wrapper. Covers the simple "alert me
 * while my kanban tab is open" case.
 *
 * Limitations vs. Tauri / true Web Push:
 *  - Only fires while the tab is alive (closes tab => no notifications).
 *  - Some browsers (Safari) require the site to be installed as a PWA
 *    before granting notification permission.
 *  - For "alert me even when the browser is closed" semantics, a Service
 *    Worker + VAPID-signed push subscription is required (separate work).
 */

export type BrowserNotificationPermission =
  | 'unsupported'
  | 'default'
  | 'granted'
  | 'denied';

export function isBrowserNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (!isBrowserNotificationsSupported()) {
    return 'unsupported';
  }
  return window.Notification.permission as BrowserNotificationPermission;
}

/**
 * Requests permission from the user. Must be called from a user gesture
 * (e.g. a button click) — calling it from a non-gesture context may
 * throw or silently fail in some browsers.
 *
 * If permission has already been resolved ("granted" or "denied"), the
 * existing value is returned without re-prompting.
 */
export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (!isBrowserNotificationsSupported()) {
    return 'unsupported';
  }
  const current = window.Notification.permission;
  if (current === 'granted' || current === 'denied') {
    return current as BrowserNotificationPermission;
  }
  try {
    const result = await window.Notification.requestPermission();
    return result as BrowserNotificationPermission;
  } catch {
    return getBrowserNotificationPermission();
  }
}
