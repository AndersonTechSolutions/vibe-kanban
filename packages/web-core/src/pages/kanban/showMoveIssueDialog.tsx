/**
 * Imperative helper that opens MoveIssueDialog from outside a React component
 * (e.g. from the command-bar action registry).
 *
 * Uses the same @ebay/nice-modal-react pattern as ConfirmDialog / LinkPrToIssueDialog.
 * The NiceModalProvider is mounted at the app root, so this works everywhere.
 */

import { create, useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/shared/lib/modals';
import { MoveIssueDialog } from './MoveIssueDialog';
import type { Issue } from 'shared/remote-types';

interface ShowMoveIssueDialogProps {
  issue: Issue;
}

/**
 * Thin nice-modal-react wrapper around the controlled MoveIssueDialog.
 * Translates modal.visible / modal.hide() into the open/onClose props.
 */
const MoveIssueDialogModal = create<ShowMoveIssueDialogProps>(({ issue }) => {
  const modal = useModal();

  const handleClose = () => {
    modal.resolve();
    modal.hide();
  };

  return (
    <MoveIssueDialog issue={issue} open={modal.visible} onClose={handleClose} />
  );
});

const MoveIssueDialogModalDefined = defineModal<ShowMoveIssueDialogProps, void>(
  MoveIssueDialogModal
);

/**
 * Open the Move Issue dialog imperatively. Resolves when the dialog closes
 * (success or cancel). Errors from the dialog are handled internally via its
 * inline error banner and do not propagate here.
 */
export async function showMoveIssueDialog({
  issue,
}: ShowMoveIssueDialogProps): Promise<void> {
  await MoveIssueDialogModalDefined.show({ issue });
}
