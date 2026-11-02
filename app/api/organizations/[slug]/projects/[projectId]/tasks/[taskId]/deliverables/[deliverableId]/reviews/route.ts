import { connection } from "next/server";
import type { ReviewDecision, ReviewDoc } from "@/lib/schema";
import {
  createReview,
  getOrganizationBySlug,
  listDeliverableReviews,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";

type ReviewDto = {
  id: string;
  projectId: string;
  taskId: string;
  deliverableId: string;
  reviewerId: string;
  decision: ReviewDecision;
  comment: string | null;
  createdAt: string;
};

const ALLOWED_CREATE_FIELDS: ReadonlySet<string> = new Set([
  "decision",
  "comment",
]);

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

const TASK_NOT_FOUND_MESSAGES: ReadonlySet<string> = new Set([
  "Referenced task does not belong to this organization.",
  "Referenced task does not belong to the specified project.",
]);

const DELIVERABLE_NOT_FOUND_MESSAGES: ReadonlySet<string> = new Set([
  "Referenced deliverable does not belong to this organization.",
  "Referenced deliverable does not belong to the specified project and task.",
]);

const LIFECYCLE_CONFLICT_MESSAGES: ReadonlySet<string> = new Set([
  "Cannot review deliverables in an archived project.",
  "Cannot review deliverables for a completed task. Reopen the task first.",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toReviewDto(review: ReviewDoc): ReviewDto {
  return {
    id: review._id.toHexString(),
    projectId: review.projectId.toHexString(),
    taskId: review.taskId.toHexString(),
    deliverableId: review.deliverableId.toHexString(),
    reviewerId: review.reviewerId,
    decision: review.decision,
    comment: review.comment ?? null,
    createdAt: review.createdAt.toISOString(),
  };
}

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      slug: string;
      projectId: string;
      taskId: string;
      deliverableId: string;
    }>;
  },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, projectId, taskId, deliverableId } = await params;
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

    const parsedDeliverableId = parseObjectId(deliverableId);
    if (!parsedDeliverableId) {
      return Response.json(
        { error: "Invalid deliverable ID." },
        { status: 400 },
      );
    }

    const reviews = await listDeliverableReviews(
      organization._id,
      parsedProjectId,
      parsedTaskId,
      parsedDeliverableId,
      request.headers,
    );

    return Response.json(
      { reviews: reviews.map(toReviewDto) },
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
      if (TASK_NOT_FOUND_MESSAGES.has(error.message)) {
        return Response.json(
          { error: "Task not found." },
          { status: 404 },
        );
      }
      if (DELIVERABLE_NOT_FOUND_MESSAGES.has(error.message)) {
        return Response.json(
          { error: "Deliverable not found." },
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
      { error: "Failed to load reviews." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      slug: string;
      projectId: string;
      taskId: string;
      deliverableId: string;
    }>;
  },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, projectId, taskId, deliverableId } = await params;
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

    if (organization.role !== "admin" && organization.role !== "manager") {
      return Response.json(
        { error: "Only admins and managers can review deliverables." },
        { status: 403 },
      );
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

    const parsedDeliverableId = parseObjectId(deliverableId);
    if (!parsedDeliverableId) {
      return Response.json(
        { error: "Invalid deliverable ID." },
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
      if (!ALLOWED_CREATE_FIELDS.has(key)) {
        return Response.json(
          {
            error: `Unexpected field "${key}". Only "decision" and optional "comment" are allowed.`,
          },
          { status: 400 },
        );
      }
    }

    const review = await createReview(
      organization._id,
      {
        projectId: parsedProjectId,
        taskId: parsedTaskId,
        deliverableId: parsedDeliverableId,
        decision: body.decision as ReviewDecision,
        comment: body.comment as string | null | undefined,
      },
      request.headers,
    );

    return Response.json(
      { review: toReviewDto(review) },
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
      if (TASK_NOT_FOUND_MESSAGES.has(error.message)) {
        return Response.json(
          { error: "Task not found." },
          { status: 404 },
        );
      }
      if (DELIVERABLE_NOT_FOUND_MESSAGES.has(error.message)) {
        return Response.json(
          { error: "Deliverable not found." },
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
      return Response.json(
        { error: "Only admins and managers can review deliverables." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to create review." },
      { status: 500 },
    );
  }
}

