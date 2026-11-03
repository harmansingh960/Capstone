import { connection } from "next/server";
import type { TaskStatus } from "@/lib/schema";
import {
  addTaskDependency,
  ARCHIVED_PROJECT_DEPENDENCY_MESSAGE,
  CIRCULAR_TASK_DEPENDENCY_MESSAGE,
  DUPLICATE_TASK_DEPENDENCY_MESSAGE,
  getOrganizationBySlug,
  getTaskDependencySummary,
  parseObjectId,
  removeTaskDependency,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type TaskBlockerSummary,
  type TaskDependencyItem,
  type UserOrganization,
} from "@/lib/tenancy";

type TaskDependencyDto = {
  id: string;
  projectId: string;
  taskId: string;
  prerequisiteTaskId: string;
  prerequisiteTitle: string;
  prerequisiteStatus: TaskStatus;
  prerequisiteParentTaskId: string | null;
  isBlocking: boolean;
  createdBy: string;
  createdAt: string;
};

type TaskBlockerSummaryDto = {
  taskId: string;
  isBlocked: boolean;
  blockerCount: number;
  dependencyCount: number;
  dependencies: TaskDependencyDto[];
  blockers: TaskDependencyDto[];
};

const ALLOWED_FIELDS: ReadonlySet<string> = new Set(["prerequisiteTaskId"]);

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

const TASK_NOT_FOUND_MESSAGES: ReadonlySet<string> = new Set([
  "Referenced task does not belong to this organization.",
  "Referenced task does not belong to the specified project.",
  "Both tasks must belong to the specified organization and project.",
]);

const CONFLICT_MESSAGES: ReadonlySet<string> = new Set([
  DUPLICATE_TASK_DEPENDENCY_MESSAGE,
  CIRCULAR_TASK_DEPENDENCY_MESSAGE,
  ARCHIVED_PROJECT_DEPENDENCY_MESSAGE,
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toTaskDependencyDto(item: TaskDependencyItem): TaskDependencyDto {
  return {
    id: item.id,
    projectId: item.projectId,
    taskId: item.taskId,
    prerequisiteTaskId: item.prerequisiteTaskId,
    prerequisiteTitle: item.prerequisiteTitle,
    prerequisiteStatus: item.prerequisiteStatus,
    prerequisiteParentTaskId: item.prerequisiteParentTaskId,
    isBlocking: item.isBlocking,
    createdBy: item.createdBy,
    createdAt: item.createdAt.toISOString(),
  };
}

function toTaskBlockerSummaryDto(
  summary: TaskBlockerSummary,
): TaskBlockerSummaryDto {
  return {
    taskId: summary.taskId,
    isBlocked: summary.isBlocked,
    blockerCount: summary.blockerCount,
    dependencyCount: summary.dependencyCount,
    dependencies: summary.dependencies.map(toTaskDependencyDto),
    blockers: summary.blockers.map(toTaskDependencyDto),
  };
}

export async function GET(
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

    const summary = await getTaskDependencySummary(
      organization._id,
      parsedProjectId,
      parsedTaskId,
      request.headers,
    );

    return Response.json(toTaskBlockerSummaryDto(summary), { status: 200 });
  } catch (error) {
    if (error instanceof TenantValidationError) {
      if (error.message === PROJECT_NOT_IN_ORG_MESSAGE) {
        return Response.json(
          { error: "Project not found." },
          { status: 404 },
        );
      }
      if (TASK_NOT_FOUND_MESSAGES.has(error.message)) {
        return Response.json(
          { error: "Task not found." },
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
      { error: "Failed to load task dependencies." },
      { status: 500 },
    );
  }
}

export async function POST(
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

    if (!isPlainObject(body)) {
      return Response.json(
        { error: "Request body must be a JSON object." },
        { status: 400 },
      );
    }

    for (const key of Object.keys(body)) {
      if (!ALLOWED_FIELDS.has(key)) {
        return Response.json(
          {
            error: `Unexpected field "${key}". Only "prerequisiteTaskId" is allowed.`,
          },
          { status: 400 },
        );
      }
    }

    if (typeof body.prerequisiteTaskId !== "string") {
      return Response.json(
        { error: "prerequisiteTaskId is required and must be a string." },
        { status: 400 },
      );
    }

    const parsedPrerequisiteTaskId = parseObjectId(body.prerequisiteTaskId);
    if (!parsedPrerequisiteTaskId) {
      return Response.json(
        { error: "Invalid prerequisiteTaskId." },
        { status: 400 },
      );
    }

    await addTaskDependency(
      organization._id,
      {
        projectId: parsedProjectId,
        taskId: parsedTaskId,
        prerequisiteTaskId: parsedPrerequisiteTaskId,
      },
      request.headers,
    );

    const summary = await getTaskDependencySummary(
      organization._id,
      parsedProjectId,
      parsedTaskId,
      request.headers,
    );

    return Response.json(toTaskBlockerSummaryDto(summary), { status: 201 });
  } catch (error) {
    if (error instanceof TenantValidationError) {
      if (error.message === PROJECT_NOT_IN_ORG_MESSAGE) {
        return Response.json(
          { error: "Project not found." },
          { status: 404 },
        );
      }
      if (TASK_NOT_FOUND_MESSAGES.has(error.message)) {
        return Response.json(
          { error: "Task not found." },
          { status: 404 },
        );
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
      { error: "Failed to add task dependency." },
      { status: 500 },
    );
  }
}

export async function DELETE(
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

    const { searchParams } = new URL(request.url);
    let rawPrerequisiteTaskId: unknown = searchParams.get("prerequisiteTaskId");

    if (rawPrerequisiteTaskId === null) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json(
          { error: "prerequisiteTaskId is required." },
          { status: 400 },
        );
      }

      if (!isPlainObject(body)) {
        return Response.json(
          { error: "Request body must be a JSON object." },
          { status: 400 },
        );
      }

      for (const key of Object.keys(body)) {
        if (!ALLOWED_FIELDS.has(key)) {
          return Response.json(
            {
              error: `Unexpected field "${key}". Only "prerequisiteTaskId" is allowed.`,
            },
            { status: 400 },
          );
        }
      }

      rawPrerequisiteTaskId = body.prerequisiteTaskId;
    }

    if (typeof rawPrerequisiteTaskId !== "string") {
      return Response.json(
        { error: "prerequisiteTaskId is required and must be a string." },
        { status: 400 },
      );
    }

    const parsedPrerequisiteTaskId = parseObjectId(rawPrerequisiteTaskId);
    if (!parsedPrerequisiteTaskId) {
      return Response.json(
        { error: "Invalid prerequisiteTaskId." },
        { status: 400 },
      );
    }

    const removed = await removeTaskDependency(
      organization._id,
      {
        projectId: parsedProjectId,
        taskId: parsedTaskId,
        prerequisiteTaskId: parsedPrerequisiteTaskId,
      },
      request.headers,
    );

    if (!removed) {
      return Response.json(
        { error: "Task dependency not found." },
        { status: 404 },
      );
    }

    const summary = await getTaskDependencySummary(
      organization._id,
      parsedProjectId,
      parsedTaskId,
      request.headers,
    );

    return Response.json(toTaskBlockerSummaryDto(summary), { status: 200 });
  } catch (error) {
    if (error instanceof TenantValidationError) {
      if (error.message === PROJECT_NOT_IN_ORG_MESSAGE) {
        return Response.json(
          { error: "Project not found." },
          { status: 404 },
        );
      }
      if (TASK_NOT_FOUND_MESSAGES.has(error.message)) {
        return Response.json(
          { error: "Task not found." },
          { status: 404 },
        );
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
      { error: "Failed to remove task dependency." },
      { status: 500 },
    );
  }
}

