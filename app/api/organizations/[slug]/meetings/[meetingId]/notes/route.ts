import { connection } from "next/server";
import { toMeetingDto } from "@/lib/meeting-dto";
import {
  ARCHIVED_MEETING_MODIFICATION_MESSAGE,
  getMeetingById,
  getOrganizationBySlug,
  mutateMeetingNotesAndDecisions,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type MutateMeetingNotesAndDecisionsInput,
  type UserOrganization,
} from "@/lib/tenancy";

const ALLOWED_NOTES_FIELDS: ReadonlySet<string> = new Set([
  "notes",
  "discussionPoints",
  "decisions",
  "addDiscussionPoint",
  "updateDiscussionPoint",
  "removeDiscussionPointId",
  "addDecision",
  "updateDecision",
  "removeDecisionId",
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

    const dto = toMeetingDto(meeting);
    return Response.json(
      {
        notes: dto.notes,
        discussionPoints: dto.discussionPoints,
        decisions: dto.decisions,
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
      { error: "Failed to load meeting notes and decisions." },
      { status: 500 },
    );
  }
}

async function handleMutate(
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
      if (!ALLOWED_NOTES_FIELDS.has(key)) {
        return Response.json(
          {
            error: `Unexpected field "${key}".`,
          },
          { status: 400 },
        );
      }
    }

    const input: MutateMeetingNotesAndDecisionsInput = {};
    if ("notes" in record) {
      input.notes = record.notes as string | null | undefined;
    }
    if ("discussionPoints" in record) {
      input.discussionPoints = record.discussionPoints as unknown[] | undefined;
    }
    if ("decisions" in record) {
      input.decisions = record.decisions as unknown[] | undefined;
    }
    if ("addDiscussionPoint" in record) {
      input.addDiscussionPoint = record.addDiscussionPoint as
        | { content: string }
        | string;
    }
    if ("updateDiscussionPoint" in record) {
      input.updateDiscussionPoint = record.updateDiscussionPoint as {
        id: string;
        content: string;
      };
    }
    if ("removeDiscussionPointId" in record) {
      input.removeDiscussionPointId = record.removeDiscussionPointId as string;
    }
    if ("addDecision" in record) {
      input.addDecision = record.addDecision as
        | { title: string; description?: string | null }
        | string;
    }
    if ("updateDecision" in record) {
      input.updateDecision = record.updateDecision as {
        id: string;
        title?: string;
        description?: string | null;
      };
    }
    if ("removeDecisionId" in record) {
      input.removeDecisionId = record.removeDecisionId as string;
    }

    const updated = await mutateMeetingNotesAndDecisions(
      organization._id,
      parsedMeetingId,
      input,
      request.headers,
    );

    if (!updated) {
      return Response.json({ error: "Meeting not found." }, { status: 404 });
    }

    const dto = toMeetingDto(updated);
    return Response.json(
      {
        meeting: dto,
        notes: dto.notes,
        discussionPoints: dto.discussionPoints,
        decisions: dto.decisions,
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
        { error: error.message || "Access denied." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to update meeting notes and decisions." },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; meetingId: string }> },
) {
  return handleMutate(request, params);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; meetingId: string }> },
) {
  return handleMutate(request, params);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string; meetingId: string }> },
) {
  return handleMutate(request, params);
}

