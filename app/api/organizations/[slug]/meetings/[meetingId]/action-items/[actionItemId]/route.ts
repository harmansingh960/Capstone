import { connection } from "next/server";
import { toMeetingActionItemDto } from "@/lib/meeting-dto";
import type { ActionItemStatus } from "@/lib/schema";
import {
  ARCHIVED_MEETING_ACTION_ITEM_MESSAGE,
  getMeetingActionItemById,
  getMeetingById,
  getOrganizationBySlug,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  updateMeetingActionItem,
  type UpdateMeetingActionItemInput,
  type UserOrganization,
} from "@/lib/tenancy";
import { POST as convertActionItemPost } from "./convert/route";

const ALLOWED_UPDATE_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "ownerId",
  "targetDate",
  "status",
]);

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      slug: string;
      meetingId: string;
      actionItemId: string;
    }>;
  },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, meetingId, actionItemId } = await params;
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

    const parsedMeetingId = parseObjectId(meetingId);
    if (!parsedMeetingId) {
      return Response.json({ error: "Invalid meeting ID." }, { status: 400 });
    }

    const parsedActionItemId = parseObjectId(actionItemId);
    if (!parsedActionItemId) {
      return Response.json(
        { error: "Invalid action item ID." },
        { status: 400 },
      );
    }

    const meeting = await getMeetingById(
      organization._id,
      parsedMeetingId,
      request.headers,
    );
    if (!meeting) {
      return Response.json({ error: "Meeting not found." }, { status: 404 });
    }

    const actionItem = await getMeetingActionItemById(
      organization._id,
      parsedMeetingId,
      parsedActionItemId,
      request.headers,
    );
    if (!actionItem) {
      return Response.json(
        { error: "Action item not found." },
        { status: 404 },
      );
    }

    return Response.json(
      { actionItem: toMeetingActionItemDto(actionItem) },
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
      return Response.json(
        { error: error.message || "Access denied." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to fetch action item." },
      { status: 500 },
    );
  }
}

export const POST = convertActionItemPost;

export async function PATCH(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      slug: string;
      meetingId: string;
      actionItemId: string;
    }>;
  },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, meetingId, actionItemId } = await params;
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

    const parsedMeetingId = parseObjectId(meetingId);
    if (!parsedMeetingId) {
      return Response.json({ error: "Invalid meeting ID." }, { status: 400 });
    }

    const parsedActionItemId = parseObjectId(actionItemId);
    if (!parsedActionItemId) {
      return Response.json(
        { error: "Invalid action item ID." },
        { status: 400 },
      );
    }

    const meeting = await getMeetingById(
      organization._id,
      parsedMeetingId,
      request.headers,
    );
    if (!meeting) {
      return Response.json({ error: "Meeting not found." }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
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
      if (!ALLOWED_UPDATE_FIELDS.has(key)) {
        return Response.json(
          {
            error: `Unexpected field "${key}".`,
          },
          { status: 400 },
        );
      }
    }

    const updateInput: UpdateMeetingActionItemInput = {};
    if ("title" in record) {
      updateInput.title = record.title as string | undefined;
    }
    if ("description" in record) {
      updateInput.description = record.description as
        | string
        | null
        | undefined;
    }
    if ("ownerId" in record) {
      updateInput.ownerId = record.ownerId as string | null | undefined;
    }
    if ("targetDate" in record) {
      updateInput.targetDate = record.targetDate as string | null | undefined;
    }
    if ("status" in record) {
      updateInput.status = record.status as ActionItemStatus | undefined;
    }

    const updated = await updateMeetingActionItem(
      organization._id,
      parsedMeetingId,
      parsedActionItemId,
      updateInput,
      request.headers,
    );

    if (!updated) {
      return Response.json(
        { error: "Action item not found." },
        { status: 404 },
      );
    }

    return Response.json(
      { actionItem: toMeetingActionItemDto(updated) },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof TenantValidationError) {
      const status =
        error.message === ARCHIVED_MEETING_ACTION_ITEM_MESSAGE ? 409 : 400;
      return Response.json({ error: error.message }, { status });
    }
    if (error instanceof TenantAccessError) {
      if (error.message === "Authentication required.") {
        return Response.json(
          { error: "Authentication required." },
          { status: 401 },
        );
      }
      return Response.json(
        { error: error.message || "Access denied." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to update action item." },
      { status: 500 },
    );
  }
}

