import { useMutation, useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/shared/lib/api';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { useHostId } from '@/shared/providers/HostIdProvider';

class ClearContextDialogCancelledError extends Error {
  constructor() {
    super('Clear context dialog was cancelled');
    this.name = 'ClearContextDialogCancelledError';
  }
}

/**
 * Mutation that prompts the user with a destructive confirm and, on accept,
 * calls POST /api/sessions/:id/clear-context. Drops the resume linkage so the
 * next user message spawns a cold executor session. Branch, worktree, PR
 * linkage, and prior message log are preserved on the backend; the frontend
 * caches are invalidated so the session reloads with the new `cleared_at`.
 */
export function useClearContextMutation(
  sessionId: string | undefined,
  workspaceId: string | undefined
) {
  const queryClient = useQueryClient();
  const hostId = useHostId();

  return useMutation({
    mutationKey: ['clear-context', sessionId],
    mutationFn: async () => {
      if (!sessionId) {
        throw new ClearContextDialogCancelledError();
      }
      const result = await ConfirmDialog.show({
        title: 'Clear executor context?',
        message:
          "This resets the agent's memory of this session. Your branch, worktree, PR linkage, and prior message log are preserved. The next message you send will start a fresh executor session with no recall of the conversation above.",
        confirmText: 'Clear context',
        cancelText: 'Cancel',
        variant: 'destructive',
      });
      if (result !== 'confirmed') {
        throw new ClearContextDialogCancelledError();
      }
      await sessionsApi.clearContext(sessionId);
    },
    onSuccess: () => {
      if (workspaceId) {
        void queryClient.invalidateQueries({
          queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
        });
        void queryClient.invalidateQueries({
          queryKey: workspaceSummaryKeys.all,
        });
      }
    },
    onError: (err) => {
      if (err instanceof ClearContextDialogCancelledError) {
        return;
      }
      console.error('Failed to clear executor context:', err);
    },
  });
}

export { ClearContextDialogCancelledError };
