import { RouterProvider } from "@tanstack/react-router";
import { HotkeysProvider } from "react-hotkeys-hook";
import { router } from "@remote/app/router";
import { AppRuntimeProvider } from "@/shared/hooks/useAppRuntime";
import { AppSystemNotifications } from "@remote/app/notifications/AppSystemNotifications";

export function AppRouter() {
  return (
    <AppRuntimeProvider runtime="remote">
      <AppSystemNotifications />
      <HotkeysProvider
        initiallyActiveScopes={["global", "workspace", "kanban", "projects"]}
      >
        <RouterProvider router={router} />
      </HotkeysProvider>
    </AppRuntimeProvider>
  );
}
