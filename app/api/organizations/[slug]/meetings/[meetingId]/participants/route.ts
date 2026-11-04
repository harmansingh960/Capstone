import { connection } from "next/server";
import { toMeetingDto } from "@/lib/meeting-dto";
import {
  addMeetingParticipant,
  ARCHIVED_MEETING_MODIFICATION_MESSAGE,
  getMeetingById,
  getOrganizationBySlug,
  parseObjectId,
  removeMeetingParticipant,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  updateMeeting,
  type UserOrganization,
} from "@/lib/tenancy";

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

    return Response.json(
      {
        participants: meeting.participants,
        participantIds: meeting.participantIds,
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
      { error: "Failed to load meeting participants." },
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

    if (organization.role !== "admin" && organization.role !== "manager") {
      return Response.json(
        { error: "Only admins and managers can manage meeting participants." },
        { status: 403 },
      );
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
      if (key !== "userId" && key !== "participantIds") {
        return Response.json(
          {
            error: `Unexpected field "${key}". Only "userId" or "participantIds" is allowed.`,
          },
          { status: 400 },
        );
      }
    }

    const updated =
      "participantIds" in record
        ? await updateMeeting(
            organization._id,
            parsedMeetingId,
            { participantIds: record.participantIds as string[] },
            request.headers,
          )
        : await addMeetingParticipant(
            organization._id,
            parsedMeetingId,
            record.userId,
            request.headers,
          );

    if (!updated) {
      return Response.json({ error: "Meeting not found." }, { status: 404 });
    }

    return Response.json(
      {
        meeting: toMeetingDto(updated),
        participants: updated.participants,
      },
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
        { error: "Only admins and managers can manage meeting participants." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to add meeting participant." },
      { status: 500 },
    );
  }
}

export async function DELETE(
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

    if (organization.role !== "admin" && organization.role !== "manager") {
      return Response.json(
        { error: "Only admins and managers can manage meeting participants." },
        { status: 403 },
      );
    }

    const parsedMeetingId = parseObjectId(meetingId);
    if (!parsedMeetingId) {
      return Response.json({ error: "Invalid meeting ID." }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    let rawUserId: unknown = searchParams.get("userId");

    if (!rawUserId) {
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
          if (key !== "userId") {
            return Response.json(
              { error: `Unexpected field "${key}". Only "userId" is allowed.` },
              { status: 400 },
            );
          }
        }
        rawUserId = record.userId;
      }
    }

    const updated = await removeMeetingParticipant(
      organization._id,
      parsedMeetingId,
      rawUserId,
      request.headers,
    );

    if (!updated) {
      return Response.json({ error: "Meeting not found." }, { status: 404 });
    }

    return Response.json(
      {
        meeting: toMeetingDto(updated),
        participants: updated.participants,
      },
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
        { error: "Only admins and managers can manage meeting participants." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to remove meeting participant." },
      { status: 500 },
    );
  }
}

