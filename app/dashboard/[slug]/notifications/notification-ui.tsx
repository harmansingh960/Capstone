"use client";

import Link from "next/link";
import type { NotificationType } from "@/lib/schema";
import {
  isSafeNotificationPath,
  type NotificationDto,
} from "@/lib/notification-dto";

export type { NotificationDto };

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  "task.assigned": "Task assigned",
  "task.updated": "Task updated",
  "deliverable.submitted": "Deliverable submitted",
  "review.decided": "Review decision",
  "blocker.reported": "Blocker reported",
  "blocker.resolved": "Blocker resolved",
  "blocker.dismissed": "Blocker dismissed",
  "meeting.participant_added": "Meeting",
  "action_item.assigned": "Action item",
  "deadline.reminder": "Deadline reminder",
  "member.added": "Member added",
  general: "Notification",
};

export function notificationsApiBase(organizationSlug: string): string {
  return `/api/organizations/${encodeURIComponent(organizationSlug)}/notifications`;
}

export async function readNotificationApiError(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error.trim() !== "") {
      return data.error;
    }
  } catch {
    // Non-JSON error body; fall through to the generic message.
  }
  return fallback;
}

export function formatNotificationTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function typeLabel(type: NotificationType): string {
  return NOTIFICATION_TYPE_LABELS[type] ?? "Notification";
}

export function NotificationListItem({
  notification,
  organizationSlug,
  marking,
  onMarkRead,
  onNavigate,
}: {
  notification: NotificationDto;
  organizationSlug: string;
  marking: boolean;
  onMarkRead: (id: string) => void;
  onNavigate?: () => void;
}) {
  const unread = !notification.isRead;
  // Defense in depth: the API already drops unsafe URLs, but only render a
  // link for internal paths inside this organization's dashboard.
  const href = isSafeNotificationPath(notification.url, organizationSlug)
    ? notification.url
    : null;

  const titleClass = unread
    ? "text-sm font-semibold text-zinc-900 dark:text-zinc-50"
    : "text-sm font-medium text-zinc-600 dark:text-zinc-400";

  return (
    <li
      data-testid="notification-item"
      data-read={unread ? "false" : "true"}
      className={`flex gap-3 border-l-4 px-3 py-3 ${
        unread
          ? "border-l-blue-600 bg-blue-50/60 dark:border-l-blue-400 dark:bg-blue-950/30"
          : "border-l-transparent"
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
          unread ? "bg-blue-600 dark:bg-blue-400" : "bg-transparent"
        }`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
          <span className="font-medium uppercase tracking-wide">
            {typeLabel(notification.type)}
          </span>
          <span aria-hidden="true">·</span>
          <time dateTime={notification.createdAt}>
            {formatNotificationTime(notification.createdAt)}
          </time>
          {unread ? <span className="sr-only">(unread)</span> : null}
        </div>
        {href ? (
          <Link
            href={href}
            data-testid="notification-link"
            className={`${titleClass} break-words hover:underline`}
            onClick={() => {
              if (unread) onMarkRead(notification.id);
              onNavigate?.();
            }}
          >
            {notification.title}
          </Link>
        ) : (
          <p className={`${titleClass} break-words`}>{notification.title}</p>
        )}
        <p
          className={`break-words text-xs ${
            unread
              ? "text-zinc-700 dark:text-zinc-300"
              : "text-zinc-500 dark:text-zinc-500"
          }`}
        >
          {notification.message}
        </p>
      </div>
      {unread ? (
        <button
          type="button"
          data-testid="notification-mark-read"
          onClick={() => onMarkRead(notification.id)}
          disabled={marking}
          className="shrink-0 self-start rounded border border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {marking ? "Marking…" : "Mark read"}
        </button>
      ) : null}
    </li>
  );
}

