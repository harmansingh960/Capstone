import { connection } from "next/server";
import { toMeetingDto } from "@/lib/meeting-dto";
import type { MeetingStatus } from "@/lib/schema";
import {
  createMeeting,
  getOrganizationBySlug,
  listMeetings,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";

const ALLOWED_CREATE_FIELDS: ReadonlySet<string> = new Set([
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
    const result = await listMeetings(
      organization._id,
      {
        search: searchParams.get("search") ?? searchParams.get("q") ?? undefined,
        status: searchParams.get("status") ?? undefined,
        projectId: searchParams.get("projectId") ?? undefined,
        participantId: searchParams.get("participantId") ?? undefined,
        archived: searchParams.get("archived") ?? undefined,
        includeArchived: searchParams.get("includeArchived") ?? undefined,
        page: searchParams.get("page") ?? undefined,
        limit: searchParams.get("limit") ?? undefined,
      },
      request.headers,
    );

    return Response.json(
      {
        meetings: result.meetings.map(toMeetingDto),
        pagination: result.pagination,
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
      { error: "Failed to load meetings." },
      { status: 500 },
    );
  }
}

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

    if (organization.role !== "admin" && organization.role !== "manager") {
      return Response.json(
        { error: "Only admins and managers can create meetings." },
        { status: 403 },
      );
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

    const meeting = await createMeeting(
      organization._id,
      {
        title: record.title as string,
        meetingDate: record.meetingDate as string,
        description: record.description as string | null | undefined,
        projectId: record.projectId as string | null | undefined,
        status: record.status as MeetingStatus | undefined,
        participantIds: record.participantIds as string[] | undefined,
        notes: record.notes as string | null | undefined,
        discussionPoints: record.discussionPoints as unknown[] | undefined,
        decisions: record.decisions as unknown[] | undefined,
      },
      request.headers,
    );

    return Response.json({ meeting: toMeetingDto(meeting) }, { status: 201 });
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
        { error: error.message || "Only admins and managers can create meetings." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to create meeting." },
      { status: 500 },
    );
  }
}

