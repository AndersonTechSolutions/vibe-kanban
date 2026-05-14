/**
 * Dialog for moving an issue to a different project in the same organization.
 *
 * Two-step picker (project, then status) wired to the POST /api/issues/:id/move
 * endpoint. On success: navigate to the new issue URL.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@vibe/ui/components/Dialog';
import { Button } from '@vibe/ui/components/Button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import { useOrgContext } from '@/shared/hooks/useOrgContext';
import { moveIssue, makeRequest } from '@/shared/lib/remoteApi';
import type { Issue, ProjectStatus } from 'shared/remote-types';

export interface MoveIssueDialogProps {
  issue: Issue;
  open: boolean;
  onClose: () => void;
}

export function MoveIssueDialog({ issue, open, onClose }: MoveIssueDialogProps) {
  const navigate = useNavigate();
  const orgContext = useOrgContext();

  // 1. Same-org projects, excluding source.
  const projects = useMemo(
    () => orgContext.projects.filter((p) => p.id !== issue.project_id),
    [orgContext.projects, issue.project_id]
  );

  const [destProjectId, setDestProjectId] = useState<string | null>(null);
  const [destStatusId, setDestStatusId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset selections whenever the dialog re-opens or the issue changes.
  useEffect(() => {
    if (open) {
      setDestProjectId(null);
      setDestStatusId(null);
      setSubmitting(false);
      setErrorMessage(null);
    }
  }, [open, issue.id]);

  // 2. Destination project statuses (non-hidden, ordered).
  const statusesQuery = useQuery({
    queryKey: ['project_statuses', destProjectId],
    enabled: !!destProjectId,
    queryFn: async (): Promise<ProjectStatus[]> => {
      const res = await makeRequest(`/v1/project_statuses?project_id=${destProjectId}`);
      if (!res.ok) throw new Error('Failed to load destination project statuses');
      const data = (await res.json()) as { project_statuses: ProjectStatus[] };
      return data.project_statuses;
    },
  });

  // Reset status selection when destination project changes.
  useEffect(() => {
    setDestStatusId(null);
  }, [destProjectId]);

  const eligibleStatuses = useMemo(
    () => (statusesQuery.data ?? []).filter((s) => !s.hidden),
    [statusesQuery.data]
  );

  // Auto-select the first eligible status once the query resolves, so the
  // user only has to click Move once after picking a project. They can still
  // change the status before submitting.
  useEffect(() => {
    if (!destProjectId) return;
    if (destStatusId) return;
    const first = eligibleStatuses[0];
    if (first) setDestStatusId(first.id);
  }, [destProjectId, destStatusId, eligibleStatuses]);

  const canSubmit =
    !!destProjectId &&
    !!destStatusId &&
    !submitting &&
    !statusesQuery.isLoading;

  const handleSubmit = async () => {
    if (!destProjectId || !destStatusId) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await moveIssue({
        issueId: issue.id,
        destinationProjectId: destProjectId,
        destinationStatusId: destStatusId,
      });
      onClose();
      navigate({
        to: '/projects/$projectId/issues/$issueId',
        params: { projectId: destProjectId, issueId: issue.id },
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move issue</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-base">
          <div>
            <label className="block text-sm font-medium mb-half">Destination project</label>
            <Select
              value={destProjectId ?? ''}
              onValueChange={(v) => setDestProjectId(v || null)}
              disabled={submitting}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a project…" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-half">Destination status</label>
            <Select
              value={destStatusId ?? ''}
              onValueChange={(v) => setDestStatusId(v || null)}
              disabled={!destProjectId || statusesQuery.isLoading || submitting}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    !destProjectId
                      ? '(pick project first…)'
                      : statusesQuery.isLoading
                        ? 'Loading…'
                        : 'Select a status…'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {eligibleStatuses.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="text-xs text-low">
            The issue&apos;s ID will change (e.g. <code>{issue.simple_id}</code> → a new
            number in the destination project). Tags will be preserved by name;
            comments, assignees, sub-issues, and PR links carry over automatically.
          </div>

          {errorMessage && (
            <div className="text-sm text-destructive" role="alert">
              {errorMessage}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? 'Moving…' : 'Move'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
