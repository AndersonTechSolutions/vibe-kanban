import { formatDateShortWithTime } from '@/shared/lib/date';

interface ContextClearedDividerProps {
  /** ISO timestamp of when the user cleared the executor context. */
  clearedAt: string;
}

/**
 * Inline horizontal divider rendered in the conversation log at the boundary
 * between pre-clear and post-clear executor turns. Phase 5 of the
 * May 2026 UX-gaps plan — surfaces the clear-context boundary so users can
 * see where their session was reset.
 */
export function ContextClearedDivider({
  clearedAt,
}: ContextClearedDividerProps) {
  return (
    <div
      role="separator"
      aria-label={`Context cleared at ${clearedAt}`}
      className="my-base flex w-full items-center gap-2 px-base text-low"
      data-scroll-anchor-ignore
    >
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span className="text-xs whitespace-nowrap">
        Context cleared {formatDateShortWithTime(clearedAt)}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
