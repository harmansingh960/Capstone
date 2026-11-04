import { connection } from "next/server";
import type { ObjectId } from "mongodb";
import type {
  MembershipRole,
  ProjectStatus,
  TaskPriority,
  TaskStatus,
} from "@/lib/schema";
import {
  createTask,
  enrichSingleTask,
  getOrganizationBySlug,
  getProjectById,
  parseObjectId,
  queryProjectTasks,
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

type TaskDto = {
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

function toTaskDto(item: EnrichedTaskItem): TaskDto {
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

    const result = await queryProjectTasks(
      organization._id,
      parsedProjectId,
      {
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
        tasks: result.tasks.map(toTaskDto),
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

    const enriched = await enrichSingleTask(
      organization._id,
      project,
      task,
      request.headers,
    );

    return Response.json(
      { task: toTaskDto(enriched) },
      { status: 201 },
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
      { error: "Failed to create task." },
      { status: 500 },
    );
  }
}

