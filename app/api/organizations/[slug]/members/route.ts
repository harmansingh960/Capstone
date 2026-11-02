import { connection } from "next/server";
import type { MembershipRole } from "@/lib/schema";
import {
  addOrganizationMember,
  getOrganizationBySlug,
  listOrganizationMembers,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  type AddableMembershipRole,
  type OrganizationMember,
  type UserOrganization,
} from "@/lib/tenancy";

type MemberDto = {
  userId: string;
  role: MembershipRole;
  name: string | null;
  email: string | null;
};

const ALLOWED_ADD_MEMBER_FIELDS: ReadonlySet<string> = new Set([
  "email",
  "role",
]);

const DUPLICATE_MEMBERSHIP_MESSAGE =
  "User is already a member of this organization.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toMemberDto(member: OrganizationMember): MemberDto {
  return {
    userId: member.userId,
    role: member.role,
    name: member.name ?? null,
    email: member.email ?? null,
  };
}

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

    const members = await listOrganizationMembers(
      organization._id,
      request.headers,
    );

    return Response.json(
      { members: members.map(toMemberDto) },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof TenantValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof TenantAccessError) {
      if (error.message === "Authentication required.") {
        return Response.json(
          { error: "Authentication required." },
          { status: 401 },
        );
      }
      return Response.json({ error: "Access denied." }, { status: 403 });
    }
    return Response.json(
      { error: "Failed to load organization members." },
      { status: 500 },
    );
  }
}

export async function POST(
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

    if (organization.role !== "admin") {
      return Response.json(
        { error: "Only organization admins can add members." },
        { status: 403 },
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
      if (!ALLOWED_ADD_MEMBER_FIELDS.has(key)) {
        return Response.json(
          {
            error: `Unexpected field "${key}". Only "email" and "role" are allowed.`,
          },
          { status: 400 },
        );
      }
    }

    const member = await addOrganizationMember(
      organization._id,
      {
        email: body.email as string,
        role: body.role as AddableMembershipRole,
      },
      request.headers,
    );

    return Response.json({ member: toMemberDto(member) }, { status: 201 });
  } catch (error) {
    if (error instanceof TenantValidationError) {
      const status =
        error.message === DUPLICATE_MEMBERSHIP_MESSAGE ? 409 : 400;
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
        { error: "Only organization admins can add members." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to add organization member." },
      { status: 500 },
    );
  }
}

