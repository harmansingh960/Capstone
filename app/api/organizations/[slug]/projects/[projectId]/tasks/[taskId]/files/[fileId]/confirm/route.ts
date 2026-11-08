import { connection } from "next/server";
import { enforceRateLimit, RATE_LIMIT_PROFILES } from "@/lib/rate-limit";
import {
  getOrganizationBySlug,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";
import { confirmFileUpload, StorageConfigurationError } from "@/lib/files";

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

const TASK_NOT_FOUND_MESSAGES: ReadonlySet<string> = new Set([
  "Referenced task does not belong to this organization.",
  "Referenced task does not belong to the specified project.",
]);

const FILE_NOT_FOUND_MESSAGES: ReadonlySet<string> = new Set([
  "File record not found.",
  "File not found.",
]);

export async function POST(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      slug: string;
      projectId: string;
      taskId: string;
      fileId: string;
    }>;
  },
) {
  await connection();
  try {
    const userId = await requireSessionUserId(request.headers);
    const rateLimitError = await enforceRateLimit(
      request,
      "files_confirm",
      RATE_LIMIT_PROFILES.mutation,
      userId,
    );
    if (rateLimitError) {
      return rateLimitError;
    }

    const { slug, projectId, taskId, fileId } = await params;
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

    const parsedFileId = parseObjectId(fileId);
    if (!parsedFileId) {
      return Response.json(
        { error: "Invalid file ID." },
        { status: 400 },
      );
    }

    const file = await confirmFileUpload(
      organization._id,
      parsedProjectId,
      parsedTaskId,
      parsedFileId,
      request.headers,
    );

    return Response.json({ file }, { status: 200 });
  } catch (error) {
    if (error instanceof StorageConfigurationError) {
      return Response.json(
        {
          error:
            "File storage service is not configured or unavailable.",
        },
        { status: 503 },
      );
    }
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
      if (FILE_NOT_FOUND_MESSAGES.has(error.message)) {
        return Response.json(
          { error: "File not found." },
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
      { error: "Failed to confirm file upload." },
      { status: 500 },
    );
  }
}

