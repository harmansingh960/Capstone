import { connection } from "next/server";
import { toMeetingActionItemDto, type MeetingActionItemDto } from "@/lib/meeting-dto";
import { enforceRateLimit, RATE_LIMIT_PROFILES } from "@/lib/rate-limit";
import type {
  MembershipRole,
  ProjectStatus,
  TaskPriority,
  TaskStatus,
} from "@/lib/schema";
import {
  ARCHIVED_MEETING_ACTION_ITEM_MESSAGE,
  convertMeetingActionItemToTask,
  getMeetingById,
  getOrganizationBySlug,
  parseObjectId,
  requireSessionUserId,
  serializeTaskAssignee,
  TenantAccessError,
  TenantValidationError,
  type ConvertMeetingActionItemInput,
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

export type ConvertedTaskDto = {
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

export type ConvertActionItemResponseDto = {
  created: boolean;
  task: ConvertedTaskDto;
  actionItem: MeetingActionItemDto;
};

const ALLOWED_CONVERT_FIELDS: ReadonlySet<string> = new Set([
  "projectId",
  "priority",
  "status",
  "approvalRequired",
  "action",
]);

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";
const MEETING_NOT_IN_ORG_MESSAGE =
  "Referenced meeting does not belong to this organization.";

const LIFECYCLE_CONFLICT_MESSAGES: ReadonlySet<string> = new Set([
  ARCHIVED_MEETING_ACTION_ITEM_MESSAGE,
  "Cannot create tasks in an archived project.",
  "Cannot mark task as done: deliverable approval is required and no deliverable has been submitted.",
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

function toConvertedTaskDto(item: EnrichedTaskItem): ConvertedTaskDto {
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

export async function POST(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      slug: string;
      meetingId: string;
      actionItemId: string;
    }>;
  },
) {
  await connection();
  try {
    const userId = await requireSessionUserId(request.headers);
    const rateLimitError = await enforceRateLimit(
      request,
      "action_item_convert",
      RATE_LIMIT_PROFILES.mutation,
      userId,
    );
    if (rateLimitError) {
      return rateLimitError;
    }

    const { slug, meetingId, actionItemId } = await params;
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

    const parsedActionItemId = parseObjectId(actionItemId);
    if (!parsedActionItemId) {
      return Response.json(
        { error: "Invalid action item ID." },
        { status: 400 },
      );
    }

    const meeting = await getMeetingById(
      organization._id,
      parsedMeetingId,
      request.headers,
    );
    if (!meeting) {
      return Response.json({ error: "Meeting not found." }, { status: 404 });
    }

    const rawText = await request.text();
    let body: unknown = {};
    if (rawText.trim() !== "") {
      try {
        body = JSON.parse(rawText);
      } catch {
        return Response.json(
          { error: "Invalid JSON request body." },
          { status: 400 },
        );
      }
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json(
        { error: "Request body must be a JSON object." },
        { status: 400 },
      );
    }

    const record = body as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!ALLOWED_CONVERT_FIELDS.has(key)) {
        return Response.json(
          { error: `Unexpected field "${key}".` },
          { status: 400 },
        );
      }
    }

    if ("action" in record && record.action !== "convert") {
      return Response.json(
        { error: 'Unsupported action. Expected "convert".' },
        { status: 400 },
      );
    }

    const convertInput: ConvertMeetingActionItemInput = {};
    if ("projectId" in record) {
      convertInput.projectId = record.projectId as string | null | undefined;
    }
    if ("priority" in record) {
      convertInput.priority = record.priority as TaskPriority | undefined;
    }
    if ("status" in record) {
      convertInput.status = record.status as TaskStatus | undefined;
    }
    if ("approvalRequired" in record) {
      convertInput.approvalRequired = record.approvalRequired as
        | boolean
        | undefined;
    }

    const result = await convertMeetingActionItemToTask(
      organization._id,
      parsedMeetingId,
      parsedActionItemId,
      convertInput,
      request.headers,
    );

    if (!result) {
      return Response.json(
        { error: "Action item not found." },
        { status: 404 },
      );
    }

    const payload: ConvertActionItemResponseDto = {
      created: result.created,
      task: toConvertedTaskDto(result.task),
      actionItem: toMeetingActionItemDto(result.actionItem),
    };

    return Response.json(payload, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof TenantValidationError) {
      if (
        error.message === PROJECT_NOT_IN_ORG_MESSAGE ||
        error.message === MEETING_NOT_IN_ORG_MESSAGE
      ) {
        return Response.json({ error: error.message }, { status: 404 });
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
      return Response.json(
        { error: error.message || "Access denied." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to convert action item to task." },
      { status: 500 },
    );
  }
}

