import { connection } from "next/server";
import { toNotificationDto } from "@/lib/notification-dto";
import {
  getUnreadNotificationCount,
  listNotifications,
} from "@/lib/notifications";
import {
  getOrganizationBySlug,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";

/**
 * GET /api/organizations/[slug]/notifications
 *
 * Lists the signed-in user's own notifications in this organization.
 * Query parameters:
 *   - `status`: `all` (default) | `unread` | `read`
 *   - `limit`:  1–50 (default 20)
 *   - `cursor`: opaque cursor from a previous response's `nextCursor`
 * The recipient is always derived from the session; no recipient parameter is
 * accepted.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug } = await params;
    let organization: UserOrganization;
    try {
      organization = await getOrganizationBySlug(slug, request.headers);
    } catch (error) {
      if (error instanceof TenantAccessError) {
        return Response.json(
          { error: "Organization not found." },
          { status: 404 },
        );
      }
      throw error;
    }

    const { searchParams } = new URL(request.url);
    const rawStatus =
      searchParams.get("status") ??
      searchParams.get("filter") ??
      (searchParams.get("unread") === "true" || searchParams.get("read") === "false"
        ? "unread"
        : searchParams.get("read") === "true" || searchParams.get("unread") === "false"
          ? "read"
          : undefined);

    const [page, unreadCount] = await Promise.all([
      listNotifications(
        organization._id,
        {
          limit: searchParams.get("limit") ?? undefined,
          cursor: searchParams.get("cursor") ?? undefined,
          status: rawStatus,
        },
        request.headers,
      ),
      getUnreadNotificationCount(organization._id, request.headers),
    ]);

    return Response.json(
      {
        notifications: page.notifications.map((item) =>
          toNotificationDto(item, organization.slug),
        ),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        unreadCount,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof TenantValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof TenantAccessError) {
      if (error.message === "Authentication required.") {
        return Response.json(
          { error: "Authentication required." },
          { status: 401 },
        );
      }
      return Response.json({ error: "Access denied." }, { status: 403 });
    }
    return Response.json(
      { error: "Failed to load notifications." },
      { status: 500 },
    );
  }
}

