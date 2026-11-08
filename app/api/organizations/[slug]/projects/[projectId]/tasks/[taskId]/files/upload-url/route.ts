import { connection } from "next/server";
import { z } from "zod";
import { enforceRateLimit, RATE_LIMIT_PROFILES } from "@/lib/rate-limit";
import {
  getOrganizationBySlug,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";
import {
  authorizeFileUpload,
  StorageConfigurationError,
} from "@/lib/files";

const uploadUrlSchema = z
  .object({
    filename: z.string().trim().min(1, "Filename cannot be empty."),
    mimeType: z.string().trim().min(1, "MIME type cannot be empty."),
    fileSize: z.number().int().positive("File size must be a positive integer."),
  })
  .strict();

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

const TASK_NOT_FOUND_MESSAGES: ReadonlySet<string> = new Set([
  "Referenced task does not belong to this organization.",
  "Referenced task does not belong to the specified project.",
]);

const LIFECYCLE_CONFLICT_MESSAGES: ReadonlySet<string> = new Set([
  "Cannot upload files to an archived project.",
  "Cannot upload files to a completed task. Reopen the task first.",
]);

export async function POST(
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
      "files_upload_url",
      RATE_LIMIT_PROFILES.mutation,
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Invalid JSON request body." },
        { status: 400 },
      );
    }

    const parseResult = uploadUrlSchema.safeParse(body);
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0];
      return Response.json(
        { error: firstIssue?.message || "Invalid request payload." },
        { status: 400 },
      );
    }

    const { filename, mimeType, fileSize } = parseResult.data;

    const result = await authorizeFileUpload(
      organization._id,
      parsedProjectId,
      parsedTaskId,
      {
        filename,
        mimeType,
        fileSize,
      },
      request.headers,
    );

    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof StorageConfigurationError) {
      return Response.json(
        {
          error:
            "File storage service is not configured or unavailable. Uploads are temporarily disabled.",
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
      { error: "Failed to generate upload URL." },
      { status: 500 },
    );
  }
}

