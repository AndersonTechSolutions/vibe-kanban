import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ScratchType,
  type DraftFollowUpData,
  type ExecutorConfig,
} from 'shared/types';
import { useScratch } from '@/shared/hooks/useScratch';
import { useDebouncedCallback } from '@/shared/hooks/useDebouncedCallback';

interface UseSessionMessageEditorOptions {
  /** Scratch ID (workspaceId for new session, sessionId for existing) */
  scratchId: string | undefined;
}

interface UseSessionMessageEditorResult {
  /** Current message value */
  localMessage: string;
  /** Set local message directly */
  setLocalMessage: (value: string) => void;
  /** Scratch data (message and variant) */
  scratchData: DraftFollowUpData | undefined;
  /** Whether scratch is loading */
  isScratchLoading: boolean;
  /** Whether the initial value has been applied from scratch */
  hasInitialValue: boolean;
  /** Save message and executor config to scratch */
  saveToScratch: (
    message: string,
    executorConfig: ExecutorConfig
  ) => Promise<void>;
  /** Delete the draft scratch */
  clearDraft: () => Promise<void>;
  /** Cancel pending debounced save */
  cancelDebouncedSave: () => void;
  /** Handle message change with debounced save */
  handleMessageChange: (value: string, executorConfig: ExecutorConfig) => void;
}

/**
 * Hook to manage message editing with draft persistence.
 * Handles local state, debounced saves to scratch, and sync on load.
 */
export function useSessionMessageEditor({
  scratchId,
}: UseSessionMessageEditorOptions): UseSessionMessageEditorResult {
  const {
    scratch,
    updateScratch,
    deleteScratch,
    isLoading: isScratchLoading,
  } = useScratch(ScratchType.DRAFT_FOLLOW_UP, scratchId ?? '');

  const scratchData: DraftFollowUpData | undefined =
    scratch?.payload?.type === 'DRAFT_FOLLOW_UP'
      ? scratch.payload.data
      : undefined;

  const [localMessage, setLocalMessage] = useState('');
  const [hasInitialValue, setHasInitialValue] = useState(false);

  const saveToScratch = useCallback(
    async (message: string, executorConfig: ExecutorConfig) => {
      if (!scratchId) return;
      try {
        await updateScratch({
          payload: {
            type: 'DRAFT_FOLLOW_UP',
            data: {
              message,
              executor_config: executorConfig,
            },
          },
        });
      } catch (e) {
        console.error('Failed to save follow-up draft', e);
      }
    },
    [scratchId, updateScratch]
  );

  const { debounced: debouncedSave, cancel: cancelDebouncedSave } =
    useDebouncedCallback(saveToScratch, 500);

  // Track whether initial load has happened to avoid re-syncing during typing
  const hasLoadedRef = useRef(false);

  // Reset load state and clear message when scratchId changes (e.g.,
  // switching workspaces, switching to approval mode). Cancel any pending
  // debounced save first so a stale typed-but-not-yet-saved message from
  // the previous scratchId doesn't end up written under the new key.
  useEffect(() => {
    cancelDebouncedSave();
    hasLoadedRef.current = false;
    setHasInitialValue(false);
    setLocalMessage('');
  }, [scratchId, cancelDebouncedSave]);

  // Sync local message from scratch only on initial load
  useEffect(() => {
    if (isScratchLoading) return;
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    setLocalMessage(scratchData?.message ?? '');
    setHasInitialValue(true);
  }, [isScratchLoading, scratchData?.message]);

  // Handle message change with debounced save
  // Pass executor profile at call-time to avoid stale closure
  const handleMessageChange = useCallback(
    (value: string, executorConfig: ExecutorConfig) => {
      setLocalMessage(value);
      debouncedSave(value, executorConfig);
    },
    [debouncedSave]
  );

  return {
    localMessage,
    setLocalMessage,
    scratchData,
    isScratchLoading,
    hasInitialValue,
    saveToScratch,
    clearDraft: deleteScratch,
    cancelDebouncedSave,
    handleMessageChange,
  };
}
