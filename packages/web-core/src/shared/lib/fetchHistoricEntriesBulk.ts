/**
 * Single-shot fetch of normalized log history for many execution processes.
 *
 * Replaces the prior pattern of opening one WebSocket per process and
 * awaiting each one in turn. The server endpoint
 * (`POST /api/execution-processes/normalized-logs/bulk`) reuses the same
 * `stream_normalized_logs` source but drains it server-side, so the wire
 * format per-message matches what `streamJsonPatchEntries` already
 * understands (`{ "JsonPatch": [...ops] }`, `{ "Stdout": "..." }`, etc.).
 *
 * For ScriptRequest processes the server returns an empty array, which
 * matches the prior client behaviour where `streamJsonPatchEntries`
 * ignored Stdout/Stderr messages anyway.
 */

import { produce } from 'immer';
import type { Operation } from 'rfc6902';
import { applyUpsertPatch } from '@/shared/lib/jsonPatch';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import type { PatchType } from 'shared/types';

interface BulkHistoryEnvelope {
  success: boolean;
  data?: {
    entries_by_process: Record<string, BulkRawLogMsg[]>;
  };
  message?: string;
}

// Mirror of the `LogMsg` variants we care about on the wire. We only
// replay `JsonPatch`; the other variants are tolerated (and skipped)
// so the parser never throws on a forward-compatible payload.
type BulkRawLogMsg =
  | { JsonPatch: Operation[] }
  | { Stdout: string }
  | { Stderr: string }
  | { SessionId: string }
  | { MessageId: string }
  | { Ready: unknown }
  | { finished: true };

export async function fetchHistoricEntriesBulk(
  ids: string[]
): Promise<Map<string, PatchType[]>> {
  if (ids.length === 0) return new Map();

  const response = await makeLocalApiRequest(
    '/api/execution-processes/normalized-logs/bulk',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }
  );
  if (!response.ok) {
    throw new Error(
      `bulk history fetch failed: ${response.status} ${response.statusText}`
    );
  }
  const envelope = (await response.json()) as BulkHistoryEnvelope;
  if (!envelope.success || !envelope.data) {
    throw new Error(
      `bulk history responded non-success: ${envelope.message ?? 'unknown'}`
    );
  }

  const result = new Map<string, PatchType[]>();
  for (const [id, msgs] of Object.entries(envelope.data.entries_by_process)) {
    result.set(id, replayMessages(msgs));
  }
  return result;
}

function replayMessages(msgs: BulkRawLogMsg[]): PatchType[] {
  const ops: Operation[] = [];
  for (const msg of msgs) {
    if ('JsonPatch' in msg) {
      ops.push(...msg.JsonPatch);
    }
    // Other variants are intentionally ignored — matches the existing
    // streamJsonPatchEntries behaviour, where only JsonPatch contributes
    // to the rendered entries array.
  }
  if (ops.length === 0) return [];

  let snapshot: { entries: PatchType[] } = { entries: [] };
  snapshot = produce(snapshot, (draft) => {
    applyUpsertPatch(draft, ops);
  });
  return snapshot.entries;
}
