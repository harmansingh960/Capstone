import { connection } from "next/server";
import type { ObjectId } from "mongodb";
import type { TaskDoc, TaskPriority, TaskStatus } from "@/lib/schema";
import {
  createTask,
  getOrganizationBySlug,
  listProjectTasks,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type ListProjectTasksFilter,
  type UserOrganization,
} from "@/lib/tenancy";

type TaskDto = {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  deadline: string | null;
  approvalRequired: boolean;
  createdAt: string;
  updatedAt: string;
};

const ALLOWED_CREATE_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "parentTaskId",
  "assigneeId",
  "priority",
  "status",
  "deadline",
  "approvalRequired",
]);

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

const LIFECYCLE_CONFLICT_MESSAGES: ReadonlySet<string> = new Set([
  "Cannot create tasks in an archived project.",
  "Subtasks must have a top-level parent task.",
  "Cannot mark task as done: deliverable approval is required and no deliverable has been submitted.",
  "Cannot mark task as done: the latest deliverable submission has not been approved.",
]);

function toTaskDto(task: TaskDoc): TaskDto {
  return {
    id: task._id.toHexString(),
    projectId: task.projectId.toHexString(),
    parentTaskId: task.parentTaskId ? task.parentTaskId.toHexString() : null,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId,
    deadline: task.deadline ? task.deadline.toISOString() : null,
    approvalRequired: task.approvalRequired === true,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function parseDeadlineInput(
  raw: unknown,
): { ok: true; value: Date | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      error: "Task deadline must be an ISO date string or null.",
    };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return {
      ok: false,
      error: "Task deadline must be a valid date or null.",
    };
  }
  return { ok: true, value: parsed };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; projectId: string }> },
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
      return Response.json(
        { error: "Invalid project ID." },
        { status: 400 },
      );
    }

    const { searchParams } = new URL(request.url);
    const filter: ListProjectTasksFilter = {};
    let hasFilter = false;

    if (searchParams.has("status")) {
      hasFilter = true;
      filter.status = (searchParams.get("status") ?? "") as TaskStatus;
    }

    if (searchParams.has("parentTaskId")) {
      hasFilter = true;
      const rawParentTaskId = searchParams.get("parentTaskId") ?? "";
      if (rawParentTaskId === "null") {
        filter.parentTaskId = null;
      } else {
        const parsedParentTaskId = parseObjectId(rawParentTaskId);
        if (!parsedParentTaskId) {
          return Response.json(
            { error: "Invalid parentTaskId filter." },
            { status: 400 },
          );
        }
        filter.parentTaskId = parsedParentTaskId;
      }
    }

    if (searchParams.has("assigneeId")) {
      hasFilter = true;
      const rawAssigneeId = searchParams.get("assigneeId") ?? "";
      filter.assigneeId = rawAssigneeId === "null" ? null : rawAssigneeId;
    }

    const tasks = await listProjectTasks(
      organization._id,
      parsedProjectId,
      hasFilter ? filter : undefined,
      request.headers,
    );

    return Response.json(
      { tasks: tasks.map(toTaskDto) },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof TenantValidationError) {
      if (error.message === PROJECT_NOT_IN_ORG_MESSAGE) {
        return Response.json(
          { error: "Project not found." },
          { status: 404 },
        );
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
      { error: "Failed to load tasks." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; projectId: string }> },
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
      return Response.json(
        { error: "Invalid project ID." },
        { status: 400 },
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
            error: `Unexpected field "${key}". Only "title", "description", "parentTaskId", "assigneeId", "priority", "status", "deadline", and "approvalRequired" are allowed.`,
          },
          { status: 400 },
        );
      }
    }

    let parsedParentTaskId: ObjectId | null | undefined;
    if ("parentTaskId" in record && record.parentTaskId !== undefined) {
      if (record.parentTaskId === null) {
        parsedParentTaskId = null;
      } else if (typeof record.parentTaskId === "string") {
        const objectId = parseObjectId(record.parentTaskId);
        if (!objectId) {
          return Response.json(
            { error: "Invalid parentTaskId." },
            { status: 400 },
          );
        }
        parsedParentTaskId = objectId;
      } else {
        return Response.json(
          { error: "Invalid parentTaskId." },
          { status: 400 },
        );
      }
    }

    const parsedDeadline = parseDeadlineInput(record.deadline);
    if (!parsedDeadline.ok) {
      return Response.json(
        { error: parsedDeadline.error },
        { status: 400 },
      );
    }

    const task = await createTask(
      organization._id,
      {
        projectId: parsedProjectId,
        parentTaskId: parsedParentTaskId,
        title: record.title as string,
        description: record.description as string | null | undefined,
        status: record.status as TaskStatus | undefined,
        priority: record.priority as TaskPriority | undefined,
        assigneeId: record.assigneeId as string | null | undefined,
        deadline: parsedDeadline.value,
        approvalRequired: record.approvalRequired as boolean | undefined,
      },
      request.headers,
    );

    return Response.json({ task: toTaskDto(task) }, { status: 201 });
  } catch (error) {
    if (error instanceof TenantValidationError) {
      if (error.message === PROJECT_NOT_IN_ORG_MESSAGE) {
        return Response.json(
          { error: "Project not found." },
          { status: 404 },
        );
      }
      const status = LIFECYCLE_CONFLICT_MESSAGES.has(error.message) ? 409 : 400;
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
      { error: "Failed to create task." },
      { status: 500 },
    );
  }
}

