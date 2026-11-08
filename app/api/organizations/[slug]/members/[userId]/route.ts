import { connection } from "next/server";
import type { MembershipRole } from "@/lib/schema";
import {
  getOrganizationBySlug,
  isElevatedMembershipRole,
  isPlatformAdmin,
  removeOrganizationMember,
  requireSessionUserId,
  TenantAccessError,
  TenantValidationError,
  updateOrganizationMemberRole,
  type OrganizationMember,
  type UserOrganization,
} from "@/lib/tenancy";

type MemberDto = {
  userId: string;
  role: MembershipRole;
  name: string | null;
  email: string | null;
};

const ALLOWED_UPDATE_ROLE_FIELDS: ReadonlySet<string> = new Set(["role"]);

const LAST_ADMIN_PROTECTION_MESSAGE =
  "Cannot remove or demote the last admin of the organization.";

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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; userId: string }> },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, userId } = await params;
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
        { error: "Only organization admins can update member roles." },
        { status: 403 },
      );
    }

    const trimmedUserId = typeof userId === "string" ? userId.trim() : "";
    if (trimmedUserId.length === 0 || trimmedUserId.length > 128) {
      return Response.json(
        { error: "Invalid user ID." },
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

    const keys = Object.keys(body);
    if (keys.length === 0) {
      return Response.json(
        { error: "Member role is required." },
        { status: 400 },
      );
    }

    for (const key of keys) {
      if (!ALLOWED_UPDATE_ROLE_FIELDS.has(key)) {
        return Response.json(
          {
            error: `Unexpected field "${key}". Only "role" is allowed.`,
          },
          { status: 400 },
        );
      }
    }

    const requestedRole = (body as Record<string, unknown>).role;
    if (isElevatedMembershipRole(requestedRole)) {
      const isPlatform = await isPlatformAdmin(request.headers);
      if (!isPlatform) {
        return Response.json(
          {
            error:
              "Only the platform administrator can grant manager or admin roles.",
          },
          { status: 403 },
        );
      }
    }

    const updatedMember = await updateOrganizationMemberRole(
      organization._id,
      {
        userId: trimmedUserId,
        role: body.role as MembershipRole,
      },
      request.headers,
    );

    if (!updatedMember) {
      return Response.json(
        { error: "Member not found." },
        { status: 404 },
      );
    }

    return Response.json(
      { member: toMemberDto(updatedMember) },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof TenantValidationError) {
      const status =
        error.message === LAST_ADMIN_PROTECTION_MESSAGE ? 409 : 400;
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
        {
          error:
            error.message ||
            "Only organization admins can update member roles.",
        },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to update organization member role." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string; userId: string }> },
) {
  await connection();
  try {
    await requireSessionUserId(request.headers);

    const { slug, userId } = await params;
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
        { error: "Only organization admins can remove members." },
        { status: 403 },
      );
    }

    const trimmedUserId = typeof userId === "string" ? userId.trim() : "";
    if (trimmedUserId.length === 0 || trimmedUserId.length > 128) {
      return Response.json(
        { error: "Invalid user ID." },
        { status: 400 },
      );
    }

    const removedMembership = await removeOrganizationMember(
      organization._id,
      trimmedUserId,
      request.headers,
    );

    if (!removedMembership) {
      return Response.json(
        { error: "Member not found." },
        { status: 404 },
      );
    }

    return Response.json(
      { removed: true, userId: removedMembership.userId },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof TenantValidationError) {
      const status =
        error.message === LAST_ADMIN_PROTECTION_MESSAGE ? 409 : 400;
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
        { error: "Only organization admins can remove members." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Failed to remove organization member." },
      { status: 500 },
    );
  }
}

