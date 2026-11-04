import { connection } from "next/server";
import {
  getUnreadNotificationCount,
  markAllNotificationsRead,
} from "@/lib/notifications";
import {
  getOrganizationBySlug,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";

/**
 * POST /api/organizations/[slug]/notifications/mark-all-read
 *
 * Marks every unread notification of the signed-in user in this organization
 * as read. No request body is required; any non-empty body is rejected.
 */
export async function POST(
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

    const rawText = await request.text();
    if (rawText.trim() !== "") {
      let body: unknown;
      try {
        body = JSON.parse(rawText);
      } catch {
        return Response.json(
          { error: "Invalid JSON request body." },
          { status: 400 },
        );
      }
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length > 0
      ) {
        return Response.json(
          { error: "This endpoint does not accept a request body." },
          { status: 400 },
        );
      }
    }

    const { updatedCount } = await markAllNotificationsRead(
      organization._id,
      request.headers,
    );
    const unreadCount = await getUnreadNotificationCount(
      organization._id,
      request.headers,
    );

    return Response.json({ updatedCount, unreadCount }, { status: 200 });
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
      { error: "Failed to mark notifications as read." },
      { status: 500 },
    );
  }
}

