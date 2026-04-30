import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PushApiUnavailableError,
  getPushVapidPublicKey,
  subscribePush,
} from '@/shared/lib/pushApi';

const SW_PATH = `${import.meta.env.BASE_URL ?? '/'}sw.js`;

export interface PushNotificationsState {
  /** Browser supports SW + PushManager + Notification AND server has VAPID configured. */
  isSupported: boolean;
  /** True after a successful subscribe() call AND a live PushManager subscription. */
  isSubscribed: boolean;
  /** True while subscribe()/init is in flight. */
  isLoading: boolean;
  /** Last error message, or null. */
  error: string | null;
  /** Browser Notification permission. */
  permission: NotificationPermission | 'unsupported';
}

export interface UsePushNotificationsReturn extends PushNotificationsState {
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<void>;
}

const hasBrowserPushSupport =
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

/**
 * Manages the Web Push lifecycle for the current browser:
 *
 * 1. Registers the service worker on mount (if the browser supports it).
 * 2. Reflects current PushManager subscription state.
 * 3. `subscribe()` requests Notification permission, fetches the VAPID public
 *    key from the server, calls `pushManager.subscribe`, and POSTs the
 *    resulting subscription to `/v1/push/subscribe`.
 * 4. `unsubscribe()` clears the local subscription. Phase 1 has no
 *    server-side unsubscribe endpoint; the row gets reaped on next 410 Gone.
 *
 * Returns `isSupported: false` (without throwing) when:
 *   - the browser lacks SW/PushManager/Notification, or
 *   - the SW file is missing (e.g. local-web bundle, non-remote-web hosts), or
 *   - the server has no VAPID configured (PushService = None → 503).
 *
 * Designed to be safe to mount unconditionally — never throws on init.
 */
export function usePushNotifications(): UsePushNotificationsReturn {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const [state, setState] = useState<PushNotificationsState>(() => ({
    isSupported: false,
    isSubscribed: false,
    isLoading: hasBrowserPushSupport,
    error: null,
    permission: hasBrowserPushSupport
      ? Notification.permission
      : 'unsupported',
  }));

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      if (!hasBrowserPushSupport) {
        setState((prev) => ({
          ...prev,
          isSupported: false,
          isLoading: false,
        }));
        return;
      }

      let registration: ServiceWorkerRegistration | null = null;
      try {
        registration = await navigator.serviceWorker.register(SW_PATH);
        await navigator.serviceWorker.ready;
      } catch (err) {
        // Most common cause: sw.js missing (e.g. local-web served without SW).
        // Treat as unsupported rather than as a hard error.
        console.warn('[usePushNotifications] service worker registration failed', err);
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            isSupported: false,
            isLoading: false,
          }));
        }
        return;
      }

      if (cancelled) {
        return;
      }
      registrationRef.current = registration;

      // Probe the server: if VAPID is unconfigured (Phase 1 returns 503),
      // mark the feature as unsupported on this deployment.
      try {
        await getPushVapidPublicKey();
      } catch (err) {
        if (err instanceof PushApiUnavailableError) {
          if (!cancelled) {
            setState((prev) => ({
              ...prev,
              isSupported: false,
              isLoading: false,
            }));
          }
          return;
        }
        // Network error or auth error — non-fatal; we'll surface it on
        // subscribe(). Don't mark unsupported.
      }

      const existing = await registration.pushManager.getSubscription();
      if (cancelled) {
        return;
      }
      setState((prev) => ({
        ...prev,
        isSupported: true,
        isSubscribed: !!existing,
        isLoading: false,
        permission: Notification.permission,
      }));
    };

    init();

    return () => {
      cancelled = true;
    };
  }, []);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!hasBrowserPushSupport || !registrationRef.current) {
      return false;
    }

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      let permission = Notification.permission;
      if (permission === 'default') {
        permission = await Notification.requestPermission();
      }
      setState((prev) => ({ ...prev, permission }));

      if (permission !== 'granted') {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error:
            permission === 'denied'
              ? 'Notification permission was denied'
              : 'Notification permission not granted',
        }));
        return false;
      }

      const { public_key } = await getPushVapidPublicKey();
      const applicationServerKey = urlBase64ToUint8Array(public_key);

      let subscription =
        await registrationRef.current.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registrationRef.current.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
        });
      }

      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error('PushManager returned an incomplete subscription');
      }

      await subscribePush(
        json.endpoint,
        json.keys.p256dh,
        json.keys.auth,
        navigator.userAgent
      );

      setState((prev) => ({
        ...prev,
        isSubscribed: true,
        isLoading: false,
        error: null,
      }));
      return true;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to subscribe to push';
      console.error('[usePushNotifications] subscribe failed', err);
      setState((prev) => ({ ...prev, isLoading: false, error: message }));
      return false;
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    if (!registrationRef.current) {
      return;
    }
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const subscription =
        await registrationRef.current.pushManager.getSubscription();
      if (subscription) {
        await subscription.unsubscribe();
      }
      // Phase 1 has no server-side unsubscribe; the row will be reaped on
      // next push send when the gateway returns 410.
      setState((prev) => ({
        ...prev,
        isSubscribed: false,
        isLoading: false,
        error: null,
      }));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to unsubscribe';
      console.error('[usePushNotifications] unsubscribe failed', err);
      setState((prev) => ({ ...prev, isLoading: false, error: message }));
    }
  }, []);

  return { ...state, subscribe, unsubscribe };
}
