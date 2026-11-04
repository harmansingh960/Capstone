"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type SubmitEvent } from "react";
import type {
  ActivityEventType,
  ActivityTargetType,
  MembershipRole,
  ProjectStatus,
  ReviewDecision,
  TaskDeliverableStatus,
  TaskPriority,
  TaskStatus,
} from "@/lib/schema";

export type ActivityActorSummary = {
  userId: string;
  name: string | null;
  email: string | null;
  role: MembershipRole | null;
  label: string;
};

export type ActivityFieldChangeSummary = {
  field: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
  beforeDisplay: string;
  afterDisplay: string;
};

export type ActivityEntrySummary = {
  id: string;
  organizationId: string;
  projectId: string | null;
  taskId: string | null;
  targetType: ActivityTargetType;
  targetId: string;
  eventType: ActivityEventType;
  actorId: string;
  actor: ActivityActorSummary;
  summary: string;
  changes: ActivityFieldChangeSummary[];
  metadata: Record<string, string | number | boolean | null> | null;
  createdAt: string;
};

const ACTIVITY_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  title: "Title",
  description: "Description",
  status: "Status",
  priority: "Priority",
  assigneeId: "Assignee",
  deadline: "Deadline",
  approvalRequired: "Approval requirement",
  parentTaskId: "Parent task",
  prerequisiteTaskId: "Prerequisite",
  submissionNumber: "Submission",
  decision: "Review decision",
  meetingDate: "Meeting date",
  projectId: "Project",
  participantId: "Participant",
  notes: "Notes",
  discussionPoint: "Discussion point",
  meetingDecision: "Decision",
  ownerId: "Owner",
  targetDate: "Target date",
  archived: "Archived",
  linkedTaskId: "Linked task",
  sourceMeetingId: "Source meeting",
  sourceActionItemId: "Source action item",
};

const ACTIVITY_EVENT_BADGES: Record<
  ActivityEventType,
  { label: string; className: string }
> = {
  "project.created": {
    label: "Project Created",
    className:
      "rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  },
  "project.updated": {
    label: "Project Updated",
    className:
      "rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  },
  "project.archived": {
    label: "Project Archived",
    className:
      "rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  },
  "project.unarchived": {
    label: "Project Unarchived",
    className:
      "rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  },
  "task.created": {
    label: "Task Created",
    className:
      "rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
  },
  "subtask.created": {
    label: "Subtask Created",
    className:
      "rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300",
  },
  "task.updated": {
    label: "Task Updated",
    className:
      "rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  },
  "task.status_changed": {
    label: "Status Changed",
    className:
      "rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  },
  "task.priority_changed": {
    label: "Priority Changed",
    className:
      "rounded border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-800 dark:border-purple-800 dark:bg-purple-950/60 dark:text-purple-300",
  },
  "task.assignee_changed": {
    label: "Assignee Changed",
    className:
      "rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-800 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  },
  "task.deadline_changed": {
    label: "Deadline Changed",
    className:
      "rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  },
  "task.approval_required_changed": {
    label: "Approval Rule Changed",
    className:
      "rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300",
  },
  "dependency.added": {
    label: "Prerequisite Added",
    className:
      "rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  },
  "dependency.removed": {
    label: "Prerequisite Removed",
    className:
      "rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  },
  "deliverable.submitted": {
    label: "Deliverable Submitted",
    className:
      "rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
  },
  "review.approved": {
    label: "Review Approved",
    className:
      "rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  },
  "review.changes_requested": {
    label: "Changes Requested",
    className:
      "rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  },
  "review.decision_updated": {
    label: "Review Decision Updated",
    className:
      "rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300",
  },
  "meeting.created": {
    label: "Meeting Created",
    className:
      "rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  },
  "meeting.updated": {
    label: "Meeting Updated",
    className:
      "rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  },
  "meeting.archived": {
    label: "Meeting Archived",
    className:
      "rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  },
  "meeting.unarchived": {
    label: "Meeting Unarchived",
    className:
      "rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  },
  "meeting.participant_added": {
    label: "Participant Added",
    className:
      "rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-800 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  },
  "meeting.participant_removed": {
    label: "Participant Removed",
    className:
      "rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  },
  "meeting.notes_updated": {
    label: "Meeting Notes Updated",
    className:
      "rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  },
  "meeting.decision_recorded": {
    label: "Decision Recorded",
    className:
      "rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300",
  },
  "action_item.created": {
    label: "Action Item Created",
    className:
      "rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
  },
  "action_item.updated": {
    label: "Action Item Updated",
    className:
      "rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  },
  "action_item.status_changed": {
    label: "Action Item Status",
    className:
      "rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  },
  "action_item.converted_to_task": {
    label: "Converted to Task",
    className:
      "rounded border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-800 dark:border-purple-800 dark:bg-purple-950/60 dark:text-purple-300",
  },
};

export type DeliverableSummary = {
  id: string;
  projectId: string;
  taskId: string;
  submittedBy: string;
  description: string | null;
  url: string | null;
  createdAt: string;
  reviews?: ReviewSummary[];
};

export type ReviewSummary = {
  id: string;
  projectId: string;
  taskId: string;
  deliverableId: string;
  reviewerId: string;
  decision: ReviewDecision;
  comment: string | null;
  createdAt: string;
};

// Matches TaskDependencyDto returned by the dependencies API routes.
export type TaskDependencyItem = {
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

export type TaskSummary = {
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
  sourceMeetingId?: string | null;
  sourceMeetingTitle?: string | null;
  sourceActionItemId?: string | null;
  sourceActionItemTitle?: string | null;
  // Dependency fields – populated by GET /tasks and PATCH /tasks/[id]
  isBlocked: boolean;
  blockerCount: number;
  dependencyCount: number;
  dependencies: TaskDependencyItem[];
  // Deliverable workflow status – populated by GET /tasks and PATCH /tasks/[id]
  deliverableStatus: TaskDeliverableStatus | null;
  // Phase 5 health & staleness fields
  isOverdue?: boolean;
  isDueToday?: boolean;
  isDueSoon?: boolean;
  deadlineState?: string;
  isStale?: boolean;
  lastActivityAt?: string;
  daysSinceActivity?: number;
  createdAt: string;
  updatedAt: string;
};

export const DELIVERABLE_STATUS_LABELS: Record<TaskDeliverableStatus, string> = {
  needs_submission: "Needs Submission",
  in_review: "In Review",
  changes_requested: "Changes Requested",
  approved: "Approved",
};

export const DELIVERABLE_STATUS_CLASSES: Record<TaskDeliverableStatus, string> = {
  needs_submission:
    "rounded border border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  in_review:
    "rounded border border-blue-300 bg-blue-50 px-2 py-0.5 font-medium text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300",
  changes_requested:
    "rounded border border-rose-300 bg-rose-50 px-2 py-0.5 font-medium text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  approved:
    "rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
};

export type TaskWithSubtasks = TaskSummary & {
  subtasks: TaskSummary[];
};

export type MemberOption = {
  userId: string;
  role: MembershipRole;
  name?: string | null;
  email?: string | null;
};

type StatusFilter = "all" | TaskStatus;

type DeliverableStatusFilterOption = "all" | TaskDeliverableStatus;

const DELIVERABLE_STATUS_FILTER_LABELS: Record<
  DeliverableStatusFilterOption,
  string
> = {
  all: "All deliverable statuses",
  needs_submission: "Needs Submission",
  in_review: "In Review",
  changes_requested: "Changes Requested",
  approved: "Approved",
};

type TasksClientProps = {
  organizationSlug: string;
  projectId: string;
  projectStatus: ProjectStatus;
  role: MembershipRole;
  currentUserId: string;
  members: MemberOption[];
  initialTasks: TaskWithSubtasks[];
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

const REVIEW_DECISION_LABELS: Record<ReviewDecision, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
};

function formatDateDisplay(isoDate: string | null): string {
  if (!isoDate) return "No deadline";
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatTimestampDisplay(isoDate: string): string {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function getSafeExternalHttpUrl(rawUrl: string | null): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function toDateInputValue(isoDate: string | null): string {
  if (!isoDate) return "";
  return isoDate.slice(0, 10);
}

function formatMemberLabel(
  userId: string | null,
  currentUserId: string,
  members: MemberOption[],
): string {
  if (!userId) return "Unassigned";
  const match = members.find((m) => m.userId === userId);
  const suffix = userId === currentUserId ? " (you)" : "";
  if (!match) {
    return `${userId}${suffix} · Former member`;
  }
  const hasName =
    typeof match.name === "string" && match.name.trim() !== "";
  const label = hasName ? `${match.name!.trim()} (${userId})` : userId;
  return `${label}${suffix} · ${match.role}`;
}

async function readApiError(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data?.error === "string" && data.error.trim() !== "") {
      return data.error;
    }
  } catch {
    // Fallback to status-based error message.
  }

  if (response.status === 401) {
    return "Your session has expired. Please sign in again.";
  }
  if (response.status === 403) {
    return "You do not have permission to perform this action.";
  }
  if (response.status === 404) {
    return "The requested organization, project, or task could not be found.";
  }
  if (response.status === 409) {
    return "This action conflicts with the current project, task completion, or review state. Verify deliverable approval or reopen the task first.";
  }
  return fallbackMessage;
}

type PreviousReviewFeedback = {
  submissionNumber: number;
  reviewerId: string;
  createdAt: string;
  comment: string;
};

type DeliverableItemProps = {
  organizationSlug: string;
  projectId: string;
  taskId: string;
  taskStatus: TaskStatus;
  deliverable: DeliverableSummary;
  submissionNumber: number;
  isRevision: boolean;
  previousFeedback?: PreviousReviewFeedback | null;
  isCurrent: boolean;
  isProjectArchived: boolean;
  canManage: boolean;
  currentUserId: string;
  members: MemberOption[];
  onReviewAdded?: (newReview: ReviewSummary) => void;
  onDeliverableStatusChange?: (status: TaskDeliverableStatus) => void;
};

function sortReviewsNewestFirst(
  reviews: ReviewSummary[] | undefined,
): ReviewSummary[] {
  if (!reviews || reviews.length === 0) return [];
  return [...reviews].sort((a, b) => {
    const timeDiff =
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (timeDiff !== 0) return timeDiff;
    return b.id.localeCompare(a.id);
  });
}

function DeliverableItem({
  organizationSlug,
  projectId,
  taskId,
  taskStatus,
  deliverable,
  submissionNumber,
  isRevision,
  previousFeedback,
  isCurrent,
  isProjectArchived,
  canManage,
  currentUserId,
  members,
  onReviewAdded,
  onDeliverableStatusChange,
}: DeliverableItemProps) {
  const reviews = sortReviewsNewestFirst(deliverable.reviews);
  const [decision, setDecision] = useState<ReviewDecision>("approved");
  const [comment, setComment] = useState("");
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewSubmitError, setReviewSubmitError] = useState<string | null>(
    null,
  );
  const [reviewSubmitSuccess, setReviewSubmitSuccess] = useState<string | null>(
    null,
  );
  const reviewInFlightRef = useRef(false);

  const reviewsEndpoint = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/deliverables/${encodeURIComponent(deliverable.id)}/reviews`;

  async function onSubmitReview(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || isProjectArchived || reviewInFlightRef.current) return;

    const trimmedComment = comment.trim();
    if (decision === "changes_requested" && trimmedComment === "") {
      setReviewSubmitError(
        "A review comment is required when requesting changes.",
      );
      setReviewSubmitSuccess(null);
      return;
    }

    if (trimmedComment.length > 5000) {
      setReviewSubmitError("Review comment cannot exceed 5000 characters.");
      setReviewSubmitSuccess(null);
      return;
    }

    reviewInFlightRef.current = true;
    setReviewSubmitting(true);
    setReviewSubmitError(null);
    setReviewSubmitSuccess(null);

    try {
      const response = await fetch(reviewsEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          comment: trimmedComment || null,
        }),
      });

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Unable to submit review.",
        );
        setReviewSubmitError(message);
        return;
      }

      const data = (await response.json()) as { review?: ReviewSummary };

      setComment("");
      setDecision("approved");
      setReviewSubmitSuccess("Review recorded.");
      if (data.review && onReviewAdded) {
        onReviewAdded(data.review);
      }
      if (isCurrent && onDeliverableStatusChange) {
        onDeliverableStatusChange(decision);
      }
    } catch {
      setReviewSubmitError(
        "Network error while submitting review. Please try again.",
      );
    } finally {
      reviewInFlightRef.current = false;
      setReviewSubmitting(false);
    }
  }

  const safeUrl = getSafeExternalHttpUrl(deliverable.url);
  const isTaskDone = taskStatus === "done";
  const canReview = isCurrent && canManage && !isProjectArchived && !isTaskDone;
  const latestReview = reviews[0] ?? null;
  const inputClassName =
    "rounded border border-zinc-300 bg-white px-2.5 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <li
      className={`flex flex-col gap-2.5 rounded border p-3 text-xs ${
        isCurrent
          ? "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
          : "border-zinc-200/80 bg-zinc-50/60 dark:border-zinc-800/80 dark:bg-zinc-900/40"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-zinc-500">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            {isRevision
              ? `Submission #${submissionNumber} — Revision`
              : `Submission #${submissionNumber}`}
          </span>
          <span>•</span>
          <span>
            Submitted by{" "}
            <strong className="font-normal text-zinc-700 dark:text-zinc-300">
              {formatMemberLabel(deliverable.submittedBy, currentUserId, members)}
            </strong>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isCurrent ? (
            <span className="rounded border border-blue-300 bg-blue-100 px-2 py-0.5 font-semibold text-blue-900 dark:border-blue-800 dark:bg-blue-950/80 dark:text-blue-200">
              Current Submission
            </span>
          ) : (
            <span className="rounded border border-zinc-300 bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
              Superseded
            </span>
          )}

          {latestReview ? (
            isCurrent ? (
              <span
                className={
                  latestReview.decision === "approved"
                    ? "rounded border border-emerald-300 bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-200"
                    : "rounded border border-amber-300 bg-amber-100 px-2 py-0.5 font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/80 dark:text-amber-200"
                }
              >
                Latest review: {REVIEW_DECISION_LABELS[latestReview.decision]}
              </span>
            ) : (
              <span className="rounded border border-zinc-200 bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                {latestReview.decision === "approved"
                  ? "Prior review: Approved (Superseded)"
                  : "Prior review: Changes requested (Superseded)"}
              </span>
            )
          ) : isCurrent ? (
            <span className="rounded bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              Awaiting review
            </span>
          ) : (
            <span className="rounded bg-zinc-100 px-2 py-0.5 font-medium text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
              Awaiting review (Superseded)
            </span>
          )}
          <span>{formatTimestampDisplay(deliverable.createdAt)}</span>
        </div>
      </div>

      {deliverable.description && (
        <p className="whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">
          {deliverable.description}
        </p>
      )}

      {deliverable.url && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-zinc-500">External link:</span>
          {safeUrl ? (
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all font-medium text-blue-600 underline hover:text-blue-500 dark:text-blue-400"
            >
              {safeUrl}
            </a>
          ) : (
            <span className="break-all text-zinc-600 dark:text-zinc-400">
              {deliverable.url}
            </span>
          )}
        </div>
      )}

      {isCurrent && previousFeedback && (
        <details
          open
          className="group rounded-md border border-sky-300 bg-sky-50/60 p-3 text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200"
        >
          <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-1 font-semibold select-none">
            <span className="flex items-center gap-1.5">
              <span>Addressing Previous Review Feedback</span>
              <span className="rounded bg-sky-200/70 px-1.5 py-0.5 text-[10px] font-medium text-sky-900 dark:bg-sky-900/80 dark:text-sky-200">
                From Submission #{previousFeedback.submissionNumber}
              </span>
            </span>
            <span className="text-xs font-normal text-sky-700 dark:text-sky-300">
              {formatTimestampDisplay(previousFeedback.createdAt)}
            </span>
          </summary>
          <div className="mt-2.5 flex flex-col gap-1.5 border-t border-sky-200/80 pt-2 text-xs dark:border-sky-800/80">
            <p className="text-sky-900 dark:text-sky-300">
              Reviewed by{" "}
              <strong className="font-medium text-sky-950 dark:text-sky-100">
                {formatMemberLabel(
                  previousFeedback.reviewerId,
                  currentUserId,
                  members,
                )}
              </strong>
            </p>
            {previousFeedback.comment && (
              <div className="rounded border border-sky-200 bg-white/80 p-2.5 text-zinc-900 whitespace-pre-wrap dark:border-sky-800 dark:bg-zinc-900/90 dark:text-zinc-100">
                {previousFeedback.comment}
              </div>
            )}
          </div>
        </details>
      )}

      {isCurrent && latestReview?.decision === "changes_requested" && (
        <div
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200"
        >
          <div className="flex flex-wrap items-center justify-between gap-1 font-semibold">
            <span>Reviewer Feedback — Changes Requested</span>
            <span className="text-xs font-normal text-amber-800 dark:text-amber-300">
              {formatTimestampDisplay(latestReview.createdAt)}
            </span>
          </div>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            Reviewed by{" "}
            <strong className="font-medium text-amber-950 dark:text-amber-100">
              {formatMemberLabel(latestReview.reviewerId, currentUserId, members)}
            </strong>
          </p>
          {latestReview.comment && (
            <div className="mt-2 rounded border border-amber-200 bg-white/70 p-2.5 text-xs text-zinc-900 whitespace-pre-wrap dark:border-amber-800 dark:bg-zinc-900/80 dark:text-zinc-100">
              {latestReview.comment}
            </div>
          )}
          <p className="mt-2 text-xs font-medium text-amber-900 dark:text-amber-200">
            A revised deliverable addressing this feedback is required before this task can be completed.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800/80">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-zinc-600 dark:text-zinc-400">
            Review history
          </span>
        </div>

        {reviews.length === 0 ? (
          <p className="text-zinc-500">No reviews yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {reviews.map((review, index) => {
              const isApproved = review.decision === "approved";
              const isSelfReview =
                review.reviewerId === deliverable.submittedBy;
              const isUpdatedDecision =
                reviews.length > 1 && index < reviews.length - 1;
              return (
                <li
                  key={review.id}
                  className="flex flex-col gap-1 rounded border border-zinc-100 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/60"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={
                          isApproved
                            ? "rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
                            : "rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-950/70 dark:text-amber-300"
                        }
                      >
                        {REVIEW_DECISION_LABELS[review.decision]}
                      </span>
                      {index === 0 && (
                        <span className="rounded bg-zinc-200/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                          Latest
                        </span>
                      )}
                      {isUpdatedDecision && (
                        <span className="rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-800 dark:border-indigo-800/80 dark:bg-indigo-950/60 dark:text-indigo-300">
                          Updated decision
                        </span>
                      )}
                      {isSelfReview && (
                        <span className="rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                          {isApproved ? "Self-approved" : "Self-review"}
                        </span>
                      )}
                      <span className="text-zinc-500">
                        by{" "}
                        <strong className="font-normal text-zinc-700 dark:text-zinc-300">
                          {formatMemberLabel(
                            review.reviewerId,
                            currentUserId,
                            members,
                          )}
                        </strong>
                      </span>
                    </div>
                    <span className="text-zinc-500">
                      {formatTimestampDisplay(review.createdAt)}
                    </span>
                  </div>
                  {review.comment && (
                    <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">
                      {review.comment}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {canManage && !isProjectArchived && isTaskDone && (
          <p className="rounded border border-zinc-200 bg-zinc-50 p-2 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
            This task is currently Done and must be reopened before another
            review can be created.
          </p>
        )}

        {canManage && !isProjectArchived && !isTaskDone && !isCurrent && (
          <p className="rounded border border-zinc-200 bg-zinc-50 p-2 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
            This submission has been superseded by a newer deliverable. Reviews can only be added to the current submission.
          </p>
        )}

        {canReview && (
          <form
            onSubmit={onSubmitReview}
            className="mt-1 flex flex-col gap-2 rounded border border-dashed border-zinc-200 p-2.5 dark:border-zinc-800"
          >
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Add review
            </span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="flex flex-col gap-1">
                <span className="text-zinc-500">Decision</span>
                <select
                  value={decision}
                  disabled={reviewSubmitting}
                  onChange={(event) =>
                    setDecision(event.target.value as ReviewDecision)
                  }
                  className={inputClassName}
                >
                  <option value="approved">Approved</option>
                  <option value="changes_requested">Changes requested</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-zinc-500">
                  {decision === "changes_requested"
                    ? "Comment *"
                    : "Comment (optional)"}
                </span>
                <input
                  type="text"
                  maxLength={5000}
                  required={decision === "changes_requested"}
                  disabled={reviewSubmitting}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder={
                    decision === "changes_requested"
                      ? "Explain what needs improvement before resubmission…"
                      : "Feedback or approval notes…"
                  }
                  className={inputClassName}
                />
                {decision === "changes_requested" && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-300">
                    Feedback is required when requesting changes to explain what needs improvement.
                  </p>
                )}
              </label>
            </div>
            {reviewSubmitError && (
              <p role="alert" className="text-red-600">
                {reviewSubmitError}
              </p>
            )}
            {reviewSubmitSuccess && (
              <p
                role="status"
                className="text-emerald-600 dark:text-emerald-400"
              >
                {reviewSubmitSuccess}
              </p>
            )}
            <button
              type="submit"
              disabled={reviewSubmitting}
              className="self-start rounded bg-black px-2.5 py-1 text-xs font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
            >
              {reviewSubmitting ? "Submitting review…" : "Submit review"}
            </button>
          </form>
        )}
      </div>
    </li>
  );
}

type TaskDeliverablesSectionProps = {
  organizationSlug: string;
  projectId: string;
  task: TaskSummary;
  isProjectArchived: boolean;
  canManage: boolean;
  currentUserId: string;
  members: MemberOption[];
  onDeliverableStatusChange?: (status: TaskDeliverableStatus) => void;
  onActivityRecorded?: () => void;
};

function TaskDeliverablesSection({
  organizationSlug,
  projectId,
  task,
  isProjectArchived,
  canManage,
  currentUserId,
  members,
  onDeliverableStatusChange,
  onActivityRecorded,
}: TaskDeliverablesSectionProps) {
  const [deliverables, setDeliverables] = useState<DeliverableSummary[]>([]);
  const [deliverablesLoading, setDeliverablesLoading] = useState(true);
  const [deliverablesError, setDeliverablesError] = useState<string | null>(
    null,
  );

  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);

  // Identify current submission matching backend's sort: createdAt DESC, then _id DESC
  let currentId: string | null = deliverables[0]?.id ?? null;
  let latestCandidate = deliverables[0];
  for (let i = 1; i < deliverables.length; i++) {
    const candidate = deliverables[i];
    const timeDiff =
      new Date(candidate.createdAt).getTime() -
      new Date(latestCandidate.createdAt).getTime();
    if (timeDiff > 0) {
      latestCandidate = candidate;
      currentId = candidate.id;
    } else if (
      timeDiff === 0 &&
      candidate.id.localeCompare(latestCandidate.id) > 0
    ) {
      latestCandidate = candidate;
      currentId = candidate.id;
    }
  }

  const currentDeliverable = deliverables.find((d) => d.id === currentId);
  const currentReview =
    sortReviewsNewestFirst(currentDeliverable?.reviews)[0] ?? null;
  const hasCurrentChangesRequested =
    currentReview?.decision === "changes_requested";

  // Compute chronological order (createdAt ASC, _id ASC) for submission numbering & revision context
  const chronologicalDeliverables = [...deliverables].sort((a, b) => {
    const timeDiff =
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });

  const deliverableMetaMap = new Map<
    string,
    {
      submissionNumber: number;
      isRevision: boolean;
      previousFeedback: PreviousReviewFeedback | null;
    }
  >();

  for (let i = 0; i < chronologicalDeliverables.length; i++) {
    const d = chronologicalDeliverables[i];
    const submissionNumber = i + 1;
    let isRevision = false;
    let previousFeedback: PreviousReviewFeedback | null = null;

    if (i > 0) {
      const prev = chronologicalDeliverables[i - 1];
      const prevLatestReview = sortReviewsNewestFirst(prev.reviews)[0] ?? null;
      if (prevLatestReview?.decision === "changes_requested") {
        isRevision = true;
        if (prevLatestReview.comment) {
          previousFeedback = {
            submissionNumber: i,
            reviewerId: prevLatestReview.reviewerId,
            createdAt: prevLatestReview.createdAt,
            comment: prevLatestReview.comment,
          };
        }
      }
    }

    deliverableMetaMap.set(d.id, {
      submissionNumber,
      isRevision,
      previousFeedback,
    });
  }

  const handleReviewAdded = useCallback(
    (deliverableId: string, newReview: ReviewSummary) => {
      setDeliverables((prev) =>
        prev.map((d) =>
          d.id === deliverableId
            ? {
                ...d,
                reviews: [
                  newReview,
                  ...(d.reviews ?? []).filter((r) => r.id !== newReview.id),
                ],
              }
            : d,
        ),
      );
      if (onActivityRecorded) {
        onActivityRecorded();
      }
    },
    [onActivityRecorded],
  );

  const deliverablesEndpoint = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/deliverables`;
  const isUserAllowedForTask = canManage || task.assigneeId === currentUserId;
  const isTaskDone = task.status === "done";
  const canSubmitDeliverable =
    !isProjectArchived && isUserAllowedForTask && !isTaskDone;

  useEffect(() => {
    let cancelled = false;

    async function fetchInitialDeliverables() {
      try {
        const response = await fetch(deliverablesEndpoint, {
          method: "GET",
          cache: "no-store",
        });

        if (!response.ok) {
          const message = await readApiError(
            response,
            "Unable to load deliverables.",
          );
          if (!cancelled) {
            setDeliverablesError(message);
          }
          return;
        }

        const data = (await response.json()) as {
          deliverables?: DeliverableSummary[];
        };
        if (!cancelled) {
          setDeliverables(
            Array.isArray(data.deliverables) ? data.deliverables : [],
          );
          setDeliverablesError(null);
        }
      } catch {
        if (!cancelled) {
          setDeliverablesError(
            "Network error while loading deliverables. Please try again.",
          );
        }
      } finally {
        if (!cancelled) {
          setDeliverablesLoading(false);
        }
      }
    }

    void fetchInitialDeliverables();

    return () => {
      cancelled = true;
    };
  }, [deliverablesEndpoint]);

  async function refreshDeliverables() {
    setDeliverablesLoading(true);
    setDeliverablesError(null);
    try {
      const response = await fetch(deliverablesEndpoint, {
        method: "GET",
        cache: "no-store",
      });

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Unable to load deliverables.",
        );
        setDeliverablesError(message);
        return;
      }

      const data = (await response.json()) as {
        deliverables?: DeliverableSummary[];
      };
      setDeliverables(
        Array.isArray(data.deliverables) ? data.deliverables : [],
      );
    } catch {
      setDeliverablesError(
        "Network error while loading deliverables. Please try again.",
      );
    } finally {
      setDeliverablesLoading(false);
    }
  }

  async function onSubmitDeliverable(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmitDeliverable || submitInFlightRef.current) return;

    const trimmedDescription = description.trim();
    const trimmedUrl = url.trim();

    if (!trimmedDescription && !trimmedUrl) {
      setSubmitError("Provide a deliverable description or external URL.");
      setSubmitSuccess(null);
      return;
    }

    if (trimmedDescription.length > 5000) {
      setSubmitError("Deliverable description cannot exceed 5000 characters.");
      setSubmitSuccess(null);
      return;
    }

    if (trimmedUrl) {
      if (trimmedUrl.length > 2048 || !getSafeExternalHttpUrl(trimmedUrl)) {
        setSubmitError("Deliverable URL must be a valid http or https URL.");
        setSubmitSuccess(null);
        return;
      }
    }

    submitInFlightRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitSuccess(null);

    try {
      const response = await fetch(deliverablesEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: trimmedDescription || null,
          url: trimmedUrl || null,
        }),
      });

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Unable to submit deliverable.",
        );
        setSubmitError(message);
        return;
      }

      setDescription("");
      setUrl("");
      setSubmitSuccess(
        hasCurrentChangesRequested
          ? "Revised deliverable submitted. Task remains open until the latest deliverable is approved and the task is marked Done."
          : task.approvalRequired
            ? "Deliverable submitted. Task remains open until the latest deliverable is approved and the task is marked Done."
            : "Deliverable submitted. Mark the task as Done when work is complete.",
      );
      if (onDeliverableStatusChange) {
        onDeliverableStatusChange("in_review");
      }
      if (onActivityRecorded) {
        onActivityRecorded();
      }
      await refreshDeliverables();
    } catch {
      setSubmitError(
        "Network error while submitting deliverable. Please try again.",
      );
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  }

  const inputClassName =
    "rounded border border-zinc-300 bg-white px-2.5 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <div className="mt-2 flex flex-col gap-2.5 border-t border-zinc-200 pt-2.5 text-xs dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2">
        <h5 className="font-medium text-zinc-700 dark:text-zinc-300">
          Deliverables ({deliverables.length})
        </h5>
        {deliverablesError && (
          <button
            type="button"
            onClick={() => void refreshDeliverables()}
            className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Retry
          </button>
        )}
      </div>

      {deliverablesError && (
        <p role="alert" className="text-red-600">
          {deliverablesError}
        </p>
      )}

      {deliverablesLoading ? (
        <p className="text-zinc-500">Loading deliverables…</p>
      ) : deliverables.length === 0 ? (
        <p className="text-zinc-500">No deliverables submitted yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {deliverables.map((deliverable) => {
            const meta = deliverableMetaMap.get(deliverable.id) ?? {
              submissionNumber: 1,
              isRevision: false,
              previousFeedback: null,
            };
            return (
              <DeliverableItem
                key={deliverable.id}
                organizationSlug={organizationSlug}
                projectId={projectId}
                taskId={task.id}
                taskStatus={task.status}
                deliverable={deliverable}
                submissionNumber={meta.submissionNumber}
                isRevision={meta.isRevision}
                previousFeedback={meta.previousFeedback}
                isCurrent={deliverable.id === currentId}
                isProjectArchived={isProjectArchived}
                canManage={canManage}
                currentUserId={currentUserId}
                members={members}
                onReviewAdded={(newReview) =>
                  handleReviewAdded(deliverable.id, newReview)
                }
                onDeliverableStatusChange={
                  deliverable.id === currentId
                    ? onDeliverableStatusChange
                    : undefined
                }
              />
            );
          })}
        </ul>
      )}

      {!isProjectArchived && isUserAllowedForTask && isTaskDone && (
        <p className="rounded border border-zinc-200 bg-zinc-50 p-2 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
          This task is currently Done. Reopen the task before submitting a new
          deliverable.
        </p>
      )}

      {canSubmitDeliverable && (
        <form
          onSubmit={onSubmitDeliverable}
          className="flex flex-col gap-2 rounded border border-dashed border-zinc-300 p-2.5 dark:border-zinc-700"
        >
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {hasCurrentChangesRequested
                ? "Submit Revised Deliverable"
                : "Submit deliverable"}
            </span>
            {hasCurrentChangesRequested && (
              <p className="text-xs text-amber-800 dark:text-amber-300">
                Provide an updated deliverable addressing the reviewer&apos;s feedback above.
              </p>
            )}
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">
              Description (optional if URL provided)
            </span>
            <textarea
              rows={2}
              maxLength={5000}
              disabled={submitting}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Summary of work completed…"
              className={inputClassName}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">
              External URL (optional if description provided)
            </span>
            <input
              type="url"
              maxLength={2048}
              disabled={submitting}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://drive.google.com/..."
              className={inputClassName}
            />
          </label>
          {submitError && (
            <p role="alert" className="text-red-600">
              {submitError}
            </p>
          )}
          {submitSuccess && (
            <p role="status" className="text-emerald-600 dark:text-emerald-400">
              {submitSuccess}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="self-start rounded bg-black px-2.5 py-1 text-xs font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
          >
            {submitting
              ? "Submitting…"
              : hasCurrentChangesRequested
                ? "Submit revised deliverable"
                : "Submit deliverable"}
          </button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaskDependenciesSection
// ---------------------------------------------------------------------------

// Shape returned by GET/POST/DELETE .../dependencies
type TaskBlockerSummaryResponse = {
  taskId: string;
  isBlocked: boolean;
  blockerCount: number;
  dependencyCount: number;
  dependencies: TaskDependencyItem[];
  blockers: TaskDependencyItem[];
};

const STATUS_CHIP_CLASSES: Record<TaskStatus, string> = {
  todo: "rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  in_progress:
    "rounded bg-blue-100 px-1.5 py-0.5 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
  done: "rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
};

type TaskDependenciesSectionProps = {
  organizationSlug: string;
  projectId: string;
  task: TaskSummary;
  allTasks: TaskWithSubtasks[];
  isProjectArchived: boolean;
  canManage: boolean;
  onActivityRecorded?: () => void;
};

function TaskDependenciesSection({
  organizationSlug,
  projectId,
  task,
  allTasks,
  isProjectArchived,
  canManage,
  onActivityRecorded,
}: TaskDependenciesSectionProps) {
  const dependenciesEndpoint = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/dependencies`;

  // Initialise from task summary so the section renders immediately without
  // a loading flash when data is already available from the parent fetch.
  const [summary, setSummary] = useState<TaskBlockerSummaryResponse>({
    taskId: task.id,
    isBlocked: task.isBlocked,
    blockerCount: task.blockerCount,
    dependencyCount: task.dependencyCount,
    dependencies: task.dependencies,
    blockers: [],
  });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedPrereqId, setSelectedPrereqId] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);
  const [addInFlight, setAddInFlight] = useState(false);
  const addInFlightRef = useRef(false);

  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Gather all tasks in the project (top-level + subtasks) that are eligible
  // to be added as prerequisites: not the current task, not already a prereq.
  const existingPrereqIds = new Set(
    summary.dependencies.map((d) => d.prerequisiteTaskId),
  );
  const eligibleTasks: TaskSummary[] = [];
  for (const t of allTasks) {
    if (t.id !== task.id && !existingPrereqIds.has(t.id)) {
      eligibleTasks.push(t);
    }
    for (const sub of t.subtasks) {
      if (sub.id !== task.id && !existingPrereqIds.has(sub.id)) {
        eligibleTasks.push(sub);
      }
    }
  }

  async function refreshSummary() {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(dependenciesEndpoint, {
        method: "GET",
        cache: "no-store",
      });
      if (!response.ok) {
        const message = await readApiError(
          response,
          "Unable to load dependencies.",
        );
        setLoadError(message);
        return;
      }
      const data = (await response.json()) as TaskBlockerSummaryResponse;
      setSummary(data);
    } catch {
      setLoadError(
        "Network error while loading dependencies. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function onAddDependency(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || isProjectArchived || addInFlightRef.current) return;
    if (!selectedPrereqId) return;

    addInFlightRef.current = true;
    setAddInFlight(true);
    setAddError(null);
    setAddSuccess(null);
    setRemoveError(null);

    try {
      const response = await fetch(dependenciesEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prerequisiteTaskId: selectedPrereqId }),
      });

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not add dependency.",
        );
        setAddError(message);
        return;
      }

      const data = (await response.json()) as TaskBlockerSummaryResponse;
      setSummary(data);
      setSelectedPrereqId("");
      setAddSuccess("Dependency added.");
      if (onActivityRecorded) {
        onActivityRecorded();
      }
    } catch {
      setAddError("Network error while adding dependency. Please try again.");
    } finally {
      addInFlightRef.current = false;
      setAddInFlight(false);
    }
  }

  async function onRemoveDependency(prerequisiteTaskId: string) {
    if (!canManage || isProjectArchived || removingId !== null) return;

    setRemovingId(prerequisiteTaskId);
    setRemoveError(null);
    setAddError(null);
    setAddSuccess(null);

    try {
      const response = await fetch(
        `${dependenciesEndpoint}/${encodeURIComponent(prerequisiteTaskId)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not remove dependency.",
        );
        setRemoveError(message);
        return;
      }

      const data = (await response.json()) as TaskBlockerSummaryResponse;
      setSummary(data);
      if (onActivityRecorded) {
        onActivityRecorded();
      }
    } catch {
      setRemoveError(
        "Network error while removing dependency. Please try again.",
      );
    } finally {
      setRemovingId(null);
    }
  }

  const sectionInputClass =
    "rounded border border-zinc-300 bg-white px-2.5 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <div className="mt-2 flex flex-col gap-2.5 border-t border-zinc-200 pt-2.5 text-xs dark:border-zinc-800">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <h5 className="font-medium text-zinc-700 dark:text-zinc-300">
          Prerequisites ({summary.dependencyCount})
          {summary.isBlocked && (
            <span className="ml-2 rounded border border-amber-300 bg-amber-100 px-2 py-0.5 font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/70 dark:text-amber-200">
              {summary.blockerCount} blocking
            </span>
          )}
        </h5>
        {loadError && (
          <button
            type="button"
            onClick={() => void refreshSummary()}
            className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Retry
          </button>
        )}
      </div>

      {/* Load error */}
      {loadError && (
        <p role="alert" className="text-red-600">
          {loadError}
        </p>
      )}

      {/* Loading spinner */}
      {loading && (
        <p className="text-zinc-500">Loading dependencies…</p>
      )}

      {/* Dependency list */}
      {!loading && summary.dependencies.length === 0 && (
        <p className="text-zinc-500">
          No prerequisites. This task can start immediately.
        </p>
      )}

      {!loading && summary.dependencies.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {summary.dependencies.map((dep) => {
            const isRemoving = removingId === dep.prerequisiteTaskId;
            return (
              <li
                key={dep.id}
                className="flex items-center justify-between gap-2 rounded border border-zinc-100 bg-zinc-50 px-2.5 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/60"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {dep.isBlocking ? (
                    <span className="rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/70 dark:text-amber-200">
                      Blocking
                    </span>
                  ) : (
                    <span className="rounded border border-emerald-300 bg-emerald-100 px-1.5 py-0.5 font-semibold text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                      Resolved
                    </span>
                  )}
                  <span className={STATUS_CHIP_CLASSES[dep.prerequisiteStatus]}>
                    {STATUS_LABELS[dep.prerequisiteStatus]}
                  </span>
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {dep.prerequisiteTitle}
                  </span>
                </div>

                {canManage && !isProjectArchived && (
                  <button
                    type="button"
                    disabled={isRemoving || removingId !== null}
                    onClick={() =>
                      void onRemoveDependency(dep.prerequisiteTaskId)
                    }
                    className="shrink-0 rounded border border-zinc-300 px-2 py-0.5 text-zinc-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-red-800 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                  >
                    {isRemoving ? "Removing…" : "Remove"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Remove error */}
      {removeError && (
        <p role="alert" className="text-red-600">
          {removeError}
        </p>
      )}

      {/* Add prerequisite form – admin/manager only */}
      {canManage && !isProjectArchived && (
        <form
          onSubmit={onAddDependency}
          className="flex flex-col gap-2 rounded border border-dashed border-zinc-300 p-2.5 dark:border-zinc-700"
        >
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Add prerequisite
          </span>
          {eligibleTasks.length === 0 ? (
            <p className="text-zinc-500">
              {summary.dependencyCount === 0
                ? "No other tasks available in this project."
                : "All available tasks are already prerequisites."}
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-zinc-500">Task</span>
                <select
                  value={selectedPrereqId}
                  disabled={addInFlight}
                  onChange={(event) => setSelectedPrereqId(event.target.value)}
                  className={sectionInputClass}
                >
                  <option value="">Select a task…</option>
                  {eligibleTasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.parentTaskId ? "↳ " : ""}
                      {t.title}
                      {" · "}
                      {STATUS_LABELS[t.status]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={addInFlight || !selectedPrereqId}
                className="rounded bg-black px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
              >
                {addInFlight ? "Adding…" : "Add"}
              </button>
            </div>
          )}

          {addError && (
            <p role="alert" className="text-red-600">
              {addError}
            </p>
          )}
          {addSuccess && (
            <p role="status" className="text-emerald-600 dark:text-emerald-400">
              {addSuccess}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity Timeline Components (Task Activity & Project Activity)
// ---------------------------------------------------------------------------

function sortAndDedupeActivitiesNewestFirst(
  items: ActivityEntrySummary[],
): ActivityEntrySummary[] {
  const seen = new Set<string>();
  const unique: ActivityEntrySummary[] = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      unique.push(item);
    }
  }
  return unique.sort((a, b) => {
    const timeDiff =
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (timeDiff !== 0) return timeDiff;
    return b.id.localeCompare(a.id);
  });
}

function formatActivityActorLabel(
  entry: ActivityEntrySummary,
  currentUserId: string,
  members: MemberOption[],
): string {
  const isCurrentUser = entry.actorId === currentUserId;
  if (entry.actor && typeof entry.actor.label === "string" && entry.actor.label.trim() !== "") {
    const roleSuffix = entry.actor.role ? ` · ${entry.actor.role}` : "";
    const youSuffix = isCurrentUser ? " (you)" : "";
    return `${entry.actor.label.trim()}${youSuffix}${roleSuffix}`;
  }
  return formatMemberLabel(entry.actorId, currentUserId, members);
}

type ActivityTimelineListProps = {
  activities: ActivityEntrySummary[];
  currentUserId: string;
  members: MemberOption[];
  compact?: boolean;
};

function ActivityTimelineList({
  activities,
  currentUserId,
  members,
  compact = false,
}: ActivityTimelineListProps) {
  const ordered = sortAndDedupeActivitiesNewestFirst(activities);

  return (
    <ol className="flex flex-col gap-2">
      {ordered.map((entry) => {
        const badge = ACTIVITY_EVENT_BADGES[entry.eventType] ?? {
          label: entry.eventType,
          className:
            "rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
        };
        const reviewComment =
          typeof entry.metadata?.comment === "string" &&
          entry.metadata.comment.trim() !== ""
            ? entry.metadata.comment.trim()
            : null;

        return (
          <li
            key={entry.id}
            className={`flex flex-col gap-1.5 rounded border border-zinc-200/80 bg-zinc-50/70 ${
              compact ? "p-2 text-xs" : "p-3 text-xs"
            } dark:border-zinc-800 dark:bg-zinc-900/50`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={badge.className}>{badge.label}</span>
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {entry.summary}
                </span>
              </div>
              <span className="text-zinc-500">
                {formatTimestampDisplay(entry.createdAt)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-zinc-500">
              <span>
                By{" "}
                <strong className="font-normal text-zinc-700 dark:text-zinc-300">
                  {formatActivityActorLabel(entry, currentUserId, members)}
                </strong>
              </span>
            </div>

            {Array.isArray(entry.changes) && entry.changes.length > 0 && (
              <ul className="mt-0.5 flex flex-col gap-1 border-l-2 border-zinc-200 pl-2.5 text-[11px] text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                {entry.changes.map((change, idx) => {
                  const fieldLabel =
                    ACTIVITY_FIELD_LABELS[change.field] ?? change.field;
                  const isTransition =
                    change.before !== null && change.after !== null;
                  const isRemoval =
                    change.before !== null &&
                    change.after === null &&
                    entry.eventType === "dependency.removed";

                  return (
                    <li
                      key={`${entry.id}-${change.field}-${idx}`}
                      className="flex flex-wrap items-center gap-1"
                    >
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        {fieldLabel}:
                      </span>
                      {isTransition ||
                      entry.eventType.endsWith("_changed") ||
                      entry.eventType.endsWith(".updated") ||
                      entry.eventType === "project.archived" ||
                      entry.eventType === "project.unarchived" ||
                      entry.eventType === "review.decision_updated" ? (
                        <>
                          <span className="rounded bg-zinc-200/70 px-1.5 py-0.5 text-zinc-700 line-through dark:bg-zinc-800 dark:text-zinc-400">
                            {change.beforeDisplay}
                          </span>
                          <span aria-hidden="true">→</span>
                          <span className="rounded bg-emerald-100/70 px-1.5 py-0.5 font-medium text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300">
                            {change.afterDisplay}
                          </span>
                        </>
                      ) : isRemoval ? (
                        <span className="rounded bg-zinc-200/70 px-1.5 py-0.5 text-zinc-700 line-through dark:bg-zinc-800 dark:text-zinc-400">
                          {change.beforeDisplay}
                        </span>
                      ) : (
                        <span className="rounded bg-zinc-200/60 px-1.5 py-0.5 font-medium text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                          {change.afterDisplay}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {reviewComment && (
              <p className="mt-0.5 rounded border border-zinc-200 bg-white/80 px-2 py-1 text-[11px] text-zinc-700 whitespace-pre-wrap dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-300">
                &ldquo;{reviewComment}&rdquo;
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

type TaskActivitySectionProps = {
  organizationSlug: string;
  projectId: string;
  task: TaskSummary;
  currentUserId: string;
  members: MemberOption[];
  seededActivities: ActivityEntrySummary[];
  parentLoading: boolean;
};

function TaskActivitySection({
  organizationSlug,
  projectId,
  task,
  currentUserId,
  members,
  seededActivities,
  parentLoading,
}: TaskActivitySectionProps) {
  const endpoint = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/activity`;

  const [fetchedActivities, setFetchedActivities] = useState<
    ActivityEntrySummary[] | null
  >(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTaskActivity = useCallback(
    async (cursor?: string | null) => {
      if (cursor) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);

      const params = new URLSearchParams({ limit: "10" });
      if (cursor) {
        params.set("cursor", cursor);
      }

      try {
        const response = await fetch(`${endpoint}?${params.toString()}`, {
          method: "GET",
          cache: "no-store",
        });

        if (!response.ok) {
          const message = await readApiError(
            response,
            "Unable to load task activity.",
          );
          setError(message);
          return;
        }

        const data = (await response.json()) as {
          activities?: ActivityEntrySummary[];
          nextCursor?: string | null;
        };
        const incoming = Array.isArray(data.activities) ? data.activities : [];

        setFetchedActivities((prev) =>
          cursor && prev
            ? sortAndDedupeActivitiesNewestFirst([...prev, ...incoming])
            : incoming,
        );
        setNextCursor(
          typeof data.nextCursor === "string" ? data.nextCursor : null,
        );
      } catch {
        setError("Network error while loading task activity. Please try again.");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [endpoint],
  );

  const combinedActivities = sortAndDedupeActivitiesNewestFirst([
    ...seededActivities,
    ...(fetchedActivities ?? []),
  ]);

  const isInitialLoading =
    loading || (fetchedActivities === null && parentLoading);

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-zinc-200 pt-2.5 text-xs dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="font-medium text-zinc-700 dark:text-zinc-300">
          Task Activity ({combinedActivities.length})
        </h5>
        <div className="flex items-center gap-1.5">
          {error && (
            <button
              type="button"
              disabled={loading || loadingMore}
              onClick={() => void loadTaskActivity(null)}
              className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Retry
            </button>
          )}
          <button
            type="button"
            disabled={loading || loadingMore}
            onClick={() => void loadTaskActivity(null)}
            className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {loading
              ? "Loading…"
              : fetchedActivities === null
                ? "Load full task activity"
                : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}

      {isInitialLoading && combinedActivities.length === 0 ? (
        <p className="text-zinc-500">Loading task activity…</p>
      ) : combinedActivities.length === 0 ? (
        <p className="text-zinc-500">No activity recorded for this task yet.</p>
      ) : (
        <>
          <ActivityTimelineList
            activities={combinedActivities}
            currentUserId={currentUserId}
            members={members}
            compact
          />
          {nextCursor && (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void loadTaskActivity(nextCursor)}
              className="self-start rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {loadingMore ? "Loading more…" : "Load more task activity"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

type ProjectActivitySectionProps = {
  activities: ActivityEntrySummary[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  currentUserId: string;
  members: MemberOption[];
  onRefresh: () => void;
  onLoadMore: () => void;
};

function ProjectActivitySection({
  activities,
  loading,
  loadingMore,
  error,
  hasMore,
  currentUserId,
  members,
  onRefresh,
  onLoadMore,
}: ProjectActivitySectionProps) {
  return (
    <section
      aria-label="Project Activity"
      className="flex flex-col gap-3 rounded border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-medium">Project Activity</h2>
          <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            {activities.length}
          </span>
        </div>
        <button
          type="button"
          disabled={loading || loadingMore}
          onClick={onRefresh}
          className="rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {loading ? "Loading…" : error ? "Retry" : "Refresh"}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {loading && activities.length === 0 ? (
        <p className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
          Loading project activity…
        </p>
      ) : activities.length === 0 ? (
        <p className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
          No activity recorded for this project yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <ActivityTimelineList
            activities={activities}
            currentUserId={currentUserId}
            members={members}
          />
          {hasMore && (
            <button
              type="button"
              disabled={loadingMore}
              onClick={onLoadMore}
              className="self-start rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {loadingMore ? "Loading more…" : "Load more activity"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function TasksClient({
  organizationSlug,
  projectId,
  projectStatus,
  role,
  currentUserId,
  members,
  initialTasks,
}: TasksClientProps) {
  const router = useRouter();
  const canManage = role === "admin" || role === "manager";
  const isProjectArchived = projectStatus === "archived";

  const [tasks, setTasks] = useState<TaskWithSubtasks[]>(initialTasks);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [deliverableStatusFilter, setDeliverableStatusFilter] =
    useState<DeliverableStatusFilterOption>("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | TaskPriority>(
    "all",
  );
  const [overdueFilter, setOverdueFilter] = useState<"all" | "true" | "false">(
    "all",
  );
  const [staleFilter, setStaleFilter] = useState<"all" | "true" | "false">(
    "all",
  );
  const [blockedFilter, setBlockedFilter] = useState<"all" | "true" | "false">(
    "all",
  );
  const [deadlineFromFilter, setDeadlineFromFilter] = useState<string>("");
  const [deadlineToFilter, setDeadlineToFilter] = useState<string>("");
  const [sortByFilter, setSortByFilter] = useState<
    "createdAt" | "deadline" | "priority" | "lastActivity" | "status"
  >("createdAt");
  const [sortOrderFilter, setSortOrderFilter] = useState<"asc" | "desc">("asc");
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Top-level task creation state (admin / manager)
  const [createTitle, setCreateTitle] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createPriority, setCreatePriority] = useState<TaskPriority>("medium");
  const [createAssigneeId, setCreateAssigneeId] = useState<string>("");
  const [createDeadline, setCreateDeadline] = useState("");
  const [createApprovalRequired, setCreateApprovalRequired] = useState(true);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const createInFlight = useRef(false);

  // Subtask creation state
  const [subtaskParentId, setSubtaskParentId] = useState<string | null>(null);
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [subtaskDescription, setSubtaskDescription] = useState("");
  const [subtaskPriority, setSubtaskPriority] =
    useState<TaskPriority>("medium");
  const [subtaskAssigneeId, setSubtaskAssigneeId] = useState<string>("");
  const [subtaskDeadline, setSubtaskDeadline] = useState("");
  const [subtaskApprovalRequired, setSubtaskApprovalRequired] = useState(true);
  const [subtaskLoading, setSubtaskLoading] = useState(false);
  const [subtaskError, setSubtaskError] = useState<string | null>(null);
  const subtaskInFlight = useRef(false);

  // Task / subtask edit state
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStatus, setEditStatus] = useState<TaskStatus>("todo");
  const [editPriority, setEditPriority] = useState<TaskPriority>("medium");
  const [editAssigneeId, setEditAssigneeId] = useState<string>("");
  const [editDeadline, setEditDeadline] = useState("");
  const [editApprovalRequired, setEditApprovalRequired] = useState(true);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionErrorTaskId, setActionErrorTaskId] = useState<string | null>(
    null,
  );
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const actionInFlight = useRef(false);

  // Project-level activity state (also seeds per-task activity without N+1 requests)
  const [projectActivities, setProjectActivities] = useState<
    ActivityEntrySummary[]
  >([]);
  const [projectActivityCursor, setProjectActivityCursor] = useState<
    string | null
  >(null);
  const [projectActivityLoading, setProjectActivityLoading] = useState(true);
  const [projectActivityLoadingMore, setProjectActivityLoadingMore] =
    useState(false);
  const [projectActivityError, setProjectActivityError] = useState<
    string | null
  >(null);

  const tasksApiUrl = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tasks`;
  const projectActivityApiUrl = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/activity`;

  const refreshProjectActivity = useCallback(async () => {
    setProjectActivityLoading(true);
    setProjectActivityError(null);
    try {
      const response = await fetch(`${projectActivityApiUrl}?limit=15`, {
        method: "GET",
        cache: "no-store",
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Unable to load project activity.",
        );
        setProjectActivityError(message);
        return;
      }

      const data = (await response.json()) as {
        activities?: ActivityEntrySummary[];
        nextCursor?: string | null;
      };
      setProjectActivities(
        Array.isArray(data.activities) ? data.activities : [],
      );
      setProjectActivityCursor(
        typeof data.nextCursor === "string" ? data.nextCursor : null,
      );
    } catch {
      setProjectActivityError(
        "Network error while loading project activity. Please try again.",
      );
    } finally {
      setProjectActivityLoading(false);
    }
  }, [projectActivityApiUrl, router]);

  const loadMoreProjectActivity = useCallback(async () => {
    if (!projectActivityCursor || projectActivityLoadingMore) return;
    setProjectActivityLoadingMore(true);
    setProjectActivityError(null);

    try {
      const params = new URLSearchParams({
        limit: "15",
        cursor: projectActivityCursor,
      });
      const response = await fetch(
        `${projectActivityApiUrl}?${params.toString()}`,
        {
          method: "GET",
          cache: "no-store",
        },
      );

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Unable to load more project activity.",
        );
        setProjectActivityError(message);
        return;
      }

      const data = (await response.json()) as {
        activities?: ActivityEntrySummary[];
        nextCursor?: string | null;
      };
      const incoming = Array.isArray(data.activities) ? data.activities : [];
      setProjectActivities((prev) =>
        sortAndDedupeActivitiesNewestFirst([...prev, ...incoming]),
      );
      setProjectActivityCursor(
        typeof data.nextCursor === "string" ? data.nextCursor : null,
      );
    } catch {
      setProjectActivityError(
        "Network error while loading more project activity. Please try again.",
      );
    } finally {
      setProjectActivityLoadingMore(false);
    }
  }, [projectActivityApiUrl, projectActivityCursor, projectActivityLoadingMore, router]);

  useEffect(() => {
    let cancelled = false;

    async function fetchInitialProjectActivity() {
      try {
        const response = await fetch(`${projectActivityApiUrl}?limit=15`, {
          method: "GET",
          cache: "no-store",
        });

        if (response.status === 401) {
          router.push("/login");
          return;
        }

        if (!response.ok) {
          const message = await readApiError(
            response,
            "Unable to load project activity.",
          );
          if (!cancelled) {
            setProjectActivityError(message);
          }
          return;
        }

        const data = (await response.json()) as {
          activities?: ActivityEntrySummary[];
          nextCursor?: string | null;
        };
        if (!cancelled) {
          setProjectActivities(
            Array.isArray(data.activities) ? data.activities : [],
          );
          setProjectActivityCursor(
            typeof data.nextCursor === "string" ? data.nextCursor : null,
          );
          setProjectActivityError(null);
        }
      } catch {
        if (!cancelled) {
          setProjectActivityError(
            "Network error while loading project activity. Please try again.",
          );
        }
      } finally {
        if (!cancelled) {
          setProjectActivityLoading(false);
        }
      }
    }

    void fetchInitialProjectActivity();

    return () => {
      cancelled = true;
    };
  }, [projectActivityApiUrl, router]);

  const handleTaskDeliverableStatusChange = useCallback(
    (taskId: string, nextStatus: TaskDeliverableStatus) => {
      setTasks((prevTasks) =>
        prevTasks.map((t) => {
          if (t.id === taskId) {
            return { ...t, deliverableStatus: nextStatus };
          }
          if (t.subtasks.some((sub) => sub.id === taskId)) {
            return {
              ...t,
              subtasks: t.subtasks.map((sub) =>
                sub.id === taskId
                  ? { ...sub, deliverableStatus: nextStatus }
                  : sub,
              ),
            };
          }
          return t;
        }),
      );
    },
    [],
  );

  function canEditTask(task: TaskSummary): boolean {
    if (isProjectArchived) return false;
    if (canManage) return true;
    return task.assigneeId === currentUserId;
  }

  function canCreateSubtaskUnder(parentTask: TaskSummary): boolean {
    if (isProjectArchived || parentTask.parentTaskId !== null) return false;
    if (canManage) return true;
    return parentTask.assigneeId === currentUserId;
  }

  type AdvancedFilterOverrides = {
    priority?: "all" | TaskPriority;
    overdue?: "all" | "true" | "false";
    stale?: "all" | "true" | "false";
    blocked?: "all" | "true" | "false";
    deadlineFrom?: string;
    deadlineTo?: string;
    sortBy?: "createdAt" | "deadline" | "priority" | "lastActivity" | "status";
    sortOrder?: "asc" | "desc";
  };

  async function refreshTasks(
    nextStatusFilter: StatusFilter = statusFilter,
    nextAssigneeFilter: string = assigneeFilter,
    nextDeliverableStatusFilter: DeliverableStatusFilterOption = deliverableStatusFilter,
    overrides?: AdvancedFilterOverrides,
  ) {
    setListLoading(true);
    setListError(null);

    const effPriority = overrides?.priority ?? priorityFilter;
    const effOverdue = overrides?.overdue ?? overdueFilter;
    const effStale = overrides?.stale ?? staleFilter;
    const effBlocked = overrides?.blocked ?? blockedFilter;
    const effDeadlineFrom = overrides?.deadlineFrom ?? deadlineFromFilter;
    const effDeadlineTo = overrides?.deadlineTo ?? deadlineToFilter;
    const effSortBy = overrides?.sortBy ?? sortByFilter;
    const effSortOrder = overrides?.sortOrder ?? sortOrderFilter;

    const params = new URLSearchParams();
    if (nextStatusFilter !== "all") {
      params.set("status", nextStatusFilter);
    }
    if (nextAssigneeFilter === "unassigned") {
      params.set("assigneeId", "null");
    } else if (nextAssigneeFilter !== "all") {
      params.set("assigneeId", nextAssigneeFilter);
    }
    if (nextDeliverableStatusFilter !== "all") {
      params.set("deliverableStatus", nextDeliverableStatusFilter);
    }
    if (effPriority !== "all") {
      params.set("priority", effPriority);
    }
    if (effOverdue !== "all") {
      params.set("overdue", effOverdue);
    }
    if (effStale !== "all") {
      params.set("stale", effStale);
    }
    if (effBlocked !== "all") {
      params.set("blocked", effBlocked);
    }
    if (effDeadlineFrom.trim() !== "") {
      params.set("deadlineFrom", effDeadlineFrom.trim());
    }
    if (effDeadlineTo.trim() !== "") {
      params.set("deadlineTo", effDeadlineTo.trim());
    }
    if (effSortBy !== "createdAt" || effSortOrder !== "asc") {
      params.set("sortBy", effSortBy);
      params.set("sortOrder", effSortOrder);
    }
    const queryString = params.toString();

    try {
      const topLevelRes = await fetch(
        `${tasksApiUrl}${queryString ? `?${queryString}` : ""}`,
        {
          method: "GET",
          cache: "no-store",
        },
      );

      if (topLevelRes.status === 401) {
        router.push("/login");
        return;
      }

      if (!topLevelRes.ok) {
        const message = await readApiError(
          topLevelRes,
          "Failed to load tasks. Please try again.",
        );
        setListError(message);
        return;
      }

      const topLevelData = (await topLevelRes.json()) as {
        tasks?: TaskSummary[];
      };
      const topLevelTasks = Array.isArray(topLevelData.tasks)
        ? topLevelData.tasks
        : [];

      const tasksWithSubtasks: TaskWithSubtasks[] = await Promise.all(
        topLevelTasks.map(async (parentTask) => {
          const subParams = new URLSearchParams({ parentTaskId: parentTask.id });
          if (nextDeliverableStatusFilter !== "all") {
            subParams.set("deliverableStatus", nextDeliverableStatusFilter);
          }
          const subRes = await fetch(
            `${tasksApiUrl}?${subParams.toString()}`,
            {
              method: "GET",
              cache: "no-store",
            },
          );
          if (!subRes.ok) {
            return { ...parentTask, subtasks: [] };
          }
          const subData = (await subRes.json()) as { tasks?: TaskSummary[] };
          return {
            ...parentTask,
            subtasks: Array.isArray(subData.tasks) ? subData.tasks : [],
          };
        }),
      );

      setTasks(tasksWithSubtasks);
    } catch {
      setListError("Could not reach the server. Please try again.");
    } finally {
      setListLoading(false);
    }
  }

  async function onStatusFilterChange(nextStatus: StatusFilter) {
    setStatusFilter(nextStatus);
    setActionError(null);
    setActionErrorTaskId(null);
    setActionSuccess(null);
    await refreshTasks(nextStatus, assigneeFilter, deliverableStatusFilter);
  }

  async function onAssigneeFilterChange(nextAssignee: string) {
    setAssigneeFilter(nextAssignee);
    setActionError(null);
    setActionErrorTaskId(null);
    setActionSuccess(null);
    await refreshTasks(statusFilter, nextAssignee, deliverableStatusFilter);
  }

  async function onDeliverableStatusFilterChange(
    nextDeliverableStatus: DeliverableStatusFilterOption,
  ) {
    setDeliverableStatusFilter(nextDeliverableStatus);
    setActionError(null);
    setActionErrorTaskId(null);
    setActionSuccess(null);
    await refreshTasks(statusFilter, assigneeFilter, nextDeliverableStatus);
  }

  async function resetAllTaskFilters() {
    setStatusFilter("all");
    setAssigneeFilter("all");
    setDeliverableStatusFilter("all");
    setPriorityFilter("all");
    setOverdueFilter("all");
    setStaleFilter("all");
    setBlockedFilter("all");
    setDeadlineFromFilter("");
    setDeadlineToFilter("");
    setSortByFilter("createdAt");
    setSortOrderFilter("asc");
    setActionError(null);
    setActionErrorTaskId(null);
    setActionSuccess(null);
    await refreshTasks("all", "all", "all", {
      priority: "all",
      overdue: "all",
      stale: "all",
      blocked: "all",
      deadlineFrom: "",
      deadlineTo: "",
      sortBy: "createdAt",
      sortOrder: "asc",
    });
  }

  async function onCreateTopLevelTask(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || isProjectArchived || createInFlight.current) return;
    createInFlight.current = true;
    setCreateError(null);
    setCreateSuccess(null);
    setActionError(null);
    setActionErrorTaskId(null);
    setActionSuccess(null);
    setCreateLoading(true);

    const trimmedTitle = createTitle.trim();
    const trimmedDesc = createDescription.trim();
    const payload: Record<string, unknown> = {
      title: trimmedTitle,
      description: trimmedDesc === "" ? null : createDescription,
      priority: createPriority,
      assigneeId: createAssigneeId === "" ? null : createAssigneeId,
      deadline:
        createDeadline.trim() === ""
          ? null
          : `${createDeadline.trim()}T00:00:00.000Z`,
      approvalRequired: createApprovalRequired,
    };

    try {
      const response = await fetch(tasksApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not create task. Please try again.",
        );
        setCreateError(message);
        return;
      }

      setCreateTitle("");
      setCreateDescription("");
      setCreatePriority("medium");
      setCreateAssigneeId("");
      setCreateDeadline("");
      setCreateApprovalRequired(true);
      setCreateSuccess("Task created.");
      await refreshTasks(statusFilter, assigneeFilter, deliverableStatusFilter);
      void refreshProjectActivity();
      router.refresh();
    } catch {
      setCreateError("Could not reach the server. Please try again.");
    } finally {
      createInFlight.current = false;
      setCreateLoading(false);
    }
  }

  function openSubtaskForm(parentTask: TaskSummary) {
    if (!canCreateSubtaskUnder(parentTask)) return;
    setSubtaskParentId(parentTask.id);
    setSubtaskTitle("");
    setSubtaskDescription("");
    setSubtaskPriority("medium");
    setSubtaskAssigneeId(canManage ? "" : currentUserId);
    setSubtaskDeadline("");
    setSubtaskApprovalRequired(true);
    setSubtaskError(null);
    setActionError(null);
    setActionErrorTaskId(null);
    setActionSuccess(null);
  }

  function cancelSubtaskForm() {
    setSubtaskParentId(null);
    setSubtaskError(null);
  }

  async function onCreateSubtask(
    event: SubmitEvent<HTMLFormElement>,
    parentId: string,
  ) {
    event.preventDefault();
    if (isProjectArchived || subtaskInFlight.current) return;
    subtaskInFlight.current = true;
    setSubtaskError(null);
    setActionError(null);
    setActionErrorTaskId(null);
    setActionSuccess(null);
    setSubtaskLoading(true);

    const trimmedTitle = subtaskTitle.trim();
    const trimmedDesc = subtaskDescription.trim();
    const payload: Record<string, unknown> = {
      parentTaskId: parentId,
      title: trimmedTitle,
      description: trimmedDesc === "" ? null : subtaskDescription,
      priority: subtaskPriority,
      assigneeId: canManage
        ? subtaskAssigneeId === ""
          ? null
          : subtaskAssigneeId
        : currentUserId,
      deadline:
        subtaskDeadline.trim() === ""
          ? null
          : `${subtaskDeadline.trim()}T00:00:00.000Z`,
    };
    if (canManage) {
      payload.approvalRequired = subtaskApprovalRequired;
    }

    try {
      const response = await fetch(tasksApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not create subtask. Please try again.",
        );
        setSubtaskError(message);
        return;
      }

      setSubtaskParentId(null);
      setActionSuccess("Subtask created.");
      await refreshTasks(statusFilter, assigneeFilter, deliverableStatusFilter);
      void refreshProjectActivity();
      router.refresh();
    } catch {
      setSubtaskError("Could not reach the server. Please try again.");
    } finally {
      subtaskInFlight.current = false;
      setSubtaskLoading(false);
    }
  }

  function startEditingTask(task: TaskSummary) {
    if (!canEditTask(task)) return;
    setEditingTaskId(task.id);
    setEditTitle(task.title);
    setEditDescription(task.description ?? "");
    setEditStatus(task.status);
    setEditPriority(task.priority);
    setEditAssigneeId(task.assigneeId ?? "");
    setEditDeadline(toDateInputValue(task.deadline));
    setEditApprovalRequired(task.approvalRequired === true);
    setActionError(null);
    setActionErrorTaskId(null);
    setActionSuccess(null);
  }

  function cancelEditingTask() {
    setEditingTaskId(null);
    setActionError(null);
    setActionErrorTaskId(null);
  }

  async function onQuickStatusChange(task: TaskSummary, nextStatus: TaskStatus) {
    if (!canEditTask(task) || actionInFlight.current || task.status === nextStatus) {
      return;
    }
    actionInFlight.current = true;
    setActionError(null);
    setActionErrorTaskId(null);
    setActionSuccess(null);
    setActionLoadingId(task.id);

    try {
      const response = await fetch(
        `${tasksApiUrl}/${encodeURIComponent(task.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        },
      );

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not update task status.",
        );
        setActionError(message);
        setActionErrorTaskId(task.id);
        return;
      }

      setActionSuccess(`Updated "${task.title}" status to ${STATUS_LABELS[nextStatus]}.`);
      await refreshTasks(statusFilter, assigneeFilter, deliverableStatusFilter);
      void refreshProjectActivity();
      router.refresh();
    } catch {
      setActionError("Could not reach the server. Please try again.");
      setActionErrorTaskId(task.id);
    } finally {
      actionInFlight.current = false;
      setActionLoadingId(null);
    }
  }

  async function onSaveTaskEdit(
    event: SubmitEvent<HTMLFormElement>,
    task: TaskSummary,
  ) {
    event.preventDefault();
    if (!canEditTask(task) || actionInFlight.current) return;
    actionInFlight.current = true;
    setActionError(null);
    setActionErrorTaskId(null);
    setActionSuccess(null);
    setActionLoadingId(task.id);

    const trimmedTitle = editTitle.trim();
    const trimmedDesc = editDescription.trim();
    const payload: Record<string, unknown> = {
      title: trimmedTitle,
      description: trimmedDesc === "" ? null : editDescription,
      status: editStatus,
    };

    if (canManage) {
      payload.priority = editPriority;
      const nextAssigneeId = editAssigneeId === "" ? null : editAssigneeId;
      const isHistoricalFormerMemberUnchanged =
        nextAssigneeId !== null &&
        nextAssigneeId === task.assigneeId &&
        !members.some((member) => member.userId === nextAssigneeId);
      if (!isHistoricalFormerMemberUnchanged) {
        payload.assigneeId = nextAssigneeId;
      }
      payload.deadline =
        editDeadline.trim() === ""
          ? null
          : `${editDeadline.trim()}T00:00:00.000Z`;
      payload.approvalRequired = editApprovalRequired;
    }

    try {
      const response = await fetch(
        `${tasksApiUrl}/${encodeURIComponent(task.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not update task. Please try again.",
        );
        setActionError(message);
        setActionErrorTaskId(task.id);
        return;
      }

      setEditingTaskId(null);
      setActionSuccess(`Updated "${trimmedTitle}".`);
      await refreshTasks(statusFilter, assigneeFilter, deliverableStatusFilter);
      void refreshProjectActivity();
      router.refresh();
    } catch {
      setActionError("Could not reach the server. Please try again.");
      setActionErrorTaskId(task.id);
    } finally {
      actionInFlight.current = false;
      setActionLoadingId(null);
    }
  }

  const inputClassName =
    "w-full rounded border border-zinc-300 px-3 py-1.5 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white";

  function renderTaskEditForm(task: TaskSummary) {
    const isBusy = actionLoadingId === task.id;
    const taskSpecificError =
      actionError && actionErrorTaskId === task.id ? actionError : null;
    const effectiveApprovalRequired = canManage
      ? editApprovalRequired
      : task.approvalRequired === true;

    return (
      <form
        onSubmit={(event) => void onSaveTaskEdit(event, task)}
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-1 text-xs font-medium">
          Title
          <input
            type="text"
            required
            maxLength={300}
            value={editTitle}
            onChange={(event) => setEditTitle(event.target.value)}
            className={inputClassName}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          <span>
            Description <span className="text-zinc-500">(optional)</span>
          </span>
          <textarea
            rows={2}
            maxLength={10000}
            value={editDescription}
            onChange={(event) => setEditDescription(event.target.value)}
            className={inputClassName}
          />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium">
            Status
            <select
              value={editStatus}
              onChange={(event) =>
                setEditStatus(event.target.value as TaskStatus)
              }
              className={inputClassName}
            >
              <option value="todo">To do</option>
              <option value="in_progress">In progress</option>
              <option value="done">Done</option>
            </select>
          </label>
          {canManage && (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Priority
                <select
                  value={editPriority}
                  onChange={(event) =>
                    setEditPriority(event.target.value as TaskPriority)
                  }
                  className={inputClassName}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Assignee
                <select
                  value={editAssigneeId}
                  onChange={(event) => setEditAssigneeId(event.target.value)}
                  className={inputClassName}
                >
                  <option value="">Unassigned</option>
                  {task.assigneeId &&
                    !members.some(
                      (member) => member.userId === task.assigneeId,
                    ) && (
                      <option value={task.assigneeId}>
                        {formatMemberLabel(
                          task.assigneeId,
                          currentUserId,
                          members,
                        )}
                      </option>
                    )}
                  {members.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {formatMemberLabel(member.userId, currentUserId, members)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                <span>
                  Deadline <span className="text-zinc-500">(optional)</span>
                </span>
                <input
                  type="date"
                  value={editDeadline}
                  onChange={(event) => setEditDeadline(event.target.value)}
                  className={inputClassName}
                />
              </label>
            </>
          )}
        </div>

        {canManage ? (
          <label className="flex items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              disabled={isBusy}
              checked={editApprovalRequired}
              onChange={(event) =>
                setEditApprovalRequired(event.target.checked)
              }
              className="rounded border-zinc-300 dark:border-zinc-700"
            />
            <span>Require deliverable approval before completion</span>
          </label>
        ) : (
          <p className="text-xs text-zinc-500">
            Approval requirement:{" "}
            <strong className="font-medium text-zinc-700 dark:text-zinc-300">
              {task.approvalRequired === true ? "Required" : "Not required"}
            </strong>{" "}
            (managed by admins and managers)
          </p>
        )}

        {effectiveApprovalRequired && editStatus === "done" && (
          <p className="text-xs text-zinc-500">
            Marking Done requires the latest deliverable submission to have an
            Approved review.
          </p>
        )}

        {taskSpecificError && (
          <p role="alert" className="text-xs text-red-600">
            {taskSpecificError}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={isBusy}
            className="rounded bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
          >
            {isBusy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={cancelEditingTask}
            className="rounded border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  function renderTaskDetails(task: TaskSummary, isSubtask: boolean) {
    const editable = canEditTask(task);
    const isBusy = actionLoadingId === task.id;
    const isApprovalRequired = task.approvalRequired === true;
    const taskSpecificError =
      actionError && actionErrorTaskId === task.id ? actionError : null;

    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h4 className={isSubtask ? "text-sm font-medium" : "font-medium"}>
              {task.title}
            </h4>
            {task.description && (
              <p className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">
                {task.description}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span
              className={
                isApprovalRequired
                  ? "rounded bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300"
                  : "rounded bg-zinc-100 px-2 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
              }
            >
              {isApprovalRequired ? "Approval required" : "Approval optional"}
            </span>
            <span className="rounded bg-zinc-100 px-2 py-0.5 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {PRIORITY_LABELS[task.priority]}
            </span>
            {task.isBlocked && (
              <span className="rounded border border-amber-300 bg-amber-100 px-2 py-0.5 font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/70 dark:text-amber-200">
                Blocked
              </span>
            )}
            {task.isOverdue && (
              <span
                data-testid={`task-overdue-badge-${task.id}`}
                className="rounded border border-red-300 bg-red-100 px-2 py-0.5 font-semibold text-red-800 dark:border-red-800 dark:bg-red-950/70 dark:text-red-300"
              >
                Overdue
              </span>
            )}
            {!task.isOverdue && task.isDueToday && (
              <span
                data-testid={`task-due-today-badge-${task.id}`}
                className="rounded border border-amber-300 bg-amber-100 px-2 py-0.5 font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-300"
              >
                Due Today
              </span>
            )}
            {!task.isOverdue && !task.isDueToday && task.isDueSoon && (
              <span
                data-testid={`task-due-soon-badge-${task.id}`}
                className="rounded border border-yellow-300 bg-yellow-50 px-2 py-0.5 font-medium text-yellow-800 dark:border-yellow-800/70 dark:bg-yellow-950/50 dark:text-yellow-300"
              >
                Due Soon
              </span>
            )}
            {task.isStale && (
              <span
                data-testid={`task-stale-badge-${task.id}`}
                className="rounded border border-amber-300 bg-amber-100 px-2 py-0.5 font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-300"
              >
                Stale · {task.daysSinceActivity ?? 7}d inactive
              </span>
            )}
            {task.deliverableStatus && (
              <span
                className={DELIVERABLE_STATUS_CLASSES[task.deliverableStatus]}
              >
                {DELIVERABLE_STATUS_LABELS[task.deliverableStatus]}
              </span>
            )}
            {editable ? (
              <select
                aria-label={`Status for ${task.title}`}
                disabled={isBusy}
                value={task.status}
                onChange={(event) =>
                  void onQuickStatusChange(
                    task,
                    event.target.value as TaskStatus,
                  )
                }
                className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              >
                <option value="todo">To do</option>
                <option value="in_progress">In progress</option>
                <option value="done">Done</option>
              </select>
            ) : (
              <span className="rounded bg-zinc-100 px-2 py-0.5 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {STATUS_LABELS[task.status]}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Assignee:{" "}
              <strong className="font-normal text-zinc-700 dark:text-zinc-300">
                {formatMemberLabel(task.assigneeId, currentUserId, members)}
              </strong>
            </span>
            <span>
              Deadline:{" "}
              <strong className="font-normal text-zinc-700 dark:text-zinc-300">
                {formatDateDisplay(task.deadline)}
              </strong>
            </span>
            {task.lastActivityAt && (
              <span data-testid={`task-last-activity-${task.id}`}>
                Last activity:{" "}
                <strong className="font-normal text-zinc-700 dark:text-zinc-300">
                  {formatTimestampDisplay(task.lastActivityAt)}
                </strong>
                {typeof task.daysSinceActivity === "number"
                  ? ` (${task.daysSinceActivity}d ago)`
                  : ""}
              </span>
            )}
            {task.sourceMeetingId && (
              <span
                data-testid={`task-source-meeting-${task.id}`}
                className="inline-flex flex-wrap items-center gap-1 rounded border border-purple-200 bg-purple-50/70 px-2 py-0.5 text-purple-900 dark:border-purple-900/60 dark:bg-purple-950/30 dark:text-purple-200"
              >
                <span>From meeting:</span>
                <Link
                  href={`/dashboard/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(task.sourceMeetingId)}`}
                  data-testid={`task-source-meeting-link-${task.id}`}
                  className="font-medium underline hover:text-purple-700 dark:hover:text-purple-100"
                >
                  {task.sourceMeetingTitle ?? "Source meeting"}
                </Link>
                {task.sourceActionItemTitle && (
                  <span className="text-purple-700 dark:text-purple-300">
                    (Action item: &ldquo;{task.sourceActionItemTitle}&rdquo;)
                  </span>
                )}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {editable && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => startEditingTask(task)}
                className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Edit
              </button>
            )}
            {!isSubtask && canCreateSubtaskUnder(task) && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => openSubtaskForm(task)}
                className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                + Subtask
              </button>
            )}
          </div>
        </div>

        {isApprovalRequired && task.status !== "done" && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Requires an Approved review on the latest deliverable submission
            before this task can be marked Done.
          </p>
        )}

        {taskSpecificError && (
          <p role="alert" className="text-xs text-red-600">
            {taskSpecificError}
          </p>
        )}

        <TaskDeliverablesSection
          organizationSlug={organizationSlug}
          projectId={projectId}
          task={task}
          isProjectArchived={isProjectArchived}
          canManage={canManage}
          currentUserId={currentUserId}
          members={members}
          onDeliverableStatusChange={(status) =>
            handleTaskDeliverableStatusChange(task.id, status)
          }
          onActivityRecorded={() => void refreshProjectActivity()}
        />

        <TaskDependenciesSection
          organizationSlug={organizationSlug}
          projectId={projectId}
          task={task}
          allTasks={tasks}
          isProjectArchived={isProjectArchived}
          canManage={canManage}
          onActivityRecorded={() => void refreshProjectActivity()}
        />

        <TaskActivitySection
          organizationSlug={organizationSlug}
          projectId={projectId}
          task={task}
          currentUserId={currentUserId}
          members={members}
          seededActivities={projectActivities.filter(
            (item) => item.taskId === task.id,
          )}
          parentLoading={projectActivityLoading}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {isProjectArchived && (
        <div
          role="status"
          className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          This project is archived. Tasks, deliverables, and reviews are
          read-only until an admin or manager unarchives the project.
        </div>
      )}

      <section className="flex flex-col gap-3">
        {/* Project-level Task Health & Overdue/Stale Summary Bar */}
        <div
          data-testid="project-task-health-summary"
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300"
        >
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Total Tasks:{" "}
              <strong className="font-semibold text-zinc-900 dark:text-zinc-100">
                {tasks.length}
              </strong>
            </span>
            <span>·</span>
            <span className="text-emerald-700 dark:text-emerald-400">
              Completed: {tasks.filter((t) => t.status === "done").length}
            </span>
            <span>·</span>
            <span className="text-blue-700 dark:text-blue-400">
              In Progress:{" "}
              {tasks.filter((t) => t.status === "in_progress").length}
            </span>
            <span>·</span>
            <span
              data-testid="project-overdue-summary-count"
              className="font-medium text-red-700 dark:text-red-400"
            >
              Overdue: {tasks.filter((t) => t.isOverdue).length}
            </span>
            <span>·</span>
            <span
              data-testid="project-stale-summary-count"
              className="font-medium text-amber-700 dark:text-amber-400"
            >
              Stale: {tasks.filter((t) => t.isStale).length}
            </span>
            <span>·</span>
            <span className="font-medium text-rose-700 dark:text-rose-400">
              Blocked:{" "}
              {tasks.filter((t) => t.status !== "done" && t.isBlocked).length}
            </span>
          </div>
          {tasks.length > 0 && (
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Completion:{" "}
              {Math.round(
                (tasks.filter((t) => t.status === "done").length /
                  tasks.length) *
                  100,
              )}
              %
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">Tasks</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-500">Status:</span>
              <select
                disabled={listLoading}
                value={statusFilter}
                onChange={(event) =>
                  void onStatusFilterChange(event.target.value as StatusFilter)
                }
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="all">All statuses</option>
                <option value="todo">To do</option>
                <option value="in_progress">In progress</option>
                <option value="done">Done</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-500">Priority:</span>
              <select
                disabled={listLoading}
                aria-label="Filter tasks by priority"
                value={priorityFilter}
                onChange={(event) => {
                  const next = event.target.value as "all" | TaskPriority;
                  setPriorityFilter(next);
                  void refreshTasks(
                    statusFilter,
                    assigneeFilter,
                    deliverableStatusFilter,
                    { priority: next },
                  );
                }}
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="all">All priorities</option>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-500">Assignee:</span>
              <select
                disabled={listLoading}
                value={assigneeFilter}
                onChange={(event) =>
                  void onAssigneeFilterChange(event.target.value)
                }
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="all">All assignees</option>
                <option value="unassigned">Unassigned</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {formatMemberLabel(member.userId, currentUserId, members)}
                  </option>
                ))}
                {Array.from(
                  new Set(
                    [
                      ...tasks.flatMap((task) => [
                        task.assigneeId,
                        ...task.subtasks.map((sub) => sub.assigneeId),
                      ]),
                      assigneeFilter !== "all" &&
                      assigneeFilter !== "unassigned"
                        ? assigneeFilter
                        : null,
                    ].filter(
                      (id): id is string =>
                        typeof id === "string" &&
                        id !== "" &&
                        !members.some((member) => member.userId === id),
                    ),
                  ),
                ).map((formerId) => (
                  <option key={formerId} value={formerId}>
                    {formatMemberLabel(formerId, currentUserId, members)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-500">Deliverable:</span>
              <select
                disabled={listLoading}
                aria-label="Filter tasks by deliverable status"
                value={deliverableStatusFilter}
                onChange={(event) =>
                  void onDeliverableStatusFilterChange(
                    event.target.value as DeliverableStatusFilterOption,
                  )
                }
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="all">All deliverable statuses</option>
                <option value="needs_submission">Needs Submission</option>
                <option value="in_review">In Review</option>
                <option value="changes_requested">Changes Requested</option>
                <option value="approved">Approved</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-500">Overdue:</span>
              <select
                disabled={listLoading}
                aria-label="Filter tasks by overdue status"
                value={overdueFilter}
                onChange={(event) => {
                  const next = event.target.value as "all" | "true" | "false";
                  setOverdueFilter(next);
                  void refreshTasks(
                    statusFilter,
                    assigneeFilter,
                    deliverableStatusFilter,
                    { overdue: next },
                  );
                }}
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="all">All</option>
                <option value="true">Overdue only</option>
                <option value="false">Not overdue</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-500">Stale:</span>
              <select
                disabled={listLoading}
                aria-label="Filter tasks by stale status"
                value={staleFilter}
                onChange={(event) => {
                  const next = event.target.value as "all" | "true" | "false";
                  setStaleFilter(next);
                  void refreshTasks(
                    statusFilter,
                    assigneeFilter,
                    deliverableStatusFilter,
                    { stale: next },
                  );
                }}
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="all">All</option>
                <option value="true">Stale only</option>
                <option value="false">Active recently</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-500">Blocked:</span>
              <select
                disabled={listLoading}
                aria-label="Filter tasks by blocked status"
                value={blockedFilter}
                onChange={(event) => {
                  const next = event.target.value as "all" | "true" | "false";
                  setBlockedFilter(next);
                  void refreshTasks(
                    statusFilter,
                    assigneeFilter,
                    deliverableStatusFilter,
                    { blocked: next },
                  );
                }}
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="all">All</option>
                <option value="true">Blocked only</option>
                <option value="false">Unblocked only</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-500">Sort:</span>
              <select
                disabled={listLoading}
                aria-label="Sort tasks by"
                value={sortByFilter}
                onChange={(event) => {
                  const next = event.target.value as
                    | "createdAt"
                    | "deadline"
                    | "priority"
                    | "lastActivity"
                    | "status";
                  setSortByFilter(next);
                  void refreshTasks(
                    statusFilter,
                    assigneeFilter,
                    deliverableStatusFilter,
                    { sortBy: next },
                  );
                }}
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="createdAt">Created</option>
                <option value="deadline">Deadline</option>
                <option value="priority">Priority</option>
                <option value="lastActivity">Last activity</option>
                <option value="status">Status</option>
              </select>
              <select
                disabled={listLoading}
                aria-label="Sort order"
                value={sortOrderFilter}
                onChange={(event) => {
                  const next = event.target.value as "asc" | "desc";
                  setSortOrderFilter(next);
                  void refreshTasks(
                    statusFilter,
                    assigneeFilter,
                    deliverableStatusFilter,
                    { sortOrder: next },
                  );
                }}
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="asc">Asc</option>
                <option value="desc">Desc</option>
              </select>
            </label>
            {(statusFilter !== "all" ||
              assigneeFilter !== "all" ||
              deliverableStatusFilter !== "all" ||
              priorityFilter !== "all" ||
              overdueFilter !== "all" ||
              staleFilter !== "all" ||
              blockedFilter !== "all" ||
              deadlineFromFilter !== "" ||
              deadlineToFilter !== "" ||
              sortByFilter !== "createdAt" ||
              sortOrderFilter !== "asc") && (
              <button
                type="button"
                disabled={listLoading}
                onClick={() => void resetAllTaskFilters()}
                className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Reset filters
              </button>
            )}
          </div>
        </div>

        {listError && (
          <p role="alert" className="text-sm text-red-600">
            {listError}
          </p>
        )}
        {actionError && (
          <p role="alert" className="text-sm text-red-600">
            {actionError}
          </p>
        )}
        {actionSuccess && (
          <p
            role="status"
            className="text-sm text-emerald-600 dark:text-emerald-400"
          >
            {actionSuccess}
          </p>
        )}

        {listLoading ? (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
            Loading tasks…
          </p>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            <p>
              {deliverableStatusFilter !== "all"
                ? `No tasks with deliverable status "${DELIVERABLE_STATUS_FILTER_LABELS[deliverableStatusFilter]}" match the current filters.`
                : "No tasks match the current filter."}
            </p>
            {deliverableStatusFilter !== "all" && (
              <button
                type="button"
                onClick={() => void onDeliverableStatusFilterChange("all")}
                className="rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Reset deliverable filter
              </button>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {tasks.map((task) => {
              const isEditing = editingTaskId === task.id;
              const isAddingSubtask = subtaskParentId === task.id;

              return (
                <li
                  key={task.id}
                  className="flex flex-col gap-3 rounded border border-zinc-200 p-4 dark:border-zinc-800"
                >
                  {isEditing
                    ? renderTaskEditForm(task)
                    : renderTaskDetails(task, false)}

                  {task.subtasks.length > 0 && (
                    <div className="flex flex-col gap-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
                      <span className="text-xs font-medium text-zinc-500">
                        Subtasks ({task.subtasks.length})
                      </span>
                      <ul className="flex flex-col gap-2">
                        {task.subtasks.map((subtask) => {
                          const isEditingSub = editingTaskId === subtask.id;
                          return (
                            <li
                              key={subtask.id}
                              className="rounded border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
                            >
                              {isEditingSub
                                ? renderTaskEditForm(subtask)
                                : renderTaskDetails(subtask, true)}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {isAddingSubtask && (
                    <form
                      onSubmit={(event) => void onCreateSubtask(event, task.id)}
                      className="flex flex-col gap-3 rounded border border-dashed border-zinc-300 p-3 dark:border-zinc-700"
                    >
                      <h4 className="text-xs font-semibold">
                        Add subtask under &ldquo;{task.title}&rdquo;
                      </h4>
                      <label className="flex flex-col gap-1 text-xs">
                        Subtask title
                        <input
                          type="text"
                          required
                          maxLength={300}
                          value={subtaskTitle}
                          onChange={(event) =>
                            setSubtaskTitle(event.target.value)
                          }
                          placeholder="Subtask title"
                          className={inputClassName}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs">
                        <span>
                          Description{" "}
                          <span className="text-zinc-500">(optional)</span>
                        </span>
                        <textarea
                          rows={2}
                          maxLength={10000}
                          value={subtaskDescription}
                          onChange={(event) =>
                            setSubtaskDescription(event.target.value)
                          }
                          className={inputClassName}
                        />
                      </label>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <label className="flex flex-col gap-1 text-xs">
                          Priority
                          <select
                            value={subtaskPriority}
                            onChange={(event) =>
                              setSubtaskPriority(
                                event.target.value as TaskPriority,
                              )
                            }
                            className={inputClassName}
                          >
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                            <option value="urgent">Urgent</option>
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                          Assignee
                          {canManage ? (
                            <select
                              value={subtaskAssigneeId}
                              onChange={(event) =>
                                setSubtaskAssigneeId(event.target.value)
                              }
                              className={inputClassName}
                            >
                              <option value="">Unassigned</option>
                              {members.map((member) => (
                                <option
                                  key={member.userId}
                                  value={member.userId}
                                >
                                  {formatMemberLabel(
                                    member.userId,
                                    currentUserId,
                                    members,
                                  )}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              disabled
                              value={formatMemberLabel(
                                currentUserId,
                                currentUserId,
                                members,
                              )}
                              className={`${inputClassName} opacity-70`}
                            />
                          )}
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                          <span>
                            Deadline{" "}
                            <span className="text-zinc-500">(optional)</span>
                          </span>
                          <input
                            type="date"
                            value={subtaskDeadline}
                            onChange={(event) =>
                              setSubtaskDeadline(event.target.value)
                            }
                            className={inputClassName}
                          />
                        </label>
                      </div>
                      {canManage ? (
                        <label className="flex items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          <input
                            type="checkbox"
                            disabled={subtaskLoading}
                            checked={subtaskApprovalRequired}
                            onChange={(event) =>
                              setSubtaskApprovalRequired(event.target.checked)
                            }
                            className="rounded border-zinc-300 dark:border-zinc-700"
                          />
                          <span>
                            Require deliverable approval before completion
                          </span>
                        </label>
                      ) : (
                        <p className="text-xs text-zinc-500">
                          Deliverable approval is required before completion by
                          default (managed by admins and managers).
                        </p>
                      )}
                      {subtaskError && (
                        <p role="alert" className="text-xs text-red-600">
                          {subtaskError}
                        </p>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          type="submit"
                          disabled={subtaskLoading}
                          className="rounded bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
                        >
                          {subtaskLoading ? "Adding…" : "Add subtask"}
                        </button>
                        <button
                          type="button"
                          disabled={subtaskLoading}
                          onClick={cancelSubtaskForm}
                          className="rounded border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canManage && !isProjectArchived && (
        <form
          onSubmit={onCreateTopLevelTask}
          className="flex flex-col gap-3 rounded border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <h2 className="text-lg font-medium">Create task</h2>
          <label className="flex flex-col gap-1 text-sm">
            Task title
            <input
              name="title"
              type="text"
              required
              maxLength={300}
              value={createTitle}
              onChange={(event) => setCreateTitle(event.target.value)}
              placeholder="Design onboarding flow"
              className={inputClassName}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>
              Description <span className="text-zinc-500">(optional)</span>
            </span>
            <textarea
              name="description"
              rows={3}
              maxLength={10000}
              value={createDescription}
              onChange={(event) => setCreateDescription(event.target.value)}
              placeholder="Acceptance criteria and notes…"
              className={inputClassName}
            />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm">
              Priority
              <select
                value={createPriority}
                onChange={(event) =>
                  setCreatePriority(event.target.value as TaskPriority)
                }
                className={inputClassName}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Assignee
              <select
                value={createAssigneeId}
                onChange={(event) => setCreateAssigneeId(event.target.value)}
                className={inputClassName}
              >
                <option value="">Unassigned</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {formatMemberLabel(member.userId, currentUserId, members)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>
                Deadline <span className="text-zinc-500">(optional)</span>
              </span>
              <input
                type="date"
                value={createDeadline}
                onChange={(event) => setCreateDeadline(event.target.value)}
                className={inputClassName}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              disabled={createLoading}
              checked={createApprovalRequired}
              onChange={(event) =>
                setCreateApprovalRequired(event.target.checked)
              }
              className="rounded border-zinc-300 dark:border-zinc-700"
            />
            <span>Require deliverable approval before completion</span>
          </label>
          {createError && (
            <p role="alert" className="text-sm text-red-600">
              {createError}
            </p>
          )}
          {createSuccess && (
            <p
              role="status"
              className="text-sm text-emerald-600 dark:text-emerald-400"
            >
              {createSuccess}
            </p>
          )}
          <button
            type="submit"
            disabled={createLoading}
            className="self-start rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-60 dark:bg-white dark:text-black"
          >
            {createLoading ? "Creating task…" : "Create task"}
          </button>
        </form>
      )}

      <ProjectActivitySection
        activities={projectActivities}
        loading={projectActivityLoading}
        loadingMore={projectActivityLoadingMore}
        error={projectActivityError}
        hasMore={projectActivityCursor !== null}
        currentUserId={currentUserId}
        members={members}
        onRefresh={() => void refreshProjectActivity()}
        onLoadMore={() => void loadMoreProjectActivity()}
      />
    </div>
  );
}

