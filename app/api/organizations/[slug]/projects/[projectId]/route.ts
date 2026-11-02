import { connection } from "next/server";
import type { ProjectDoc, ProjectStatus } from "@/lib/schema";
import {
  getOrganizationBySlug,
  parseObjectId,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  updateProject,
  type UpdateProjectInput,
  type UserOrganization,
} from "@/lib/tenancy";

type ProjectDto = {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
};

const ALLOWED_UPDATE_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "status",
]);

const ARCHIVED_PROJECT_MODIFICATION_MESSAGE =
  "Cannot modify name or description of an archived project unless unarchiving it.";

function toProjectDto(project: ProjectDoc): ProjectDto {
  return {
    id: project._id.toHexString(),
    name: project.name,
    description: project.description ?? null,
    status: project.status,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export async function PATCH(
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

    if (organization.role !== "admin" && organization.role !== "manager") {
      return Response.json(
        { error: "Only admins and managers can update projects." },
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
      if (!ALLOWED_UPDATE_FIELDS.has(key)) {
        return Response.json(
          {
            error: `Unexpected field "${key}". Only "name", "description", and "status" are allowed.`,
          },
          { status: 400 },
        );
      }
    }

    const updateInput: UpdateProjectInput = {};
    if ("name" in record) {
      updateInput.name = record.name as string | undefined;
    }
    if ("description" in record) {
      updateInput.description = record.description as string | null | undefined;
    }
    if ("status" in record) {
      updateInput.status = record.status as ProjectStatus | undefined;
    }

    const updatedProject = await updateProject(
      organization._id,
      parsedProjectId,
      updateInput,
      request.headers,
    );

    if (!updatedProject) {
      return Response.json(
        { error: "Project not found." },
        { status: 404 },
      );
    }

    return Response.json(
      { project: toProjectDto(updatedProject) },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof TenantValidationError) {
      const status =
        error.message === ARCHIVED_PROJECT_MODIFICATION_MESSAGE ? 409 : 400;
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
        { error: "Only admins and managers can update projects." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to update project." },
      { status: 500 },
    );
  }
}
