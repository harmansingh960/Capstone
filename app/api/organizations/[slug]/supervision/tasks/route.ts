import { connection } from "next/server";
import type {
  MembershipRole,
  ProjectStatus,
  TaskPriority,
  TaskStatus,
} from "@/lib/schema";
import {
  getOrganizationBySlug,
  queryOrganizationTasks,
  requireSessionUserId,
  serializeTaskAssignee,
  TenantAccessError,
  TenantValidationError,
  type EnrichedTaskItem,
  type TaskDeadlineState,
  type TaskDeliverableStatus,
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

type TaskAssigneeDto = {
  id: string;
  name: string | null;
  email: string | null;
  role: MembershipRole | null;
};

type SupervisionTaskDto = {
  id: string;
  projectId: string;
  projectName: string;
  projectStatus: ProjectStatus;
  parentTaskId: string | null;
  parentTaskTitle: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  assignee: TaskAssigneeDto | null;
  deadline: string | null;
  approvalRequired: boolean;
  sourceMeetingId: string | null;
  sourceMeetingTitle: string | null;
  sourceActionItemId: string | null;
  sourceActionItemTitle: string | null;
  isBlocked: boolean;
  blockerCount: number;
  dependencyCount: number;
  dependencies: TaskDependencyDto[];
  deliverableStatus: TaskDeliverableStatus | null;
  isOverdue: boolean;
  isDueToday: boolean;
  isDueSoon: boolean;
  deadlineState: TaskDeadlineState;
  isStale: boolean;
  lastActivityAt: string;
  daysSinceActivity: number;
  createdAt: string;
  updatedAt: string;
};

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

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

function toSupervisionTaskDto(item: EnrichedTaskItem): SupervisionTaskDto {
  return {
    id: item.id,
    projectId: item.projectId,
    projectName: item.projectName,
    projectStatus: item.projectStatus,
    parentTaskId: item.parentTaskId,
    parentTaskTitle: item.parentTaskTitle,
    title: item.title,
    description: item.description,
    status: item.status,
    priority: item.priority,
    assigneeId: item.assigneeId,
    assignee: serializeTaskAssignee(item.assignee),
    deadline: item.deadline ? item.deadline.toISOString() : null,
    approvalRequired: item.approvalRequired,
    sourceMeetingId: item.sourceMeetingId,
    sourceMeetingTitle: item.sourceMeetingTitle,
    sourceActionItemId: item.sourceActionItemId,
    sourceActionItemTitle: item.sourceActionItemTitle,
    isBlocked: item.isBlocked,
    blockerCount: item.blockerCount,
    dependencyCount: item.dependencyCount,
    dependencies: item.dependencies.map(toTaskDependencyDto),
    deliverableStatus: item.deliverableStatus,
    isOverdue: item.isOverdue,
    isDueToday: item.isDueToday,
    isDueSoon: item.isDueSoon,
    deadlineState: item.deadlineState,
    isStale: item.isStale,
    lastActivityAt: item.lastActivityAt.toISOString(),
    daysSinceActivity: item.daysSinceActivity,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
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

    const result = await queryOrganizationTasks(
      organization._id,
      {
        projectId: searchParams.has("projectId")
          ? searchParams.get("projectId")
          : undefined,
        projectStatus: searchParams.has("projectStatus")
          ? searchParams.get("projectStatus")
          : undefined,
        includeArchived: searchParams.has("includeArchived")
          ? searchParams.get("includeArchived")
          : undefined,
        status: searchParams.has("status")
          ? searchParams.get("status")
          : undefined,
        priority: searchParams.has("priority")
          ? searchParams.get("priority")
          : undefined,
        assigneeId: searchParams.has("assigneeId")
          ? searchParams.get("assigneeId")
          : undefined,
        deliverableStatus: searchParams.get("deliverableStatus"),
        overdue: searchParams.has("overdue")
          ? searchParams.get("overdue")
          : searchParams.has("isOverdue")
            ? searchParams.get("isOverdue")
            : undefined,
        dueToday: searchParams.has("dueToday")
          ? searchParams.get("dueToday")
          : undefined,
        dueSoon: searchParams.has("dueSoon")
          ? searchParams.get("dueSoon")
          : undefined,
        stale: searchParams.has("stale")
          ? searchParams.get("stale")
          : searchParams.has("isStale")
            ? searchParams.get("isStale")
            : undefined,
        staleThresholdDays: searchParams.has("staleThresholdDays")
          ? searchParams.get("staleThresholdDays")
          : searchParams.has("staleDays")
            ? searchParams.get("staleDays")
            : undefined,
        blocked: searchParams.has("blocked")
          ? searchParams.get("blocked")
          : searchParams.has("isBlocked")
            ? searchParams.get("isBlocked")
            : undefined,
        deadlineFrom: searchParams.has("deadlineFrom")
          ? searchParams.get("deadlineFrom")
          : searchParams.has("deadlineAfter")
            ? searchParams.get("deadlineAfter")
            : undefined,
        deadlineTo: searchParams.has("deadlineTo")
          ? searchParams.get("deadlineTo")
          : searchParams.has("deadlineBefore")
            ? searchParams.get("deadlineBefore")
            : undefined,
        parentTaskId: searchParams.has("parentTaskId")
          ? searchParams.get("parentTaskId")
          : undefined,
        taskScope: searchParams.has("taskScope")
          ? searchParams.get("taskScope")
          : searchParams.has("taskType")
            ? searchParams.get("taskType")
            : undefined,
        sortBy: searchParams.has("sortBy")
          ? searchParams.get("sortBy")
          : undefined,
        sortOrder: searchParams.has("sortOrder")
          ? searchParams.get("sortOrder")
          : searchParams.has("order")
            ? searchParams.get("order")
            : undefined,
        page: searchParams.has("page") ? searchParams.get("page") : undefined,
        limit: searchParams.has("limit")
          ? searchParams.get("limit")
          : undefined,
      },
      request.headers,
    );

    return Response.json(
      {
        tasks: result.tasks.map(toSupervisionTaskDto),
        summary: result.summary,
        pagination: result.pagination,
        filters: result.filters,
        sort: result.sort,
      },
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
      { error: "Failed to load organization tasks." },
      { status: 500 },
    );
  }
}

