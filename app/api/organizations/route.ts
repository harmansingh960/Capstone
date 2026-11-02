import { connection } from "next/server";
import {
  createOrganization,
  listUserOrganizations,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type UserOrganization,
} from "@/lib/tenancy";

type OrganizationDto = {
  id: string;
  name: string;
  slug: string;
  role: UserOrganization["role"];
};

const ALLOWED_CREATE_FIELDS: ReadonlySet<string> = new Set(["name", "slug"]);
const DUPLICATE_SLUG_MESSAGE = "Organization slug is already taken.";

function toOrganizationDto(org: UserOrganization): OrganizationDto {
  return {
    id: org._id.toHexString(),
    name: org.name,
    slug: org.slug,
    role: org.role,
  };
}

export async function GET(request: Request) {
  await connection();
  try {
    const organizations = await listUserOrganizations(request.headers);
    return Response.json(
      { organizations: organizations.map(toOrganizationDto) },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }
    return Response.json(
      { error: "Failed to load organizations." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

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
      if (!ALLOWED_CREATE_FIELDS.has(key)) {
        return Response.json(
          { error: `Unexpected field "${key}". Only "name" and optional "slug" are allowed.` },
          { status: 400 },
        );
      }
    }

    if (typeof record.name !== "string") {
      return Response.json(
        { error: "Organization name is required and must be a string." },
        { status: 400 },
      );
    }

    if (
      record.slug !== undefined &&
      record.slug !== null &&
      typeof record.slug !== "string"
    ) {
      return Response.json(
        { error: "Organization slug must be a string when provided." },
        { status: 400 },
      );
    }

    const organization = await createOrganization(
      {
        name: record.name,
        slug: (record.slug as string | null | undefined) ?? undefined,
      },
      request.headers,
    );

    return Response.json(
      { organization: toOrganizationDto(organization) },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof TenantValidationError) {
      const status = error.message === DUPLICATE_SLUG_MESSAGE ? 409 : 400;
      return Response.json({ error: error.message }, { status });
    }
    if (error instanceof TenantAccessError) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }
    return Response.json(
      { error: "Failed to create organization." },
      { status: 500 },
    );
  }
}

