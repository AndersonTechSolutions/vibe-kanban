import { aggregateConsecutiveEntries } from '@/shared/lib/aggregateEntries';
import type {
  ContextClearedDivider,
  DisplayEntry,
  PatchTypeWithKey,
} from '@/shared/hooks/useConversationHistory/types';

import {
  buildConversationRowsIncremental,
  type ConversationRow,
} from './conversation-row-model';

export interface DerivedConversationTimeline {
  readonly displayEntries: DisplayEntry[];
  readonly rows: ConversationRow[];
}

function isRenderableConversationEntry(entry: DisplayEntry): boolean {
  if (
    entry.type === 'NORMALIZED_ENTRY' &&
    typeof entry.content !== 'string' &&
    'entry_type' in entry.content
  ) {
    const entryType = entry.content.entry_type.type;
    return entryType !== 'next_action' && entryType !== 'token_usage_info';
  }

  return (
    entry.type === 'NORMALIZED_ENTRY' ||
    entry.type === 'STDOUT' ||
    entry.type === 'STDERR' ||
    entry.type === 'AGGREGATED_GROUP' ||
    entry.type === 'AGGREGATED_DIFF_GROUP' ||
    entry.type === 'AGGREGATED_THINKING_GROUP' ||
    entry.type === 'CONTEXT_CLEARED_DIVIDER'
  );
}

/**
 * Inject a synthetic "context cleared" divider into the chronologically-ordered
 * `displayEntries` list. The divider lands at the boundary between entries
 * whose owning execution process was created before `clearedAt` and entries
 * whose process was created strictly after `clearedAt`. If no post-clear
 * process exists yet, the divider is appended at the end so the user sees
 * "context cleared, next message starts a fresh session."
 *
 * The boundary lookup uses `processCreatedAtById` because `DisplayEntry`
 * itself doesn't carry a timestamp — the timestamp lives on the parent
 * execution_process. Phase 5 of the May 2026 UX-gaps plan.
 */
function injectClearedDivider(
  entries: DisplayEntry[],
  clearedAt: string | null,
  processCreatedAtById: ReadonlyMap<string, string>
): DisplayEntry[] {
  if (!clearedAt) return entries;
  const clearedAtMs = Date.parse(clearedAt);
  if (!Number.isFinite(clearedAtMs)) return entries;

  let boundary = entries.length;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === 'CONTEXT_CLEARED_DIVIDER') continue;
    const procCreatedAt = processCreatedAtById.get(entry.executionProcessId);
    if (!procCreatedAt) continue;
    const procMs = Date.parse(procCreatedAt);
    if (Number.isFinite(procMs) && procMs > clearedAtMs) {
      boundary = i;
      break;
    }
  }

  const divider: ContextClearedDivider = {
    type: 'CONTEXT_CLEARED_DIVIDER',
    clearedAt,
    patchKey: `cleared:${clearedAt}`,
    executionProcessId: '',
  };

  return [...entries.slice(0, boundary), divider, ...entries.slice(boundary)];
}

// Final UI-facing timeline step: aggregate display entries and build stable rows
// for virtualization, navigation, and scroll orchestration.

export function deriveConversationTimeline(
  entries: PatchTypeWithKey[],
  previousDisplayEntries: DisplayEntry[],
  previousRows: ConversationRow[],
  clearedAt: string | null = null,
  processCreatedAtById: ReadonlyMap<string, string> = new Map()
): DerivedConversationTimeline {
  const aggregated = aggregateConsecutiveEntries(entries).filter(
    isRenderableConversationEntry
  );
  const displayEntries = injectClearedDivider(
    aggregated,
    clearedAt,
    processCreatedAtById
  );

  const rows = buildConversationRowsIncremental(
    displayEntries,
    previousDisplayEntries,
    previousRows
  );

  return {
    displayEntries,
    rows,
  };
}
