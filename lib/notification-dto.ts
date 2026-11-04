import type { NotificationEntityType, NotificationType } from "@/lib/schema";
import type { NotificationItem } from "@/lib/notifications";

// Client-safe notification DTO helpers (no server-only imports at runtime).

export type NotificationDto = {
  id: string;
  organizationId: string;
  type: NotificationType;
  title: string;
  message: string;
  /** Internal destination inside this organization's dashboard, or `null`. */
  url: string | null;
  entityType: NotificationEntityType | null;
  entityId: string | null;
  projectId: string | null;
  createdAt: string;
  readAt: string | null;
  isRead: boolean;
};

// Conservative allow-list for internal paths: `/dashboard/<slug>` optionally
// followed by `/segments`, a query string, and/or a fragment. Rejects
// protocol-relative (`//`), absolute (`https:`), backslash and dot-segment
// paths so a stored URL can never navigate off-site or escape the dashboard.
const SAFE_PATH_PATTERN =
  /^\/dashboard\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[A-Za-z0-9\-._~%]+)*\/?(?:\?[A-Za-z0-9\-._~%&=+]*)?(?:#[A-Za-z0-9\-._~%]*)?$/;

/**
 * Returns `true` when `path` is a safe internal path within
 * `/dashboard/<organizationSlug>`. Used both when persisting notifications and
 * when serializing them, so a link is only ever rendered for the organization
 * the notification belongs to.
 */
export function isSafeNotificationPath(
  path: unknown,
  organizationSlug: string,
): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 2048) {
    return false;
  }
  if (path.includes("//") || path.includes("\\") || path.includes("/../") || path.includes("/./")) {
    return false;
  }
  if (!SAFE_PATH_PATTERN.test(path)) {
    return false;
  }
  const prefix = `/dashboard/${organizationSlug}`;
  if (!path.startsWith(prefix)) {
    return false;
  }
  const rest = path.slice(prefix.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#");
}

export function toNotificationDto(
  item: NotificationItem,
  organizationSlug: string,
): NotificationDto {
  return {
    id: item.id,
    organizationId: item.organizationId,
    type: item.type,
    title: item.title,
    message: item.message,
    url: isSafeNotificationPath(item.url, organizationSlug) ? item.url : null,
    entityType: item.entityType,
    entityId: item.entityId,
    projectId: item.projectId,
    createdAt: item.createdAt.toISOString(),
    readAt: item.readAt ? item.readAt.toISOString() : null,
    isRead: item.readAt !== null,
  };
}

