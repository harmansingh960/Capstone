import { connection } from "next/server";
import {
  getOrganizationBySlug,
  listOrganizationActivity,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type ActivityActor,
  type ActivityEventType,
  type ActivityFieldChangeItem,
  type ActivityFieldValue,
  type ActivityItem,
  type ActivityTargetType,
  type UserOrganization,
} from "@/lib/tenancy";

type ActivityDto = {
  id: string;
  organizationId: string;
  projectId: string | null;
  taskId: string | null;
  actorId: string;
  actor: ActivityActor;
  eventType: ActivityEventType;
  targetType: ActivityTargetType;
  targetId: string;
  summary: string;
  changes: ActivityFieldChangeItem[];
  metadata: Record<string, ActivityFieldValue> | null;
  createdAt: string;
};

function toActivityDto(item: ActivityItem): ActivityDto {
  return {
    id: item.id,
    organizationId: item.organizationId,
    projectId: item.projectId,
    taskId: item.taskId,
    actorId: item.actorId,
    actor: item.actor,
    eventType: item.eventType,
    targetType: item.targetType,
    targetId: item.targetId,
    summary: item.summary,
    changes: item.changes,
    metadata: item.metadata,
    createdAt: item.createdAt.toISOString(),
  };
}

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
    const rawLimit = searchParams.get("limit");
    const rawCursor = searchParams.get("cursor");

    const page = await listOrganizationActivity(
      organization._id,
      {
        limit: rawLimit ?? undefined,
        cursor: rawCursor ?? undefined,
      },
      request.headers,
    );

    return Response.json(
      {
        activities: page.activities.map(toActivityDto),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
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
      { error: "Failed to load organization activity." },
      { status: 500 },
    );
  }
}

