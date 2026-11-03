import { connection } from "next/server";
import type { TaskStatus } from "@/lib/schema";
import {
  ARCHIVED_PROJECT_DEPENDENCY_MESSAGE,
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

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

const TASK_NOT_FOUND_MESSAGES: ReadonlySet<string> = new Set([
  "Referenced task does not belong to this organization.",
  "Referenced task does not belong to the specified project.",
]);

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

export async function DELETE(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      slug: string;
      projectId: string;
      taskId: string;
      prerequisiteTaskId: string;
    }>;
  },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, projectId, taskId, prerequisiteTaskId } = await params;
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

    const parsedPrerequisiteTaskId = parseObjectId(prerequisiteTaskId);
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
      const status =
        error.message === ARCHIVED_PROJECT_DEPENDENCY_MESSAGE ? 409 : 400;
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

