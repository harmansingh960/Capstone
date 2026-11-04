import { connection } from "next/server";
import { toMeetingDto } from "@/lib/meeting-dto";
import {
  archiveMeeting,
  getOrganizationBySlug,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";

async function handleArchive(
  request: Request,
  params: Promise<{ slug: string; meetingId: string }>,
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
        { error: "Only admins and managers can archive or unarchive meetings." },
        { status: 403 },
      );
    }

    const parsedMeetingId = parseObjectId(meetingId);
    if (!parsedMeetingId) {
      return Response.json({ error: "Invalid meeting ID." }, { status: 400 });
    }

    let archived = true;
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
        if (key !== "archived") {
          return Response.json(
            { error: `Unexpected field "${key}". Only "archived" is allowed.` },
            { status: 400 },
          );
        }
      }
      if ("archived" in record) {
        if (typeof record.archived !== "boolean") {
          return Response.json(
            { error: "Field \"archived\" must be a boolean." },
            { status: 400 },
          );
        }
        archived = record.archived;
      }
    }

    const updated = await archiveMeeting(
      organization._id,
      parsedMeetingId,
      { archived },
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
        { error: "Only admins and managers can archive or unarchive meetings." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to archive meeting." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; meetingId: string }> },
) {
  return handleArchive(request, params);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; meetingId: string }> },
) {
  return handleArchive(request, params);
}

