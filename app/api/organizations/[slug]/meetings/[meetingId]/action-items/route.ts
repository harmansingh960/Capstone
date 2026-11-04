import { connection } from "next/server";
import { toMeetingActionItemDto } from "@/lib/meeting-dto";
import type { ActionItemStatus } from "@/lib/schema";
import {
  ARCHIVED_MEETING_ACTION_ITEM_MESSAGE,
  createMeetingActionItem,
  getMeetingById,
  getOrganizationBySlug,
  listMeetingActionItems,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";

const ALLOWED_CREATE_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "ownerId",
  "targetDate",
  "status",
]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; meetingId: string }> },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, meetingId } = await params;
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

    const meeting = await getMeetingById(
      organization._id,
      parsedMeetingId,
      request.headers,
    );
    if (!meeting) {
      return Response.json({ error: "Meeting not found." }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const items = await listMeetingActionItems(
      organization._id,
      parsedMeetingId,
      {
        status: searchParams.get("status") ?? undefined,
        ownerId: searchParams.get("ownerId") ?? undefined,
      },
      request.headers,
    );

    return Response.json(
      { actionItems: items.map(toMeetingActionItemDto) },
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
      { error: "Failed to load action items." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; meetingId: string }> },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, meetingId } = await params;
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
      if (!ALLOWED_CREATE_FIELDS.has(key)) {
        return Response.json(
          {
            error: `Unexpected field "${key}".`,
          },
          { status: 400 },
        );
      }
    }

    const created = await createMeetingActionItem(
      organization._id,
      parsedMeetingId,
      {
        title: record.title as string,
        description: record.description as string | null | undefined,
        ownerId: record.ownerId as string | null | undefined,
        targetDate: record.targetDate as string | null | undefined,
        status: record.status as ActionItemStatus | undefined,
      },
      request.headers,
    );

    return Response.json(
      { actionItem: toMeetingActionItemDto(created) },
      { status: 201 },
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
      { error: "Failed to create action item." },
      { status: 500 },
    );
  }
}

