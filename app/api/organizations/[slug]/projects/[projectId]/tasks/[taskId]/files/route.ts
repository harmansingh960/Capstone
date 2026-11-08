import { connection } from "next/server";
import { FILE_STATUSES, type FileStatus } from "@/lib/schema";
import { enforceRateLimit, RATE_LIMIT_PROFILES } from "@/lib/rate-limit";
import {
  getOrganizationBySlug,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";
import { listTaskFiles } from "@/lib/files";

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

const TASK_NOT_FOUND_MESSAGES: ReadonlySet<string> = new Set([
  "Referenced task does not belong to this organization.",
  "Referenced task does not belong to the specified project.",
]);

const VALID_FILE_STATUSES: ReadonlySet<string> = new Set(FILE_STATUSES);

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
    const userId = await requireSessionUserId(request.headers);
    const rateLimitError = await enforceRateLimit(
      request,
      "files_list",
      RATE_LIMIT_PROFILES.api,
      userId,
    );
    if (rateLimitError) {
      return rateLimitError;
    }

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

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    if (statusParam && !VALID_FILE_STATUSES.has(statusParam)) {
      return Response.json(
        {
          error: `Invalid status parameter. Must be one of: ${FILE_STATUSES.join(", ")}.`,
        },
        { status: 400 },
      );
    }

    const files = await listTaskFiles(
      organization._id,
      parsedProjectId,
      parsedTaskId,
      statusParam ? { status: statusParam as FileStatus } : undefined,
      request.headers,
    );

    return Response.json({ files }, { status: 200 });
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
      { error: "Failed to load files." },
      { status: 500 },
    );
  }
}

