import { type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Provider as NiceModalProvider } from "@ebay/nice-modal-react";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import { SequenceTrackerProvider } from "@/shared/keyboard/SequenceTracker";
import { SequenceIndicator } from "@/shared/keyboard/SequenceIndicator";
import { useWorkspaceShortcuts } from "@/shared/keyboard/useWorkspaceShortcuts";
import { useKeyShowHelp, Scope } from "@/shared/keyboard";
import { KeyboardShortcutsDialog } from "@/shared/dialogs/shared/KeyboardShortcutsDialog";
import { TerminalProvider } from "@/shared/providers/TerminalProvider";
import { WorkspaceProvider } from "@/shared/providers/WorkspaceProvider";
import { ExecutionProcessesProvider } from "@/shared/providers/ExecutionProcessesProvider";
import { LogsPanelProvider } from "@/shared/providers/LogsPanelProvider";
import { ActionsProvider } from "@/shared/providers/ActionsProvider";
import { useWorkspaceContext } from "@/shared/hooks/useWorkspaceContext";
import { Workspaces } from "@/pages/workspaces/Workspaces";
import { RemoteWorkspacesPageShell } from "@remote/pages/RemoteWorkspacesPageShell";

function KeyboardShortcutsHandler() {
  useKeyShowHelp(
    () => {
      KeyboardShortcutsDialog.show();
    },
    { scope: Scope.GLOBAL },
  );
  useWorkspaceShortcuts();
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
  return (
    <PopoutProviders>
      <SequenceTrackerProvider>
        <SequenceIndicator />
        <KeyboardShortcutsHandler />
        <RemoteWorkspacesPageShell>
          <div className="h-screen flex flex-col bg-primary">
            <Workspaces popout />
          </div>
        </RemoteWorkspacesPageShell>
      </SequenceTrackerProvider>
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
