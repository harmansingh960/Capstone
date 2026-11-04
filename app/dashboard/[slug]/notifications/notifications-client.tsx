"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import {
  NotificationListItem,
  notificationsApiBase,
  readNotificationApiError,
  type NotificationDto,
} from "./notification-ui";

type NotificationFilter = "all" | "unread" | "read";

export function NotificationsClient({
  organizationSlug,
  initialNotifications,
  initialHasMore,
  initialNextCursor,
  initialUnreadCount,
}: {
  organizationSlug: string;
  initialNotifications: NotificationDto[];
  initialHasMore: boolean;
  initialNextCursor: string | null;
  initialUnreadCount: number;
}) {
  const router = useRouter();
  const apiBase = notificationsApiBase(organizationSlug);

  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [notifications, setNotifications] =
    useState<NotificationDto[]>(initialNotifications);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [nextCursor, setNextCursor] = useState<string | null>(
    initialNextCursor,
  );
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [markingIds, setMarkingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [markingAll, setMarkingAll] = useState(false);

  const fetchFiltered = useCallback(
    async (targetFilter: NotificationFilter) => {
      setLoading(true);
      setError(null);
      setActionError(null);
      try {
        const params = new URLSearchParams({
          limit: "20",
          status: targetFilter,
        });
        const res = await fetch(`${apiBase}?${params.toString()}`, {
          method: "GET",
          cache: "no-store",
        });
        if (res.status === 401) {
          router.push("/login");
          return;
        }
        if (!res.ok) {
          setError(
            await readNotificationApiError(
              res,
              "Unable to load notifications.",
            ),
          );
          return;
        }
        const data = (await res.json()) as {
          notifications?: NotificationDto[];
          nextCursor?: string | null;
          hasMore?: boolean;
          unreadCount?: number;
        };
        setNotifications(
          Array.isArray(data.notifications) ? data.notifications : [],
        );
        setHasMore(data.hasMore === true);
        setNextCursor(
          typeof data.nextCursor === "string" ? data.nextCursor : null,
        );
        if (typeof data.unreadCount === "number") {
          setUnreadCount(data.unreadCount);
        }
      } catch {
        setError("Could not load notifications. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    [apiBase, router],
  );

  function handleFilterChange(newFilter: NotificationFilter) {
    if (newFilter === filter) return;
    setFilter(newFilter);
    void fetchFiltered(newFilter);
  }

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setActionError(null);
    try {
      const params = new URLSearchParams({
        limit: "20",
        status: filter,
        cursor: nextCursor,
      });
      const res = await fetch(`${apiBase}?${params.toString()}`, {
        method: "GET",
        cache: "no-store",
      });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        setActionError(
          await readNotificationApiError(
            res,
            "Unable to load more notifications.",
          ),
        );
        return;
      }
      const data = (await res.json()) as {
        notifications?: NotificationDto[];
        nextCursor?: string | null;
        hasMore?: boolean;
        unreadCount?: number;
      };
      const incoming = Array.isArray(data.notifications)
        ? data.notifications
        : [];
      setNotifications((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        const merged = [...prev];
        for (const item of incoming) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            merged.push(item);
          }
        }
        return merged;
      });
      setHasMore(data.hasMore === true);
      setNextCursor(
        typeof data.nextCursor === "string" ? data.nextCursor : null,
      );
      if (typeof data.unreadCount === "number") {
        setUnreadCount(data.unreadCount);
      }
    } catch {
      setActionError("Could not load more notifications. Please try again.");
    } finally {
      setLoadingMore(false);
    }
  }, [apiBase, filter, nextCursor, loadingMore, router]);

  async function markRead(id: string) {
    if (markingIds.has(id)) return;
    setMarkingIds((prev) => new Set(prev).add(id));
    setActionError(null);
    try {
      const res = await fetch(`${apiBase}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read: true }),
      });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        setActionError(
          await readNotificationApiError(
            res,
            "Unable to mark notification as read.",
          ),
        );
        return;
      }
      const data = (await res.json()) as {
        notification?: NotificationDto;
        unreadCount?: number;
      };
      const updated = data.notification;
      if (updated) {
        setNotifications((prev) => {
          if (filter === "unread") {
            return prev.filter((n) => n.id !== id);
          }
          return prev.map((n) => (n.id === id ? updated : n));
        });
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
      const res = await fetch(`${apiBase}/mark-all-read`, {
        method: "POST",
      });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        setActionError(
          await readNotificationApiError(
            res,
            "Unable to mark all notifications as read.",
          ),
        );
        return;
      }
      const data = (await res.json()) as { unreadCount?: number };
      const readAt = new Date().toISOString();
      setNotifications((prev) => {
        if (filter === "unread") {
          return [];
        }
        return prev.map((n) =>
          n.isRead ? n : { ...n, isRead: true, readAt: n.readAt ?? readAt },
        );
      });
      setUnreadCount(typeof data.unreadCount === "number" ? data.unreadCount : 0);
    } catch {
      setActionError(
        "Could not mark all notifications as read. Please try again.",
      );
    } finally {
      setMarkingAll(false);
    }
  }

  const emptyMessage =
    filter === "unread"
      ? "You have no unread notifications."
      : filter === "read"
        ? "You have no read notifications."
        : "You have no notifications.";

  return (
    <div className="flex flex-col gap-4">
      {/* Action / Filter bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <div
          role="tablist"
          aria-label="Notification filters"
          className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <button
            type="button"
            role="tab"
            aria-selected={filter === "all"}
            data-testid="filter-all"
            onClick={() => handleFilterChange("all")}
            className={`rounded px-3 py-1 text-xs font-medium transition ${
              filter === "all"
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            All
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "unread"}
            data-testid="filter-unread"
            onClick={() => handleFilterChange("unread")}
            className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition ${
              filter === "unread"
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            <span>Unread</span>
            {unreadCount > 0 ? (
              <span className="rounded-full bg-blue-100 px-1.5 py-0.2 text-[10px] font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "read"}
            data-testid="filter-read"
            onClick={() => handleFilterChange("read")}
            className={`rounded px-3 py-1 text-xs font-medium transition ${
              filter === "read"
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            Read
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void markAllRead()}
            disabled={markingAll || unreadCount === 0}
            data-testid="notifications-mark-all-read"
            className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {markingAll ? "Marking…" : "Mark all as read"}
          </button>
          <button
            type="button"
            onClick={() => void fetchFiltered(filter)}
            disabled={loading}
            aria-label="Refresh notifications"
            className="rounded border border-zinc-300 p-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        </div>
      </div>

      {actionError ? (
        <div
          role="alert"
          className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {actionError}
        </div>
      ) : null}

      {/* Main notification list container */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {loading ? (
          <p className="px-4 py-12 text-center text-sm text-zinc-500">
            Loading notifications…
          </p>
        ) : error ? (
          <div
            role="alert"
            data-testid="notification-error"
            className="flex flex-col items-center gap-3 px-4 py-12 text-center"
          >
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            <button
              type="button"
              onClick={() => void fetchFiltered(filter)}
              className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Retry
            </button>
          </div>
        ) : notifications.length === 0 ? (
          <div
            data-testid="notification-empty"
            className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center text-zinc-500"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              className="h-8 w-8 text-zinc-400"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
              />
            </svg>
            <p className="text-sm font-medium">{emptyMessage}</p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {notifications.map((notification) => (
              <NotificationListItem
                key={notification.id}
                notification={notification}
                organizationSlug={organizationSlug}
                marking={markingIds.has(notification.id)}
                onMarkRead={(id) => void markRead(id)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Pagination / Load more */}
      {hasMore && !loading && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            data-testid="notification-load-more"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded border border-zinc-300 bg-white px-4 py-2 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {loadingMore ? "Loading more…" : "Load more notifications"}
          </button>
        </div>
      )}
    </div>
  );
}

