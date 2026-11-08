import { connection } from "next/server";
import {
  createBlockerReport,
  getOrganizationBySlug,
  listProjectBlockers,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type BlockerStatus,
  type BlockerType,
  type UserOrganization,
} from "@/lib/tenancy";

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

const TASK_NOT_FOUND_MESSAGES: ReadonlySet<string> = new Set([
  "Referenced task does not belong to this organization.",
  "Referenced task does not belong to the specified project.",
  "Referenced blocker does not belong to this organization or project.",
]);

const CONFLICT_MESSAGES: ReadonlySet<string> = new Set([
  "Cannot report blockers in an archived project.",
  "Cannot report blockers on a completed task.",
  "An open blocker is already reported for this dependency task.",
  "An identical open blocker is already reported for this task.",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ slug: string; projectId: string }>;
  },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, projectId } = await params;
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
        { error: "Only admins and managers can view project blockers." },
        { status: 403 },
      );
    }

    const parsedProjectId = parseObjectId(projectId);
    if (!parsedProjectId) {
      return Response.json({ error: "Invalid project ID." }, { status: 400 });
    }

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const taskIdParam = url.searchParams.get("taskId");
    const typeParam = url.searchParams.get("type");
    const cursor = url.searchParams.get("cursor");
    const limit = url.searchParams.get("limit")
      ? parseInt(url.searchParams.get("limit")!, 10)
      : undefined;

    let status: BlockerStatus | "all" | undefined;
    if (statusParam) {
      if (
        statusParam === "all" ||
        statusParam === "open" ||
        statusParam === "resolved" ||
        statusParam === "dismissed"
      ) {
        status = statusParam;
      } else {
        return Response.json(
          { error: "Invalid status filter." },
          { status: 400 },
        );
      }
    }

    let type: BlockerType | undefined;
    if (typeParam) {
      if (typeParam === "task_dependency" || typeParam === "general") {
        type = typeParam;
      } else {
        return Response.json(
          { error: "Invalid type filter." },
          { status: 400 },
        );
      }
    }

    const result = await listProjectBlockers(
      organization._id,
      parsedProjectId,
      {
        status,
        taskId: taskIdParam || undefined,
        type,
        cursor,
        limit,
      },
      request.headers,
    );

    return Response.json(result);
  } catch (error) {
    if (error instanceof TenantValidationError) {
      if (error.message === PROJECT_NOT_IN_ORG_MESSAGE) {
        return Response.json({ error: "Project not found." }, { status: 404 });
      }
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof TenantAccessError) {
      if (error.message === "Authentication required.") {
        return Response.json(
          { error: "Authentication required." },
          { status: 401 },
        );
      }
      return Response.json({ error: error.message }, { status: 403 });
    }
    return Response.json(
      { error: "Failed to list project blockers." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ slug: string; projectId: string }>;
  },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, projectId } = await params;
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

    const parsedProjectId = parseObjectId(projectId);
    if (!parsedProjectId) {
      return Response.json({ error: "Invalid project ID." }, { status: 400 });
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

    if (!isPlainObject(body)) {
      return Response.json(
        { error: "Request body must be a JSON object." },
        { status: 400 },
      );
    }

    const { taskId, type, dependencyTaskId, description, impact } = body;

    if (typeof taskId !== "string" || !taskId.trim()) {
      return Response.json(
        { error: "taskId is required and must be a string." },
        { status: 400 },
      );
    }

    if (type !== "task_dependency" && type !== "general") {
      return Response.json(
        { error: "Blocker type must be 'task_dependency' or 'general'." },
        { status: 400 },
      );
    }

    if (typeof description !== "string" || !description.trim()) {
      return Response.json(
        { error: "description is required and must be a string." },
        { status: 400 },
      );
    }

    if (typeof impact !== "string" || !impact.trim()) {
      return Response.json(
        { error: "impact is required and must be a string." },
        { status: 400 },
      );
    }

    const blocker = await createBlockerReport(
      organization._id,
      {
        projectId: parsedProjectId,
        taskId,
        type,
        dependencyTaskId:
          typeof dependencyTaskId === "string" ? dependencyTaskId : null,
        description,
        impact,
      },
      request.headers,
    );

    return Response.json(blocker, { status: 201 });
  } catch (error) {
    if (error instanceof TenantValidationError) {
      if (error.message === PROJECT_NOT_IN_ORG_MESSAGE) {
        return Response.json({ error: "Project not found." }, { status: 404 });
      }
      if (TASK_NOT_FOUND_MESSAGES.has(error.message)) {
        return Response.json({ error: "Task not found." }, { status: 404 });
      }
      const status = CONFLICT_MESSAGES.has(error.message) ? 409 : 400;
      return Response.json({ error: error.message }, { status });
    }
    if (error instanceof TenantAccessError) {
      if (error.message === "Authentication required.") {
        return Response.json(
          { error: "Authentication required." },
          { status: 401 },
        );
      }
      return Response.json({ error: error.message }, { status: 403 });
    }
    return Response.json(
      { error: "Failed to create blocker report." },
      { status: 500 },
    );
  }
}

