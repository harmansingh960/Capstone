"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  NotificationListItem,
  notificationsApiBase,
  readNotificationApiError,
  type NotificationDto,
} from "./notifications/notification-ui";

const BELL_PAGE_LIMIT = 10;
const UNREAD_POLL_INTERVAL_MS = 60_000;

/**
 * Notification bell with unread badge and a compact dropdown of the signed-in
 * user's most recent notifications in this organization. All data comes from
 * the recipient-scoped notification APIs; the recipient is never sent by the
 * client.
 */
export function NotificationBell({
  organizationSlug,
}: {
  organizationSlug: string;
}) {
  const router = useRouter();
  const apiBase = notificationsApiBase(organizationSlug);
  const notificationsPageHref = `/dashboard/${encodeURIComponent(organizationSlug)}/notifications`;

  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [markingIds, setMarkingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [markingAll, setMarkingAll] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Unread count: initial load, periodic refresh while the tab is visible, and
  // refresh when the tab becomes visible again.
  useEffect(() => {
    let cancelled = false;

    async function refreshUnreadCount() {
      try {
        const response = await fetch(`${apiBase}/unread-count`, {
          method: "GET",
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = (await response.json()) as { unreadCount?: unknown };
        if (!cancelled && typeof data.unreadCount === "number") {
          setUnreadCount(data.unreadCount);
        }
      } catch {
        // Badge refresh is best-effort; keep the last known value.
      }
    }

    void refreshUnreadCount();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshUnreadCount();
      }
    }, UNREAD_POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshUnreadCount();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [apiBase]);

  // Close the dropdown on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    setActionError(null);
    try {
      const response = await fetch(`${apiBase}?limit=${BELL_PAGE_LIMIT}`, {
        method: "GET",
        cache: "no-store",
      });
      if (response.status === 401) {
        router.push("/login");
        return;
      }
      if (!response.ok) {
        setListError(
          await readNotificationApiError(
            response,
            "Unable to load notifications.",
          ),
        );
        return;
      }
      const data = (await response.json()) as {
        notifications?: NotificationDto[];
        hasMore?: boolean;
        unreadCount?: number;
      };
      setItems(Array.isArray(data.notifications) ? data.notifications : []);
      setHasMore(data.hasMore === true);
      if (typeof data.unreadCount === "number") {
        setUnreadCount(data.unreadCount);
      }
    } catch {
      setListError("Could not load notifications. Please try again.");
    } finally {
      setListLoading(false);
    }
  }, [apiBase, router]);

  function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    void loadList();
  }

  async function markRead(id: string) {
    if (markingIds.has(id)) return;
    setMarkingIds((prev) => new Set(prev).add(id));
    setActionError(null);
    try {
      const response = await fetch(`${apiBase}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read: true }),
      });
      if (response.status === 401) {
        router.push("/login");
        return;
      }
      if (!response.ok) {
        setActionError(
          await readNotificationApiError(
            response,
            "Unable to mark notification as read.",
          ),
        );
        return;
      }
      const data = (await response.json()) as {
        notification?: NotificationDto;
        unreadCount?: number;
      };
      const updated = data.notification;
      if (updated) {
        setItems((prev) => prev.map((n) => (n.id === id ? updated : n)));
      }
      if (typeof data.unreadCount === "number") {
        setUnreadCount(data.unreadCount);
      }
    } catch {
      setActionError("Could not mark notification as read. Please try again.");
    } finally {
      setMarkingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function markAllRead() {
    if (markingAll) return;
    setMarkingAll(true);
    setActionError(null);
    try {
      const response = await fetch(`${apiBase}/mark-all-read`, {
        method: "POST",
      });
      if (response.status === 401) {
        router.push("/login");
        return;
      }
      if (!response.ok) {
        setActionError(
          await readNotificationApiError(
            response,
            "Unable to mark all notifications as read.",
          ),
        );
        return;
      }
      const data = (await response.json()) as { unreadCount?: number };
      const readAt = new Date().toISOString();
      setItems((prev) =>
        prev.map((n) =>
          n.isRead ? n : { ...n, isRead: true, readAt: n.readAt ?? readAt },
        ),
      );
      setUnreadCount(typeof data.unreadCount === "number" ? data.unreadCount : 0);
    } catch {
      setActionError(
        "Could not mark all notifications as read. Please try again.",
      );
    } finally {
      setMarkingAll(false);
    }
  }

  const count = unreadCount ?? 0;
  const badgeText = count > 99 ? "99+" : String(count);
  const buttonLabel =
    count > 0 ? `Notifications, ${count} unread` : "Notifications";

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        aria-label={buttonLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="notification-bell"
        className="relative inline-flex items-center justify-center rounded border border-zinc-300 p-2 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          className="h-5 w-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
          />
        </svg>
        {count > 0 ? (
          <span
            data-testid="notification-unread-badge"
            className="absolute -right-1.5 -top-1.5 min-w-[1.25rem] rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-5 text-white"
          >
            {badgeText}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          data-testid="notification-panel"
          className="fixed inset-x-2 top-16 z-50 flex max-h-[75vh] flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white text-left shadow-lg dark:border-zinc-800 dark:bg-zinc-900 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96"
        >
          <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <h2 className="text-sm font-semibold">
              Notifications
              {count > 0 ? (
                <span className="ml-1 text-xs font-normal text-zinc-500">
                  ({count} unread)
                </span>
              ) : null}
            </h2>
            <button
              type="button"
              onClick={() => void markAllRead()}
              disabled={markingAll || count === 0}
              data-testid="notification-mark-all-read"
              className="rounded px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
            >
              {markingAll ? "Marking…" : "Mark all as read"}
            </button>
          </div>

          {actionError ? (
            <p
              role="alert"
              className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            >
              {actionError}
            </p>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {listLoading && items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-zinc-500">
                Loading notifications…
              </p>
            ) : listError ? (
              <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {listError}
                </p>
                <button
                  type="button"
                  onClick={() => void loadList()}
                  className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Retry
                </button>
              </div>
            ) : items.length === 0 ? (
              <p
                data-testid="notification-empty"
                className="px-3 py-6 text-center text-sm text-zinc-500"
              >
                You have no notifications.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {items.map((notification) => (
                  <NotificationListItem
                    key={notification.id}
                    notification={notification}
                    organizationSlug={organizationSlug}
                    marking={markingIds.has(notification.id)}
                    onMarkRead={(id) => void markRead(id)}
                    onNavigate={() => setOpen(false)}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-zinc-200 px-3 py-2 text-center dark:border-zinc-800">
            <Link
              href={notificationsPageHref}
              onClick={() => setOpen(false)}
              data-testid="notification-view-all"
              className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
            >
              {hasMore ? "View all notifications" : "Open notification center"}
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

