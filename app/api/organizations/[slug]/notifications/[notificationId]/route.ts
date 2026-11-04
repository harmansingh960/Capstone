import { connection } from "next/server";
import { toNotificationDto } from "@/lib/notification-dto";
import {
  getUnreadNotificationCount,
  markNotificationRead,
  parseNotificationId,
} from "@/lib/notifications";
import {
  getOrganizationBySlug,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";

/**
 * PATCH /api/organizations/[slug]/notifications/[notificationId]
 *
 * Body: `{ "read": true }` (an empty body is treated the same way).
 * Marks one of the signed-in user's own notifications as read. Notifications
 * belonging to other users or organizations return 404.
 */
export async function PATCH(
  request: Request,
  {
    params,
  }: { params: Promise<{ slug: string; notificationId: string }> },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, notificationId } = await params;
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

    const parsedNotificationId = parseNotificationId(notificationId);
    if (!parsedNotificationId) {
      return Response.json(
        { error: "Invalid notification ID." },
        { status: 400 },
      );
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
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return Response.json(
          { error: "Request body must be a JSON object." },
          { status: 400 },
        );
      }
      const record = body as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key !== "read") {
          return Response.json(
            { error: `Unexpected field "${key}". Only "read" is allowed.` },
            { status: 400 },
          );
        }
      }
      if ("read" in record && record.read !== true) {
        return Response.json(
          { error: "Field \"read\" must be true." },
          { status: 400 },
        );
      }
    }

    const updated = await markNotificationRead(
      organization._id,
      parsedNotificationId,
      request.headers,
    );
    if (!updated) {
      return Response.json(
        { error: "Notification not found." },
        { status: 404 },
      );
    }

    const unreadCount = await getUnreadNotificationCount(
      organization._id,
      request.headers,
    );

    return Response.json(
      {
        notification: toNotificationDto(updated, organization.slug),
        unreadCount,
      },
      { status: 200 },
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
      { error: "Failed to update notification." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string; notificationId: string }> },
) {
  return PATCH(request, context);
}


