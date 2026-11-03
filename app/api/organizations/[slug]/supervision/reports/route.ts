import { connection } from "next/server";
import {
  getOrganizationBySlug,
  getSupervisionReports,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";

const PROJECT_NOT_IN_ORG_MESSAGE =
  "Referenced project does not belong to this organization.";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug } = await params;
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

    const { searchParams } = new URL(request.url);

    const report = await getSupervisionReports(
      organization._id,
      {
        projectId: searchParams.has("projectId")
          ? searchParams.get("projectId")
          : undefined,
        memberId: searchParams.has("memberId")
          ? searchParams.get("memberId")
          : searchParams.has("assigneeId")
            ? searchParams.get("assigneeId")
            : undefined,
        dateFrom: searchParams.has("dateFrom")
          ? searchParams.get("dateFrom")
          : searchParams.has("startDate")
            ? searchParams.get("startDate")
            : searchParams.has("from")
              ? searchParams.get("from")
              : undefined,
        dateTo: searchParams.has("dateTo")
          ? searchParams.get("dateTo")
          : searchParams.has("endDate")
            ? searchParams.get("endDate")
            : searchParams.has("to")
              ? searchParams.get("to")
              : undefined,
        status: searchParams.has("status")
          ? searchParams.get("status")
          : undefined,
        priority: searchParams.has("priority")
          ? searchParams.get("priority")
          : undefined,
        projectStatus: searchParams.has("projectStatus")
          ? searchParams.get("projectStatus")
          : undefined,
        staleThresholdDays: searchParams.has("staleThresholdDays")
          ? searchParams.get("staleThresholdDays")
          : searchParams.has("staleDays")
            ? searchParams.get("staleDays")
            : undefined,
      },
      request.headers,
    );

    return Response.json(
      {
        organization: {
          id: organization._id.toHexString(),
          name: organization.name,
          slug: organization.slug,
          role: organization.role,
        },
        ...report,
      },
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
      { error: "Failed to load supervision reports." },
      { status: 500 },
    );
  }
}

