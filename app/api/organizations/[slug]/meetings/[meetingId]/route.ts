import { connection } from "next/server";
import { toMeetingActionItemDto, toMeetingDto } from "@/lib/meeting-dto";
import type { MeetingStatus } from "@/lib/schema";
import {
  ARCHIVED_MEETING_MODIFICATION_MESSAGE,
  getMeetingById,
  getOrganizationBySlug,
  listMeetingActionItems,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  updateMeeting,
  type UpdateMeetingInput,
  type UserOrganization,
} from "@/lib/tenancy";

const ALLOWED_UPDATE_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "meetingDate",
  "description",
  "projectId",
  "status",
  "participantIds",
  "notes",
  "discussionPoints",
  "decisions",
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

    const actionItems = await listMeetingActionItems(
      organization._id,
      parsedMeetingId,
      undefined,
      request.headers,
    );

    return Response.json(
      {
        meeting: toMeetingDto(meeting),
        actionItems: actionItems.map(toMeetingActionItemDto),
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
      { error: "Failed to load meeting." },
      { status: 500 },
    );
  }
}

export async function PATCH(
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

    const updateInput: UpdateMeetingInput = {};
    if ("title" in record) {
      updateInput.title = record.title as string | undefined;
    }
    if ("meetingDate" in record) {
      updateInput.meetingDate = record.meetingDate as string | undefined;
    }
    if ("description" in record) {
      updateInput.description = record.description as
        | string
        | null
        | undefined;
    }
    if ("projectId" in record) {
      updateInput.projectId = record.projectId as string | null | undefined;
    }
    if ("status" in record) {
      updateInput.status = record.status as MeetingStatus | undefined;
    }
    if ("participantIds" in record) {
      updateInput.participantIds = record.participantIds as
        | string[]
        | undefined;
    }
    if ("notes" in record) {
      updateInput.notes = record.notes as string | null | undefined;
    }
    if ("discussionPoints" in record) {
      updateInput.discussionPoints = record.discussionPoints as
        | unknown[]
        | undefined;
    }
    if ("decisions" in record) {
      updateInput.decisions = record.decisions as unknown[] | undefined;
    }

    const updated = await updateMeeting(
      organization._id,
      parsedMeetingId,
      updateInput,
      request.headers,
    );

    if (!updated) {
      return Response.json({ error: "Meeting not found." }, { status: 404 });
    }

    return Response.json(
      { meeting: toMeetingDto(updated) },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof TenantValidationError) {
      const status =
        error.message === ARCHIVED_MEETING_MODIFICATION_MESSAGE ? 409 : 400;
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
      { error: "Failed to update meeting." },
      { status: 500 },
    );
  }
}

