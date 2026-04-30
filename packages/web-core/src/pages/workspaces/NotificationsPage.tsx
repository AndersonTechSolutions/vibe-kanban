import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { BellIcon, CheckIcon, ChecksIcon } from '@phosphor-icons/react';
import { UserAvatar } from '@vibe/ui/components/UserAvatar';
import { useNotifications } from '@/shared/hooks/useNotifications';
import { useNotificationMembers } from '@/shared/hooks/useNotificationMembers';
import type { GroupedNotification } from '@/shared/lib/notifications';
import {
  getGroupedNotificationSegments,
  type MessageSegment,
} from '@/shared/lib/notificationMessage';
import { formatRelativeTime } from '@/shared/lib/date';
import { isTauriApp } from '@/shared/lib/platform';
import {
  getBrowserNotificationPermission,
  isBrowserNotificationsSupported,
  requestBrowserNotificationPermission,
  type BrowserNotificationPermission,
} from '@/shared/lib/browserNotifications';
import { usePushNotifications } from '@/shared/hooks/usePushNotifications';
import { cn } from '@/shared/lib/utils';

function BrowserNotificationBanner() {
  const [permission, setPermission] = useState<BrowserNotificationPermission>(
    () => getBrowserNotificationPermission()
  );
  const [requesting, setRequesting] = useState(false);
  const push = usePushNotifications();

  useEffect(() => {
    setPermission(getBrowserNotificationPermission());
  }, []);

  // Tauri uses native OS notifications via the desktop wrapper — no
  // browser permission needed there.
  if (isTauriApp()) {
    return null;
  }
  if (!isBrowserNotificationsSupported()) {
    return null;
  }

  // If push (Tier 2) is supported on this deployment AND the user has
  // already granted permission, show a secondary CTA to also enable the
  // background-alerts subscription. Hidden once both are wired up.
  const showPushUpgrade =
    permission === 'granted' && push.isSupported && !push.isSubscribed;

  if (
    (permission === 'granted' || permission === 'unsupported') &&
    !showPushUpgrade
  ) {
    return null;
  }

  const handleEnable = async () => {
    setRequesting(true);
    try {
      let nextPermission: BrowserNotificationPermission = permission;
      if (permission !== 'granted') {
        nextPermission = await requestBrowserNotificationPermission();
        setPermission(nextPermission);
      }
      // If push is supported on this deployment, also subscribe so OS
      // toasts fire even when the tab is closed (Tier 2). subscribe()
      // is a no-op if push is unsupported or already subscribed.
      if (nextPermission === 'granted' && push.isSupported) {
        await push.subscribe();
      }
    } finally {
      setRequesting(false);
    }
  };

  if (permission === 'denied') {
    return (
      <div className="px-double py-base border-b border-border bg-secondary/50 text-sm text-low">
        Desktop notifications are blocked. Enable them in your browser's
        site settings to get OS-level alerts when this tab is not in
        focus.
      </div>
    );
  }

  const titleCopy = showPushUpgrade
    ? 'Enable background alerts'
    : 'Enable desktop notifications';
  const subtitleCopy = showPushUpgrade
    ? 'Get OS-level alerts even when this tab is closed.'
    : push.isSupported
      ? 'Get OS-level alerts even when this tab is closed.'
      : 'Get OS-level alerts when this tab is in the background. Only fires while the browser is open.';
  const buttonLabel = requesting || push.isLoading ? 'Enabling…' : 'Enable';

  return (
    <div className="flex items-center justify-between gap-base px-double py-base border-b border-border bg-secondary/50">
      <div className="flex flex-col">
        <p className="text-sm text-high">{titleCopy}</p>
        <p className="text-xs text-low">{subtitleCopy}</p>
        {push.error && (
          <p className="text-xs text-destructive mt-half">{push.error}</p>
        )}
      </div>
      <button
        type="button"
        onClick={handleEnable}
        disabled={requesting || push.isLoading}
        className={cn(
          'shrink-0 inline-flex items-center rounded-sm px-base py-half text-sm transition-colors cursor-pointer',
          'border border-border text-high hover:bg-secondary',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand',
          'disabled:opacity-60 disabled:cursor-not-allowed'
        )}
      >
        {buttonLabel}
      </button>
    </div>
  );
}

function NotificationMessage({
  segments,
  membersByUserId,
}: {
  segments: MessageSegment[];
  membersByUserId: ReturnType<typeof useNotificationMembers>['membersByUserId'];
}) {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'text') return <span key={i}>{seg.value}</span>;
        if (seg.type === 'emphasis') {
          return (
            <span key={i} className="font-medium text-high">
              {seg.value}
            </span>
          );
        }
        if (seg.type === 'issue') {
          return (
            <span
              key={i}
              className="font-ibm-plex-mono text-high text-[0.95em]"
            >
              {seg.value}
            </span>
          );
        }
        const member = membersByUserId.get(seg.userId);
        if (member) {
          return (
            <UserAvatar
              key={i}
              user={member}
              className="inline-flex h-5 w-5 align-text-bottom text-[10px]"
            />
          );
        }
        return <span key={i}>Someone</span>;
      })}
    </>
  );
}

export function NotificationsPage() {
  const router = useRouter();
  const { data, updateMany, enabled, unseenCount, groupedNotifications } =
    useNotifications();
  const { membersByUserId } = useNotificationMembers(data);

  const markGroupSeen = useCallback(
    (group: GroupedNotification) => {
      if (group.unseenNotificationIds.length === 0) {
        return;
      }

      updateMany(
        group.unseenNotificationIds.map((notificationId) => ({
          id: notificationId,
          changes: { seen: true },
        }))
      );
    },
    [updateMany]
  );

  const handleClick = useCallback(
    (group: GroupedNotification) => {
      markGroupSeen(group);
      const path = group.deeplinkPath;
      if (path) {
        router.navigate({ to: path as '/' });
      }
    },
    [markGroupSeen, router]
  );

  const handleMarkAllSeen = useCallback(() => {
    const unseen = data.filter((n) => !n.seen);
    if (unseen.length === 0) return;
    updateMany(unseen.map((n) => ({ id: n.id, changes: { seen: true } })));
  }, [data, updateMany]);

  if (!enabled) {
    return (
      <div className="flex items-center justify-center h-full text-low">
        Sign in to view notifications
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-double py-base border-b border-border">
        <h1 className="text-xl font-medium text-high">Notifications</h1>
        {unseenCount > 0 && (
          <button
            type="button"
            onClick={handleMarkAllSeen}
            className="flex items-center gap-1 px-base py-half text-sm text-low hover:text-normal transition-colors cursor-pointer"
          >
            <ChecksIcon size={16} />
            Mark all as read
          </button>
        )}
      </div>

      <BrowserNotificationBanner />

      <div className="flex-1 overflow-y-auto">
        {groupedNotifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-low">
            <BellIcon size={32} weight="light" />
            <p className="text-base">No notifications yet</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {groupedNotifications.map((group) => (
              <div
                key={group.id}
                role="button"
                tabIndex={0}
                onClick={() => handleClick(group)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleClick(group);
                  }
                }}
                className={cn(
                  'w-full flex items-center gap-base px-double py-base text-left transition-colors cursor-pointer outline-none',
                  'hover:bg-secondary',
                  'focus-visible:bg-secondary',
                  'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand',
                  !group.seen && 'bg-brand/5'
                )}
              >
                <span
                  className={cn(
                    'shrink-0 w-2 h-2 rounded-full',
                    !group.seen && 'bg-brand'
                  )}
                />
                <div className="flex-1 min-w-0">
                  <p
                    className={cn(
                      'text-base truncate',
                      group.seen ? 'text-normal' : 'text-high'
                    )}
                  >
                    <NotificationMessage
                      segments={getGroupedNotificationSegments(group)}
                      membersByUserId={membersByUserId}
                    />
                  </p>
                  <p className="text-sm text-low mt-0.5">
                    {formatRelativeTime(group.latest.created_at)}
                  </p>
                </div>
                {!group.seen && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      markGroupSeen(group);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    className={cn(
                      'shrink-0 inline-flex items-center gap-half rounded-sm px-half py-half text-sm text-low transition-colors cursor-pointer',
                      'hover:bg-secondary hover:text-normal',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand'
                    )}
                    aria-label="Mark notification as read"
                    title="Mark as read"
                  >
                    <CheckIcon size={14} weight="bold" />
                    <span className="hidden sm:inline">Mark as read</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
