import { connection } from "next/server";
import {
  dismissBlocker,
  getOrganizationBySlug,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

const CONFLICT_MESSAGES: ReadonlySet<string> = new Set([
  "Blocker is already dismissed.",
  "Cannot dismiss an already resolved blocker.",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

async function handleDismiss(
  request: Request,
  params: Promise<{ slug: string; projectId: string; blockerId: string }>,
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
        { error: "Only admins and managers can dismiss blockers." },
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

    let resolutionNote: string | undefined;
    const rawText = await request.text();
    if (rawText.trim() !== "") {
      let body: unknown;
      try {
        body = JSON.parse(rawText);
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
      if (typeof body.resolutionNote === "string") {
        resolutionNote = body.resolutionNote;
      }
    }

    const updated = await dismissBlocker(
      organization._id,
      parsedProjectId,
      parsedBlockerId,
      resolutionNote,
      request.headers,
    );

    return Response.json(updated);
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
      { error: "Failed to dismiss blocker." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  context: {
    params: Promise<{ slug: string; projectId: string; blockerId: string }>;
  },
) {
  return handleDismiss(request, context.params);
}

export async function PATCH(
  request: Request,
  context: {
    params: Promise<{ slug: string; projectId: string; blockerId: string }>;
  },
) {
  return handleDismiss(request, context.params);
}

