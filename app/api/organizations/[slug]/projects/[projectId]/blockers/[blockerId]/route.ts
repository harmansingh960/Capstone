import { connection } from "next/server";
import {
  dismissBlocker,
  getBlockerById,
  getOrganizationBySlug,
  parseObjectId,
  requireSessionUserId,
  resolveBlocker,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

const CONFLICT_MESSAGES: ReadonlySet<string> = new Set([
  "Blocker is already resolved.",
  "Blocker is already dismissed.",
  "Cannot resolve a dismissed blocker. Reopen or create a new blocker.",
  "Cannot dismiss an already resolved blocker.",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ slug: string; projectId: string; blockerId: string }>;
  },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, projectId, blockerId } = await params;
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
      return Response.json({ error: "Invalid project ID." }, { status: 400 });
    }

    const parsedBlockerId = parseObjectId(blockerId);
    if (!parsedBlockerId) {
      return Response.json({ error: "Invalid blocker ID." }, { status: 400 });
    }

    const blocker = await getBlockerById(
      organization._id,
      parsedProjectId,
      parsedBlockerId,
      request.headers,
    );

    return Response.json(blocker);
  } catch (error) {
    if (error instanceof TenantValidationError) {
      if (error.message === PROJECT_NOT_IN_ORG_MESSAGE) {
        return Response.json({ error: "Project not found." }, { status: 404 });
      }
      if (
        error.message ===
        "Referenced blocker does not belong to this organization or project."
      ) {
        return Response.json({ error: "Blocker not found." }, { status: 404 });
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
      { error: "Failed to retrieve blocker." },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ slug: string; projectId: string; blockerId: string }>;
  },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, projectId, blockerId } = await params;
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
        { error: "Only admins and managers can resolve or dismiss blockers." },
        { status: 403 },
      );
    }

    const parsedProjectId = parseObjectId(projectId);
    if (!parsedProjectId) {
      return Response.json({ error: "Invalid project ID." }, { status: 400 });
    }

    const parsedBlockerId = parseObjectId(blockerId);
    if (!parsedBlockerId) {
      return Response.json({ error: "Invalid blocker ID." }, { status: 400 });
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

    const status = body.status ?? body.action;
    const resolutionNote =
      typeof body.resolutionNote === "string"
        ? body.resolutionNote
        : undefined;

    if (status === "resolved" || status === "resolve") {
      const updated = await resolveBlocker(
        organization._id,
        parsedProjectId,
        parsedBlockerId,
        resolutionNote,
        request.headers,
      );
      return Response.json(updated);
    }

    if (status === "dismissed" || status === "dismiss") {
      const updated = await dismissBlocker(
        organization._id,
        parsedProjectId,
        parsedBlockerId,
        resolutionNote,
        request.headers,
      );
      return Response.json(updated);
    }

    return Response.json(
      {
        error:
          "Invalid status transition. Status or action must be 'resolved' or 'dismissed'.",
      },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof TenantValidationError) {
      if (error.message === PROJECT_NOT_IN_ORG_MESSAGE) {
        return Response.json({ error: "Project not found." }, { status: 404 });
      }
      if (
        error.message ===
        "Referenced blocker does not belong to this organization or project."
      ) {
        return Response.json({ error: "Blocker not found." }, { status: 404 });
      }
      const statusCode = CONFLICT_MESSAGES.has(error.message) ? 409 : 400;
      return Response.json({ error: error.message }, { status: statusCode });
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
      { error: "Failed to update blocker status." },
      { status: 500 },
    );
  }
}

