import { type ReactNode } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { Provider as NiceModalProvider } from "@ebay/nice-modal-react";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import { useKeyShowHelp, Scope } from "@/shared/keyboard";
import { KeyboardShortcutsDialog } from "@/shared/dialogs/shared/KeyboardShortcutsDialog";
import { TerminalProvider } from "@/shared/providers/TerminalProvider";
import { WorkspaceProvider } from "@/shared/providers/WorkspaceProvider";
import { ExecutionProcessesProvider } from "@/shared/providers/ExecutionProcessesProvider";
import { LogsPanelProvider } from "@/shared/providers/LogsPanelProvider";
import { ActionsProvider } from "@/shared/providers/ActionsProvider";
import { useWorkspaceContext } from "@/shared/hooks/useWorkspaceContext";
import { Workspaces } from "@/pages/workspaces/Workspaces";
import WorkspacesUnavailablePage from "@remote/pages/WorkspacesUnavailablePage";
import { useRelayWorkspaceHostHealth } from "@remote/shared/hooks/useRelayWorkspaceHostHealth";

function GlobalKeyboardShortcuts() {
  useKeyShowHelp(
    () => {
      KeyboardShortcutsDialog.show();
    },
    { scope: Scope.GLOBAL },
  );
  return null;
}

function ExecutionProcessesProviderWrapper({
  children,
}: {
  children: ReactNode;
}) {
  const { selectedSessionId } = useWorkspaceContext();
  return (
    <ExecutionProcessesProvider sessionId={selectedSessionId}>
      {children}
    </ExecutionProcessesProvider>
  );
}

function PopoutProviders({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <ExecutionProcessesProviderWrapper>
        <TerminalProvider>
          <LogsPanelProvider>
            <ActionsProvider>
              <NiceModalProvider>{children}</NiceModalProvider>
            </ActionsProvider>
          </LogsPanelProvider>
        </TerminalProvider>
      </ExecutionProcessesProviderWrapper>
    </WorkspaceProvider>
  );
}

function PopoutRouteComponent() {
  // Inline the host-health gate from RemoteWorkspacesPageShell, but skip
  // its WorkspaceTitleSync child component — that component reads the
  // workspace context via a hook that React Forget-memoizes, and re-renders
  // triggered by external subscriptions race the provider tree on first
  // popout-window mount. The popout doesn't need mobile title sync anyway
  // (WorkspacesLayout already calls usePageTitle).
  const { hostId } = useParams({ strict: false });
  const hostHealth = useRelayWorkspaceHostHealth(hostId ?? null);

  if (!hostId) {
    return <WorkspacesUnavailablePage />;
  }
  if (hostHealth.isChecking) {
    return (
      <WorkspacesUnavailablePage
        blockedHost={{ id: hostId, name: null }}
        isCheckingBlockedHost
      />
    );
  }
  if (hostHealth.isError) {
    return (
      <WorkspacesUnavailablePage
        blockedHost={{
          id: hostId,
          name: null,
          errorMessage: hostHealth.errorMessage,
        }}
      />
    );
  }

  return (
    <PopoutProviders>
      <GlobalKeyboardShortcuts />
      <div className="h-screen flex flex-col bg-primary">
        <Workspaces popout />
      </div>
    </PopoutProviders>
  );
}

export const Route = createFileRoute(
  "/hosts/$hostId/workspaces/$workspaceId/popout",
)({
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: PopoutRouteComponent,
});
