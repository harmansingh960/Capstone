import { connection } from "next/server";
import type { TaskDoc, TaskPriority, TaskStatus } from "@/lib/schema";
import {
  getOrganizationBySlug,
  getProjectById,
  getTaskById,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  updateTask,
  type UpdateTaskInput,
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

const ALLOWED_UPDATE_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "status",
  "priority",
  "assigneeId",
  "deadline",
  "parentTaskId",
  "approvalRequired",
]);

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

const LIFECYCLE_CONFLICT_MESSAGES: ReadonlySet<string> = new Set([
  "Cannot modify tasks in an archived project.",
  "Cannot move a task into an archived project.",
  "Cannot move a task with subtasks to a different project.",
  "Cannot convert a task that already has subtasks into a subtask.",
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
): { ok: true; value: Date | null } | { ok: false; error: string } {
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

export async function PATCH(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ slug: string; projectId: string; taskId: string }>;
  },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, projectId, taskId } = await params;
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

    const parsedTaskId = parseObjectId(taskId);
    if (!parsedTaskId) {
      return Response.json(
        { error: "Invalid task ID." },
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
    const keys = Object.keys(record);
    if (keys.length === 0) {
      return Response.json(
        { error: "At least one task field must be provided for update." },
        { status: 400 },
      );
    }

    for (const key of keys) {
      if (!ALLOWED_UPDATE_FIELDS.has(key)) {
        return Response.json(
          {
            error: `Unexpected field "${key}". Only "title", "description", "status", "priority", "assigneeId", "deadline", "parentTaskId", and "approvalRequired" are allowed.`,
          },
          { status: 400 },
        );
      }
    }

    const updateInput: UpdateTaskInput = {};

    if ("title" in record) {
      updateInput.title = record.title as string | undefined;
    }
    if ("description" in record) {
      updateInput.description = record.description as string | null | undefined;
    }
    if ("status" in record) {
      updateInput.status = record.status as TaskStatus | undefined;
    }
    if ("priority" in record) {
      updateInput.priority = record.priority as TaskPriority | undefined;
    }
    if ("assigneeId" in record) {
      updateInput.assigneeId = record.assigneeId as string | null | undefined;
    }
    if ("deadline" in record) {
      const parsedDeadline = parseDeadlineInput(record.deadline);
      if (!parsedDeadline.ok) {
        return Response.json(
          { error: parsedDeadline.error },
          { status: 400 },
        );
      }
      updateInput.deadline = parsedDeadline.value;
    }
    if ("parentTaskId" in record) {
      if (record.parentTaskId === null) {
        updateInput.parentTaskId = null;
      } else if (typeof record.parentTaskId === "string") {
        const parsedParentId = parseObjectId(record.parentTaskId);
        if (!parsedParentId) {
          return Response.json(
            { error: "Invalid parentTaskId." },
            { status: 400 },
          );
        }
        updateInput.parentTaskId = parsedParentId;
      } else {
        return Response.json(
          { error: "Invalid parentTaskId." },
          { status: 400 },
        );
      }
    }
    if ("approvalRequired" in record) {
      updateInput.approvalRequired = record.approvalRequired as
        | boolean
        | undefined;
    }

    const project = await getProjectById(
      organization._id,
      parsedProjectId,
      request.headers,
    );
    if (!project) {
      return Response.json(
        { error: "Project not found." },
        { status: 404 },
      );
    }

    const existingTask = await getTaskById(
      organization._id,
      parsedTaskId,
      request.headers,
    );
    if (!existingTask || !existingTask.projectId.equals(parsedProjectId)) {
      return Response.json(
        { error: "Task not found." },
        { status: 404 },
      );
    }

    const updatedTask = await updateTask(
      organization._id,
      parsedTaskId,
      updateInput,
      request.headers,
    );

    if (!updatedTask) {
      return Response.json(
        { error: "Task not found." },
        { status: 404 },
      );
    }

    return Response.json(
      { task: toTaskDto(updatedTask) },
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
      { error: "Failed to update task." },
      { status: 500 },
    );
  }
}

