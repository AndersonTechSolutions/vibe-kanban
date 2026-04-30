import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { AppRouter } from "@remote/app/entry/App";
import { RemoteAuthProvider } from "@remote/app/providers/RemoteAuthProvider";
import { getIdentity } from "@remote/shared/lib/api";
import { getToken, triggerRefresh } from "@remote/shared/lib/auth/tokenManager";
import "@remote/app/styles/index.css";
import "@/i18n";
import { configureAuthRuntime } from "@/shared/lib/auth/runtime";
import { setRemoteApiBase } from "@/shared/lib/remoteApi";
import { setRelayApiBase } from "@/shared/lib/relayBackendApi";
import { setLocalApiTransport } from "@/shared/lib/localApiTransport";
import "@/shared/types/modals";
import { queryClient } from "@/shared/lib/queryClient";
import {
  requestLocalApiViaWebRtc,
  openLocalApiWebSocketViaWebRtc,
} from "@remote/shared/lib/webrtc";

if (import.meta.env.VITE_PUBLIC_POSTHOG_KEY) {
  posthog.init(import.meta.env.VITE_PUBLIC_POSTHOG_KEY, {
    api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
  });
}

setRemoteApiBase(import.meta.env.VITE_API_BASE_URL || window.location.origin);
setRelayApiBase(
  import.meta.env.VITE_RELAY_API_BASE_URL ||
    import.meta.env.VITE_API_BASE_URL ||
    window.location.origin,
);
setLocalApiTransport({
  request: requestLocalApiViaWebRtc,
  openWebSocket: openLocalApiWebSocketViaWebRtc,
});

configureAuthRuntime({
  getToken,
  triggerRefresh,
  registerShape: () => () => {},
  getCurrentUser: async () => {
    const identity = await getIdentity();
    return { user_id: identity.user_id };
  },
});

// Register the service worker on app boot, not lazily inside the
// notifications hook. Chrome's PWA install criteria require an active
// SW with a fetch handler before the "Install app" affordance appears,
// so deferring registration to /notifications meant most users never
// saw the install card on the home page. Fire-and-forget — failures
// (e.g. local-web with no /sw.js, or unsupported browsers) are
// non-fatal.
if (
  typeof window !== "undefined" &&
  "serviceWorker" in navigator
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL ?? "/"}sw.js`)
      .catch((err) => {
        console.warn("[Bootstrap] service worker registration failed", err);
      });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <PostHogProvider client={posthog}>
        <RemoteAuthProvider>
          <AppRouter />
        </RemoteAuthProvider>
      </PostHogProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
