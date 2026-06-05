import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { getAppCopy } from '../i18n';

export type TopbarNotificationTone = 'critical' | 'info' | 'success' | 'warning';

export type TopbarNotificationItem = {
  body?: string | null;
  createdAt?: string | null;
  href?: string | null;
  id: string;
  read?: boolean;
  title: string;
  tone: TopbarNotificationTone;
};

export function TopbarNotifications({
  initialOpen = false,
  items = [],
  locale,
  loadError = null,
  navigate,
  onNotificationOpen,
  unreadCount,
}: {
  initialOpen?: boolean;
  items?: TopbarNotificationItem[];
  locale?: string | null;
  loadError?: string | null;
  navigate?(path: string): void;
  onNotificationOpen?(item: TopbarNotificationItem): void;
  unreadCount?: number;
}): ReactElement {
  const t = getAppCopy(locale).notifications;
  const [open, setOpen] = useState(initialOpen);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const visibleUnreadCount = useMemo(
    () => countUnreadNotifications(items),
    [items],
  );
  const totalUnreadCount =
    unreadCount === undefined
      ? visibleUnreadCount
      : Math.max(0, Math.floor(unreadCount));
  const hasLoadError = loadError !== null && loadError.trim() !== '';

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      if (
        rootRef.current !== null &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const openNotification = (item: TopbarNotificationItem): void => {
    onNotificationOpen?.(item);
    if (item.href !== null && item.href !== undefined && item.href !== '') {
      navigate?.(item.href);
    }
    setOpen(false);
  };

  return (
    <div className="topbar-notifications" ref={rootRef}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t.openNotifications}
        className={`notification-button${hasLoadError ? ' has-error' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title={t.openNotifications}
        type="button"
      >
        <BellIcon />
        {totalUnreadCount === 0 && hasLoadError ? (
          <span className="notification-badge notification-badge--error" aria-label={t.loadFailedShort}>
            !
          </span>
        ) : totalUnreadCount === 0 ? null : (
          <span className="notification-badge" aria-label={t.unreadCount(totalUnreadCount)}>
            {formatUnreadCount(totalUnreadCount)}
          </span>
        )}
      </button>
      {open ? (
        <div
          aria-label={t.notifications}
          className="notification-menu"
          id={menuId}
          role="menu"
        >
          <div className="notification-menu-header">
            <strong>{t.notifications}</strong>
            <span>{hasLoadError ? t.loadFailedShort : totalUnreadCount === 0 ? t.allCaughtUp : t.unreadCount(totalUnreadCount)}</span>
          </div>
          {hasLoadError ? (
            <p className="notification-load-error" role="status">{loadError}</p>
          ) : null}
          {items.length === 0 && !hasLoadError ? (
            <p className="notification-empty">{t.noNotifications}</p>
          ) : (
            <div className="notification-list">
              {items.map((item) => (
                <button
                  className={`notification-item notification-item--${item.tone}${item.read === true ? ' is-read' : ''}`}
                  key={item.id}
                  onClick={() => openNotification(item)}
                  role="menuitem"
                  type="button"
                >
                  <span className="notification-item-tone" aria-hidden="true" />
                  <span>
                    <strong>{item.title}</strong>
                    {item.body === null || item.body === undefined ? null : (
                      <small>{item.body}</small>
                    )}
                    {item.createdAt === null || item.createdAt === undefined ? null : (
                      <time dateTime={item.createdAt}>{item.createdAt}</time>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function countUnreadNotifications(items: TopbarNotificationItem[]): number {
  return items.filter((item) => item.read !== true).length;
}

function formatUnreadCount(count: number): string {
  if (count > 99) return '99+';
  return String(count);
}

function BellIcon(): ReactElement {
  return (
    <svg aria-hidden="true" className="notification-bell-icon" viewBox="0 0 24 24">
      <path d="M12 22a2.6 2.6 0 0 0 2.45-1.75h-4.9A2.6 2.6 0 0 0 12 22Zm7-5.25-1.7-2.05v-4.45A5.32 5.32 0 0 0 13 5.04V4a1 1 0 1 0-2 0v1.04a5.32 5.32 0 0 0-4.3 5.21v4.45L5 16.75V18h14v-1.25Z" />
    </svg>
  );
}
