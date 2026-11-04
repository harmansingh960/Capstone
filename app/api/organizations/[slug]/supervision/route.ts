import { connection } from "next/server";
import type {
  MembershipRole,
  ProjectStatus,
  TaskPriority,
  TaskStatus,
} from "@/lib/schema";
import {
  getOrganizationBySlug,
  getSupervisorDashboard,
  requireSessionUserId,
  serializeTaskAssignee,
  TenantAccessError,
  TenantValidationError,
  type EnrichedTaskItem,
  type SupervisorProjectOverviewItem,
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

type ProjectOverviewDto = Omit<
  SupervisorProjectOverviewItem,
  "createdAt" | "updatedAt"
> & {
  createdAt: string;
  updatedAt: string;
};

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

function toProjectOverviewDto(
  item: SupervisorProjectOverviewItem,
): ProjectOverviewDto {
  return {
    ...item,
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
    const dashboard = await getSupervisorDashboard(
      organization._id,
      {
        projectStatus: searchParams.has("projectStatus")
          ? searchParams.get("projectStatus")
          : undefined,
        includeArchived: searchParams.has("includeArchived")
          ? searchParams.get("includeArchived")
          : undefined,
        staleThresholdDays: searchParams.has("staleThresholdDays")
          ? searchParams.get("staleThresholdDays")
          : searchParams.has("staleDays")
            ? searchParams.get("staleDays")
            : undefined,
      },
      request.headers,
    );

    return Response.json(
      {
        organization: {
          id: organization._id.toHexString(),
          name: organization.name,
          slug: organization.slug,
          role: organization.role,
        },
        config: {
          ...dashboard.config,
          generatedAt: dashboard.config.generatedAt.toISOString(),
        },
        overview: dashboard.overview,
        projects: dashboard.projects.map(toProjectOverviewDto),
        overdueHighlightTasks: dashboard.overdueHighlightTasks.map(
          toSupervisionTaskDto,
        ),
        staleHighlightTasks:
          dashboard.staleHighlightTasks.map(toSupervisionTaskDto),
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
      return Response.json({ error: error.message }, { status: 403 });
    }
    return Response.json(
      { error: "Failed to load supervisor dashboard." },
      { status: 500 },
    );
  }
}

