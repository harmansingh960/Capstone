"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import type {
  MembershipRole,
  ProjectStatus,
  ReviewDecision,
  TaskPriority,
  TaskStatus,
} from "@/lib/schema";

export type DeliverableSummary = {
  id: string;
  projectId: string;
  taskId: string;
  submittedBy: string;
  description: string | null;
  url: string | null;
  createdAt: string;
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
  createdAt: string;
  updatedAt: string;
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

type DeliverableItemProps = {
  organizationSlug: string;
  projectId: string;
  taskId: string;
  taskStatus: TaskStatus;
  deliverable: DeliverableSummary;
  isProjectArchived: boolean;
  canManage: boolean;
  currentUserId: string;
  members: MemberOption[];
};

function DeliverableItem({
  organizationSlug,
  projectId,
  taskId,
  taskStatus,
  deliverable,
  isProjectArchived,
  canManage,
  currentUserId,
  members,
}: DeliverableItemProps) {
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(true);
  const [reviewsError, setReviewsError] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;

    async function fetchInitialReviews() {
      try {
        const response = await fetch(reviewsEndpoint, {
          method: "GET",
          cache: "no-store",
        });

        if (!response.ok) {
          const message = await readApiError(
            response,
            "Unable to load reviews.",
          );
          if (!cancelled) {
            setReviewsError(message);
          }
          return;
        }

        const data = (await response.json()) as { reviews?: ReviewSummary[] };
        if (!cancelled) {
          setReviews(Array.isArray(data.reviews) ? data.reviews : []);
          setReviewsError(null);
        }
      } catch {
        if (!cancelled) {
          setReviewsError(
            "Network error while loading reviews. Please try again.",
          );
        }
      } finally {
        if (!cancelled) {
          setReviewsLoading(false);
        }
      }
    }

    void fetchInitialReviews();

    return () => {
      cancelled = true;
    };
  }, [reviewsEndpoint]);

  async function refreshReviews() {
    setReviewsLoading(true);
    setReviewsError(null);
    try {
      const response = await fetch(reviewsEndpoint, {
        method: "GET",
        cache: "no-store",
      });

      if (!response.ok) {
        const message = await readApiError(response, "Unable to load reviews.");
        setReviewsError(message);
        return;
      }

      const data = (await response.json()) as { reviews?: ReviewSummary[] };
      setReviews(Array.isArray(data.reviews) ? data.reviews : []);
    } catch {
      setReviewsError("Network error while loading reviews. Please try again.");
    } finally {
      setReviewsLoading(false);
    }
  }

  async function onSubmitReview(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || isProjectArchived || reviewInFlightRef.current) return;

    const trimmedComment = comment.trim();
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

      setComment("");
      setDecision("approved");
      setReviewSubmitSuccess("Review recorded.");
      await refreshReviews();
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
  const canReview = canManage && !isProjectArchived && !isTaskDone;
  const latestReview = reviews[0] ?? null;
  const inputClassName =
    "rounded border border-zinc-300 bg-white px-2.5 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <li className="flex flex-col gap-2.5 rounded border border-zinc-200 bg-white p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center justify-between gap-2 text-zinc-500">
        <span>
          Submitted by{" "}
          <strong className="font-normal text-zinc-700 dark:text-zinc-300">
            {formatMemberLabel(deliverable.submittedBy, currentUserId, members)}
          </strong>
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {!reviewsLoading &&
            (latestReview ? (
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
              <span className="rounded bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                Awaiting review
              </span>
            ))}
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

      <div className="flex flex-col gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800/80">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-zinc-600 dark:text-zinc-400">
            Review history
          </span>
          {reviewsError && (
            <button
              type="button"
              onClick={() => void refreshReviews()}
              className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Retry
            </button>
          )}
        </div>

        {reviewsError && (
          <p role="alert" className="text-red-600">
            {reviewsError}
          </p>
        )}

        {reviewsLoading ? (
          <p className="text-zinc-500">Loading reviews…</p>
        ) : reviews.length === 0 ? (
          <p className="text-zinc-500">No reviews yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {reviews.map((review, index) => {
              const isApproved = review.decision === "approved";
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
                <span className="text-zinc-500">Comment (optional)</span>
                <input
                  type="text"
                  maxLength={5000}
                  disabled={reviewSubmitting}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Feedback or approval notes…"
                  className={inputClassName}
                />
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
};

function TaskDeliverablesSection({
  organizationSlug,
  projectId,
  task,
  isProjectArchived,
  canManage,
  currentUserId,
  members,
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
        task.approvalRequired
          ? "Deliverable submitted. Task remains open until the latest deliverable is approved and the task is marked Done."
          : "Deliverable submitted. Mark the task as Done when work is complete.",
      );
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
          {deliverables.map((deliverable) => (
            <DeliverableItem
              key={deliverable.id}
              organizationSlug={organizationSlug}
              projectId={projectId}
              taskId={task.id}
              taskStatus={task.status}
              deliverable={deliverable}
              isProjectArchived={isProjectArchived}
              canManage={canManage}
              currentUserId={currentUserId}
              members={members}
            />
          ))}
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
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Submit deliverable
          </span>
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
            {submitting ? "Submitting…" : "Submit deliverable"}
          </button>
        </form>
      )}
    </div>
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

  const tasksApiUrl = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tasks`;

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

  async function refreshTasks(
    nextStatusFilter: StatusFilter,
    nextAssigneeFilter: string,
  ) {
    setListLoading(true);
    setListError(null);

    const params = new URLSearchParams();
    if (nextStatusFilter !== "all") {
      params.set("status", nextStatusFilter);
    }
    if (nextAssigneeFilter === "unassigned") {
      params.set("assigneeId", "null");
    } else if (nextAssigneeFilter !== "all") {
      params.set("assigneeId", nextAssigneeFilter);
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
          const subRes = await fetch(
            `${tasksApiUrl}?parentTaskId=${encodeURIComponent(parentTask.id)}`,
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
    await refreshTasks(nextStatus, assigneeFilter);
  }

  async function onAssigneeFilterChange(nextAssignee: string) {
    setAssigneeFilter(nextAssignee);
    setActionError(null);
    setActionErrorTaskId(null);
    setActionSuccess(null);
    await refreshTasks(statusFilter, nextAssignee);
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
      await refreshTasks(statusFilter, assigneeFilter);
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
      await refreshTasks(statusFilter, assigneeFilter);
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
      await refreshTasks(statusFilter, assigneeFilter);
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
      await refreshTasks(statusFilter, assigneeFilter);
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
          <p className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
            No tasks match the current filter.
          </p>
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
    </div>
  );
}

