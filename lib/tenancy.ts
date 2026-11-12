import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { ObjectId, type ClientSession } from "mongodb";
import { getAuth } from "@/lib/auth";
import { getCollections } from "@/lib/collections";
import { getDb, getMongoClient } from "@/lib/db";
import { createNotificationSafe } from "@/lib/notifications";
import {
  ACTION_ITEM_STATUSES,
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_TARGET_TYPES,
  BLOCKER_STATUSES,
  BLOCKER_TYPES,
  MEETING_STATUSES,
  MEMBERSHIP_ROLES,
  PROJECT_STATUSES,
  REVIEW_DECISIONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  PLATFORM_ROLES,
  type PlatformRole,
  type ActionItemStatus,
  type ActivityDoc,
  type ActivityEventType,
  type ActivityFieldChange,
  type ActivityFieldValue,
  type ActivityTargetType,
  type BlockerDoc,
  type BlockerStatus,
  type BlockerType,
  type DeliverableDoc,
  type FileDoc,
  type MeetingActionItemDoc,
  type MeetingDecisionDoc,
  type MeetingDiscussionPointDoc,
  type MeetingDoc,
  type MeetingStatus,
  type MembershipDoc,
  type MembershipRole,
  type OrganizationDoc,
  type ProjectDoc,
  type ProjectStatus,
  type ReviewDecision,
  type ReviewDoc,
  TASK_DELIVERABLE_STATUSES,
  type TaskDeliverableStatus,
  type TaskDependencyDoc,
  type TaskDoc,
  type TaskPriority,
  type TaskStatus,
  type UserDoc,
  type UserId,
} from "@/lib/schema";

export {
  ACTION_ITEM_STATUSES,
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_TARGET_TYPES,
  BLOCKER_STATUSES,
  BLOCKER_TYPES,
  MEETING_STATUSES,
  PLATFORM_ROLES,
  TASK_DELIVERABLE_STATUSES,
  type ActionItemStatus,
  type ActivityDoc,
  type ActivityEventType,
  type ActivityFieldChange,
  type ActivityFieldValue,
  type ActivityTargetType,
  type BlockerDoc,
  type BlockerStatus,
  type BlockerType,
  type MeetingActionItemDoc,
  type MeetingDecisionDoc,
  type MeetingDiscussionPointDoc,
  type MeetingDoc,
  type MeetingStatus,
  type PlatformRole,
  type TaskDeliverableStatus,
};

// Tenant boundary rules enforced by this module:
//   1. The acting user ID is always derived on the server from the Better Auth
//      session (`requireSessionUserId`) — never trusted from client input.
//   2. `requireMembership()` verifies that the authenticated session user belongs
//      to the target organization (and holds an allowed role, if specified).
//   3. Project and task data-access functions always scope queries and writes by
//      `organizationId: membership.organizationId` and validate cross-document
//      references (project, parent task, assignee) within that organization.

export class TenantAccessError extends Error {
  constructor(message = "Not a member of this organization, or insufficient role.") {
    super(message);
    this.name = "TenantAccessError";
  }
}

export class TenantValidationError extends TenantAccessError {
  constructor(message: string) {
    super(message);
    this.name = "TenantValidationError";
  }
}

/** Strictly parses a 24-char hex id from untrusted input (e.g. route params). */
export function parseObjectId(value: string): ObjectId | null {
  return /^[a-f0-9]{24}$/i.test(value) ? new ObjectId(value) : null;
}

/**
 * Normalizes optional project/task descriptions to match the schema policy:
 * stored documents always carry `description: string | null`, and omitted,
 * `null`, or whitespace-only inputs are stored as `null`.
 */
export function normalizeDescription(description?: string | null): string | null {
  if (description === undefined || description === null) {
    return null;
  }
  if (typeof description !== "string") {
    throw new TenantValidationError("Description must be a string or null.");
  }
  return description.trim() === "" ? null : description;
}

function requireObjectId(value: unknown, fieldName: string): ObjectId {
  if (!(value instanceof ObjectId)) {
    throw new TenantValidationError(
      `Invalid ${fieldName}: expected a MongoDB ObjectId.`,
    );
  }
  return value;
}

function validateNullableObjectId(
  value: unknown,
  fieldName: string,
): ObjectId | null {
  if (value === null) {
    return null;
  }
  return requireObjectId(value, fieldName);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const USER_ID_MIN_LENGTH = 1;
const USER_ID_MAX_LENGTH = 128;

function normalizeUserIdValue(value: unknown): UserId | null {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed.length >= USER_ID_MIN_LENGTH &&
      trimmed.length <= USER_ID_MAX_LENGTH
    ) {
      return trimmed;
    }
  }
  return null;
}

function buildUserIdFilter(
  userId: UserId,
): UserId | { $in: Array<UserId | ObjectId> } {
  const parsed = parseObjectId(userId);
  return parsed ? { $in: [userId, parsed] } : userId;
}

function validateAssigneeId(assigneeId: unknown): UserId | null {
  if (assigneeId === null) {
    return null;
  }
  if (assigneeId instanceof ObjectId) {
    return assigneeId.toHexString();
  }
  if (typeof assigneeId !== "string") {
    throw new TenantValidationError(
      "Invalid assigneeId: expected a non-empty string or null.",
    );
  }
  const trimmed = assigneeId.trim();
  if (
    trimmed.length < USER_ID_MIN_LENGTH ||
    trimmed.length > USER_ID_MAX_LENGTH
  ) {
    throw new TenantValidationError(
      `Invalid assigneeId: must be a non-empty string of at most ${USER_ID_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/**
 * Resolves the signed-in user's ID from the server-side Better Auth session.
 * Never accepts a client-supplied user ID.
 */
export async function requireSessionUserId(requestHeaders?: Headers): Promise<UserId> {
  const resolvedHeaders = requestHeaders ?? (await headers());
  const session = await getAuth().api.getSession({ headers: resolvedHeaders });
  const userId = normalizeUserIdValue(session?.user?.id);
  if (!userId) {
    throw new TenantAccessError("Authentication required.");
  }
  return userId;
}

const BETTER_AUTH_USER_COLLECTION = "user";

/**
 * Resolves whether the current session user holds the global "platform_admin" role.
 * Returns false if unauthenticated or if the user is not a platform admin.
 * Fallback to direct database lookup ensures newly bootstrapped platform admins
 * take effect immediately even if their current session cookies lack the updated token state.
 */
export async function isPlatformAdmin(requestHeaders?: Headers): Promise<boolean> {
  const resolvedHeaders = requestHeaders ?? (await headers());
  const session = await getAuth().api.getSession({ headers: resolvedHeaders });
  if (!session?.user?.id) {
    return false;
  }
  const user = session.user as { platformRole?: string | null } | undefined;
  if (user?.platformRole === "platform_admin") {
    return true;
  }

  const parsedId = parseObjectId(session.user.id);
  const idMatchers: Array<ObjectId | string> = [session.user.id];
  if (parsedId) {
    idMatchers.push(parsedId);
  }

  const db = await getDb();
  const userDoc = await db
    .collection<UserDoc>(BETTER_AUTH_USER_COLLECTION)
    .findOne(
      { _id: { $in: idMatchers } },
      { projection: { platformRole: 1 } },
    );

  return userDoc?.platformRole === "platform_admin";
}

/**
 * Asserts that the authenticated session user is the global platform admin.
 * Throws TenantAccessError if unauthenticated ("Authentication required.")
 * or if the user is not a platform admin ("Only the platform administrator can create organizations.").
 */
export async function requirePlatformAdmin(
  requestHeaders?: Headers,
  customForbiddenMessage = "Only the platform administrator can create organizations.",
): Promise<UserId> {
  const resolvedHeaders = requestHeaders ?? (await headers());
  const session = await getAuth().api.getSession({ headers: resolvedHeaders });
  const userId = session?.user?.id;
  if (!userId) {
    throw new TenantAccessError("Authentication required.");
  }

  const isAdmin = await isPlatformAdmin(resolvedHeaders);
  if (!isAdmin) {
    throw new TenantAccessError(customForbiddenMessage);
  }

  return userId;
}

/**
 * Returns the authenticated session user's membership in `organizationId`, or
 * throws `TenantAccessError` if unauthenticated, not a member, or lacking one
 * of `allowedRoles`.
 */
export async function requireMembership(
  organizationId: ObjectId,
  allowedRoles?: readonly MembershipRole[],
  requestHeaders?: Headers,
): Promise<MembershipDoc> {
  const userId = await requireSessionUserId(requestHeaders);
  requireObjectId(organizationId, "organizationId");
  const { memberships } = await getCollections();
  const membership = await memberships.findOne({
    organizationId,
    userId: buildUserIdFilter(userId) as unknown as UserId,
  });
  if (!membership || (allowedRoles && !allowedRoles.includes(membership.role))) {
    throw new TenantAccessError();
  }
  return {
    ...membership,
    userId: normalizeUserIdValue(membership.userId) ?? userId,
  };
}

export const ADMIN_ROLES: readonly MembershipRole[] = ["admin"];
export const MANAGER_ROLES: readonly MembershipRole[] = ["admin", "manager"];

export function isManagerRole(role: MembershipRole): boolean {
  return MANAGER_ROLES.includes(role);
}

function sameNullableObjectId(a: ObjectId | null, b: ObjectId | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a instanceof ObjectId && b instanceof ObjectId && a.equals(b);
}

// ---------------------------------------------------------------------------
// Cross-document tenant validators (require verified membership)
// ---------------------------------------------------------------------------

/** Verifies that `projectId` exists and belongs to `membership.organizationId`. */
export async function requireProjectInOrg(
  membership: MembershipDoc,
  projectId: ObjectId,
): Promise<ProjectDoc> {
  requireObjectId(projectId, "projectId");
  const { projects } = await getCollections();
  const project = await projects.findOne({
    _id: projectId,
    organizationId: membership.organizationId,
  });
  if (!project) {
    throw new TenantValidationError("Referenced project does not belong to this organization.");
  }
  return project;
}

/**
 * Verifies that `parentTaskId` exists in `membership.organizationId`, belongs
 * to `projectId`, and is a top-level task (`parentTaskId === null`).
 */
async function requireTopLevelParentTaskInProject(
  membership: MembershipDoc,
  projectId: ObjectId,
  parentTaskId: ObjectId,
): Promise<TaskDoc> {
  requireObjectId(projectId, "projectId");
  requireObjectId(parentTaskId, "parentTaskId");
  const { tasks } = await getCollections();
  const parentTask = await tasks.findOne({
    _id: parentTaskId,
    organizationId: membership.organizationId,
  });
  if (!parentTask) {
    throw new TenantValidationError("Parent task does not belong to this organization.");
  }
  if (!parentTask.projectId.equals(projectId)) {
    throw new TenantValidationError("Subtask parent must belong to the same project.");
  }
  if (parentTask.parentTaskId !== null) {
    throw new TenantValidationError("Subtasks must have a top-level parent task.");
  }
  return normalizeTaskDoc(parentTask);
}

/** Verifies that `assigneeId` is a member of `membership.organizationId`. */
async function requireAssigneeInOrg(
  membership: MembershipDoc,
  assigneeId: UserId,
): Promise<MembershipDoc> {
  const validatedAssigneeId = validateAssigneeId(assigneeId);
  if (validatedAssigneeId === null) {
    throw new TenantValidationError(
      "Invalid assigneeId: expected a non-empty string.",
    );
  }
  const { memberships } = await getCollections();
  const assigneeMembership = await memberships.findOne({
    organizationId: membership.organizationId,
    userId: buildUserIdFilter(validatedAssigneeId) as unknown as UserId,
  });
  if (!assigneeMembership) {
    throw new TenantValidationError("Assignee is not a member of this organization.");
  }
  return {
    ...assigneeMembership,
    userId: normalizeUserIdValue(assigneeMembership.userId) ?? validatedAssigneeId,
  };
}

/**
 * Verifies that `taskId` exists in `membership.organizationId` and belongs
 * to `projectId`.
 */
export async function requireTaskInProjectAndOrg(
  membership: MembershipDoc,
  projectId: ObjectId,
  taskId: ObjectId,
): Promise<TaskDoc> {
  requireObjectId(projectId, "projectId");
  requireObjectId(taskId, "taskId");
  const { tasks } = await getCollections();
  const task = await tasks.findOne({
    _id: taskId,
    organizationId: membership.organizationId,
  });
  if (!task) {
    throw new TenantValidationError("Referenced task does not belong to this organization.");
  }
  if (!task.projectId.equals(projectId)) {
    throw new TenantValidationError("Referenced task does not belong to the specified project.");
  }
  return normalizeTaskDoc(task);
}

/**
 * Verifies that `deliverableId` exists in `membership.organizationId` and
 * belongs to both `projectId` and `taskId`.
 */
async function requireDeliverableInTaskAndOrg(
  membership: MembershipDoc,
  projectId: ObjectId,
  taskId: ObjectId,
  deliverableId: ObjectId,
): Promise<DeliverableDoc> {
  requireObjectId(projectId, "projectId");
  requireObjectId(taskId, "taskId");
  requireObjectId(deliverableId, "deliverableId");
  const { deliverables } = await getCollections();
  const deliverable = await deliverables.findOne({
    _id: deliverableId,
    organizationId: membership.organizationId,
  });
  if (!deliverable) {
    throw new TenantValidationError(
      "Referenced deliverable does not belong to this organization.",
    );
  }
  if (
    !deliverable.projectId.equals(projectId) ||
    !deliverable.taskId.equals(taskId)
  ) {
    throw new TenantValidationError(
      "Referenced deliverable does not belong to the specified project and task.",
    );
  }
  return deliverable;
}

// ---------------------------------------------------------------------------
// Organization & membership bootstrap data access
// ---------------------------------------------------------------------------

const ORG_NAME_MIN_LENGTH = 1;
const ORG_NAME_MAX_LENGTH = 120;
const ORG_SLUG_MIN_LENGTH = 2;
const ORG_SLUG_MAX_LENGTH = 50;
const ORG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RESERVED_ORGANIZATION_SLUGS: ReadonlySet<string> = new Set([
  "login",
  "signup",
  "dashboard",
  "api",
  "settings",
  "admin",
  "new",
  "auth",
  "logout",
  "health",
]);

function validateOrganizationSlug(slug: string): string {
  if (typeof slug !== "string") {
    throw new TenantValidationError("Organization slug must be a string.");
  }
  const normalized = slug.trim();
  if (
    normalized.length < ORG_SLUG_MIN_LENGTH ||
    normalized.length > ORG_SLUG_MAX_LENGTH ||
    !ORG_SLUG_PATTERN.test(normalized)
  ) {
    throw new TenantValidationError(
      "Organization slug must be 2–50 lowercase alphanumeric characters separated by single hyphens.",
    );
  }
  if (RESERVED_ORGANIZATION_SLUGS.has(normalized)) {
    throw new TenantValidationError(`Organization slug "${normalized}" is reserved.`);
  }
  return normalized;
}

/**
 * Normalizes an organization name into a URL-safe slug and validates it
 * against the schema length/pattern rules and reserved application routes.
 */
export function slugifyOrganizationName(name: string): string {
  if (typeof name !== "string") {
    throw new TenantValidationError("Organization name must be a string.");
  }
  const candidate = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return validateOrganizationSlug(candidate);
}

export type CreateOrganizationInput = {
  name: string;
  slug?: string | null;
};

export type UserOrganization = OrganizationDoc & {
  role: MembershipRole;
};

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * Creates a new organization owned by the authenticated platform admin and
 * inserts their initial `"admin"` membership. Cleans up the organization
 * document if the membership insert fails. Restricted strictly to the platform admin.
 */
export async function createOrganization(
  input: CreateOrganizationInput,
  requestHeaders?: Headers,
): Promise<UserOrganization> {
  const userId = await requirePlatformAdmin(requestHeaders);

  if (typeof input.name !== "string") {
    throw new TenantValidationError("Organization name is required.");
  }
  const trimmedName = input.name.trim();
  if (
    trimmedName.length < ORG_NAME_MIN_LENGTH ||
    trimmedName.length > ORG_NAME_MAX_LENGTH
  ) {
    throw new TenantValidationError(
      `Organization name must be between ${ORG_NAME_MIN_LENGTH} and ${ORG_NAME_MAX_LENGTH} characters.`,
    );
  }

  if (input.slug !== undefined && input.slug !== null && typeof input.slug !== "string") {
    throw new TenantValidationError("Organization slug must be a string.");
  }
  const rawSlug =
    typeof input.slug === "string" ? input.slug.trim() : "";
  const slug =
    rawSlug !== ""
      ? validateOrganizationSlug(rawSlug)
      : slugifyOrganizationName(trimmedName);

  const { organizations, memberships } = await getCollections();
  const now = new Date();
  const orgDoc: OrganizationDoc = {
    _id: new ObjectId(),
    name: trimmedName,
    slug,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await organizations.insertOne(orgDoc);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new TenantValidationError("Organization slug is already taken.");
    }
    if (error instanceof TenantAccessError) {
      throw error;
    }
    throw new Error("Failed to create organization.");
  }

  const membershipDoc: MembershipDoc = {
    _id: new ObjectId(),
    organizationId: orgDoc._id,
    userId,
    role: "admin",
    createdAt: now,
    updatedAt: now,
  };

  try {
    await memberships.insertOne(membershipDoc);
  } catch (membershipError) {
    try {
      await organizations.deleteOne({ _id: orgDoc._id, createdBy: userId });
    } catch {
      // Preserve the original membership creation error if cleanup also fails.
    }
    throw membershipError;
  }

  return { ...orgDoc, role: membershipDoc.role };
}

/**
 * Lists all organizations the authenticated session user belongs to, paired
 * with their membership role in each organization.
 */
export async function listUserOrganizations(
  requestHeaders?: Headers,
): Promise<UserOrganization[]> {
  const userId = await requireSessionUserId(requestHeaders);
  const { memberships, organizations } = await getCollections();

  const userMemberships = await memberships.find({ userId }).toArray();
  if (userMemberships.length === 0) {
    return [];
  }

  const roleByOrgId = new Map<string, MembershipRole>();
  const orgIds: ObjectId[] = [];
  for (const membership of userMemberships) {
    const key = membership.organizationId.toHexString();
    if (!roleByOrgId.has(key)) {
      roleByOrgId.set(key, membership.role);
      orgIds.push(membership.organizationId);
    }
  }

  const orgDocs = await organizations
    .find({ _id: { $in: orgIds } })
    .sort({ createdAt: -1 })
    .toArray();

  const results: UserOrganization[] = [];
  for (const org of orgDocs) {
    const role = roleByOrgId.get(org._id.toHexString());
    if (role !== undefined) {
      results.push({ ...org, role });
    }
  }
  return results;
}

/**
 * Resolves an organization by slug and verifies that the authenticated session
 * user is a member before returning it. Throws the same generic
 * `TenantAccessError` whether the slug does not exist or the user is not a member.
 */
export async function getOrganizationBySlug(
  slug: string,
  requestHeaders?: Headers,
): Promise<UserOrganization> {
  const userId = await requireSessionUserId(requestHeaders);
  const normalizedSlug = validateOrganizationSlug(slug);
  const { organizations, memberships } = await getCollections();

  const organization = await organizations.findOne({ slug: normalizedSlug });
  if (!organization) {
    throw new TenantAccessError();
  }

  const membership = await memberships.findOne({
    organizationId: organization._id,
    userId,
  });
  if (!membership) {
    throw new TenantAccessError();
  }

  return { ...organization, role: membership.role };
}

export const ADDABLE_MEMBERSHIP_ROLES = ["admin", "manager", "member"] as const;
export type AddableMembershipRole = (typeof ADDABLE_MEMBERSHIP_ROLES)[number];

export const ELEVATED_MEMBERSHIP_ROLES = ["admin", "manager"] as const;
export type ElevatedMembershipRole = (typeof ELEVATED_MEMBERSHIP_ROLES)[number];

export function isElevatedMembershipRole(
  role: unknown,
): role is ElevatedMembershipRole {
  return role === "admin" || role === "manager";
}

export type OrganizationMember = {
  userId: UserId;
  role: MembershipRole;
  name: string | null;
  email: string | null;
};

export type OrganizationMemberDetail = MembershipDoc & {
  name: string | null;
  email: string | null;
};

export type AddOrganizationMemberInput = {
  email: string;
  role: AddableMembershipRole;
};

export type UpdateOrganizationMemberRoleInput = {
  userId: UserId;
  role: MembershipRole;
};

export type RemoveOrganizationMemberInput = {
  userId: UserId;
};

const EMAIL_MAX_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LAST_ADMIN_PROTECTION_MESSAGE =
  "Cannot remove or demote the last admin of the organization.";

type BetterAuthUserProjection = {
  _id: ObjectId | string;
  id?: unknown;
  name?: unknown;
  email?: unknown;
};

type SafeRegisteredUserProfile = {
  userId: UserId;
  name: string | null;
  email: string | null;
};

function escapeMongoRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBetterAuthUserId(doc: BetterAuthUserProjection): UserId | null {
  let rawId: string | null = null;
  if (doc._id instanceof ObjectId) {
    rawId = doc._id.toHexString();
  } else if (typeof doc._id === "string") {
    rawId = doc._id.trim();
  } else if (typeof doc.id === "string") {
    rawId = doc.id.trim();
  }

  if (
    rawId === null ||
    rawId.length < USER_ID_MIN_LENGTH ||
    rawId.length > USER_ID_MAX_LENGTH
  ) {
    return null;
  }
  return rawId;
}

function toSafeUserProfile(
  doc: BetterAuthUserProjection,
): SafeRegisteredUserProfile | null {
  const userId = extractBetterAuthUserId(doc);
  if (userId === null) {
    return null;
  }
  const name =
    typeof doc.name === "string" && doc.name.trim() !== ""
      ? doc.name.trim()
      : null;
  const email =
    typeof doc.email === "string" && doc.email.trim() !== ""
      ? doc.email.trim()
      : null;

  return { userId, name, email };
}

/**
 * Queries Better Auth's `user` collection with an explicit allowlist projection
 * (`_id`, `id`, `name`, `email`) so credentials, sessions, and internal fields
 * are never read or returned.
 */
async function lookupRegisteredUsersByIds(
  userIds: readonly UserId[],
): Promise<Map<UserId, { name: string | null; email: string | null }>> {
  const result = new Map<UserId, { name: string | null; email: string | null }>();
  if (userIds.length === 0) {
    return result;
  }

  const uniqueUserIds = Array.from(new Set(userIds));
  const idMatchers: Array<ObjectId | string> = [];
  for (const id of uniqueUserIds) {
    const parsed = parseObjectId(id);
    if (parsed) {
      idMatchers.push(parsed);
    }
    idMatchers.push(id);
  }

  const db = await getDb();
  const docs = await db
    .collection<BetterAuthUserProjection>(BETTER_AUTH_USER_COLLECTION)
    .find(
      {
        $or: [
          { _id: { $in: idMatchers } },
          { id: { $in: uniqueUserIds } },
        ],
      },
      { projection: { _id: 1, id: 1, name: 1, email: 1 } },
    )
    .toArray();

  for (const doc of docs) {
    const profile = toSafeUserProfile(doc);
    if (profile) {
      result.set(profile.userId, { name: profile.name, email: profile.email });
      if (typeof doc.id === "string" && doc.id.trim() !== "") {
        result.set(doc.id.trim(), { name: profile.name, email: profile.email });
      }
    }
  }

  return result;
}

async function findRegisteredUserByEmail(
  normalizedEmail: string,
): Promise<SafeRegisteredUserProfile | null> {
  const db = await getDb();
  const users = db.collection<BetterAuthUserProjection>(
    BETTER_AUTH_USER_COLLECTION,
  );
  const projection = { _id: 1, id: 1, name: 1, email: 1 } as const;

  const exactMatch = await users.findOne(
    { email: normalizedEmail },
    { projection },
  );
  if (exactMatch) {
    return toSafeUserProfile(exactMatch);
  }

  const insensitiveMatch = await users.findOne(
    {
      email: {
        $regex: `^${escapeMongoRegex(normalizedEmail)}$`,
        $options: "i",
      },
    },
    { projection },
  );
  return insensitiveMatch ? toSafeUserProfile(insensitiveMatch) : null;
}

function validateMemberEmail(email: unknown): string {
  if (typeof email !== "string") {
    throw new TenantValidationError("Member email must be a string.");
  }
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > EMAIL_MAX_LENGTH ||
    !EMAIL_PATTERN.test(normalized)
  ) {
    throw new TenantValidationError("A valid email address is required.");
  }
  return normalized;
}

function validateAddableMemberRole(role: unknown): AddableMembershipRole {
  if (
    typeof role !== "string" ||
    !(ADDABLE_MEMBERSHIP_ROLES as readonly string[]).includes(role)
  ) {
    throw new TenantValidationError(
      `New member role must be one of: ${ADDABLE_MEMBERSHIP_ROLES.join(", ")}.`,
    );
  }
  return role as AddableMembershipRole;
}

function validateMembershipRole(role: unknown): MembershipRole {
  if (
    typeof role !== "string" ||
    !(MEMBERSHIP_ROLES as readonly string[]).includes(role)
  ) {
    throw new TenantValidationError(
      `Member role must be one of: ${MEMBERSHIP_ROLES.join(", ")}.`,
    );
  }
  return role as MembershipRole;
}

function validateMemberUserId(userId: unknown): UserId {
  if (typeof userId !== "string") {
    throw new TenantValidationError(
      "Invalid userId: expected a non-empty string.",
    );
  }
  const trimmed = userId.trim();
  if (
    trimmed.length < USER_ID_MIN_LENGTH ||
    trimmed.length > USER_ID_MAX_LENGTH
  ) {
    throw new TenantValidationError(
      `Invalid userId: must be a non-empty string of at most ${USER_ID_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function isTransactionsUnsupportedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  const codeName =
    "codeName" in error ? (error as { codeName?: unknown }).codeName : undefined;
  return (
    code === 20 ||
    code === 303 ||
    code === 263 ||
    codeName === "IllegalOperation" ||
    codeName === "CannotImplicitlyCreateCollectionInfo"
  );
}

const ACTIVITY_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

const ACTIVITY_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

const ACTIVITY_REVIEW_LABELS: Record<ReviewDecision, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
};

export type BuildActivityInput = {
  organizationId: ObjectId;
  projectId: ObjectId | null;
  taskId: ObjectId | null;
  actorId: UserId;
  eventType: ActivityEventType;
  targetType: ActivityTargetType;
  targetId: ObjectId;
  summary: string;
  changes?: ActivityFieldChange[];
  metadata?: Record<string, ActivityFieldValue> | null;
  createdAt?: Date;
};

export function buildActivityDoc(input: BuildActivityInput): ActivityDoc {
  const rawSummary = input.summary.trim();
  const summary =
    rawSummary.length > 1000
      ? `${rawSummary.slice(0, 997)}...`
      : rawSummary || input.eventType;
  return {
    _id: new ObjectId(),
    organizationId: input.organizationId,
    projectId: input.projectId,
    taskId: input.taskId,
    actorId: input.actorId,
    eventType: input.eventType,
    targetType: input.targetType,
    targetId: input.targetId,
    summary,
    changes: input.changes ?? [],
    metadata: input.metadata ?? null,
    createdAt: input.createdAt ?? new Date(),
  };
}

/**
 * Executes `transactionalFn` inside a MongoDB multi-document transaction so
 * concurrent admin demotions/removals can be serialized via an organization
 * write lock. Falls back to `fallbackFn` only if the connected MongoDB server
 * topology does not support transactions (e.g. a standalone non-replica-set test instance).
 */
async function runInTransactionOrFallback<T>(
  transactionalFn: (session: ClientSession) => Promise<T>,
  fallbackFn: () => Promise<T>,
): Promise<T> {
  await getDb();
  const client = getMongoClient();
  const session = client.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await transactionalFn(session);
    });
    return result;
  } catch (error) {
    if (isTransactionsUnsupportedError(error)) {
      return fallbackFn();
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

/**
 * Lists all members of `organizationId`, including their `{ userId, role }`
 * from the app-owned `memberships` collection and their `{ name, email }`
 * (when safely available) from Better Auth's `user` collection.
 * Never exposes passwords, authentication secrets, sessions, or internal Better Auth fields.
 */
export async function listOrganizationMembers(
  organizationId: ObjectId,
  requestHeaders?: Headers,
): Promise<OrganizationMember[]> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const { memberships } = await getCollections();
  const orgMemberships = await memberships
    .find(
      { organizationId: membership.organizationId },
      { projection: { _id: 0, userId: 1, role: 1 } },
    )
    .sort({ createdAt: 1, _id: 1 })
    .toArray();

  if (orgMemberships.length === 0) {
    return [];
  }

  const normalizedMemberships = orgMemberships.map((doc) => ({
    userId: normalizeUserIdValue(doc.userId) ?? String(doc.userId),
    role: doc.role,
  }));

  const profilesById = await lookupRegisteredUsersByIds(
    normalizedMemberships.map((doc) => doc.userId),
  );

  return normalizedMemberships.map((doc) => {
    const profile = profilesById.get(doc.userId);
    return {
      userId: doc.userId,
      role: doc.role,
      name: profile?.name ?? null,
      email: profile?.email ?? null,
    };
  });
}

/**
 * Adds an existing registered user to `organizationId`. Organization `manager`s
 * can add members with role `member` only. Organization `admin`s can add `member`s;
 * elevated roles (`manager` and `admin`) strictly require the global platform
 * administrator. Looks up the user by email in Better Auth's `user` collection
 * and derives `userId` strictly from the matched database record (never trusting
 * a caller-supplied user ID).
 */
export async function addOrganizationMember(
  organizationId: ObjectId,
  input: AddOrganizationMemberInput,
  requestHeaders?: Headers,
): Promise<OrganizationMemberDetail>;
export async function addOrganizationMember(
  organizationId: ObjectId,
  email: string,
  role: AddableMembershipRole,
  requestHeaders?: Headers,
): Promise<OrganizationMemberDetail>;
export async function addOrganizationMember(
  organizationId: ObjectId,
  emailOrInput: string | AddOrganizationMemberInput,
  roleOrHeaders?: AddableMembershipRole | Headers,
  maybeHeaders?: Headers,
): Promise<OrganizationMemberDetail> {
  let rawEmail: unknown;
  let rawRole: unknown;
  let resolvedHeaders: Headers | undefined;

  if (typeof emailOrInput === "string") {
    rawEmail = emailOrInput;
    rawRole = roleOrHeaders;
    resolvedHeaders = maybeHeaders;
  } else if (isPlainObject(emailOrInput)) {
    const record = emailOrInput as Record<string, unknown>;
    if ("userId" in record || "id" in record || "_id" in record) {
      throw new TenantValidationError(
        "User ID cannot be supplied when adding a member; provide the registered user's email.",
      );
    }
    for (const key of Object.keys(record)) {
      if (key !== "email" && key !== "role") {
        throw new TenantValidationError(
          `Unexpected field "${key}". Only "email" and "role" are allowed.`,
        );
      }
    }
    rawEmail = record.email;
    rawRole = record.role;
    resolvedHeaders = roleOrHeaders instanceof Headers ? roleOrHeaders : maybeHeaders;
  } else {
    throw new TenantValidationError("Member input must be a plain object.");
  }

  const callerMembership = await requireMembership(
    organizationId,
    ["admin", "manager"],
    resolvedHeaders,
  );

  const normalizedEmail = validateMemberEmail(rawEmail);
  const role = validateAddableMemberRole(rawRole);

  if (callerMembership.role === "manager" && role !== "member") {
    throw new TenantAccessError(
      "Managers can only add members with the member role.",
    );
  }

  if (isElevatedMembershipRole(role)) {
    const isPlatform = await isPlatformAdmin(resolvedHeaders);
    if (!isPlatform) {
      throw new TenantAccessError(
        "Only the platform administrator can grant manager or admin roles.",
      );
    }
  }

  const registeredUser = await findRegisteredUserByEmail(normalizedEmail);
  if (!registeredUser) {
    throw new TenantValidationError(
      "No registered user found with that email address.",
    );
  }

  const { memberships, organizations } = await getCollections();
  const existingMembership = await memberships.findOne({
    organizationId: callerMembership.organizationId,
    userId: registeredUser.userId,
  });
  if (existingMembership) {
    throw new TenantValidationError(
      "User is already a member of this organization.",
    );
  }

  const now = new Date();
  const membershipDoc: MembershipDoc = {
    _id: new ObjectId(),
    organizationId: callerMembership.organizationId,
    userId: registeredUser.userId,
    role,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await memberships.insertOne(membershipDoc);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new TenantValidationError(
        "User is already a member of this organization.",
      );
    }
    throw error;
  }

  if (callerMembership.role === "manager") {
    try {
      const [orgDoc, managerProfiles, adminMemberships] = await Promise.all([
        organizations.findOne({ _id: callerMembership.organizationId }),
        lookupRegisteredUsersByIds([callerMembership.userId]),
        memberships
          .find({
            organizationId: callerMembership.organizationId,
            role: "admin",
          })
          .toArray(),
      ]);

      const orgName = orgDoc?.name ?? "the organization";
      const orgSlug = orgDoc?.slug ?? "";
      const managerProfile = managerProfiles.get(callerMembership.userId);
      const managerDisplayName =
        managerProfile?.name?.trim() ||
        managerProfile?.email?.trim() ||
        "A manager";
      const memberDisplayName =
        registeredUser.name?.trim() ||
        registeredUser.email?.trim() ||
        registeredUser.email;

      const notificationUrl = orgSlug
        ? `/dashboard/${encodeURIComponent(orgSlug)}/members`
        : null;

      for (const admin of adminMemberships) {
        if (admin.userId === callerMembership.userId) {
          continue;
        }
        await createNotificationSafe({
          organizationId: callerMembership.organizationId,
          recipientId: admin.userId,
          type: "member.added",
          title: `New member added to ${orgName}`,
          message: `${managerDisplayName} added ${memberDisplayName} to ${orgName} as a member.`,
          url: notificationUrl,
          actorId: callerMembership.userId,
          dedupeKey: `member.added:${callerMembership.organizationId.toHexString()}:${registeredUser.userId}:${membershipDoc._id.toHexString()}`,
        });
      }
    } catch (notifyError) {
      console.warn(
        "[tenancy] Failed to notify admins of added member:",
        notifyError,
      );
    }
  }

  return {
    ...membershipDoc,
    name: registeredUser.name,
    email: registeredUser.email,
  };
}

/**
 * Updates an organization member's role (`admin`, `manager`, or `member`).
 * Restricted to organization `admin`s; elevated roles (`manager` and `admin`)
 * strictly require the global platform administrator. Serializes admin
 * demotions per organization so the last admin of an organization can never
 * be demoted, even under concurrent requests. Returns `null` if `userId` is
 * not a member of the organization.
 */
export async function updateOrganizationMemberRole(
  organizationId: ObjectId,
  input: UpdateOrganizationMemberRoleInput,
  requestHeaders?: Headers,
): Promise<OrganizationMemberDetail | null>;
export async function updateOrganizationMemberRole(
  organizationId: ObjectId,
  userId: UserId,
  role: MembershipRole | { role: MembershipRole },
  requestHeaders?: Headers,
): Promise<OrganizationMemberDetail | null>;
export async function updateOrganizationMemberRole(
  organizationId: ObjectId,
  userIdOrInput: UserId | UpdateOrganizationMemberRoleInput,
  roleOrHeaders?: MembershipRole | { role: MembershipRole } | Headers,
  maybeHeaders?: Headers,
): Promise<OrganizationMemberDetail | null> {
  let rawUserId: unknown;
  let rawRole: unknown;
  let resolvedHeaders: Headers | undefined;

  if (typeof userIdOrInput === "string") {
    rawUserId = userIdOrInput;
    if (typeof roleOrHeaders === "string") {
      rawRole = roleOrHeaders;
    } else if (isPlainObject(roleOrHeaders)) {
      const record = roleOrHeaders as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key !== "role") {
          throw new TenantValidationError(
            `Unexpected field "${key}". Only "role" is allowed.`,
          );
        }
      }
      rawRole = record.role;
    } else {
      rawRole = roleOrHeaders;
    }
    resolvedHeaders = maybeHeaders;
  } else if (isPlainObject(userIdOrInput)) {
    const record = userIdOrInput as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "userId" && key !== "role") {
        throw new TenantValidationError(
          `Unexpected field "${key}". Only "userId" and "role" are allowed.`,
        );
      }
    }
    rawUserId = record.userId;
    rawRole = record.role;
    resolvedHeaders = roleOrHeaders instanceof Headers ? roleOrHeaders : maybeHeaders;
  } else {
    throw new TenantValidationError(
      "Member role update input must be a plain object.",
    );
  }

  const adminMembership = await requireMembership(
    organizationId,
    ADMIN_ROLES,
    resolvedHeaders,
  );
  const orgId = adminMembership.organizationId;
  const actingUserId = adminMembership.userId;
  const targetUserId = validateMemberUserId(rawUserId);
  const newRole = validateMembershipRole(rawRole);

  if (isElevatedMembershipRole(newRole)) {
    const isPlatform = await isPlatformAdmin(resolvedHeaders);
    if (!isPlatform) {
      throw new TenantAccessError(
        "Only the platform administrator can grant manager or admin roles.",
      );
    }
  }

  const { organizations, memberships } = await getCollections();

  const updatedDoc = await runInTransactionOrFallback<MembershipDoc | null>(
    async (session) => {
      const currentActor = await memberships.findOne(
        { organizationId: orgId, userId: actingUserId, role: "admin" },
        { session },
      );
      if (!currentActor) {
        throw new TenantAccessError(
          "Only organization admins can update member roles.",
        );
      }

      const targetMembership = await memberships.findOne(
        { organizationId: orgId, userId: targetUserId },
        { session },
      );
      if (!targetMembership) {
        return null;
      }

      const now = new Date();
      if (targetMembership.role === "admin" && newRole !== "admin") {
        // Acquire a write lock on the parent organization document within the
        // transaction so concurrent admin demotions/removals on the same
        // organization conflict and retry sequentially (preventing write skew).
        await organizations.updateOne(
          { _id: orgId },
          { $set: { updatedAt: now } },
          { session },
        );

        const otherAdmin = await memberships.findOne(
          {
            organizationId: orgId,
            role: "admin",
            _id: { $ne: targetMembership._id },
          },
          { projection: { _id: 1 }, session },
        );
        if (!otherAdmin) {
          throw new TenantValidationError(LAST_ADMIN_PROTECTION_MESSAGE);
        }
      }

      return memberships.findOneAndUpdate(
        {
          _id: targetMembership._id,
          organizationId: orgId,
          role: targetMembership.role,
        },
        { $set: { role: newRole, updatedAt: now } },
        { returnDocument: "after", session },
      );
    },
    async () => {
      const currentActor = await memberships.findOne({
        organizationId: orgId,
        userId: actingUserId,
        role: "admin",
      });
      if (!currentActor) {
        throw new TenantAccessError(
          "Only organization admins can update member roles.",
        );
      }

      const targetMembership = await memberships.findOne({
        organizationId: orgId,
        userId: targetUserId,
      });
      if (!targetMembership) {
        return null;
      }

      const isAdminDemotion =
        targetMembership.role === "admin" && newRole !== "admin";
      if (isAdminDemotion) {
        const otherAdmin = await memberships.findOne(
          {
            organizationId: orgId,
            role: "admin",
            _id: { $ne: targetMembership._id },
          },
          { projection: { _id: 1 } },
        );
        if (!otherAdmin) {
          throw new TenantValidationError(LAST_ADMIN_PROTECTION_MESSAGE);
        }
      }

      const now = new Date();
      const updated = await memberships.findOneAndUpdate(
        {
          _id: targetMembership._id,
          organizationId: orgId,
          role: targetMembership.role,
        },
        { $set: { role: newRole, updatedAt: now } },
        { returnDocument: "after" },
      );

      if (updated && isAdminDemotion) {
        const remainingAdmin = await memberships.findOne(
          { organizationId: orgId, role: "admin" },
          { projection: { _id: 1 } },
        );
        if (!remainingAdmin) {
          await memberships.updateOne(
            { _id: targetMembership._id, organizationId: orgId },
            { $set: { role: "admin", updatedAt: new Date() } },
          );
          throw new TenantValidationError(LAST_ADMIN_PROTECTION_MESSAGE);
        }
      }

      return updated;
    },
  );

  if (!updatedDoc) {
    return null;
  }

  const profilesById = await lookupRegisteredUsersByIds([updatedDoc.userId]);
  const profile = profilesById.get(updatedDoc.userId);
  return {
    ...updatedDoc,
    name: profile?.name ?? null,
    email: profile?.email ?? null,
  };
}

/**
 * Removes a member from `organizationId`. Restricted to organization `admin`s.
 * Serializes admin removals per organization so the last admin can never be
 * removed, even under concurrent requests. Deletes only the organization
 * membership record and never deletes the user's Better Auth account. Returns
 * the removed `MembershipDoc`, or `null` if `userId` is not a member of the
 * organization.
 */
export async function removeOrganizationMember(
  organizationId: ObjectId,
  userId: UserId,
  requestHeaders?: Headers,
): Promise<MembershipDoc | null>;
export async function removeOrganizationMember(
  organizationId: ObjectId,
  input: RemoveOrganizationMemberInput,
  requestHeaders?: Headers,
): Promise<MembershipDoc | null>;
export async function removeOrganizationMember(
  organizationId: ObjectId,
  userIdOrInput: UserId | RemoveOrganizationMemberInput,
  requestHeaders?: Headers,
): Promise<MembershipDoc | null> {
  let rawUserId: unknown;

  if (typeof userIdOrInput === "string") {
    rawUserId = userIdOrInput;
  } else if (isPlainObject(userIdOrInput)) {
    const record = userIdOrInput as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "userId") {
        throw new TenantValidationError(
          `Unexpected field "${key}". Only "userId" is allowed.`,
        );
      }
    }
    rawUserId = record.userId;
  } else {
    throw new TenantValidationError(
      "Member removal input must be a plain object or userId string.",
    );
  }

  const adminMembership = await requireMembership(
    organizationId,
    ADMIN_ROLES,
    requestHeaders,
  );
  const orgId = adminMembership.organizationId;
  const actingUserId = adminMembership.userId;
  const targetUserId = validateMemberUserId(rawUserId);

  const { organizations, memberships } = await getCollections();

  return runInTransactionOrFallback<MembershipDoc | null>(
    async (session) => {
      const currentActor = await memberships.findOne(
        { organizationId: orgId, userId: actingUserId, role: "admin" },
        { session },
      );
      if (!currentActor) {
        throw new TenantAccessError(
          "Only organization admins can remove organization members.",
        );
      }

      const targetMembership = await memberships.findOne(
        { organizationId: orgId, userId: targetUserId },
        { session },
      );
      if (!targetMembership) {
        return null;
      }

      if (targetMembership.role === "admin") {
        // Acquire a write lock on the parent organization document within the
        // transaction so concurrent admin removals/demotions on the same
        // organization conflict and retry sequentially (preventing write skew).
        await organizations.updateOne(
          { _id: orgId },
          { $set: { updatedAt: new Date() } },
          { session },
        );

        const otherAdmin = await memberships.findOne(
          {
            organizationId: orgId,
            role: "admin",
            _id: { $ne: targetMembership._id },
          },
          { projection: { _id: 1 }, session },
        );
        if (!otherAdmin) {
          throw new TenantValidationError(LAST_ADMIN_PROTECTION_MESSAGE);
        }
      }

      return memberships.findOneAndDelete(
        {
          _id: targetMembership._id,
          organizationId: orgId,
          role: targetMembership.role,
        },
        { session },
      );
    },
    async () => {
      const currentActor = await memberships.findOne({
        organizationId: orgId,
        userId: actingUserId,
        role: "admin",
      });
      if (!currentActor) {
        throw new TenantAccessError(
          "Only organization admins can remove organization members.",
        );
      }

      const targetMembership = await memberships.findOne({
        organizationId: orgId,
        userId: targetUserId,
      });
      if (!targetMembership) {
        return null;
      }

      const isAdminRemoval = targetMembership.role === "admin";
      if (isAdminRemoval) {
        const otherAdmin = await memberships.findOne(
          {
            organizationId: orgId,
            role: "admin",
            _id: { $ne: targetMembership._id },
          },
          { projection: { _id: 1 } },
        );
        if (!otherAdmin) {
          throw new TenantValidationError(LAST_ADMIN_PROTECTION_MESSAGE);
        }
      }

      const deleted = await memberships.findOneAndDelete({
        _id: targetMembership._id,
        organizationId: orgId,
        role: targetMembership.role,
      });

      if (deleted && isAdminRemoval) {
        const remainingAdmin = await memberships.findOne(
          { organizationId: orgId, role: "admin" },
          { projection: { _id: 1 } },
        );
        if (!remainingAdmin) {
          await memberships.updateOne(
            { _id: deleted._id, organizationId: orgId },
            {
              $setOnInsert: {
                ...deleted,
                role: "admin",
                updatedAt: new Date(),
              },
            },
            { upsert: true },
          );
          throw new TenantValidationError(LAST_ADMIN_PROTECTION_MESSAGE);
        }
      }

      return deleted;
    },
  );
}

// ---------------------------------------------------------------------------
// Tenant-scoped project data access
// ---------------------------------------------------------------------------

const PROJECT_NAME_MIN_LENGTH = 1;
const PROJECT_NAME_MAX_LENGTH = 200;
const PROJECT_DESCRIPTION_MAX_LENGTH = 5000;

function validateProjectName(name: unknown): string {
  if (typeof name !== "string") {
    throw new TenantValidationError("Project name must be a string.");
  }
  const trimmed = name.trim();
  if (
    trimmed.length < PROJECT_NAME_MIN_LENGTH ||
    trimmed.length > PROJECT_NAME_MAX_LENGTH
  ) {
    throw new TenantValidationError(
      `Project name must be between ${PROJECT_NAME_MIN_LENGTH} and ${PROJECT_NAME_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function validateProjectDescription(description: unknown): string | null {
  if (description === undefined || description === null) {
    return null;
  }
  if (typeof description !== "string") {
    throw new TenantValidationError("Project description must be a string or null.");
  }
  if (description.length > PROJECT_DESCRIPTION_MAX_LENGTH) {
    throw new TenantValidationError(
      `Project description must be at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }
  return normalizeDescription(description);
}

function validateProjectStatus(status: unknown): ProjectStatus {
  if (
    typeof status !== "string" ||
    !(PROJECT_STATUSES as readonly string[]).includes(status)
  ) {
    throw new TenantValidationError(
      `Project status must be one of: ${PROJECT_STATUSES.join(", ")}.`,
    );
  }
  return status as ProjectStatus;
}

export type CreateProjectInput = {
  name: string;
  description?: string | null;
  status?: ProjectStatus;
};

export type UpdateProjectInput = {
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
};

export async function createProject(
  organizationId: ObjectId,
  input: CreateProjectInput,
  requestHeaders?: Headers,
): Promise<ProjectDoc> {
  const membership = await requireMembership(organizationId, MANAGER_ROLES, requestHeaders);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TenantValidationError("Project input must be an object.");
  }

  const name = validateProjectName(input.name);
  const description = validateProjectDescription(input.description);
  const status =
    input.status !== undefined ? validateProjectStatus(input.status) : "active";

  const { projects, activities } = await getCollections();
  const now = new Date();
  const doc: ProjectDoc = {
    _id: new ObjectId(),
    organizationId: membership.organizationId,
    name,
    description,
    status,
    createdBy: membership.userId,
    createdAt: now,
    updatedAt: now,
  };
  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: doc._id,
    taskId: null,
    actorId: membership.userId,
    eventType: "project.created",
    targetType: "project",
    targetId: doc._id,
    summary: `Created project "${doc.name}"`,
    changes: [
      { field: "name", before: null, after: doc.name },
      ...(doc.description !== null && doc.description !== undefined
        ? [{ field: "description", before: null, after: doc.description }]
        : []),
      { field: "status", before: null, after: doc.status },
    ],
    metadata: {
      projectName: doc.name,
      status: doc.status,
    },
    createdAt: now,
  });

  await runInTransactionOrFallback(
    async (session) => {
      await projects.insertOne(doc, { session });
      await activities.insertOne(activityDoc, { session });
    },
    async () => {
      await projects.insertOne(doc);
      await activities.insertOne(activityDoc);
    },
  );
  return doc;
}

export async function getProjectById(
  organizationId: ObjectId,
  projectId: ObjectId,
  requestHeaders?: Headers,
): Promise<ProjectDoc | null> {
  const membership = await requireMembership(organizationId, undefined, requestHeaders);
  requireObjectId(projectId, "projectId");
  const { projects } = await getCollections();
  return projects.findOne({
    _id: projectId,
    organizationId: membership.organizationId,
  });
}

export async function listProjects(
  organizationId: ObjectId,
  filter?: { status?: ProjectStatus },
  requestHeaders?: Headers,
): Promise<ProjectDoc[]> {
  const membership = await requireMembership(organizationId, undefined, requestHeaders);
  let statusFilter: ProjectStatus | undefined;
  if (filter !== undefined) {
    if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
      throw new TenantValidationError("Project filter must be an object.");
    }
    if (filter.status !== undefined) {
      statusFilter = validateProjectStatus(filter.status);
    }
  }

  const { projects } = await getCollections();
  return projects
    .find({
      organizationId: membership.organizationId,
      ...(statusFilter !== undefined ? { status: statusFilter } : {}),
    })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function updateProject(
  organizationId: ObjectId,
  projectId: ObjectId,
  input: UpdateProjectInput,
  requestHeaders?: Headers,
): Promise<ProjectDoc | null> {
  const membership = await requireMembership(organizationId, MANAGER_ROLES, requestHeaders);
  requireObjectId(projectId, "projectId");
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TenantValidationError("Project update input must be an object.");
  }

  const hasName = input.name !== undefined;
  const hasDescription = input.description !== undefined;
  const hasStatus = input.status !== undefined;

  if (!hasName && !hasDescription && !hasStatus) {
    throw new TenantValidationError(
      "At least one project field (name, description, or status) must be provided.",
    );
  }

  const updates: Partial<ProjectDoc> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (hasName) {
    updates.name = validateProjectName(input.name);
  }
  if (hasDescription) {
    updates.description = validateProjectDescription(input.description);
  }
  if (hasStatus) {
    updates.status = validateProjectStatus(input.status);
  }

  const { projects, activities } = await getCollections();
  const existing = await projects.findOne({
    _id: projectId,
    organizationId: membership.organizationId,
  });
  if (!existing) {
    return null;
  }

  if (
    existing.status === "archived" &&
    (hasName || hasDescription) &&
    updates.status !== "active"
  ) {
    throw new TenantValidationError(
      "Cannot modify name or description of an archived project unless unarchiving it.",
    );
  }

  const targetName = updates.name !== undefined ? updates.name : existing.name;
  const targetDescription =
    updates.description !== undefined
      ? updates.description
      : (existing.description ?? null);
  const nameChanged = hasName && targetName !== existing.name;
  const descriptionChanged =
    hasDescription && targetDescription !== (existing.description ?? null);
  const statusChanged =
    hasStatus && updates.status !== undefined && updates.status !== existing.status;

  const activityDocs: ActivityDoc[] = [];
  if (nameChanged || descriptionChanged) {
    const editChanges: ActivityFieldChange[] = [];
    if (nameChanged) {
      editChanges.push({
        field: "name",
        before: existing.name,
        after: targetName,
      });
    }
    if (descriptionChanged) {
      editChanges.push({
        field: "description",
        before: existing.description ?? null,
        after: targetDescription,
      });
    }
    const editSummary =
      nameChanged && descriptionChanged
        ? `Updated name and description for project "${targetName}"`
        : nameChanged
          ? `Renamed project from "${existing.name}" to "${targetName}"`
          : `Updated description for project "${targetName}"`;
    activityDocs.push(
      buildActivityDoc({
        organizationId: membership.organizationId,
        projectId: existing._id,
        taskId: null,
        actorId: membership.userId,
        eventType: "project.updated",
        targetType: "project",
        targetId: existing._id,
        summary: editSummary,
        changes: editChanges,
        metadata: { projectName: targetName },
        createdAt: updates.updatedAt,
      }),
    );
  }

  if (statusChanged) {
    const nextStatus = updates.status!;
    activityDocs.push(
      buildActivityDoc({
        organizationId: membership.organizationId,
        projectId: existing._id,
        taskId: null,
        actorId: membership.userId,
        eventType:
          nextStatus === "archived"
            ? "project.archived"
            : "project.unarchived",
        targetType: "project",
        targetId: existing._id,
        summary:
          nextStatus === "archived"
            ? `Archived project "${targetName}"`
            : `Unarchived project "${targetName}"`,
        changes: [
          {
            field: "status",
            before: existing.status,
            after: nextStatus,
          },
        ],
        metadata: {
          projectName: targetName,
          status: nextStatus,
        },
        createdAt: updates.updatedAt,
      }),
    );
  }

  return runInTransactionOrFallback<ProjectDoc | null>(
    async (session) => {
      const updated = await projects.findOneAndUpdate(
        { _id: projectId, organizationId: membership.organizationId },
        { $set: updates },
        { returnDocument: "after", session },
      );
      if (updated && activityDocs.length > 0) {
        await activities.insertMany(activityDocs, { session });
      }
      return updated;
    },
    async () => {
      const updated = await projects.findOneAndUpdate(
        { _id: projectId, organizationId: membership.organizationId },
        { $set: updates },
        { returnDocument: "after" },
      );
      if (updated && activityDocs.length > 0) {
        await activities.insertMany(activityDocs);
      }
      return updated;
    },
  );
}

// ---------------------------------------------------------------------------
// Tenant-scoped task data access
// ---------------------------------------------------------------------------

const TASK_TITLE_MIN_LENGTH = 1;
const TASK_TITLE_MAX_LENGTH = 300;
const TASK_DESCRIPTION_MAX_LENGTH = 10000;

function validateTaskTitle(title: unknown): string {
  if (typeof title !== "string") {
    throw new TenantValidationError("Task title must be a string.");
  }
  const trimmed = title.trim();
  if (
    trimmed.length < TASK_TITLE_MIN_LENGTH ||
    trimmed.length > TASK_TITLE_MAX_LENGTH
  ) {
    throw new TenantValidationError(
      `Task title must be between ${TASK_TITLE_MIN_LENGTH} and ${TASK_TITLE_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function validateTaskDescription(description: unknown): string | null {
  if (description === undefined || description === null) {
    return null;
  }
  if (typeof description !== "string") {
    throw new TenantValidationError("Task description must be a string or null.");
  }
  if (description.length > TASK_DESCRIPTION_MAX_LENGTH) {
    throw new TenantValidationError(
      `Task description must be at most ${TASK_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }
  return normalizeDescription(description);
}

function validateTaskStatus(status: unknown): TaskStatus {
  if (
    typeof status !== "string" ||
    !(TASK_STATUSES as readonly string[]).includes(status)
  ) {
    throw new TenantValidationError(
      `Task status must be one of: ${TASK_STATUSES.join(", ")}.`,
    );
  }
  return status as TaskStatus;
}

function validateTaskPriority(priority: unknown): TaskPriority {
  if (
    typeof priority !== "string" ||
    !(TASK_PRIORITIES as readonly string[]).includes(priority)
  ) {
    throw new TenantValidationError(
      `Task priority must be one of: ${TASK_PRIORITIES.join(", ")}.`,
    );
  }
  return priority as TaskPriority;
}

function validateTaskDeadline(deadline: unknown): Date | null {
  if (deadline === undefined || deadline === null) {
    return null;
  }
  if (!(deadline instanceof Date) || Number.isNaN(deadline.getTime())) {
    throw new TenantValidationError(
      "Task deadline must be a valid Date or null.",
    );
  }
  return deadline;
}

function validateTaskApprovalRequired(approvalRequired: unknown): boolean {
  if (typeof approvalRequired !== "boolean") {
    throw new TenantValidationError(
      "Task approvalRequired must be a boolean.",
    );
  }
  return approvalRequired;
}

/**
 * Normalizes a `TaskDoc` read from MongoDB so pre-existing task documents
 * lacking `approvalRequired` behave as `approvalRequired: false` without
 * overwriting the stored document.
 */
function normalizeTaskDoc(
  doc: Omit<TaskDoc, "approvalRequired"> & { approvalRequired?: boolean },
): TaskDoc {
  const normalizedAssigneeId = normalizeUserIdValue(
    (doc as { assigneeId?: unknown }).assigneeId,
  );
  const normalizedCreatedBy =
    normalizeUserIdValue((doc as { createdBy?: unknown }).createdBy) ??
    doc.createdBy;
  return {
    ...doc,
    assigneeId: normalizedAssigneeId,
    createdBy: normalizedCreatedBy,
    approvalRequired: doc.approvalRequired === true,
    sourceMeetingId: doc.sourceMeetingId ?? null,
    sourceActionItemId: doc.sourceActionItemId ?? null,
  };
}

const TASK_APPROVAL_REQUIRED_NO_DELIVERABLE_MESSAGE =
  "Cannot mark task as done: deliverable approval is required and no deliverable has been submitted.";
const TASK_APPROVAL_REQUIRED_UNAPPROVED_MESSAGE =
  "Cannot mark task as done: the latest deliverable submission has not been approved.";

/**
 * Verifies that the latest deliverable submission for `(organizationId, projectId, taskId)`
 * exists and that its latest review in the same organization, project, and task
 * has `decision === "approved"`.
 */
async function requireApprovedLatestDeliverable(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
): Promise<void> {
  const { deliverables, reviews } = await getCollections();
  const latestDeliverable = await deliverables.findOne(
    {
      organizationId,
      projectId,
      taskId,
    },
    {
      sort: { createdAt: -1, _id: -1 },
    },
  );

  if (!latestDeliverable) {
    throw new TenantValidationError(
      TASK_APPROVAL_REQUIRED_NO_DELIVERABLE_MESSAGE,
    );
  }

  const latestReview = await reviews.findOne(
    {
      organizationId,
      projectId,
      taskId,
      deliverableId: latestDeliverable._id,
    },
    {
      sort: { createdAt: -1, _id: -1 },
    },
  );

  if (!latestReview || latestReview.decision !== "approved") {
    throw new TenantValidationError(
      TASK_APPROVAL_REQUIRED_UNAPPROVED_MESSAGE,
    );
  }
}

export type CreateTaskInput = {
  projectId: ObjectId;
  parentTaskId?: ObjectId | null;
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: UserId | null;
  deadline?: Date | null;
  approvalRequired?: boolean;
};

export type UpdateTaskInput = {
  projectId?: ObjectId;
  parentTaskId?: ObjectId | null;
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: UserId | null;
  deadline?: Date | null;
  approvalRequired?: boolean;
};

export type ListProjectTasksFilter = {
  parentTaskId?: ObjectId | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: UserId | null;
  deliverableStatus?: DeliverableStatusFilter;
  overdue?: boolean | BooleanFilterValue;
  dueToday?: boolean | BooleanFilterValue;
  dueSoon?: boolean | BooleanFilterValue;
  stale?: boolean | BooleanFilterValue;
  staleThresholdDays?: number;
  blocked?: boolean | BooleanFilterValue;
  deadlineFrom?: Date | string | null;
  deadlineTo?: Date | string | null;
  taskScope?: TaskScopeFilter;
  sortBy?: TaskSortField;
  sortOrder?: SortDirection;
};

export async function createTask(
  organizationId: ObjectId,
  input: CreateTaskInput,
  requestHeaders?: Headers,
): Promise<TaskDoc> {
  const membership = await requireMembership(organizationId, undefined, requestHeaders);
  if (!isPlainObject(input)) {
    throw new TenantValidationError("Task input must be a plain object.");
  }

  const orgId = membership.organizationId;
  const isManager = isManagerRole(membership.role);

  const project = await requireProjectInOrg(membership, input.projectId);
  const parentTaskId =
    input.parentTaskId === undefined
      ? null
      : validateNullableObjectId(input.parentTaskId, "parentTaskId");

  if (!isManager) {
    if (parentTaskId !== null) {
      throw new TenantAccessError(
        "Only admins and managers can create subtasks.",
      );
    }
    throw new TenantAccessError(
      "Only admins and managers can create top-level project tasks.",
    );
  }

  if (!isManager && input.approvalRequired !== undefined) {
    throw new TenantAccessError(
      "Only admins and managers can set or change task approval requirements.",
    );
  }

  if (project.status === "archived") {
    throw new TenantValidationError("Cannot create tasks in an archived project.");
  }

  if (parentTaskId !== null) {
    await requireTopLevelParentTaskInProject(
      membership,
      project._id,
      parentTaskId,
    );
  }

  const requestedAssigneeId =
    input.assigneeId === undefined
      ? null
      : validateAssigneeId(input.assigneeId);

  let assigneeId: UserId | null;
  if (isManager) {
    assigneeId = requestedAssigneeId;
    if (assigneeId !== null) {
      const assigneeMembership = await requireAssigneeInOrg(
        membership,
        assigneeId,
      );
      assigneeId = assigneeMembership.userId;
    }
  } else {
    if (
      requestedAssigneeId !== null &&
      requestedAssigneeId !== membership.userId
    ) {
      throw new TenantAccessError(
        "Only admins and managers can assign tasks to other members.",
      );
    }
    assigneeId = membership.userId;
  }

  const title = validateTaskTitle(input.title);
  const description = validateTaskDescription(input.description);
  const status =
    input.status !== undefined ? validateTaskStatus(input.status) : "todo";
  const priority =
    input.priority !== undefined
      ? validateTaskPriority(input.priority)
      : "medium";
  const deadline = validateTaskDeadline(input.deadline);
  const approvalRequired =
    input.approvalRequired !== undefined
      ? validateTaskApprovalRequired(input.approvalRequired)
      : true;

  if (status === "done" && approvalRequired) {
    throw new TenantValidationError(
      TASK_APPROVAL_REQUIRED_NO_DELIVERABLE_MESSAGE,
    );
  }

  const { tasks, activities, organizations } = await getCollections();
  const now = new Date();
  const doc: TaskDoc = {
    _id: new ObjectId(),
    organizationId: orgId,
    projectId: project._id,
    parentTaskId,
    title,
    description,
    status,
    priority,
    assigneeId,
    createdBy: membership.userId,
    deadline,
    approvalRequired,
    sourceMeetingId: null,
    sourceActionItemId: null,
    createdAt: now,
    updatedAt: now,
  };

  const isSubtask = doc.parentTaskId !== null;
  const activityDoc = buildActivityDoc({
    organizationId: orgId,
    projectId: project._id,
    taskId: doc._id,
    actorId: membership.userId,
    eventType: isSubtask ? "subtask.created" : "task.created",
    targetType: isSubtask ? "subtask" : "task",
    targetId: doc._id,
    summary: isSubtask
      ? `Created subtask "${doc.title}"`
      : `Created task "${doc.title}"`,
    changes: [
      { field: "title", before: null, after: doc.title },
      ...(doc.description !== null && doc.description !== undefined
        ? [{ field: "description", before: null, after: doc.description }]
        : []),
      { field: "status", before: null, after: doc.status },
      { field: "priority", before: null, after: doc.priority },
      { field: "assigneeId", before: null, after: doc.assigneeId },
      ...(doc.deadline !== null
        ? [
          {
            field: "deadline",
            before: null,
            after: doc.deadline.toISOString(),
          },
        ]
        : []),
      {
        field: "approvalRequired",
        before: null,
        after: doc.approvalRequired === true,
      },
    ],
    metadata: {
      taskTitle: doc.title,
      parentTaskId: doc.parentTaskId ? doc.parentTaskId.toHexString() : null,
      isSubtask,
    },
    createdAt: now,
  });

  await runInTransactionOrFallback(
    async (session) => {
      await tasks.insertOne(doc, { session });
      await activities.insertOne(activityDoc, { session });
    },
    async () => {
      await tasks.insertOne(doc);
      await activities.insertOne(activityDoc);
    },
  );

  if (doc.assigneeId !== null && doc.assigneeId !== membership.userId) {
    const organization = await organizations.findOne({ _id: orgId });
    if (organization) {
      await createNotificationSafe({
        organizationId: orgId,
        recipientId: doc.assigneeId,
        type: "task.assigned",
        title: `Task assigned: ${doc.title}`,
        message: `You were assigned to "${doc.title}" in project "${project.name}".`,
        url: `/dashboard/${organization.slug}/projects/${project._id}#task-${doc._id}`,
        entityType: "task",
        entityId: doc._id,
        projectId: project._id,
        actorId: membership.userId,
        dedupeKey: `task.assigned:${doc._id.toHexString()}:${doc.assigneeId}`,
      });
    }
  }

  return doc;
}

export async function getTaskById(
  organizationId: ObjectId,
  taskId: ObjectId,
  requestHeaders?: Headers,
): Promise<TaskDoc | null> {
  const membership = await requireMembership(organizationId, undefined, requestHeaders);
  requireObjectId(taskId, "taskId");
  const { tasks } = await getCollections();
  const doc = await tasks.findOne({
    _id: taskId,
    organizationId: membership.organizationId,
  });
  if (!doc) {
    return null;
  }
  const normalized = normalizeTaskDoc(doc);
  if (!isManagerRole(membership.role) && normalized.assigneeId !== membership.userId) {
    return null;
  }
  return normalized;
}

export async function listProjectTasks(
  organizationId: ObjectId,
  projectId: ObjectId,
  filter?: ListProjectTasksFilter,
  requestHeaders?: Headers,
): Promise<TaskDoc[]> {
  const membership = await requireMembership(organizationId, undefined, requestHeaders);
  const orgId = membership.organizationId;
  const project = await requireProjectInOrg(membership, projectId);

  let parentTaskIdFilter: ObjectId | null = null;
  let hasTaskScope = false;
  let taskScopeFilter: TaskScopeFilter = "top_level";
  let statusFilter: TaskStatus | undefined;
  let priorityFilter: TaskPriority | undefined;
  let hasAssigneeFilter = false;
  let assigneeIdFilter: UserId | null = null;
  let deliverableStatusFilter: DeliverableStatusFilter = "all";
  let overdueFilter: BooleanFilterValue = "all";
  let dueTodayFilter: BooleanFilterValue = "all";
  let dueSoonFilter: BooleanFilterValue = "all";
  let staleFilter: BooleanFilterValue = "all";
  let staleThresholdDays = DEFAULT_STALE_THRESHOLD_DAYS;
  let blockedFilter: BooleanFilterValue = "all";
  let deadlineFromFilter: Date | null = null;
  let deadlineToFilter: Date | null = null;
  let hasCustomSort = false;
  let sortByFilter: TaskSortField = "createdAt";
  let sortOrderFilter: SortDirection = "asc";

  if (filter !== undefined) {
    if (!isPlainObject(filter)) {
      throw new TenantValidationError("Task filter must be a plain object.");
    }
    if (filter.parentTaskId !== undefined) {
      parentTaskIdFilter = validateNullableObjectId(
        filter.parentTaskId,
        "parentTaskId",
      );
    }
    if (filter.taskScope !== undefined) {
      hasTaskScope = true;
      taskScopeFilter = validateTaskScopeFilter(filter.taskScope);
    }
    if (filter.status !== undefined) {
      statusFilter = validateTaskStatus(filter.status);
    }
    if (filter.priority !== undefined) {
      priorityFilter = validateTaskPriority(filter.priority);
    }
    if (filter.assigneeId !== undefined) {
      hasAssigneeFilter = true;
      assigneeIdFilter = validateAssigneeId(filter.assigneeId);
    }
    if (filter.deliverableStatus !== undefined) {
      deliverableStatusFilter = validateDeliverableStatusFilter(
        filter.deliverableStatus,
      );
    }
    if (filter.overdue !== undefined) {
      overdueFilter = validateBooleanFilter(filter.overdue, "overdue");
    }
    if (filter.dueToday !== undefined) {
      dueTodayFilter = validateBooleanFilter(filter.dueToday, "dueToday");
    }
    if (filter.dueSoon !== undefined) {
      dueSoonFilter = validateBooleanFilter(filter.dueSoon, "dueSoon");
    }
    if (filter.stale !== undefined) {
      staleFilter = validateBooleanFilter(filter.stale, "stale");
    }
    if (filter.staleThresholdDays !== undefined) {
      staleThresholdDays = validateStaleThresholdDays(filter.staleThresholdDays);
    }
    if (filter.blocked !== undefined) {
      blockedFilter = validateBooleanFilter(filter.blocked, "blocked");
    }
    if (filter.deadlineFrom !== undefined) {
      deadlineFromFilter = parseFilterDate(
        filter.deadlineFrom,
        "deadlineFrom",
        "start",
      );
    }
    if (filter.deadlineTo !== undefined) {
      deadlineToFilter = parseFilterDate(
        filter.deadlineTo,
        "deadlineTo",
        "end",
      );
    }
    if (
      deadlineFromFilter &&
      deadlineToFilter &&
      deadlineFromFilter.getTime() > deadlineToFilter.getTime()
    ) {
      throw new TenantValidationError(
        "Invalid deadline range: deadlineFrom cannot be after deadlineTo.",
      );
    }
    if (filter.sortBy !== undefined) {
      hasCustomSort = true;
      sortByFilter = validateTaskSortField(filter.sortBy, "createdAt");
      sortOrderFilter = validateSortDirection(
        filter.sortOrder,
        defaultSortDirectionForField(sortByFilter, "asc"),
      );
    } else if (filter.sortOrder !== undefined) {
      hasCustomSort = true;
      sortOrderFilter = validateSortDirection(filter.sortOrder, "asc");
    }
  }

  const mongoQuery: Record<string, unknown> = {
    organizationId: orgId,
    projectId,
  };

  const isManager = isManagerRole(membership.role);
  const { tasks } = await getCollections();

  if (!isManager) {
    if (
      hasAssigneeFilter &&
      (assigneeIdFilter === null || assigneeIdFilter !== membership.userId)
    ) {
      throw new TenantAccessError("Members can only view tasks assigned to them.");
    }
    mongoQuery.assigneeId = buildUserIdFilter(membership.userId);

    if (filter?.parentTaskId !== undefined) {
      mongoQuery.parentTaskId = parentTaskIdFilter;
    } else if (hasTaskScope && taskScopeFilter === "subtasks") {
      mongoQuery.parentTaskId = { $ne: null };
    } else if (!hasTaskScope || taskScopeFilter === "top_level") {
      const memberAssignedTasks = await tasks
        .find(
          {
            organizationId: orgId,
            projectId,
            assigneeId: buildUserIdFilter(membership.userId) as unknown as UserId,
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      const memberTaskIdSet = memberAssignedTasks.map((t) => t._id);
      mongoQuery.$or = [
        { parentTaskId: null },
        { parentTaskId: { $nin: memberTaskIdSet } },
      ];
    }
  } else {
    if (filter?.parentTaskId !== undefined) {
      mongoQuery.parentTaskId = parentTaskIdFilter;
    } else if (hasTaskScope) {
      if (taskScopeFilter === "top_level") {
        mongoQuery.parentTaskId = null;
      } else if (taskScopeFilter === "subtasks") {
        mongoQuery.parentTaskId = { $ne: null };
      }
    } else {
      mongoQuery.parentTaskId = null;
    }

    if (hasAssigneeFilter) {
      mongoQuery.assigneeId =
        assigneeIdFilter === null ? null : buildUserIdFilter(assigneeIdFilter);
    }
  }

  if (statusFilter !== undefined) {
    mongoQuery.status = statusFilter;
  }
  if (priorityFilter !== undefined) {
    mongoQuery.priority = priorityFilter;
  }
  if (deadlineFromFilter || deadlineToFilter) {
    const deadlineCond: Record<string, Date> = {};
    if (deadlineFromFilter) {
      deadlineCond.$gte = deadlineFromFilter;
    }
    if (deadlineToFilter) {
      deadlineCond.$lte = deadlineToFilter;
    }
    mongoQuery.deadline = deadlineCond;
  }

  const docs = (
    await tasks
      .find(mongoQuery)
      .sort({ createdAt: 1, _id: 1 })
      .toArray()
  ).map(normalizeTaskDoc);

  const needsDeliverables = deliverableStatusFilter !== "all";
  const needsBlockers = blockedFilter !== "all";
  const needsStaleOrActivitySort =
    staleFilter !== "all" || (hasCustomSort && sortByFilter === "lastActivity");
  const needsDeadlineHealth =
    overdueFilter !== "all" ||
    dueTodayFilter !== "all" ||
    dueSoonFilter !== "all";

  if (
    !needsDeliverables &&
    !needsBlockers &&
    !needsStaleOrActivitySort &&
    !needsDeadlineHealth &&
    !hasCustomSort
  ) {
    return docs;
  }

  const now = new Date();
  const [deliverableStatuses, blockerSummaries, lastActivityMap] =
    await Promise.all([
      needsDeliverables
        ? getOrgTasksDeliverableStatusesInternal(orgId, docs)
        : Promise.resolve(new Map<string, TaskDeliverableStatus | null>()),
      needsBlockers
        ? getOrgTasksBlockerSummariesInternal(
          orgId,
          docs.map((d) => d._id),
        )
        : Promise.resolve(new Map<string, TaskBlockerSummary>()),
      needsStaleOrActivitySort
        ? getOrgTasksLastActivityMapInternal(orgId, docs)
        : Promise.resolve(new Map<string, Date>()),
    ]);

  let filtered = docs;

  if (needsDeliverables) {
    filtered = filterTasksByDeliverableStatus(
      filtered,
      deliverableStatuses,
      deliverableStatusFilter,
    );
  }

  if (needsBlockers) {
    const wantBlocked = blockedFilter === "true";
    filtered = filtered.filter((doc) => {
      const summary = blockerSummaries.get(doc._id.toHexString());
      const isBlocked = summary?.isBlocked ?? false;
      return isBlocked === wantBlocked;
    });
  }

  if (needsDeadlineHealth) {
    filtered = filtered.filter((doc) => {
      const health = computeTaskDeadlineHealth(doc, project.status, now);
      if (
        overdueFilter !== "all" &&
        health.isOverdue !== (overdueFilter === "true")
      ) {
        return false;
      }
      if (
        dueTodayFilter !== "all" &&
        health.isDueToday !== (dueTodayFilter === "true")
      ) {
        return false;
      }
      if (
        dueSoonFilter !== "all" &&
        health.isDueSoon !== (dueSoonFilter === "true")
      ) {
        return false;
      }
      return true;
    });
  }

  if (staleFilter !== "all") {
    const wantStale = staleFilter === "true";
    filtered = filtered.filter((doc) => {
      const lastAct = lastActivityMap.get(doc._id.toHexString());
      const staleHealth = computeTaskStaleHealth(
        doc,
        project.status,
        lastAct,
        now,
        staleThresholdDays,
      );
      return staleHealth.isStale === wantStale;
    });
  }

  if (hasCustomSort) {
    filtered = sortTaskDocs(
      filtered,
      sortByFilter,
      sortOrderFilter,
      lastActivityMap,
    );
  }

  return filtered;
}

export async function listSubtasks(
  organizationId: ObjectId,
  parentTaskId: ObjectId,
  requestHeaders?: Headers,
): Promise<TaskDoc[]> {
  const membership = await requireMembership(organizationId, undefined, requestHeaders);
  requireObjectId(parentTaskId, "parentTaskId");
  const orgId = membership.organizationId;
  const { tasks } = await getCollections();
  const parentTask = await tasks.findOne({ _id: parentTaskId, organizationId: orgId });
  if (!parentTask) {
    throw new TenantValidationError("Parent task does not belong to this organization.");
  }
  const subtaskQuery: Record<string, unknown> = {
    organizationId: orgId,
    projectId: parentTask.projectId,
    parentTaskId: parentTask._id,
  };
  if (!isManagerRole(membership.role)) {
    subtaskQuery.assigneeId = buildUserIdFilter(membership.userId);
  }
  const docs = await tasks
    .find(subtaskQuery)
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
  return docs.map(normalizeTaskDoc);
}

export async function updateTask(
  organizationId: ObjectId,
  taskId: ObjectId,
  input: UpdateTaskInput,
  requestHeaders?: Headers,
): Promise<TaskDoc | null> {
  const membership = await requireMembership(organizationId, undefined, requestHeaders);
  requireObjectId(taskId, "taskId");
  if (!isPlainObject(input)) {
    throw new TenantValidationError("Task update input must be a plain object.");
  }

  const hasProjectId = input.projectId !== undefined;
  const hasParentTaskId = input.parentTaskId !== undefined;
  const hasTitle = input.title !== undefined;
  const hasDescription = input.description !== undefined;
  const hasStatus = input.status !== undefined;
  const hasPriority = input.priority !== undefined;
  const hasAssigneeId = input.assigneeId !== undefined;
  const hasDeadline = input.deadline !== undefined;
  const hasApprovalRequired = input.approvalRequired !== undefined;

  if (
    !hasProjectId &&
    !hasParentTaskId &&
    !hasTitle &&
    !hasDescription &&
    !hasStatus &&
    !hasPriority &&
    !hasAssigneeId &&
    !hasDeadline &&
    !hasApprovalRequired
  ) {
    throw new TenantValidationError(
      "At least one task field must be provided for update.",
    );
  }

  const orgId = membership.organizationId;
  const isManager = isManagerRole(membership.role);
  const { tasks, taskDependencies, activities, organizations } =
    await getCollections();

  const existing = await tasks.findOne({ _id: taskId, organizationId: orgId });
  if (!existing) {
    return null;
  }

  const targetProjectId = hasProjectId
    ? requireObjectId(input.projectId, "projectId")
    : existing.projectId;
  const projectChanged = !targetProjectId.equals(existing.projectId);

  const targetParentTaskId = hasParentTaskId
    ? validateNullableObjectId(input.parentTaskId, "parentTaskId")
    : existing.parentTaskId;
  const parentChanged = !sameNullableObjectId(targetParentTaskId, existing.parentTaskId);

  const existingAssigneeId = normalizeUserIdValue(existing.assigneeId);
  const validatedAssigneeId = hasAssigneeId
    ? validateAssigneeId(input.assigneeId)
    : existingAssigneeId;
  const assigneeChanged =
    hasAssigneeId && validatedAssigneeId !== existingAssigneeId;

  const priorityOrDeadlineSupplied = hasPriority || hasDeadline;

  if (!isManager) {
    if (existingAssigneeId !== membership.userId) {
      throw new TenantAccessError("Members can only modify tasks assigned to them.");
    }
    if (hasTitle || hasDescription) {
      throw new TenantAccessError(
        "Only admins and managers can edit task details.",
      );
    }
    if (projectChanged || parentChanged) {
      throw new TenantAccessError(
        "Only admins and managers can change a task's project or parent hierarchy.",
      );
    }
    if (hasAssigneeId || assigneeChanged) {
      throw new TenantAccessError("Only admins and managers can reassign tasks.");
    }
    if (priorityOrDeadlineSupplied) {
      throw new TenantAccessError(
        "Only admins and managers can change task priority or deadline.",
      );
    }
    if (hasApprovalRequired) {
      throw new TenantAccessError(
        "Only admins and managers can set or change task approval requirements.",
      );
    }
  }

  const updates: Partial<TaskDoc> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (hasProjectId) {
    updates.projectId = targetProjectId;
  }
  if (hasParentTaskId) {
    updates.parentTaskId = targetParentTaskId;
  }
  if (hasTitle) {
    updates.title = validateTaskTitle(input.title);
  }
  if (hasDescription) {
    updates.description = validateTaskDescription(input.description);
  }
  if (hasStatus) {
    updates.status = validateTaskStatus(input.status);
  }
  if (hasPriority) {
    updates.priority = validateTaskPriority(input.priority);
  }
  if (hasAssigneeId) {
    updates.assigneeId = validatedAssigneeId;
  }
  if (hasDeadline) {
    updates.deadline = validateTaskDeadline(input.deadline);
  }
  if (hasApprovalRequired) {
    updates.approvalRequired = validateTaskApprovalRequired(
      input.approvalRequired,
    );
  }

  const existingProject = await requireProjectInOrg(membership, existing.projectId);
  if (existingProject.status === "archived") {
    throw new TenantValidationError("Cannot modify tasks in an archived project.");
  }

  if (projectChanged) {
    const targetProject = await requireProjectInOrg(membership, targetProjectId);
    if (targetProject.status === "archived") {
      throw new TenantValidationError("Cannot move a task into an archived project.");
    }
    const linkedDependencyCount = await taskDependencies.countDocuments(
      {
        organizationId: orgId,
        $or: [
          { taskId: existing._id },
          { prerequisiteTaskId: existing._id },
        ],
      },
      { limit: 1 },
    );
    if (linkedDependencyCount > 0) {
      throw new TenantValidationError(
        "Cannot move a task with dependencies to a different project.",
      );
    }
  }

  if (projectChanged || targetParentTaskId !== null) {
    const subtaskCount = await tasks.countDocuments(
      { organizationId: orgId, parentTaskId: existing._id },
      { limit: 1 },
    );
    if (projectChanged && subtaskCount > 0) {
      throw new TenantValidationError(
        "Cannot move a task with subtasks to a different project.",
      );
    }
    if (targetParentTaskId !== null && subtaskCount > 0) {
      throw new TenantValidationError(
        "Cannot convert a task that already has subtasks into a subtask.",
      );
    }
  }

  if (targetParentTaskId !== null) {
    if (targetParentTaskId.equals(existing._id)) {
      throw new TenantValidationError("A task cannot be its own parent.");
    }
    await requireTopLevelParentTaskInProject(
      membership,
      targetProjectId,
      targetParentTaskId,
    );
  }

  if (hasAssigneeId && validatedAssigneeId !== null) {
    const assigneeMembership = await requireAssigneeInOrg(
      membership,
      validatedAssigneeId,
    );
    updates.assigneeId = assigneeMembership.userId;
  }

  const existingApprovalRequired = existing.approvalRequired === true;
  const effectiveApprovalRequired =
    updates.approvalRequired !== undefined
      ? updates.approvalRequired
      : existingApprovalRequired;
  const targetStatus =
    updates.status !== undefined ? updates.status : existing.status;

  if (
    effectiveApprovalRequired &&
    targetStatus === "done" &&
    (hasStatus ||
      existing.status !== "done" ||
      !existingApprovalRequired ||
      projectChanged)
  ) {
    await requireApprovedLatestDeliverable(
      orgId,
      targetProjectId,
      existing._id,
    );
  }

  const existingNorm = normalizeTaskDoc(existing);
  const nextTitle =
    updates.title !== undefined ? updates.title : existingNorm.title;
  const nextDescription =
    updates.description !== undefined
      ? updates.description
      : (existingNorm.description ?? null);
  const nextPriority =
    updates.priority !== undefined ? updates.priority : existingNorm.priority;
  const nextAssigneeId =
    updates.assigneeId !== undefined
      ? updates.assigneeId
      : existingNorm.assigneeId;
  const beforeDeadlineIso = existingNorm.deadline
    ? existingNorm.deadline.toISOString()
    : null;
  const afterDeadlineIso = hasDeadline
    ? updates.deadline
      ? updates.deadline.toISOString()
      : null
    : beforeDeadlineIso;

  const titleChanged = hasTitle && nextTitle !== existingNorm.title;
  const descriptionChanged =
    hasDescription && nextDescription !== (existingNorm.description ?? null);
  const statusChanged = hasStatus && targetStatus !== existingNorm.status;
  const priorityChanged = hasPriority && nextPriority !== existingNorm.priority;
  const deadlineChanged = hasDeadline && beforeDeadlineIso !== afterDeadlineIso;
  const approvalRequiredChanged =
    hasApprovalRequired &&
    effectiveApprovalRequired !== existingApprovalRequired;

  const isSubtask = targetParentTaskId !== null;
  const targetType: ActivityTargetType = isSubtask ? "subtask" : "task";
  const entityNoun = isSubtask ? "subtask" : "task";
  const baseMetadata: Record<string, ActivityFieldValue> = {
    taskTitle: nextTitle,
    parentTaskId: targetParentTaskId ? targetParentTaskId.toHexString() : null,
    isSubtask,
  };

  const activityDocs: ActivityDoc[] = [];

  if (titleChanged || descriptionChanged || parentChanged || projectChanged) {
    const editChanges: ActivityFieldChange[] = [];
    if (titleChanged) {
      editChanges.push({
        field: "title",
        before: existingNorm.title,
        after: nextTitle,
      });
    }
    if (descriptionChanged) {
      editChanges.push({
        field: "description",
        before: existingNorm.description ?? null,
        after: nextDescription,
      });
    }
    if (parentChanged) {
      editChanges.push({
        field: "parentTaskId",
        before: existingNorm.parentTaskId
          ? existingNorm.parentTaskId.toHexString()
          : null,
        after: targetParentTaskId ? targetParentTaskId.toHexString() : null,
      });
    }
    if (projectChanged) {
      editChanges.push({
        field: "projectId",
        before: existingNorm.projectId.toHexString(),
        after: targetProjectId.toHexString(),
      });
    }

    const editSummary =
      titleChanged && descriptionChanged
        ? `Updated title and description on ${entityNoun} "${nextTitle}"`
        : titleChanged
          ? `Renamed ${entityNoun} from "${existingNorm.title}" to "${nextTitle}"`
          : descriptionChanged
            ? `Updated description on ${entityNoun} "${nextTitle}"`
            : `Updated ${entityNoun} "${nextTitle}"`;

    activityDocs.push(
      buildActivityDoc({
        organizationId: orgId,
        projectId: targetProjectId,
        taskId: existing._id,
        actorId: membership.userId,
        eventType: "task.updated",
        targetType,
        targetId: existing._id,
        summary: editSummary,
        changes: editChanges,
        metadata: baseMetadata,
        createdAt: updates.updatedAt,
      }),
    );
  }

  if (statusChanged) {
    activityDocs.push(
      buildActivityDoc({
        organizationId: orgId,
        projectId: targetProjectId,
        taskId: existing._id,
        actorId: membership.userId,
        eventType: "task.status_changed",
        targetType,
        targetId: existing._id,
        summary: `Changed status of ${entityNoun} "${nextTitle}" from ${ACTIVITY_STATUS_LABELS[existingNorm.status]} to ${ACTIVITY_STATUS_LABELS[targetStatus]}`,
        changes: [
          {
            field: "status",
            before: existingNorm.status,
            after: targetStatus,
          },
        ],
        metadata: baseMetadata,
        createdAt: updates.updatedAt,
      }),
    );
  }

  if (priorityChanged) {
    activityDocs.push(
      buildActivityDoc({
        organizationId: orgId,
        projectId: targetProjectId,
        taskId: existing._id,
        actorId: membership.userId,
        eventType: "task.priority_changed",
        targetType,
        targetId: existing._id,
        summary: `Changed priority of ${entityNoun} "${nextTitle}" from ${ACTIVITY_PRIORITY_LABELS[existingNorm.priority]} to ${ACTIVITY_PRIORITY_LABELS[nextPriority]}`,
        changes: [
          {
            field: "priority",
            before: existingNorm.priority,
            after: nextPriority,
          },
        ],
        metadata: baseMetadata,
        createdAt: updates.updatedAt,
      }),
    );
  }

  if (assigneeChanged) {
    const assigneeSummary =
      nextAssigneeId === null
        ? `Unassigned ${entityNoun} "${nextTitle}"`
        : existingNorm.assigneeId === null
          ? `Assigned ${entityNoun} "${nextTitle}"`
          : `Reassigned ${entityNoun} "${nextTitle}"`;
    activityDocs.push(
      buildActivityDoc({
        organizationId: orgId,
        projectId: targetProjectId,
        taskId: existing._id,
        actorId: membership.userId,
        eventType: "task.assignee_changed",
        targetType,
        targetId: existing._id,
        summary: assigneeSummary,
        changes: [
          {
            field: "assigneeId",
            before: existingNorm.assigneeId ?? null,
            after: nextAssigneeId ?? null,
          },
        ],
        metadata: baseMetadata,
        createdAt: updates.updatedAt,
      }),
    );
  }

  if (deadlineChanged) {
    const deadlineSummary =
      afterDeadlineIso === null
        ? `Cleared deadline on ${entityNoun} "${nextTitle}"`
        : beforeDeadlineIso === null
          ? `Set deadline on ${entityNoun} "${nextTitle}" to ${afterDeadlineIso.slice(0, 10)}`
          : `Changed deadline on ${entityNoun} "${nextTitle}" from ${beforeDeadlineIso.slice(0, 10)} to ${afterDeadlineIso.slice(0, 10)}`;
    activityDocs.push(
      buildActivityDoc({
        organizationId: orgId,
        projectId: targetProjectId,
        taskId: existing._id,
        actorId: membership.userId,
        eventType: "task.deadline_changed",
        targetType,
        targetId: existing._id,
        summary: deadlineSummary,
        changes: [
          {
            field: "deadline",
            before: beforeDeadlineIso,
            after: afterDeadlineIso,
          },
        ],
        metadata: baseMetadata,
        createdAt: updates.updatedAt,
      }),
    );
  }

  if (approvalRequiredChanged) {
    activityDocs.push(
      buildActivityDoc({
        organizationId: orgId,
        projectId: targetProjectId,
        taskId: existing._id,
        actorId: membership.userId,
        eventType: "task.approval_required_changed",
        targetType,
        targetId: existing._id,
        summary: `${effectiveApprovalRequired ? "Enabled" : "Disabled"} deliverable approval requirement on ${entityNoun} "${nextTitle}"`,
        changes: [
          {
            field: "approvalRequired",
            before: existingApprovalRequired,
            after: effectiveApprovalRequired,
          },
        ],
        metadata: baseMetadata,
        createdAt: updates.updatedAt,
      }),
    );
  }

  const updated = await runInTransactionOrFallback(
    async (session) => {
      const updatedDoc = await tasks.findOneAndUpdate(
        { _id: taskId, organizationId: orgId },
        { $set: updates },
        { returnDocument: "after", session },
      );
      if (updatedDoc && activityDocs.length > 0) {
        await activities.insertMany(activityDocs, { session });
      }
      return updatedDoc;
    },
    async () => {
      const updatedDoc = await tasks.findOneAndUpdate(
        { _id: taskId, organizationId: orgId },
        { $set: updates },
        { returnDocument: "after" },
      );
      if (updatedDoc && activityDocs.length > 0) {
        await activities.insertMany(activityDocs);
      }
      return updatedDoc;
    },
  );

  if (updated) {
    const organization = await organizations.findOne({ _id: orgId });
    if (organization) {
      const effectiveProject = projectChanged
        ? await requireProjectInOrg(membership, targetProjectId)
        : existingProject;

      if (
        assigneeChanged &&
        nextAssigneeId !== null &&
        nextAssigneeId !== existingNorm.assigneeId &&
        nextAssigneeId !== membership.userId
      ) {
        await createNotificationSafe({
          organizationId: orgId,
          recipientId: nextAssigneeId,
          type: "task.assigned",
          title: `Task assigned: ${nextTitle}`,
          message: `You were assigned to "${nextTitle}" in project "${effectiveProject.name}".`,
          url: `/dashboard/${organization.slug}/projects/${targetProjectId}#task-${existing._id}`,
          entityType: "task",
          entityId: existing._id,
          projectId: targetProjectId,
          actorId: membership.userId,
          dedupeKey: `task.assigned:${existing._id.toHexString()}:${nextAssigneeId}:${updates.updatedAt.getTime()}`,
        });
      } else if (
        !assigneeChanged &&
        nextAssigneeId !== null &&
        nextAssigneeId !== membership.userId &&
        (statusChanged || priorityChanged || deadlineChanged || titleChanged)
      ) {
        const changeNotes: string[] = [];
        if (statusChanged) {
          changeNotes.push(
            `status changed to ${ACTIVITY_STATUS_LABELS[targetStatus]}`,
          );
        }
        if (priorityChanged) {
          changeNotes.push(
            `priority changed to ${ACTIVITY_PRIORITY_LABELS[nextPriority]}`,
          );
        }
        if (deadlineChanged) {
          changeNotes.push(
            afterDeadlineIso
              ? `deadline set to ${afterDeadlineIso.slice(0, 10)}`
              : "deadline cleared",
          );
        }
        if (titleChanged) {
          changeNotes.push(`renamed from "${existingNorm.title}"`);
        }
        if (changeNotes.length > 0) {
          await createNotificationSafe({
            organizationId: orgId,
            recipientId: nextAssigneeId,
            type: "task.updated",
            title: `Task updated: ${nextTitle}`,
            message: `Task "${nextTitle}" was updated: ${changeNotes.join(", ")}.`,
            url: `/dashboard/${organization.slug}/projects/${targetProjectId}#task-${existing._id}`,
            entityType: "task",
            entityId: existing._id,
            projectId: targetProjectId,
            actorId: membership.userId,
            dedupeKey: `task.updated:${existing._id.toHexString()}:${updates.updatedAt.getTime()}`,
          });
        }
      }
    }
  }

  return updated ? normalizeTaskDoc(updated) : null;
}

// ---------------------------------------------------------------------------
// Tenant-scoped deliverables & review data access
// ---------------------------------------------------------------------------

const DELIVERABLE_DESCRIPTION_MAX_LENGTH = 10000;
const DELIVERABLE_URL_MAX_LENGTH = 2048;
const REVIEW_COMMENT_MAX_LENGTH = 10000;

function validateDeliverableDescription(description: unknown): string | null {
  if (description === undefined || description === null) {
    return null;
  }
  if (typeof description !== "string") {
    throw new TenantValidationError(
      "Deliverable description must be a string or null.",
    );
  }
  if (description.length > DELIVERABLE_DESCRIPTION_MAX_LENGTH) {
    throw new TenantValidationError(
      `Deliverable description must be at most ${DELIVERABLE_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }
  return normalizeDescription(description);
}

/**
 * Identifies if a given string represents a valid Google Drive or Google Docs sharing URL.
 */
export function isGoogleDriveUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "drive.google.com" ||
      hostname === "docs.google.com" ||
      hostname.endsWith(".drive.google.com") ||
      hostname.endsWith(".docs.google.com")
    );
  } catch {
    return false;
  }
}

export function validateDeliverableUrl(url: unknown): string | null {
  if (url === undefined || url === null) {
    return null;
  }
  if (typeof url !== "string") {
    throw new TenantValidationError("Deliverable URL must be a string or null.");
  }
  const trimmed = url.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.length > DELIVERABLE_URL_MAX_LENGTH) {
    throw new TenantValidationError(
      `Deliverable URL must be at most ${DELIVERABLE_URL_MAX_LENGTH} characters.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new TenantValidationError(
      "Deliverable URL must be a valid HTTP or HTTPS URL.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TenantValidationError(
      "Deliverable URL must use the http or https protocol.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new TenantValidationError(
      "Deliverable URL must not include embedded authentication credentials.",
    );
  }
  return trimmed;
}

function validateReviewDecision(decision: unknown): ReviewDecision {
  if (
    typeof decision !== "string" ||
    !(REVIEW_DECISIONS as readonly string[]).includes(decision)
  ) {
    throw new TenantValidationError(
      `Review decision must be one of: ${REVIEW_DECISIONS.join(", ")}.`,
    );
  }
  return decision as ReviewDecision;
}

export const REVIEW_COMMENT_REQUIRED_MESSAGE =
  "A review comment is required when requesting changes.";

function validateReviewComment(
  comment: unknown,
  decision?: ReviewDecision,
): string | null {
  if (decision === "changes_requested") {
    if (
      comment === undefined ||
      comment === null ||
      typeof comment !== "string" ||
      comment.trim() === ""
    ) {
      throw new TenantValidationError(REVIEW_COMMENT_REQUIRED_MESSAGE);
    }
  }

  if (comment === undefined || comment === null) {
    return null;
  }
  if (typeof comment !== "string") {
    throw new TenantValidationError("Review comment must be a string or null.");
  }
  const trimmed = comment.trim();
  if (trimmed === "") {
    if (decision === "changes_requested") {
      throw new TenantValidationError(REVIEW_COMMENT_REQUIRED_MESSAGE);
    }
    return null;
  }
  if (trimmed.length > REVIEW_COMMENT_MAX_LENGTH) {
    throw new TenantValidationError(
      `Review comment must be at most ${REVIEW_COMMENT_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
}

export type CreateDeliverableInput = {
  projectId: ObjectId;
  taskId: ObjectId;
  description?: string | null;
  url?: string | null;
  fileIds?: string[] | null;
};

export type DeliverableWithFilesDoc = DeliverableDoc & {
  files: FileDoc[];
};

export type CreateReviewInput = {
  projectId: ObjectId;
  taskId: ObjectId;
  deliverableId: ObjectId;
  decision: ReviewDecision;
  comment?: string | null;
};

/**
 * Records a deliverable submission for `input.taskId` within `input.projectId`
 * and `organizationId`. `submittedBy` is derived from the authenticated session
 * membership. Admins and managers can submit deliverables for any task in the
 * organization; members can submit deliverables for tasks assigned to them.
 * Rejects submissions when the project is archived or the task is already marked
 * `done` (the task must be reopened before submitting a new deliverable).
 */
export async function createDeliverable(
  organizationId: ObjectId,
  input: CreateDeliverableInput,
  requestHeaders?: Headers,
): Promise<DeliverableWithFilesDoc> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  if (!isPlainObject(input)) {
    throw new TenantValidationError("Deliverable input must be a plain object.");
  }

  const project = await requireProjectInOrg(membership, input.projectId);
  if (project.status === "archived") {
    throw new TenantValidationError(
      "Cannot submit deliverables in an archived project.",
    );
  }

  const task = await requireTaskInProjectAndOrg(
    membership,
    project._id,
    input.taskId,
  );

  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only submit deliverables for tasks assigned to them.",
    );
  }

  if (task.status === "done") {
    throw new TenantValidationError(
      "Cannot submit deliverables for a completed task. Reopen the task first.",
    );
  }

  const fileObjectIds: ObjectId[] = [];
  if (input.fileIds !== undefined && input.fileIds !== null) {
    if (!Array.isArray(input.fileIds)) {
      throw new TenantValidationError("fileIds must be an array of file IDs.");
    }
    if (input.fileIds.length > 10) {
      throw new TenantValidationError(
        "A deliverable submission cannot have more than 10 files.",
      );
    }
    const seen = new Set<string>();
    for (const idStr of input.fileIds) {
      if (typeof idStr !== "string") {
        throw new TenantValidationError("Each file ID must be a string.");
      }
      if (seen.has(idStr)) {
        continue;
      }
      seen.add(idStr);
      const parsed = parseObjectId(idStr);
      if (!parsed) {
        throw new TenantValidationError(`Invalid file ID: "${idStr}".`);
      }
      fileObjectIds.push(parsed);
    }
  }

  const {
    deliverables,
    activities,
    memberships: membershipsColl,
    organizations,
    files: filesColl,
  } = await getCollections();

  let verifiedFiles: FileDoc[] = [];
  if (fileObjectIds.length > 0) {
    verifiedFiles = await filesColl
      .find({
        _id: { $in: fileObjectIds },
        organizationId: membership.organizationId,
      })
      .toArray();

    if (verifiedFiles.length !== fileObjectIds.length) {
      throw new TenantValidationError(
        "One or more referenced files do not exist in this organization.",
      );
    }

    let aggregateBytes = 0;
    for (const file of verifiedFiles) {
      if (
        !file.projectId.equals(project._id) ||
        !file.taskId.equals(task._id)
      ) {
        throw new TenantValidationError(
          "Referenced file does not belong to the specified project and task.",
        );
      }
      if (file.status === "attached") {
        throw new TenantValidationError(
          `File "${file.originalFilename}" is already attached to a deliverable.`,
        );
      }
      if (file.status === "pending") {
        throw new TenantValidationError(
          `File "${file.originalFilename}" upload has not been confirmed yet.`,
        );
      }
      if (file.status === "deleted" || file.status === "deletion_pending") {
        throw new TenantValidationError(
          `File "${file.originalFilename}" has been deleted.`,
        );
      }
      if (file.status !== "uploaded") {
        throw new TenantValidationError(
          `File "${file.originalFilename}" is not in an uploaded state.`,
        );
      }
      if (
        !isManagerRole(membership.role) &&
        file.uploadedBy !== membership.userId
      ) {
        throw new TenantAccessError(
          "You can only attach files that you uploaded.",
        );
      }
      aggregateBytes += file.fileSize;
    }

    const MAX_AGGREGATE_BYTES = 500 * 1024 * 1024; // 500 MB
    if (aggregateBytes > MAX_AGGREGATE_BYTES) {
      throw new TenantValidationError(
        "Aggregate file size exceeds the 500 MB limit per deliverable.",
      );
    }
  }

  const description = validateDeliverableDescription(input.description);
  const url = validateDeliverableUrl(input.url);

  if (description === null && url === null && verifiedFiles.length === 0) {
    throw new TenantValidationError(
      "A deliverable must include a description, a URL, or at least one attached file.",
    );
  }

  const priorCount = await deliverables.countDocuments({
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
  });
  const submissionNumber = priorCount + 1;
  const now = new Date();
  const doc: DeliverableDoc = {
    _id: new ObjectId(),
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
    submittedBy: membership.userId,
    description,
    url,
    createdAt: now,
  };
  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
    actorId: membership.userId,
    eventType: "deliverable.submitted",
    targetType: "deliverable",
    targetId: doc._id,
    summary:
      submissionNumber > 1
        ? `Submitted revised deliverable #${submissionNumber} for "${task.title}"`
        : `Submitted deliverable #${submissionNumber} for "${task.title}"`,
    changes: [
      ...(doc.description !== null && doc.description !== undefined
        ? [{ field: "description", before: null, after: doc.description }]
        : []),
      ...(doc.url !== null && doc.url !== undefined
        ? [{ field: "url", before: null, after: doc.url }]
        : []),
    ],
    metadata: {
      taskTitle: task.title,
      deliverableId: doc._id.toHexString(),
      submissionNumber,
      isRevision: submissionNumber > 1,
      parentTaskId: task.parentTaskId ? task.parentTaskId.toHexString() : null,
      attachedFileCount: verifiedFiles.length,
      fileNames: verifiedFiles.map((f) => f.originalFilename),
    },
    createdAt: now,
  });

  await runInTransactionOrFallback(
    async (session) => {
      await deliverables.insertOne(doc, { session });
      if (verifiedFiles.length > 0) {
        await filesColl.updateMany(
          {
            _id: { $in: verifiedFiles.map((f) => f._id) },
            organizationId: membership.organizationId,
          },
          {
            $set: {
              deliverableId: doc._id,
              status: "attached",
              updatedAt: now,
            },
            $unset: {
              expiresAt: "",
            },
          },
          { session },
        );
      }
      await activities.insertOne(activityDoc, { session });
    },
    async () => {
      await deliverables.insertOne(doc);
      if (verifiedFiles.length > 0) {
        await filesColl.updateMany(
          {
            _id: { $in: verifiedFiles.map((f) => f._id) },
            organizationId: membership.organizationId,
          },
          {
            $set: {
              deliverableId: doc._id,
              status: "attached",
              updatedAt: now,
            },
            $unset: {
              expiresAt: "",
            },
          },
        );
      }
      await activities.insertOne(activityDoc);
    },
  );

  const organization = await organizations.findOne({
    _id: membership.organizationId,
  });
  if (organization) {
    const adminOrManagerMembers = await membershipsColl
      .find({
        organizationId: membership.organizationId,
        role: { $in: ["admin", "manager"] },
        userId: { $ne: membership.userId },
      })
      .toArray();

    const recipientUserIds = new Set<string>();
    for (const m of adminOrManagerMembers) {
      const normalizedRecipientId = normalizeUserIdValue(m.userId);
      if (normalizedRecipientId && normalizedRecipientId !== membership.userId) {
        recipientUserIds.add(normalizedRecipientId);
      }
    }

    const userProfiles = await lookupRegisteredUsersByIds([membership.userId]);
    const submitterUser = userProfiles.get(membership.userId);
    const memberName =
      submitterUser?.name?.trim() ||
      submitterUser?.email?.trim() ||
      "A member";

    const reviewUrl = `/dashboard/${encodeURIComponent(organization.slug)}/projects/${project._id}#task-${task._id}`;
    const submissionTime = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const title = "New deliverable submitted";
    const message =
      submissionNumber > 1
        ? `${memberName} submitted revised work (revision #${submissionNumber}) for task "${task.title}" in project "${project.name}" (${organization.name}) at ${submissionTime}.`
        : `${memberName} submitted work for task "${task.title}" in project "${project.name}" (${organization.name}) at ${submissionTime}.`;

    for (const recipientId of recipientUserIds) {
      await createNotificationSafe({
        organizationId: membership.organizationId,
        recipientId,
        type: "deliverable.submitted",
        title,
        message,
        url: reviewUrl,
        entityType: "deliverable",
        entityId: doc._id,
        projectId: project._id,
        actorId: membership.userId,
        dedupeKey: `deliverable.submitted:${doc._id.toHexString()}:${recipientId}`,
      });
    }
  }

  const attachedFiles: FileDoc[] = verifiedFiles.map((f) => ({
    ...f,
    deliverableId: doc._id,
    status: "attached" as const,
    updatedAt: now,
    expiresAt: null,
  }));

  return {
    ...doc,
    files: attachedFiles,
  };
}

export async function getDeliverableById(
  organizationId: ObjectId,
  deliverableId: ObjectId,
  requestHeaders?: Headers,
): Promise<DeliverableDoc | null> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  requireObjectId(deliverableId, "deliverableId");
  const { deliverables } = await getCollections();
  return deliverables.findOne({
    _id: deliverableId,
    organizationId: membership.organizationId,
  });
}

export async function listTaskDeliverables(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  requestHeaders?: Headers,
): Promise<DeliverableWithFilesDoc[]> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  await requireProjectInOrg(membership, projectId);
  const task = await requireTaskInProjectAndOrg(membership, projectId, taskId);

  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only view deliverables for tasks assigned to them.",
    );
  }

  const { deliverables, files: filesColl } = await getCollections();
  const orgId = membership.organizationId;
  const [delivDocs, attachedFiles] = await Promise.all([
    deliverables
      .find({
        organizationId: orgId,
        projectId,
        taskId,
      })
      .sort({ createdAt: -1, _id: -1 })
      .toArray(),
    filesColl
      .find({
        organizationId: orgId,
        taskId,
        status: "attached",
      })
      .sort({ createdAt: 1, _id: 1 })
      .toArray(),
  ]);

  const filesByDeliverableId = new Map<string, FileDoc[]>();
  for (const f of attachedFiles) {
    if (f.deliverableId) {
      const hex = f.deliverableId.toHexString();
      const list = filesByDeliverableId.get(hex);
      if (list) {
        list.push(f);
      } else {
        filesByDeliverableId.set(hex, [f]);
      }
    }
  }

  return delivDocs.map((d) => ({
    ...d,
    files: filesByDeliverableId.get(d._id.toHexString()) ?? [],
  }));
}

export type DeliverableWithReviewsDoc = DeliverableDoc & {
  reviews: ReviewDoc[];
  files: FileDoc[];
};

export async function listTaskDeliverablesWithReviews(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  requestHeaders?: Headers,
): Promise<DeliverableWithReviewsDoc[]> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  await requireProjectInOrg(membership, projectId);
  const task = await requireTaskInProjectAndOrg(membership, projectId, taskId);

  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only view deliverables for tasks assigned to them.",
    );
  }

  const { deliverables, reviews, files: filesColl } = await getCollections();
  const orgId = membership.organizationId;

  const [delivDocs, reviewDocs, attachedFiles] = await Promise.all([
    deliverables
      .find({ organizationId: orgId, projectId, taskId })
      .sort({ createdAt: -1, _id: -1 })
      .toArray(),
    reviews
      .find({ organizationId: orgId, projectId, taskId })
      .sort({ createdAt: -1, _id: -1 })
      .toArray(),
    filesColl
      .find({ organizationId: orgId, taskId, status: "attached" })
      .sort({ createdAt: 1, _id: 1 })
      .toArray(),
  ]);

  const reviewsByDeliverableId = new Map<string, ReviewDoc[]>();
  for (const r of reviewDocs) {
    const delivHex = r.deliverableId.toHexString();
    const list = reviewsByDeliverableId.get(delivHex);
    if (list) {
      list.push(r);
    } else {
      reviewsByDeliverableId.set(delivHex, [r]);
    }
  }

  const filesByDeliverableId = new Map<string, FileDoc[]>();
  for (const f of attachedFiles) {
    if (f.deliverableId) {
      const hex = f.deliverableId.toHexString();
      const list = filesByDeliverableId.get(hex);
      if (list) {
        list.push(f);
      } else {
        filesByDeliverableId.set(hex, [f]);
      }
    }
  }

  return delivDocs.map((d) => ({
    ...d,
    reviews: reviewsByDeliverableId.get(d._id.toHexString()) ?? [],
    files: filesByDeliverableId.get(d._id.toHexString()) ?? [],
  }));
}

/**
 * Records a review decision (`approved` or `changes_requested`) against a
 * deliverable belonging to the specified organization, project, and task.
 * Restricted to `admin` and `manager` roles; `reviewerId` is derived from the
 * authenticated session membership. Rejects reviews when the project is
 * archived or the task is already marked `done` (the task must be reopened
 * before its deliverable can be reviewed again). Does not mutate task status
 * automatically.
 */
export async function createReview(
  organizationId: ObjectId,
  input: CreateReviewInput,
  requestHeaders?: Headers,
): Promise<ReviewDoc> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  if (!isPlainObject(input)) {
    throw new TenantValidationError("Review input must be a plain object.");
  }

  const project = await requireProjectInOrg(membership, input.projectId);
  if (project.status === "archived") {
    throw new TenantValidationError(
      "Cannot review deliverables in an archived project.",
    );
  }

  const task = await requireTaskInProjectAndOrg(
    membership,
    project._id,
    input.taskId,
  );
  const deliverable = await requireDeliverableInTaskAndOrg(
    membership,
    project._id,
    input.taskId,
    input.deliverableId,
  );

  if (task.status === "done") {
    throw new TenantValidationError(
      "Cannot review deliverables for a completed task. Reopen the task first.",
    );
  }

  const decision = validateReviewDecision(input.decision);
  const comment = validateReviewComment(input.comment, decision);

  const { reviews, activities, organizations } = await getCollections();
  const previousReview = await reviews.findOne(
    {
      organizationId: membership.organizationId,
      projectId: project._id,
      taskId: deliverable.taskId,
      deliverableId: deliverable._id,
    },
    { sort: { createdAt: -1, _id: -1 } },
  );

  const isSubsequentReview = previousReview !== null;
  const now = new Date();
  const doc: ReviewDoc = {
    _id: new ObjectId(),
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: deliverable.taskId,
    deliverableId: deliverable._id,
    reviewerId: membership.userId,
    decision,
    comment,
    createdAt: now,
  };

  const eventType: ActivityEventType = isSubsequentReview
    ? "review.decision_updated"
    : decision === "approved"
      ? "review.approved"
      : "review.changes_requested";

  const summary = isSubsequentReview
    ? `Updated review decision on "${task.title}" from ${ACTIVITY_REVIEW_LABELS[previousReview.decision]} to ${ACTIVITY_REVIEW_LABELS[decision]}`
    : decision === "approved"
      ? `Approved deliverable for "${task.title}"`
      : `Requested changes on deliverable for "${task.title}"`;

  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: deliverable.taskId,
    actorId: membership.userId,
    eventType,
    targetType: "review",
    targetId: doc._id,
    summary,
    changes: [
      {
        field: "decision",
        before: previousReview ? previousReview.decision : null,
        after: decision,
      },
      ...(comment !== null
        ? [
          {
            field: "comment",
            before: previousReview ? (previousReview.comment ?? null) : null,
            after: comment,
          },
        ]
        : []),
    ],
    metadata: {
      taskTitle: task.title,
      deliverableId: deliverable._id.toHexString(),
      reviewId: doc._id.toHexString(),
      decision,
      previousDecision: previousReview ? previousReview.decision : null,
      isSubsequentReview,
      isSelfReview: membership.userId === deliverable.submittedBy,
      parentTaskId: task.parentTaskId ? task.parentTaskId.toHexString() : null,
    },
    createdAt: now,
  });

  await runInTransactionOrFallback(
    async (session) => {
      await reviews.insertOne(doc, { session });
      await activities.insertOne(activityDoc, { session });
    },
    async () => {
      await reviews.insertOne(doc);
      await activities.insertOne(activityDoc);
    },
  );

  const organization = await organizations.findOne({
    _id: membership.organizationId,
  });
  if (organization) {
    const recipients = new Set<string>();
    if (
      deliverable.submittedBy &&
      deliverable.submittedBy !== membership.userId
    ) {
      recipients.add(deliverable.submittedBy);
    }
    if (task.assigneeId && task.assigneeId !== membership.userId) {
      recipients.add(task.assigneeId);
    }

    const decisionText =
      decision === "approved" ? "Approved" : "Changes requested";
    const commentNote =
      comment && comment.trim() !== ""
        ? ` Note: "${comment.length > 150 ? comment.slice(0, 147) + "..." : comment}"`
        : "";

    for (const recipientId of recipients) {
      await createNotificationSafe({
        organizationId: membership.organizationId,
        recipientId,
        type: "review.decided",
        title:
          decision === "approved"
            ? `Deliverable approved: ${task.title}`
            : `Changes requested: ${task.title}`,
        message: `Review decision on "${task.title}": ${decisionText}.${commentNote}`,
        url: `/dashboard/${organization.slug}/projects/${project._id}#task-${task._id}`,
        entityType: "review",
        entityId: doc._id,
        projectId: project._id,
        actorId: membership.userId,
        dedupeKey: `review.decided:${doc._id.toHexString()}:${recipientId}`,
      });
    }
  }

  return doc;
}

export async function listDeliverableReviews(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  deliverableId: ObjectId,
  requestHeaders?: Headers,
): Promise<ReviewDoc[]> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  await requireProjectInOrg(membership, projectId);
  const task = await requireTaskInProjectAndOrg(membership, projectId, taskId);
  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only view reviews for tasks assigned to them.",
    );
  }
  await requireDeliverableInTaskAndOrg(
    membership,
    projectId,
    taskId,
    deliverableId,
  );

  const { reviews } = await getCollections();
  return reviews
    .find({
      organizationId: membership.organizationId,
      projectId,
      taskId,
      deliverableId,
    })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();
}

export async function listTaskReviews(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  requestHeaders?: Headers,
): Promise<ReviewDoc[]> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  await requireProjectInOrg(membership, projectId);
  const task = await requireTaskInProjectAndOrg(membership, projectId, taskId);

  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only view reviews for tasks assigned to them.",
    );
  }

  const { reviews } = await getCollections();
  return reviews
    .find({
      organizationId: membership.organizationId,
      projectId,
      taskId,
    })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();
}

// ---------------------------------------------------------------------------
// Tenant-scoped task dependencies & blocker derivation
// ---------------------------------------------------------------------------

export const DUPLICATE_TASK_DEPENDENCY_MESSAGE =
  "This task dependency already exists.";
export const CIRCULAR_TASK_DEPENDENCY_MESSAGE =
  "Cannot add dependency: circular dependency chains are not allowed.";
export const SELF_TASK_DEPENDENCY_MESSAGE =
  "A task cannot depend on itself.";
export const ARCHIVED_PROJECT_DEPENDENCY_MESSAGE =
  "Cannot modify task dependencies in an archived project.";
export const MOVE_TASK_WITH_DEPENDENCIES_MESSAGE =
  "Cannot move a task with dependencies to a different project.";

export type AddTaskDependencyInput = {
  projectId: ObjectId;
  taskId: ObjectId;
  prerequisiteTaskId: ObjectId;
};

export type RemoveTaskDependencyInput = {
  projectId: ObjectId;
  taskId: ObjectId;
  prerequisiteTaskId: ObjectId;
};

export type TaskDependencyItem = {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  prerequisiteTaskId: string;
  prerequisiteTitle: string;
  prerequisiteStatus: TaskStatus;
  prerequisiteParentTaskId: string | null;
  /**
   * Dynamically derived from the prerequisite task's live status: `true` when
   * `prerequisiteStatus !== "done"`, `false` when `prerequisiteStatus === "done"`.
   */
  isBlocking: boolean;
  createdBy: UserId;
  createdAt: Date;
};

export type TaskBlockerSummary = {
  taskId: string;
  /**
   * Dynamically derived from `dependencies`: `true` when one or more
   * prerequisites are not yet `done`. Never stored as a manual task status.
   */
  isBlocked: boolean;
  blockerCount: number;
  dependencyCount: number;
  dependencies: TaskDependencyItem[];
  blockers: TaskDependencyItem[];
};

/**
 * Checks whether `targetHex` is reachable from `startHex` in the directed
 * dependency graph where each edge `{ taskId, prerequisiteTaskId }` points from
 * a dependent task (`taskId`) to one of its prerequisites (`prerequisiteTaskId`).
 * If `taskId` is reachable from `prerequisiteTaskId`, adding the edge
 * `taskId -> prerequisiteTaskId` would close a cycle.
 */
function hasDependencyPath(
  edges: ReadonlyArray<Pick<TaskDependencyDoc, "taskId" | "prerequisiteTaskId">>,
  startHex: string,
  targetHex: string,
): boolean {
  if (startHex === targetHex) {
    return true;
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const from = edge.taskId.toHexString();
    const to = edge.prerequisiteTaskId.toHexString();
    const existing = adjacency.get(from);
    if (existing) {
      existing.push(to);
    } else {
      adjacency.set(from, [to]);
    }
  }

  const visited = new Set<string>([startHex]);
  const queue: string[] = [startHex];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjacency.get(current);
    if (!neighbors) {
      continue;
    }
    for (const next of neighbors) {
      if (next === targetHex) {
        return true;
      }
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  return false;
}

/**
 * Adds a directed dependency so `input.taskId` depends on `input.prerequisiteTaskId`
 * within the same organization and active project. Restricted to organization
 * `admin` and `manager` roles.
 *
 * Enforces:
 * - Self-dependency rejection (`taskId` cannot equal `prerequisiteTaskId`)
 * - Same-organization and same-project membership for both tasks
 * - Archived-project restriction
 * - Duplicate dependency prevention
 * - Direct and transitive cycle prevention (`A -> B -> A`, `A -> B -> C -> A`, etc.),
 *   serialized per project inside a MongoDB transaction so concurrent requests
 *   cannot introduce cycles via write skew.
 * - Never modifies any task's workflow status.
 */
export async function addTaskDependency(
  organizationId: ObjectId,
  input: AddTaskDependencyInput,
  requestHeaders?: Headers,
): Promise<TaskDependencyDoc> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  if (!isPlainObject(input)) {
    throw new TenantValidationError(
      "Task dependency input must be a plain object.",
    );
  }

  const allowedKeys: ReadonlySet<string> = new Set([
    "projectId",
    "taskId",
    "prerequisiteTaskId",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new TenantValidationError(
        `Unexpected field "${key}". Only "projectId", "taskId", and "prerequisiteTaskId" are allowed.`,
      );
    }
  }

  const orgId = membership.organizationId;
  const actingUserId = membership.userId;
  const projectId = requireObjectId(input.projectId, "projectId");
  const taskId = requireObjectId(input.taskId, "taskId");
  const prerequisiteTaskId = requireObjectId(
    input.prerequisiteTaskId,
    "prerequisiteTaskId",
  );

  if (taskId.equals(prerequisiteTaskId)) {
    throw new TenantValidationError(SELF_TASK_DEPENDENCY_MESSAGE);
  }

  const project = await requireProjectInOrg(membership, projectId);
  if (project.status === "archived") {
    throw new TenantValidationError(ARCHIVED_PROJECT_DEPENDENCY_MESSAGE);
  }

  const dependentTask = await requireTaskInProjectAndOrg(
    membership,
    project._id,
    taskId,
  );
  const prereqTask = await requireTaskInProjectAndOrg(
    membership,
    project._id,
    prerequisiteTaskId,
  );

  const { memberships, projects, tasks, taskDependencies, activities } =
    await getCollections();

  const targetHex = taskId.toHexString();
  const startHex = prerequisiteTaskId.toHexString();

  const buildDepAddedActivity = (depDoc: TaskDependencyDoc): ActivityDoc =>
    buildActivityDoc({
      organizationId: orgId,
      projectId: project._id,
      taskId,
      actorId: actingUserId,
      eventType: "dependency.added",
      targetType: "dependency",
      targetId: depDoc._id,
      summary: `Added prerequisite "${prereqTask.title}" to "${dependentTask.title}"`,
      changes: [
        {
          field: "prerequisiteTaskId",
          before: null,
          after: prerequisiteTaskId.toHexString(),
        },
        {
          field: "prerequisiteTitle",
          before: null,
          after: prereqTask.title,
        },
      ],
      metadata: {
        taskTitle: dependentTask.title,
        prerequisiteTaskId: prerequisiteTaskId.toHexString(),
        prerequisiteTitle: prereqTask.title,
        parentTaskId: dependentTask.parentTaskId
          ? dependentTask.parentTaskId.toHexString()
          : null,
      },
      createdAt: depDoc.createdAt,
    });

  try {
    return await runInTransactionOrFallback<TaskDependencyDoc>(
      async (session) => {
        const currentActor = await memberships.findOne(
          {
            organizationId: orgId,
            userId: actingUserId,
            role: { $in: [...MANAGER_ROLES] },
          },
          { session },
        );
        if (!currentActor) {
          throw new TenantAccessError(
            "Only organization admins and managers can manage task dependencies.",
          );
        }

        const now = new Date();
        // Acquire a write lock on the parent project document inside the
        // transaction so concurrent dependency additions in the same project
        // serialize and cannot introduce a cycle through snapshot write skew.
        const lockedProject = await projects.findOneAndUpdate(
          { _id: project._id, organizationId: orgId },
          { $set: { updatedAt: now } },
          { returnDocument: "after", session },
        );
        if (!lockedProject) {
          throw new TenantValidationError(
            "Referenced project does not belong to this organization.",
          );
        }
        if (lockedProject.status === "archived") {
          throw new TenantValidationError(ARCHIVED_PROJECT_DEPENDENCY_MESSAGE);
        }

        const tasksInProject = await tasks
          .find(
            {
              _id: { $in: [taskId, prerequisiteTaskId] },
              organizationId: orgId,
              projectId: project._id,
            },
            { projection: { _id: 1 }, session },
          )
          .toArray();
        if (tasksInProject.length !== 2) {
          throw new TenantValidationError(
            "Both tasks must belong to the specified organization and project.",
          );
        }

        const existingEdge = await taskDependencies.findOne(
          {
            organizationId: orgId,
            projectId: project._id,
            taskId,
            prerequisiteTaskId,
          },
          { projection: { _id: 1 }, session },
        );
        if (existingEdge) {
          throw new TenantValidationError(DUPLICATE_TASK_DEPENDENCY_MESSAGE);
        }

        const projectEdges = await taskDependencies
          .find(
            { organizationId: orgId, projectId: project._id },
            { projection: { taskId: 1, prerequisiteTaskId: 1 }, session },
          )
          .toArray();

        if (hasDependencyPath(projectEdges, startHex, targetHex)) {
          throw new TenantValidationError(CIRCULAR_TASK_DEPENDENCY_MESSAGE);
        }

        const doc: TaskDependencyDoc = {
          _id: new ObjectId(),
          organizationId: orgId,
          projectId: project._id,
          taskId,
          prerequisiteTaskId,
          createdBy: actingUserId,
          createdAt: now,
        };

        await taskDependencies.insertOne(doc, { session });
        await activities.insertOne(buildDepAddedActivity(doc), { session });
        return doc;
      },
      async () => {
        const existingEdge = await taskDependencies.findOne(
          {
            organizationId: orgId,
            projectId: project._id,
            taskId,
            prerequisiteTaskId,
          },
          { projection: { _id: 1 } },
        );
        if (existingEdge) {
          throw new TenantValidationError(DUPLICATE_TASK_DEPENDENCY_MESSAGE);
        }

        const projectEdgesBefore = await taskDependencies
          .find(
            { organizationId: orgId, projectId: project._id },
            { projection: { taskId: 1, prerequisiteTaskId: 1 } },
          )
          .toArray();

        if (hasDependencyPath(projectEdgesBefore, startHex, targetHex)) {
          throw new TenantValidationError(CIRCULAR_TASK_DEPENDENCY_MESSAGE);
        }

        const doc: TaskDependencyDoc = {
          _id: new ObjectId(),
          organizationId: orgId,
          projectId: project._id,
          taskId,
          prerequisiteTaskId,
          createdBy: actingUserId,
          createdAt: new Date(),
        };

        await taskDependencies.insertOne(doc);

        const projectEdgesAfter = await taskDependencies
          .find(
            {
              organizationId: orgId,
              projectId: project._id,
              _id: { $ne: doc._id },
            },
            { projection: { taskId: 1, prerequisiteTaskId: 1 } },
          )
          .toArray();

        if (hasDependencyPath(projectEdgesAfter, startHex, targetHex)) {
          await taskDependencies.deleteOne({
            _id: doc._id,
            organizationId: orgId,
          });
          throw new TenantValidationError(CIRCULAR_TASK_DEPENDENCY_MESSAGE);
        }

        await activities.insertOne(buildDepAddedActivity(doc));
        return doc;
      },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new TenantValidationError(DUPLICATE_TASK_DEPENDENCY_MESSAGE);
    }
    throw error;
  }
}

/**
 * Removes a dependency edge `(taskId -> prerequisiteTaskId)` within the same
 * organization and active project. Restricted to organization `admin` and
 * `manager` roles. Never modifies any task's workflow status.
 * Returns the removed `TaskDependencyDoc`, or `null` if no matching dependency
 * edge exists for that task.
 */
export async function removeTaskDependency(
  organizationId: ObjectId,
  input: RemoveTaskDependencyInput,
  requestHeaders?: Headers,
): Promise<TaskDependencyDoc | null> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  if (!isPlainObject(input)) {
    throw new TenantValidationError(
      "Task dependency removal input must be a plain object.",
    );
  }

  const allowedKeys: ReadonlySet<string> = new Set([
    "projectId",
    "taskId",
    "prerequisiteTaskId",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new TenantValidationError(
        `Unexpected field "${key}". Only "projectId", "taskId", and "prerequisiteTaskId" are allowed.`,
      );
    }
  }

  const orgId = membership.organizationId;
  const projectId = requireObjectId(input.projectId, "projectId");
  const taskId = requireObjectId(input.taskId, "taskId");
  const prerequisiteTaskId = requireObjectId(
    input.prerequisiteTaskId,
    "prerequisiteTaskId",
  );

  const project = await requireProjectInOrg(membership, projectId);
  if (project.status === "archived") {
    throw new TenantValidationError(ARCHIVED_PROJECT_DEPENDENCY_MESSAGE);
  }

  const dependentTask = await requireTaskInProjectAndOrg(
    membership,
    project._id,
    taskId,
  );

  const { tasks, taskDependencies, activities } = await getCollections();
  const prereqTask = await tasks.findOne({
    _id: prerequisiteTaskId,
    organizationId: orgId,
    projectId: project._id,
  });
  const prereqTitle = prereqTask?.title ?? prerequisiteTaskId.toHexString();

  const buildDepRemovedActivity = (deletedDoc: TaskDependencyDoc): ActivityDoc =>
    buildActivityDoc({
      organizationId: orgId,
      projectId: project._id,
      taskId,
      actorId: membership.userId,
      eventType: "dependency.removed",
      targetType: "dependency",
      targetId: deletedDoc._id,
      summary: `Removed prerequisite "${prereqTitle}" from "${dependentTask.title}"`,
      changes: [
        {
          field: "prerequisiteTaskId",
          before: prerequisiteTaskId.toHexString(),
          after: null,
        },
        {
          field: "prerequisiteTitle",
          before: prereqTitle,
          after: null,
        },
      ],
      metadata: {
        taskTitle: dependentTask.title,
        prerequisiteTaskId: prerequisiteTaskId.toHexString(),
        prerequisiteTitle: prereqTitle,
        parentTaskId: dependentTask.parentTaskId
          ? dependentTask.parentTaskId.toHexString()
          : null,
      },
      createdAt: new Date(),
    });

  return runInTransactionOrFallback<TaskDependencyDoc | null>(
    async (session) => {
      const deleted = await taskDependencies.findOneAndDelete(
        {
          organizationId: orgId,
          projectId: project._id,
          taskId,
          prerequisiteTaskId,
        },
        { session },
      );
      if (deleted) {
        await activities.insertOne(buildDepRemovedActivity(deleted), {
          session,
        });
      }
      return deleted;
    },
    async () => {
      const deleted = await taskDependencies.findOneAndDelete({
        organizationId: orgId,
        projectId: project._id,
        taskId,
        prerequisiteTaskId,
      });
      if (deleted) {
        await activities.insertOne(buildDepRemovedActivity(deleted));
      }
      return deleted;
    },
  );
}

function buildBlockerSummaryForTask(
  taskIdHex: string,
  edges: readonly TaskDependencyDoc[],
  prereqById: ReadonlyMap<string, TaskDoc>,
): TaskBlockerSummary {
  const dependencies: TaskDependencyItem[] = [];
  for (const edge of edges) {
    const prereqHex = edge.prerequisiteTaskId.toHexString();
    const prereqTask = prereqById.get(prereqHex);
    if (!prereqTask) {
      continue;
    }
    const isBlocking = prereqTask.status !== "done";
    dependencies.push({
      id: edge._id.toHexString(),
      organizationId: edge.organizationId.toHexString(),
      projectId: edge.projectId.toHexString(),
      taskId: edge.taskId.toHexString(),
      prerequisiteTaskId: prereqHex,
      prerequisiteTitle: prereqTask.title,
      prerequisiteStatus: prereqTask.status,
      prerequisiteParentTaskId: prereqTask.parentTaskId
        ? prereqTask.parentTaskId.toHexString()
        : null,
      isBlocking,
      createdBy: edge.createdBy,
      createdAt: edge.createdAt,
    });
  }

  const blockers = dependencies.filter((item) => item.isBlocking);
  return {
    taskId: taskIdHex,
    isBlocked: blockers.length > 0,
    blockerCount: blockers.length,
    dependencyCount: dependencies.length,
    dependencies,
    blockers,
  };
}

/**
 * Retrieves the current dependency and derived blocker summary for a single
 * task within `projectId` and `organizationId`. Accessible to any authenticated
 * member of the organization (`admin`, `manager`, or `member`).
 */
export async function getTaskDependencySummary(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  requestHeaders?: Headers,
): Promise<TaskBlockerSummary> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const orgId = membership.organizationId;
  await requireProjectInOrg(membership, projectId);
  const task = await requireTaskInProjectAndOrg(membership, projectId, taskId);

  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only view dependencies for tasks assigned to them.",
    );
  }

  const { tasks, taskDependencies } = await getCollections();
  const edges = await taskDependencies
    .find({
      organizationId: orgId,
      projectId,
      taskId,
    })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();

  if (edges.length === 0) {
    return {
      taskId: taskId.toHexString(),
      isBlocked: false,
      blockerCount: 0,
      dependencyCount: 0,
      dependencies: [],
      blockers: [],
    };
  }

  const prereqIds = edges.map((edge) => edge.prerequisiteTaskId);
  const prereqDocs = await tasks
    .find({
      _id: { $in: prereqIds },
      organizationId: orgId,
      projectId,
    })
    .toArray();

  const prereqById = new Map<string, TaskDoc>();
  for (const doc of prereqDocs) {
    prereqById.set(doc._id.toHexString(), normalizeTaskDoc(doc));
  }

  return buildBlockerSummaryForTask(taskId.toHexString(), edges, prereqById);
}

/**
 * Lists all prerequisite dependencies (and their live completion/blocking status)
 * for `taskId` within `projectId` and `organizationId`.
 */
export async function listTaskDependencies(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  requestHeaders?: Headers,
): Promise<TaskDependencyItem[]> {
  const summary = await getTaskDependencySummary(
    organizationId,
    projectId,
    taskId,
    requestHeaders,
  );
  return summary.dependencies;
}

/**
 * Computes derived blocker and dependency summaries for a batch of tasks in
 * `projectId` and `organizationId` using two indexed queries.
 */
export async function getTasksBlockerSummaries(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskIds: readonly ObjectId[],
  requestHeaders?: Headers,
): Promise<Map<string, TaskBlockerSummary>> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const orgId = membership.organizationId;
  await requireProjectInOrg(membership, projectId);

  const result = new Map<string, TaskBlockerSummary>();
  if (taskIds.length === 0) {
    return result;
  }

  const validatedTaskIds = taskIds.map((id) => requireObjectId(id, "taskId"));
  for (const id of validatedTaskIds) {
    const hex = id.toHexString();
    result.set(hex, {
      taskId: hex,
      isBlocked: false,
      blockerCount: 0,
      dependencyCount: 0,
      dependencies: [],
      blockers: [],
    });
  }

  const { tasks, taskDependencies } = await getCollections();
  const edges = await taskDependencies
    .find({
      organizationId: orgId,
      projectId,
      taskId: { $in: validatedTaskIds },
    })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();

  if (edges.length === 0) {
    return result;
  }

  const prereqIdMap = new Map<string, ObjectId>();
  const edgesByTaskHex = new Map<string, TaskDependencyDoc[]>();
  for (const edge of edges) {
    const prereqHex = edge.prerequisiteTaskId.toHexString();
    if (!prereqIdMap.has(prereqHex)) {
      prereqIdMap.set(prereqHex, edge.prerequisiteTaskId);
    }
    const taskHex = edge.taskId.toHexString();
    const list = edgesByTaskHex.get(taskHex);
    if (list) {
      list.push(edge);
    } else {
      edgesByTaskHex.set(taskHex, [edge]);
    }
  }

  const prereqDocs = await tasks
    .find({
      _id: { $in: Array.from(prereqIdMap.values()) },
      organizationId: orgId,
      projectId,
    })
    .toArray();

  const prereqById = new Map<string, TaskDoc>();
  for (const doc of prereqDocs) {
    prereqById.set(doc._id.toHexString(), normalizeTaskDoc(doc));
  }

  for (const [taskHex, taskEdges] of edgesByTaskHex.entries()) {
    result.set(
      taskHex,
      buildBlockerSummaryForTask(taskHex, taskEdges, prereqById),
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tenant-scoped task deliverable workflow status derivation
// ---------------------------------------------------------------------------

export type TaskDeliverableStatusItem = {
  _id: ObjectId;
  approvalRequired: boolean;
};

/**
 * Computes derived deliverable workflow statuses for a batch of tasks within
 * `projectId` and `organizationId` using at most two indexed aggregation queries.
 *
 * Status derivation rules:
 * 1. `needs_submission`: `approvalRequired === true` and no deliverable exists.
 * 2. `in_review`: a current deliverable exists but has no review.
 * 3. `changes_requested`: the latest review on the current deliverable has decision `changes_requested`.
 * 4. `approved`: the latest review on the current deliverable has decision `approved`.
 * 5. `null`: approval is not required and no deliverable exists.
 *
 * Superseded deliverables and their historical reviews never determine the current status.
 */
export async function getTasksDeliverableStatuses(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskList: readonly TaskDeliverableStatusItem[],
  requestHeaders?: Headers,
): Promise<Map<string, TaskDeliverableStatus | null>> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const orgId = membership.organizationId;
  await requireProjectInOrg(membership, projectId);

  const result = new Map<string, TaskDeliverableStatus | null>();
  if (taskList.length === 0) {
    return result;
  }

  const taskIds: ObjectId[] = [];
  const approvalRequiredByTaskId = new Map<string, boolean>();

  for (const item of taskList) {
    const id = requireObjectId(item._id, "taskId");
    const hex = id.toHexString();
    taskIds.push(id);
    approvalRequiredByTaskId.set(hex, item.approvalRequired === true);
    // Default when no deliverable exists
    result.set(hex, item.approvalRequired === true ? "needs_submission" : null);
  }

  const { deliverables, reviews } = await getCollections();

  // 1. Find the latest deliverable for each task (sorted by createdAt DESC, _id DESC)
  const latestDeliverables = await deliverables
    .aggregate<{
      _id: ObjectId; // taskId
      deliverableId: ObjectId;
      createdAt: Date;
    }>([
      {
        $match: {
          organizationId: orgId,
          projectId,
          taskId: { $in: taskIds },
        },
      },
      {
        $sort: { createdAt: -1, _id: -1 },
      },
      {
        $group: {
          _id: "$taskId",
          deliverableId: { $first: "$_id" },
          createdAt: { $first: "$createdAt" },
        },
      },
    ])
    .toArray();

  if (latestDeliverables.length === 0) {
    return result;
  }

  const latestDeliverableIds = latestDeliverables.map((d) => d.deliverableId);
  const deliverableToTaskHex = new Map<string, string>();
  for (const d of latestDeliverables) {
    const taskHex = d._id.toHexString();
    deliverableToTaskHex.set(d.deliverableId.toHexString(), taskHex);
    // Deliverable exists; initial state before reviews is "in_review"
    result.set(taskHex, "in_review");
  }

  // 2. Find the latest review for each of those latest deliverables
  const latestReviews = await reviews
    .aggregate<{
      _id: ObjectId; // deliverableId
      decision: ReviewDecision;
      createdAt: Date;
    }>([
      {
        $match: {
          organizationId: orgId,
          taskId: { $in: taskIds },
          deliverableId: { $in: latestDeliverableIds },
        },
      },
      {
        $sort: { createdAt: -1, _id: -1 },
      },
      {
        $group: {
          _id: "$deliverableId",
          decision: { $first: "$decision" },
          createdAt: { $first: "$createdAt" },
        },
      },
    ])
    .toArray();

  for (const rev of latestReviews) {
    const taskHex = deliverableToTaskHex.get(rev._id.toHexString());
    if (taskHex) {
      if (rev.decision === "changes_requested") {
        result.set(taskHex, "changes_requested");
      } else if (rev.decision === "approved") {
        result.set(taskHex, "approved");
      }
    }
  }

  return result;
}

/**
 * Computes the deliverable workflow status for a single task.
 */
export async function getTaskDeliverableStatus(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  approvalRequired: boolean,
  requestHeaders?: Headers,
): Promise<TaskDeliverableStatus | null> {
  const map = await getTasksDeliverableStatuses(
    organizationId,
    projectId,
    [{ _id: taskId, approvalRequired }],
    requestHeaders,
  );
  return map.get(taskId.toHexString()) ?? null;
}

// ---------------------------------------------------------------------------
// Deliverable workflow status filter validation and utilities
// ---------------------------------------------------------------------------

export const DELIVERABLE_STATUS_FILTER_VALUES = [
  "all",
  "needs_submission",
  "in_review",
  "changes_requested",
  "approved",
] as const;

export type DeliverableStatusFilter =
  (typeof DELIVERABLE_STATUS_FILTER_VALUES)[number];

export function validateDeliverableStatusFilter(
  value: unknown,
): DeliverableStatusFilter {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "all"
  ) {
    return "all";
  }
  if (
    typeof value !== "string" ||
    !DELIVERABLE_STATUS_FILTER_VALUES.includes(value as DeliverableStatusFilter)
  ) {
    throw new TenantValidationError(
      `Invalid deliverableStatus filter "${String(value)}". Supported values: all, needs_submission, in_review, changes_requested, approved.`,
    );
  }
  return value as DeliverableStatusFilter;
}

export function filterTasksByDeliverableStatus<T extends { _id: ObjectId }>(
  tasks: readonly T[],
  deliverableStatuses: ReadonlyMap<string, TaskDeliverableStatus | null>,
  filter: DeliverableStatusFilter,
): T[] {
  if (filter === "all") {
    return [...tasks];
  }
  return tasks.filter(
    (task) => deliverableStatuses.get(task._id.toHexString()) === filter,
  );
}

// ---------------------------------------------------------------------------
// Tenant-scoped activity history & audit trail retrieval
// ---------------------------------------------------------------------------

export const DEFAULT_ACTIVITY_PAGE_LIMIT = 25;
export const MAX_ACTIVITY_PAGE_LIMIT = 100;

export type ActivityActor = {
  userId: UserId;
  name: string | null;
  email: string | null;
  role: MembershipRole | null;
};

export type ActivityFieldChangeItem = {
  field: string;
  before: ActivityFieldValue;
  after: ActivityFieldValue;
  beforeDisplay: string | null;
  afterDisplay: string | null;
};

export type ActivityItem = {
  id: string;
  organizationId: string;
  projectId: string | null;
  taskId: string | null;
  actorId: UserId;
  actor: ActivityActor;
  eventType: ActivityEventType;
  targetType: ActivityTargetType;
  targetId: string;
  summary: string;
  changes: ActivityFieldChangeItem[];
  metadata: Record<string, ActivityFieldValue> | null;
  createdAt: Date;
};

export type ActivityPage = {
  activities: ActivityItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type ListActivityOptions = {
  limit?: unknown;
  cursor?: unknown;
};

export function validateActivityLimit(rawLimit: unknown): number {
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
    return DEFAULT_ACTIVITY_PAGE_LIMIT;
  }
  const num =
    typeof rawLimit === "number"
      ? rawLimit
      : typeof rawLimit === "string" && /^\d+$/.test(rawLimit.trim())
        ? Number.parseInt(rawLimit.trim(), 10)
        : Number.NaN;
  if (
    !Number.isInteger(num) ||
    num < 1 ||
    num > MAX_ACTIVITY_PAGE_LIMIT
  ) {
    throw new TenantValidationError(
      `Invalid limit: must be an integer between 1 and ${MAX_ACTIVITY_PAGE_LIMIT}.`,
    );
  }
  return num;
}

export function encodeActivityCursor(
  doc: Pick<ActivityDoc, "_id" | "createdAt">,
): string {
  return `${doc.createdAt.toISOString()}_${doc._id.toHexString()}`;
}

export function parseActivityCursor(
  rawCursor: unknown,
): { createdAt: Date; id: ObjectId } | null {
  if (rawCursor === undefined || rawCursor === null || rawCursor === "") {
    return null;
  }
  if (typeof rawCursor !== "string") {
    throw new TenantValidationError("Invalid pagination cursor.");
  }
  const trimmed = rawCursor.trim();
  const separatorIndex = trimmed.lastIndexOf("_");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new TenantValidationError("Invalid pagination cursor.");
  }
  const isoPart = trimmed.slice(0, separatorIndex);
  const idPart = trimmed.slice(separatorIndex + 1);
  const createdAt = new Date(isoPart);
  const id = parseObjectId(idPart);
  if (Number.isNaN(createdAt.getTime()) || !id) {
    throw new TenantValidationError("Invalid pagination cursor.");
  }
  return { createdAt, id };
}

function formatActivityFieldValue(
  field: string,
  value: ActivityFieldValue,
  profilesById: ReadonlyMap<UserId, { name: string | null; email: string | null }>,
): string | null {
  if (field === "assigneeId" || field === "ownerId" || field === "participantId") {
    if (value === null || value === "") {
      return field === "participantId" ? "None" : "Unassigned";
    }
    const userId = String(value);
    const profile = profilesById.get(userId);
    if (profile?.name) {
      return `${profile.name} (${userId})`;
    }
    if (profile?.email) {
      return `${profile.email} (${userId})`;
    }
    return userId;
  }

  if (field === "deadline" || field === "targetDate" || field === "meetingDate") {
    if (value === null || value === "") {
      return field === "targetDate"
        ? "No target date"
        : field === "meetingDate"
          ? "Not set"
          : "No deadline";
    }
    return String(value).slice(0, 10);
  }

  if (field === "approvalRequired") {
    if (value === null) return null;
    return value === true ? "Required" : "Not required";
  }

  if (field === "archived") {
    if (value === null) return null;
    return value === true ? "Archived" : "Active";
  }

  if (field === "status") {
    if (value === null) return null;
    if (typeof value === "string" && value in ACTIVITY_STATUS_LABELS) {
      return ACTIVITY_STATUS_LABELS[value as TaskStatus];
    }
    if (value === "active") return "Active";
    if (value === "archived") return "Archived";
    if (value === "scheduled") return "Scheduled";
    if (value === "completed") return "Completed";
    if (value === "cancelled") return "Cancelled";
    if (value === "open") return "Open";
    return String(value);
  }

  if (field === "priority") {
    if (value === null) return null;
    if (typeof value === "string" && value in ACTIVITY_PRIORITY_LABELS) {
      return ACTIVITY_PRIORITY_LABELS[value as TaskPriority];
    }
    return String(value);
  }

  if (field === "decision") {
    if (value === null) return null;
    if (typeof value === "string" && value in ACTIVITY_REVIEW_LABELS) {
      return ACTIVITY_REVIEW_LABELS[value as ReviewDecision];
    }
    return String(value);
  }

  if (value === null) {
    return "None";
  }
  return String(value);
}

async function hydrateActivityItems(
  organizationId: ObjectId,
  docs: readonly ActivityDoc[],
): Promise<ActivityItem[]> {
  if (docs.length === 0) {
    return [];
  }

  const userIdSet = new Set<UserId>();
  for (const doc of docs) {
    userIdSet.add(doc.actorId);
    for (const change of doc.changes ?? []) {
      if (
        change.field === "assigneeId" ||
        change.field === "ownerId" ||
        change.field === "participantId"
      ) {
        if (typeof change.before === "string" && change.before.trim() !== "") {
          userIdSet.add(change.before.trim());
        }
        if (typeof change.after === "string" && change.after.trim() !== "") {
          userIdSet.add(change.after.trim());
        }
      }
    }
  }

  const allUserIds = Array.from(userIdSet);
  const { memberships } = await getCollections();
  const [profilesById, memberDocs] = await Promise.all([
    lookupRegisteredUsersByIds(allUserIds),
    memberships
      .find(
        { organizationId, userId: { $in: allUserIds } },
        { projection: { _id: 0, userId: 1, role: 1 } },
      )
      .toArray(),
  ]);

  const roleByUserId = new Map<UserId, MembershipRole>();
  for (const m of memberDocs) {
    roleByUserId.set(m.userId, m.role);
  }

  return docs.map((doc) => {
    const actorProfile = profilesById.get(doc.actorId);
    const actorRole = roleByUserId.get(doc.actorId) ?? null;
    const changes: ActivityFieldChangeItem[] = (doc.changes ?? []).map(
      (change) => ({
        field: change.field,
        before: change.before,
        after: change.after,
        beforeDisplay: formatActivityFieldValue(
          change.field,
          change.before,
          profilesById,
        ),
        afterDisplay: formatActivityFieldValue(
          change.field,
          change.after,
          profilesById,
        ),
      }),
    );

    return {
      id: doc._id.toHexString(),
      organizationId: doc.organizationId.toHexString(),
      projectId: doc.projectId ? doc.projectId.toHexString() : null,
      taskId: doc.taskId ? doc.taskId.toHexString() : null,
      actorId: doc.actorId,
      actor: {
        userId: doc.actorId,
        name: actorProfile?.name ?? null,
        email: actorProfile?.email ?? null,
        role: actorRole,
      },
      eventType: doc.eventType,
      targetType: doc.targetType,
      targetId: doc.targetId.toHexString(),
      summary: doc.summary,
      changes,
      metadata: doc.metadata ?? null,
      createdAt: doc.createdAt,
    };
  });
}

async function queryPaginatedActivities(
  organizationId: ObjectId,
  baseFilter: Record<string, unknown>,
  options?: ListActivityOptions,
): Promise<ActivityPage> {
  const limit = validateActivityLimit(options?.limit);
  const cursor = parseActivityCursor(options?.cursor);

  const filter: Record<string, unknown> = {
    ...baseFilter,
    organizationId,
  };

  if (cursor) {
    const cursorConditions = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
    ];
    if (baseFilter.$or) {
      delete filter.$or;
      const existingAnd = Array.isArray(baseFilter.$and) ? baseFilter.$and : [];
      filter.$and = [
        ...existingAnd,
        { $or: baseFilter.$or as Record<string, unknown>[] },
        { $or: cursorConditions },
      ];
    } else {
      filter.$or = cursorConditions;
    }
  }

  const { activities } = await getCollections();
  const docs = await activities
    .find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();

  const hasMore = docs.length > limit;
  const pageDocs = hasMore ? docs.slice(0, limit) : docs;
  const nextCursor =
    hasMore && pageDocs.length > 0
      ? encodeActivityCursor(pageDocs[pageDocs.length - 1])
      : null;

  const items = await hydrateActivityItems(organizationId, pageDocs);
  return {
    activities: items,
    nextCursor,
    hasMore,
  };
}

/**
 * Lists organization-wide activity in deterministic newest-first order with
 * cursor pagination. Accessible to organization admins of `organizationId`.
 */
export async function listOrganizationActivity(
  organizationId: ObjectId,
  options?: ListActivityOptions,
  requestHeaders?: Headers,
): Promise<ActivityPage> {
  const membership = await requireMembership(
    organizationId,
    ADMIN_ROLES,
    requestHeaders,
  );
  return queryPaginatedActivities(membership.organizationId, {}, options);
}

/**
 * Lists project-scoped activity (including all task, subtask, dependency,
 * deliverable, and review events within the project) in deterministic
 * newest-first order with cursor pagination. Preserves read access on archived
 * projects. Admins see all project activity; Managers see their own activity
 * plus activity from Members assigned to tasks within this project.
 */
export async function listProjectActivity(
  organizationId: ObjectId,
  projectId: ObjectId,
  options?: ListActivityOptions,
  requestHeaders?: Headers,
): Promise<ActivityPage> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);

  if (membership.role === "admin") {
    return queryPaginatedActivities(
      membership.organizationId,
      { projectId: project._id },
      options,
    );
  }

  // Manager:
  // 1. Activity created by the authenticated Manager themselves within the authorized project.
  // 2. Activity created by Members belonging to the same organization who are assigned to tasks within that project.
  // Hide: activity created by Admins, other Managers, Members not assigned to tasks in the project,
  // or Member activity not associated with their assigned tasks.
  const { tasks, memberships } = await getCollections();
  const projectTasks = await tasks
    .find(
      {
        organizationId: membership.organizationId,
        projectId: project._id,
        assigneeId: { $ne: null },
      },
      { projection: { _id: 1, assigneeId: 1 } },
    )
    .toArray();

  const candidateAssigneeIds = Array.from(
    new Set(
      projectTasks
        .map((t) => normalizeUserIdValue(t.assigneeId))
        .filter((id): id is string => id !== null),
    ),
  );

  const memberTaskMap = new Map<string, ObjectId[]>();

  if (candidateAssigneeIds.length > 0) {
    const memberMemberships = await memberships
      .find(
        {
          organizationId: membership.organizationId,
          userId: { $in: candidateAssigneeIds },
          role: "member",
        },
        { projection: { userId: 1, role: 1 } },
      )
      .toArray();

    const verifiedMemberUserIds = new Set(
      memberMemberships
        .map((m) => normalizeUserIdValue(m.userId))
        .filter((id): id is string => id !== null),
    );

    for (const task of projectTasks) {
      const normalizedAssignee = normalizeUserIdValue(task.assigneeId);
      if (normalizedAssignee && verifiedMemberUserIds.has(normalizedAssignee)) {
        const existing = memberTaskMap.get(normalizedAssignee);
        if (existing) {
          existing.push(task._id);
        } else {
          memberTaskMap.set(normalizedAssignee, [task._id]);
        }
      }
    }
  }

  const orClauses: Record<string, unknown>[] = [
    { actorId: membership.userId },
  ];

  for (const [memberId, taskIds] of memberTaskMap.entries()) {
    orClauses.push({
      actorId: memberId,
      taskId: taskIds.length === 1 ? taskIds[0] : { $in: taskIds },
    });
  }

  const activityFilter: Record<string, unknown> = {
    projectId: project._id,
  };

  if (orClauses.length === 1) {
    activityFilter.actorId = membership.userId;
  } else {
    activityFilter.$or = orClauses;
  }

  return queryPaginatedActivities(
    membership.organizationId,
    activityFilter,
    options,
  );
}

/**
 * Lists task-scoped activity (including task/subtask updates, dependency
 * mutations, deliverable submissions, and review decisions for that task) in
 * deterministic newest-first order with cursor pagination. Preserves read access
 * on archived projects.
 */
export async function listTaskActivity(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  options?: ListActivityOptions,
  requestHeaders?: Headers,
): Promise<ActivityPage> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);
  const task = await requireTaskInProjectAndOrg(membership, project._id, taskId);

  let activityFilter: Record<string, unknown>;

  if (membership.role === "admin") {
    // Admin: Can see all activity entries across all tasks within authorized organization
    activityFilter = {
      projectId: project._id,
      taskId: task._id,
    };
  } else if (membership.role === "manager") {
    // Manager: Can see:
    // - Activity entries created by the Manager themselves on tasks they are authorized to manage.
    // - Activity entries created by Members working under that Manager, on tasks assigned to those Members within the Manager's organization.
    // - Cannot see activity entries created by other Managers or Admins.
    const allowedActorIds: string[] = [membership.userId];

    if (task.assigneeId) {
      const { memberships } = await getCollections();
      const assigneeMembership = await memberships.findOne(
        {
          organizationId: membership.organizationId,
          userId: task.assigneeId,
        },
        { projection: { role: 1 } },
      );

      if (assigneeMembership && assigneeMembership.role === "member") {
        allowedActorIds.push(task.assigneeId);
      }
    }

    activityFilter = {
      projectId: project._id,
      taskId: task._id,
      actorId:
        allowedActorIds.length === 1
          ? allowedActorIds[0]
          : { $in: allowedActorIds },
    };
  } else {
    // Member: Can see only activity entries created by that Member themselves,
    // and only on tasks assigned to them.
    if (task.assigneeId !== membership.userId) {
      throw new TenantAccessError(
        "Members can only view activity for tasks assigned to them.",
      );
    }

    activityFilter = {
      projectId: project._id,
      taskId: task._id,
      actorId: membership.userId,
    };
  }

  return queryPaginatedActivities(
    membership.organizationId,
    activityFilter,
    options,
  );
}

// ---------------------------------------------------------------------------
// Phase 5: Supervision System — Overdue, Stale, Advanced Filters & Reports
// ---------------------------------------------------------------------------

export const DEFAULT_STALE_THRESHOLD_DAYS = 7;
export const MIN_STALE_THRESHOLD_DAYS = 1;
export const MAX_STALE_THRESHOLD_DAYS = 365;

export const DEFAULT_DUE_SOON_DAYS = 7;

export const DEFAULT_SUPERVISION_TASK_PAGE_LIMIT = 25;
export const MAX_SUPERVISION_TASK_PAGE_LIMIT = 100;

export const MEANINGFUL_TASK_ACTIVITY_EVENT_TYPES: readonly ActivityEventType[] = [
  "task.created",
  "subtask.created",
  "task.updated",
  "task.status_changed",
  "task.priority_changed",
  "task.assignee_changed",
  "task.deadline_changed",
  "task.approval_required_changed",
  "dependency.added",
  "dependency.removed",
  "deliverable.submitted",
  "review.approved",
  "review.changes_requested",
  "review.decision_updated",
  "action_item.converted_to_task",
] as const;

export const TASK_DEADLINE_STATES = [
  "overdue",
  "due_today",
  "due_soon",
  "scheduled",
  "completed",
  "archived",
  "none",
] as const;
export type TaskDeadlineState = (typeof TASK_DEADLINE_STATES)[number];

export const TASK_SORT_FIELDS = [
  "deadline",
  "priority",
  "createdAt",
  "lastActivity",
  "status",
] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export const BOOLEAN_FILTER_VALUES = ["all", "true", "false"] as const;
export type BooleanFilterValue = (typeof BOOLEAN_FILTER_VALUES)[number];

export const TASK_SCOPE_FILTER_VALUES = [
  "all",
  "top_level",
  "subtasks",
] as const;
export type TaskScopeFilter = (typeof TASK_SCOPE_FILTER_VALUES)[number];

export const PROJECT_SCOPE_FILTER_VALUES = [
  "active",
  "archived",
  "all",
] as const;
export type ProjectScopeFilter = (typeof PROJECT_SCOPE_FILTER_VALUES)[number];

const PRIORITY_SORT_RANK: Record<TaskPriority, number> = {
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

const STATUS_SORT_RANK: Record<TaskStatus, number> = {
  todo: 1,
  in_progress: 2,
  done: 3,
};

export function validateStaleThresholdDays(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_STALE_THRESHOLD_DAYS;
  }
  const num =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
        ? Number.parseInt(raw.trim(), 10)
        : Number.NaN;
  if (
    !Number.isInteger(num) ||
    num < MIN_STALE_THRESHOLD_DAYS ||
    num > MAX_STALE_THRESHOLD_DAYS
  ) {
    throw new TenantValidationError(
      `Invalid staleThresholdDays: must be an integer between ${MIN_STALE_THRESHOLD_DAYS} and ${MAX_STALE_THRESHOLD_DAYS}.`,
    );
  }
  return num;
}

export function validateBooleanFilter(
  raw: unknown,
  fieldName = "filter",
): BooleanFilterValue {
  if (raw === undefined || raw === null || raw === "" || raw === "all") {
    return "all";
  }
  if (raw === true || raw === "true" || raw === "1") {
    return "true";
  }
  if (raw === false || raw === "false" || raw === "0") {
    return "false";
  }
  throw new TenantValidationError(
    `Invalid ${fieldName} filter "${String(raw)}". Supported values: all, true, false.`,
  );
}

export function validateTaskPriorityFilter(
  raw: unknown,
): TaskPriority | "all" {
  if (raw === undefined || raw === null || raw === "" || raw === "all") {
    return "all";
  }
  if (
    typeof raw === "string" &&
    (TASK_PRIORITIES as readonly string[]).includes(raw)
  ) {
    return raw as TaskPriority;
  }
  throw new TenantValidationError(
    `Invalid priority filter "${String(raw)}". Supported values: all, ${TASK_PRIORITIES.join(", ")}.`,
  );
}

export function validateTaskStatusFilter(raw: unknown): TaskStatus | "all" {
  if (raw === undefined || raw === null || raw === "" || raw === "all") {
    return "all";
  }
  if (
    typeof raw === "string" &&
    (TASK_STATUSES as readonly string[]).includes(raw)
  ) {
    return raw as TaskStatus;
  }
  throw new TenantValidationError(
    `Invalid status filter "${String(raw)}". Supported values: all, ${TASK_STATUSES.join(", ")}.`,
  );
}

export function validateProjectScopeFilter(raw: unknown): ProjectScopeFilter {
  if (raw === undefined || raw === null || raw === "" || raw === "active") {
    return "active";
  }
  if (raw === "archived" || raw === "all") {
    return raw;
  }
  throw new TenantValidationError(
    `Invalid projectStatus filter "${String(raw)}". Supported values: active, archived, all.`,
  );
}

export function validateTaskScopeFilter(raw: unknown): TaskScopeFilter {
  if (raw === undefined || raw === null || raw === "" || raw === "all") {
    return "all";
  }
  if (
    raw === "top_level" ||
    raw === "parent" ||
    raw === "root" ||
    raw === "task" ||
    raw === "tasks"
  ) {
    return "top_level";
  }
  if (raw === "subtasks" || raw === "subtask") {
    return "subtasks";
  }
  throw new TenantValidationError(
    `Invalid taskScope filter "${String(raw)}". Supported values: all, top_level, subtasks.`,
  );
}

export function validateTaskSortField(
  raw: unknown,
  defaultSort: TaskSortField = "createdAt",
): TaskSortField {
  if (raw === undefined || raw === null || raw === "") {
    return defaultSort;
  }
  if (raw === "deadline") return "deadline";
  if (raw === "priority") return "priority";
  if (raw === "createdAt" || raw === "created") return "createdAt";
  if (
    raw === "lastActivity" ||
    raw === "lastActivityAt" ||
    raw === "activity" ||
    raw === "updatedAt"
  ) {
    return "lastActivity";
  }
  if (raw === "status") return "status";
  throw new TenantValidationError(
    `Invalid sortBy parameter "${String(raw)}". Supported values: deadline, priority, createdAt, lastActivity, status.`,
  );
}

export function defaultSortDirectionForField(
  field: TaskSortField,
  fallback: SortDirection = "asc",
): SortDirection {
  switch (field) {
    case "deadline":
      return "asc";
    case "priority":
      return "desc";
    case "lastActivity":
      return "desc";
    case "status":
      return "asc";
    case "createdAt":
    default:
      return fallback;
  }
}

export function validateSortDirection(
  raw: unknown,
  defaultOrder: SortDirection = "asc",
): SortDirection {
  if (raw === undefined || raw === null || raw === "") {
    return defaultOrder;
  }
  if (raw === "asc" || raw === "desc") {
    return raw;
  }
  throw new TenantValidationError(
    `Invalid sortOrder parameter "${String(raw)}". Supported values: asc, desc.`,
  );
}

export function parseFilterDate(
  raw: unknown,
  fieldName: string,
  mode: "start" | "end",
): Date | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      throw new TenantValidationError(
        `Invalid ${fieldName}: must be a valid date.`,
      );
    }
    return raw;
  }
  if (typeof raw !== "string") {
    throw new TenantValidationError(
      `Invalid ${fieldName}: must be an ISO date string.`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const suffix = mode === "end" ? "T23:59:59.999Z" : "T00:00:00.000Z";
    const parsedDay = new Date(`${trimmed}${suffix}`);
    if (Number.isNaN(parsedDay.getTime())) {
      throw new TenantValidationError(
        `Invalid ${fieldName}: must be a valid YYYY-MM-DD or ISO date string.`,
      );
    }
    return parsedDay;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new TenantValidationError(
      `Invalid ${fieldName}: must be a valid ISO date string.`,
    );
  }
  return parsed;
}

export function validateSupervisionPageLimit(
  rawLimit: unknown,
  defaultLimit = DEFAULT_SUPERVISION_TASK_PAGE_LIMIT,
): number {
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
    return defaultLimit;
  }
  const num =
    typeof rawLimit === "number"
      ? rawLimit
      : typeof rawLimit === "string" && /^\d+$/.test(rawLimit.trim())
        ? Number.parseInt(rawLimit.trim(), 10)
        : Number.NaN;
  if (
    !Number.isInteger(num) ||
    num < 1 ||
    num > MAX_SUPERVISION_TASK_PAGE_LIMIT
  ) {
    throw new TenantValidationError(
      `Invalid limit: must be an integer between 1 and ${MAX_SUPERVISION_TASK_PAGE_LIMIT}.`,
    );
  }
  return num;
}

export function validateSupervisionPageNumber(rawPage: unknown): number {
  if (rawPage === undefined || rawPage === null || rawPage === "") {
    return 1;
  }
  const num =
    typeof rawPage === "number"
      ? rawPage
      : typeof rawPage === "string" && /^\d+$/.test(rawPage.trim())
        ? Number.parseInt(rawPage.trim(), 10)
        : Number.NaN;
  if (!Number.isInteger(num) || num < 1 || num > 10000) {
    throw new TenantValidationError(
      "Invalid page: must be a positive integer.",
    );
  }
  return num;
}

export type TaskDeadlineHealth = {
  isOverdue: boolean;
  isDueToday: boolean;
  isDueSoon: boolean;
  deadlineState: TaskDeadlineState;
};

/**
 * Dynamically derives overdue, due-today, and due-soon status from a task's
 * deadline, status, and project status at server evaluation time.
 *
 * Rules (Phase 5.3):
 * - Completed tasks (`status === "done"`) are never overdue, due today, or due soon.
 * - Tasks in archived projects (`projectStatus === "archived"`) are excluded from
 *   active overdue, due-today, and due-soon indicators.
 * - Tasks without a valid deadline have `deadlineState === "none"`.
 * - Date-only deadlines stored as midnight UTC (`00:00:00.000Z`) are evaluated
 *   against the end of that UTC calendar day (`23:59:59.999Z`), so a deadline set
 *   to today's UTC date is classified as `due_today` throughout that UTC day and
 *   becomes `overdue` once that UTC day ends.
 * - Explicit non-midnight timestamps are compared against `now` (with a 60-second
 *   grace window on the current UTC day so a deadline created via `new Date()` is
 *   recognized as `due_today` rather than immediately overdue).
 */
export function computeTaskDeadlineHealth(
  task: Pick<TaskDoc, "deadline" | "status">,
  projectStatus: ProjectStatus,
  now: Date = new Date(),
  dueSoonDays: number = DEFAULT_DUE_SOON_DAYS,
): TaskDeadlineHealth {
  const d = task.deadline;
  if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) {
    return {
      isOverdue: false,
      isDueToday: false,
      isDueSoon: false,
      deadlineState:
        task.status === "done"
          ? "completed"
          : projectStatus === "archived"
            ? "archived"
            : "none",
    };
  }

  if (projectStatus === "archived") {
    return {
      isOverdue: false,
      isDueToday: false,
      isDueSoon: false,
      deadlineState: "archived",
    };
  }

  if (task.status === "done") {
    return {
      isOverdue: false,
      isDueToday: false,
      isDueSoon: false,
      deadlineState: "completed",
    };
  }

  const isMidnightUtc =
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;

  const isSameUtcDay =
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate();

  const effectiveDeadlineMs = isMidnightUtc
    ? Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      23,
      59,
      59,
      999,
    )
    : isSameUtcDay && now.getTime() - d.getTime() >= 0 && now.getTime() - d.getTime() < 60_000
      ? now.getTime() + 1_000
      : d.getTime();

  const nowMs = now.getTime();

  if (effectiveDeadlineMs < nowMs) {
    return {
      isOverdue: true,
      isDueToday: false,
      isDueSoon: false,
      deadlineState: "overdue",
    };
  }

  if (isSameUtcDay) {
    return {
      isOverdue: false,
      isDueToday: true,
      isDueSoon: false,
      deadlineState: "due_today",
    };
  }

  const dueSoonEndMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + dueSoonDays,
    23,
    59,
    59,
    999,
  );

  if (effectiveDeadlineMs <= dueSoonEndMs) {
    return {
      isOverdue: false,
      isDueToday: false,
      isDueSoon: true,
      deadlineState: "due_soon",
    };
  }

  return {
    isOverdue: false,
    isDueToday: false,
    isDueSoon: false,
    deadlineState: "scheduled",
  };
}

export type TaskStaleHealth = {
  isStale: boolean;
  lastActivityAt: Date;
  daysSinceActivity: number;
};

/**
 * Dynamically derives stale status from a task's last meaningful activity
 * timestamp, status, and project status.
 *
 * Rules (Phase 5.4):
 * - Belongs to an active project (`projectStatus === "active"`).
 * - Task status is not `"done"`.
 * - Time elapsed since `lastActivityAt` meets or exceeds `staleThresholdDays`
 *   (default 7 days).
 */
export function computeTaskStaleHealth(
  task: Pick<TaskDoc, "status" | "createdAt" | "updatedAt">,
  projectStatus: ProjectStatus,
  lastActivityAt: Date | null | undefined,
  now: Date = new Date(),
  staleThresholdDays: number = DEFAULT_STALE_THRESHOLD_DAYS,
): TaskStaleHealth {
  const effectiveLastActivity =
    lastActivityAt instanceof Date && !Number.isNaN(lastActivityAt.getTime())
      ? lastActivityAt
      : task.updatedAt instanceof Date && !Number.isNaN(task.updatedAt.getTime())
        ? task.updatedAt
        : task.createdAt;

  const elapsedMs = Math.max(
    0,
    now.getTime() - effectiveLastActivity.getTime(),
  );
  const daysSinceActivity = Math.floor(elapsedMs / 86_400_000);
  const thresholdMs = staleThresholdDays * 86_400_000;

  const isStale =
    projectStatus === "active" &&
    task.status !== "done" &&
    elapsedMs >= thresholdMs;

  return {
    isStale,
    lastActivityAt: effectiveLastActivity,
    daysSinceActivity,
  };
}

/**
 * Internal batch helper: resolves the latest meaningful activity timestamp per
 * task from the `activities` collection using a single indexed aggregation query,
 * falling back to `task.updatedAt ?? task.createdAt` when no activity record
 * exists for a task.
 */
async function getOrgTasksLastActivityMapInternal(
  organizationId: ObjectId,
  taskDocs: readonly TaskDoc[],
): Promise<Map<string, Date>> {
  const result = new Map<string, Date>();
  if (taskDocs.length === 0) {
    return result;
  }

  const taskIds: ObjectId[] = [];
  const taskByHex = new Map<string, TaskDoc>();
  for (const doc of taskDocs) {
    const hex = doc._id.toHexString();
    taskIds.push(doc._id);
    taskByHex.set(hex, doc);
    result.set(hex, doc.updatedAt ?? doc.createdAt);
  }

  const { activities } = await getCollections();
  const rows = await activities
    .aggregate<{
      _id: ObjectId;
      lastActivityAt: Date;
      activityCount: number;
    }>([
      {
        $match: {
          organizationId,
          taskId: { $in: taskIds },
          eventType: { $in: [...MEANINGFUL_TASK_ACTIVITY_EVENT_TYPES] },
        },
      },
      {
        $group: {
          _id: "$taskId",
          lastActivityAt: { $max: "$createdAt" },
          activityCount: { $sum: 1 },
        },
      },
    ])
    .toArray();

  for (const row of rows) {
    if (!row._id || !(row.lastActivityAt instanceof Date)) continue;
    const hex = row._id.toHexString();
    const taskDoc = taskByHex.get(hex);
    if (
      taskDoc &&
      row.activityCount === 1 &&
      taskDoc.updatedAt instanceof Date &&
      taskDoc.updatedAt.getTime() < row.lastActivityAt.getTime()
    ) {
      // If only the initial creation activity exists and the task document's
      // updatedAt was explicitly backdated earlier than creation, honor the
      // earlier timestamp.
      result.set(hex, taskDoc.updatedAt);
    } else {
      result.set(hex, row.lastActivityAt);
    }
  }

  return result;
}

/**
 * Public tenant-scoped batch helper for retrieving last meaningful activity
 * timestamps for a list of tasks in `organizationId`.
 */
export async function getTasksLastActivityMap(
  organizationId: ObjectId,
  taskDocs: readonly TaskDoc[],
  requestHeaders?: Headers,
): Promise<Map<string, Date>> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  return getOrgTasksLastActivityMapInternal(
    membership.organizationId,
    taskDocs,
  );
}

/**
 * Internal batch helper: computes deliverable statuses across any set of tasks
 * in `organizationId` (spanning one or multiple projects) using at most two
 * indexed aggregation queries.
 */
async function getOrgTasksDeliverableStatusesInternal(
  organizationId: ObjectId,
  taskList: readonly TaskDeliverableStatusItem[],
): Promise<Map<string, TaskDeliverableStatus | null>> {
  const result = new Map<string, TaskDeliverableStatus | null>();
  if (taskList.length === 0) {
    return result;
  }

  const taskIds: ObjectId[] = [];
  for (const item of taskList) {
    const id = requireObjectId(item._id, "taskId");
    const hex = id.toHexString();
    taskIds.push(id);
    result.set(hex, item.approvalRequired === true ? "needs_submission" : null);
  }

  const { deliverables, reviews } = await getCollections();

  const latestDeliverables = await deliverables
    .aggregate<{
      _id: ObjectId;
      deliverableId: ObjectId;
      createdAt: Date;
    }>([
      {
        $match: {
          organizationId,
          taskId: { $in: taskIds },
        },
      },
      {
        $sort: { createdAt: -1, _id: -1 },
      },
      {
        $group: {
          _id: "$taskId",
          deliverableId: { $first: "$_id" },
          createdAt: { $first: "$createdAt" },
        },
      },
    ])
    .toArray();

  if (latestDeliverables.length === 0) {
    return result;
  }

  const latestDeliverableIds = latestDeliverables.map((d) => d.deliverableId);
  const deliverableToTaskHex = new Map<string, string>();
  for (const d of latestDeliverables) {
    const taskHex = d._id.toHexString();
    deliverableToTaskHex.set(d.deliverableId.toHexString(), taskHex);
    result.set(taskHex, "in_review");
  }

  const latestReviews = await reviews
    .aggregate<{
      _id: ObjectId;
      decision: ReviewDecision;
      createdAt: Date;
    }>([
      {
        $match: {
          organizationId,
          taskId: { $in: taskIds },
          deliverableId: { $in: latestDeliverableIds },
        },
      },
      {
        $sort: { createdAt: -1, _id: -1 },
      },
      {
        $group: {
          _id: "$deliverableId",
          decision: { $first: "$decision" },
          createdAt: { $first: "$createdAt" },
        },
      },
    ])
    .toArray();

  for (const rev of latestReviews) {
    const taskHex = deliverableToTaskHex.get(rev._id.toHexString());
    if (taskHex) {
      if (rev.decision === "changes_requested") {
        result.set(taskHex, "changes_requested");
      } else if (rev.decision === "approved") {
        result.set(taskHex, "approved");
      }
    }
  }

  return result;
}

/**
 * Internal batch helper: computes blocker summaries across any set of tasks in
 * `organizationId` (spanning one or multiple projects) using at most two indexed
 * queries.
 */
async function getOrgTasksBlockerSummariesInternal(
  organizationId: ObjectId,
  taskIds: readonly ObjectId[],
): Promise<Map<string, TaskBlockerSummary>> {
  const result = new Map<string, TaskBlockerSummary>();
  if (taskIds.length === 0) {
    return result;
  }

  const validatedTaskIds = taskIds.map((id) => requireObjectId(id, "taskId"));
  for (const id of validatedTaskIds) {
    const hex = id.toHexString();
    result.set(hex, {
      taskId: hex,
      isBlocked: false,
      blockerCount: 0,
      dependencyCount: 0,
      dependencies: [],
      blockers: [],
    });
  }

  const { tasks, taskDependencies } = await getCollections();
  const edges = await taskDependencies
    .find({
      organizationId,
      taskId: { $in: validatedTaskIds },
    })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();

  if (edges.length === 0) {
    return result;
  }

  const prereqIdMap = new Map<string, ObjectId>();
  const edgesByTaskHex = new Map<string, TaskDependencyDoc[]>();
  for (const edge of edges) {
    const prereqHex = edge.prerequisiteTaskId.toHexString();
    if (!prereqIdMap.has(prereqHex)) {
      prereqIdMap.set(prereqHex, edge.prerequisiteTaskId);
    }
    const taskHex = edge.taskId.toHexString();
    const list = edgesByTaskHex.get(taskHex);
    if (list) {
      list.push(edge);
    } else {
      edgesByTaskHex.set(taskHex, [edge]);
    }
  }

  const prereqDocs = await tasks
    .find({
      _id: { $in: Array.from(prereqIdMap.values()) },
      organizationId,
    })
    .toArray();

  const prereqById = new Map<string, TaskDoc>();
  for (const doc of prereqDocs) {
    prereqById.set(doc._id.toHexString(), normalizeTaskDoc(doc));
  }

  for (const [taskHex, taskEdges] of edgesByTaskHex.entries()) {
    result.set(
      taskHex,
      buildBlockerSummaryForTask(taskHex, taskEdges, prereqById),
    );
  }

  return result;
}

function sortTaskDocs(
  docs: readonly TaskDoc[],
  sortBy: TaskSortField,
  sortOrder: SortDirection,
  lastActivityMap: ReadonlyMap<string, Date>,
): TaskDoc[] {
  const dir = sortOrder === "asc" ? 1 : -1;
  return [...docs].sort((a, b) => {
    const hexA = a._id.toHexString();
    const hexB = b._id.toHexString();

    if (sortBy === "deadline") {
      const hasA = a.deadline instanceof Date && !Number.isNaN(a.deadline.getTime());
      const hasB = b.deadline instanceof Date && !Number.isNaN(b.deadline.getTime());
      if (hasA && !hasB) return -1;
      if (!hasA && hasB) return 1;
      if (hasA && hasB) {
        const diff = a.deadline!.getTime() - b.deadline!.getTime();
        if (diff !== 0) return diff * dir;
      }
    } else if (sortBy === "priority") {
      const diff = PRIORITY_SORT_RANK[a.priority] - PRIORITY_SORT_RANK[b.priority];
      if (diff !== 0) return diff * dir;
    } else if (sortBy === "status") {
      const diff = STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status];
      if (diff !== 0) return diff * dir;
    } else if (sortBy === "lastActivity") {
      const timeA = (lastActivityMap.get(hexA) ?? a.updatedAt ?? a.createdAt).getTime();
      const timeB = (lastActivityMap.get(hexB) ?? b.updatedAt ?? b.createdAt).getTime();
      const diff = timeA - timeB;
      if (diff !== 0) return diff * dir;
    } else {
      const diff = a.createdAt.getTime() - b.createdAt.getTime();
      if (diff !== 0) return diff * dir;
    }

    return hexA.localeCompare(hexB) * dir;
  });
}

export type EnrichedTaskAssignee = {
  userId: UserId;
  name: string | null;
  email: string | null;
  role: MembershipRole | null;
};

export type SerializedTaskAssignee = {
  id: string;
  name: string | null;
  email: string | null;
  role: MembershipRole | null;
};

export function serializeTaskAssignee(
  assignee: EnrichedTaskAssignee | null,
): SerializedTaskAssignee | null {
  if (!assignee) {
    return null;
  }
  return {
    id: assignee.userId,
    name: assignee.name,
    email: assignee.email,
    role: assignee.role,
  };
}

export type EnrichedTaskItem = {
  id: string;
  organizationId: string;
  projectId: string;
  projectName: string;
  projectStatus: ProjectStatus;
  parentTaskId: string | null;
  parentTaskTitle: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: UserId | null;
  assignee: EnrichedTaskAssignee | null;
  createdBy: UserId;
  deadline: Date | null;
  approvalRequired: boolean;
  sourceMeetingId: string | null;
  sourceMeetingTitle: string | null;
  sourceActionItemId: string | null;
  sourceActionItemTitle: string | null;
  isBlocked: boolean;
  blockerCount: number;
  dependencyCount: number;
  dependencies: TaskDependencyItem[];
  deliverableStatus: TaskDeliverableStatus | null;
  isOverdue: boolean;
  isDueToday: boolean;
  isDueSoon: boolean;
  deadlineState: TaskDeadlineState;
  isStale: boolean;
  lastActivityAt: Date;
  daysSinceActivity: number;
  createdAt: Date;
  updatedAt: Date;
};

export function sortEnrichedTasks(
  items: readonly EnrichedTaskItem[],
  sortBy: TaskSortField,
  sortOrder: SortDirection,
): EnrichedTaskItem[] {
  const dir = sortOrder === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (sortBy === "deadline") {
      const hasA = a.deadline !== null;
      const hasB = b.deadline !== null;
      if (hasA && !hasB) return -1;
      if (!hasA && hasB) return 1;
      if (hasA && hasB) {
        const diff = a.deadline!.getTime() - b.deadline!.getTime();
        if (diff !== 0) return diff * dir;
      }
    } else if (sortBy === "priority") {
      const diff = PRIORITY_SORT_RANK[a.priority] - PRIORITY_SORT_RANK[b.priority];
      if (diff !== 0) return diff * dir;
    } else if (sortBy === "status") {
      const diff = STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status];
      if (diff !== 0) return diff * dir;
    } else if (sortBy === "lastActivity") {
      const diff = a.lastActivityAt.getTime() - b.lastActivityAt.getTime();
      if (diff !== 0) return diff * dir;
    } else {
      const diff = a.createdAt.getTime() - b.createdAt.getTime();
      if (diff !== 0) return diff * dir;
    }
    return a.id.localeCompare(b.id) * dir;
  });
}

async function hydrateEnrichedTasksInternal(
  organizationId: ObjectId,
  taskDocs: readonly TaskDoc[],
  projectsByHex: ReadonlyMap<string, ProjectDoc>,
  options?: {
    staleThresholdDays?: number;
    now?: Date;
  },
): Promise<EnrichedTaskItem[]> {
  if (taskDocs.length === 0) {
    return [];
  }

  const now = options?.now ?? new Date();
  const staleThresholdDays =
    options?.staleThresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;

  const taskIds = taskDocs.map((d) => d._id);
  const parentIdsToLookup = new Map<string, ObjectId>();
  const taskTitleByHex = new Map<string, string>();
  const assigneeIds = new Set<UserId>();
  const sourceMeetingIdsToLookup = new Map<string, ObjectId>();
  const sourceActionItemIdsToLookup = new Map<string, ObjectId>();

  for (const doc of taskDocs) {
    taskTitleByHex.set(doc._id.toHexString(), doc.title);
    if (doc.assigneeId) {
      assigneeIds.add(doc.assigneeId);
    }
    if (doc.sourceMeetingId) {
      const mHex = doc.sourceMeetingId.toHexString();
      if (!sourceMeetingIdsToLookup.has(mHex)) {
        sourceMeetingIdsToLookup.set(mHex, doc.sourceMeetingId);
      }
    }
    if (doc.sourceActionItemId) {
      const aiHex = doc.sourceActionItemId.toHexString();
      if (!sourceActionItemIdsToLookup.has(aiHex)) {
        sourceActionItemIdsToLookup.set(aiHex, doc.sourceActionItemId);
      }
    }
  }
  for (const doc of taskDocs) {
    if (doc.parentTaskId) {
      const pHex = doc.parentTaskId.toHexString();
      if (!taskTitleByHex.has(pHex) && !parentIdsToLookup.has(pHex)) {
        parentIdsToLookup.set(pHex, doc.parentTaskId);
      }
    }
  }

  const { tasks, memberships, meetings, meetingActionItems } = await getCollections();
  const assigneeIdList = Array.from(assigneeIds);

  const [
    deliverableStatuses,
    blockerSummaries,
    lastActivityMap,
    missingParents,
    profilesById,
    memberDocs,
    sourceMeetings,
    sourceActionItems,
  ] = await Promise.all([
    getOrgTasksDeliverableStatusesInternal(organizationId, taskDocs),
    getOrgTasksBlockerSummariesInternal(organizationId, taskIds),
    getOrgTasksLastActivityMapInternal(organizationId, taskDocs),
    parentIdsToLookup.size > 0
      ? tasks
        .find(
          {
            _id: { $in: Array.from(parentIdsToLookup.values()) },
            organizationId,
          },
          { projection: { _id: 1, title: 1 } },
        )
        .toArray()
      : Promise.resolve([]),
    assigneeIdList.length > 0
      ? lookupRegisteredUsersByIds(assigneeIdList)
      : Promise.resolve(new Map<UserId, { name: string | null; email: string | null }>()),
    assigneeIdList.length > 0
      ? memberships
        .find(
          { organizationId, userId: { $in: assigneeIdList } },
          { projection: { _id: 0, userId: 1, role: 1 } },
        )
        .toArray()
      : Promise.resolve([]),
    sourceMeetingIdsToLookup.size > 0
      ? meetings
        .find(
          {
            _id: { $in: Array.from(sourceMeetingIdsToLookup.values()) },
            organizationId,
          },
          { projection: { _id: 1, title: 1 } },
        )
        .toArray()
      : Promise.resolve([]),
    sourceActionItemIdsToLookup.size > 0
      ? meetingActionItems
        .find(
          {
            _id: { $in: Array.from(sourceActionItemIdsToLookup.values()) },
            organizationId,
          },
          { projection: { _id: 1, title: 1, meetingId: 1 } },
        )
        .toArray()
      : Promise.resolve([]),
  ]);

  for (const p of missingParents) {
    taskTitleByHex.set(p._id.toHexString(), p.title);
  }

  const sourceMeetingTitleByHex = new Map<string, string>();
  for (const m of sourceMeetings) {
    sourceMeetingTitleByHex.set(m._id.toHexString(), m.title);
  }

  const sourceActionItemTitleByHex = new Map<string, string>();
  const sourceActionItemMeetingHexByHex = new Map<string, string>();
  for (const ai of sourceActionItems) {
    const aiHex = ai._id.toHexString();
    sourceActionItemTitleByHex.set(aiHex, ai.title);
    sourceActionItemMeetingHexByHex.set(aiHex, ai.meetingId.toHexString());
  }

  const roleByUserId = new Map<UserId, MembershipRole>();
  for (const m of memberDocs) {
    roleByUserId.set(m.userId, m.role);
  }

  return taskDocs.map((doc) => {
    const hex = doc._id.toHexString();
    const projHex = doc.projectId.toHexString();
    const project = projectsByHex.get(projHex);
    const projectStatus: ProjectStatus = project?.status ?? "active";
    const projectName = project?.name ?? projHex;
    const parentHex = doc.parentTaskId ? doc.parentTaskId.toHexString() : null;
    const parentTaskTitle = parentHex
      ? (taskTitleByHex.get(parentHex) ?? null)
      : null;
    const sourceActionItemHex = doc.sourceActionItemId
      ? doc.sourceActionItemId.toHexString()
      : null;
    const sourceMeetingHex = doc.sourceMeetingId
      ? doc.sourceMeetingId.toHexString()
      : sourceActionItemHex
        ? (sourceActionItemMeetingHexByHex.get(sourceActionItemHex) ?? null)
        : null;
    const sourceMeetingTitle = sourceMeetingHex
      ? (sourceMeetingTitleByHex.get(sourceMeetingHex) ?? null)
      : null;
    const sourceActionItemTitle = sourceActionItemHex
      ? (sourceActionItemTitleByHex.get(sourceActionItemHex) ?? null)
      : null;

    const blockerSummary = blockerSummaries.get(hex);
    const deliverableStatus = deliverableStatuses.get(hex) ?? null;
    const deadlineHealth = computeTaskDeadlineHealth(doc, projectStatus, now);
    const staleHealth = computeTaskStaleHealth(
      doc,
      projectStatus,
      lastActivityMap.get(hex),
      now,
      staleThresholdDays,
    );

    let assignee: EnrichedTaskAssignee | null = null;
    if (doc.assigneeId) {
      const profile = profilesById.get(doc.assigneeId);
      assignee = {
        userId: doc.assigneeId,
        name: profile?.name ?? null,
        email: profile?.email ?? null,
        role: roleByUserId.get(doc.assigneeId) ?? null,
      };
    }

    return {
      id: hex,
      organizationId: doc.organizationId.toHexString(),
      projectId: projHex,
      projectName,
      projectStatus,
      parentTaskId: parentHex,
      parentTaskTitle,
      title: doc.title,
      description: doc.description ?? null,
      status: doc.status,
      priority: doc.priority,
      assigneeId: doc.assigneeId,
      assignee,
      createdBy: doc.createdBy,
      deadline: doc.deadline ?? null,
      approvalRequired: doc.approvalRequired === true,
      sourceMeetingId: sourceMeetingHex,
      sourceMeetingTitle,
      sourceActionItemId: sourceActionItemHex,
      sourceActionItemTitle,
      isBlocked: blockerSummary?.isBlocked ?? false,
      blockerCount: blockerSummary?.blockerCount ?? 0,
      dependencyCount: blockerSummary?.dependencyCount ?? 0,
      dependencies: blockerSummary?.dependencies ?? [],
      deliverableStatus,
      isOverdue: deadlineHealth.isOverdue,
      isDueToday: deadlineHealth.isDueToday,
      isDueSoon: deadlineHealth.isDueSoon,
      deadlineState: deadlineHealth.deadlineState,
      isStale: staleHealth.isStale,
      lastActivityAt: staleHealth.lastActivityAt,
      daysSinceActivity: staleHealth.daysSinceActivity,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  });
}

export type QueryTasksOptions = {
  projectId?: unknown;
  projectStatus?: unknown;
  includeArchived?: unknown;
  status?: unknown;
  priority?: unknown;
  assigneeId?: unknown;
  deadlineFrom?: unknown;
  deadlineTo?: unknown;
  overdue?: unknown;
  dueToday?: unknown;
  dueSoon?: unknown;
  stale?: unknown;
  staleThresholdDays?: unknown;
  blocked?: unknown;
  deliverableStatus?: unknown;
  parentTaskId?: unknown;
  taskScope?: unknown;
  sortBy?: unknown;
  sortOrder?: unknown;
  page?: unknown;
  limit?: unknown;
};

export type TaskHealthSummaryCounts = {
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  notStartedTasks: number;
  blockedTasks: number;
  overdueTasks: number;
  staleTasks: number;
  tasksDueToday: number;
  tasksDueSoon: number;
  awaitingSubmissionTasks: number;
  awaitingReviewTasks: number;
  completionPercentage: number;
};

export type QueryTasksResult = {
  tasks: EnrichedTaskItem[];
  summary: TaskHealthSummaryCounts;
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
  filters: {
    projectId: string | null;
    projectStatus: ProjectScopeFilter;
    status: TaskStatus | "all";
    priority: TaskPriority | "all";
    assigneeId: string | "unassigned" | "all";
    deadlineFrom: string | null;
    deadlineTo: string | null;
    overdue: BooleanFilterValue;
    dueToday: BooleanFilterValue;
    dueSoon: BooleanFilterValue;
    stale: BooleanFilterValue;
    staleThresholdDays: number;
    blocked: BooleanFilterValue;
    deliverableStatus: DeliverableStatusFilter;
    parentTaskId: string | null;
    taskScope: TaskScopeFilter;
  };
  sort: {
    sortBy: TaskSortField;
    sortOrder: SortDirection;
  };
};

function computeSummaryFromEnrichedTasks(
  items: readonly EnrichedTaskItem[],
): TaskHealthSummaryCounts {
  let completedTasks = 0;
  let inProgressTasks = 0;
  let notStartedTasks = 0;
  let blockedTasks = 0;
  let overdueTasks = 0;
  let staleTasks = 0;
  let tasksDueToday = 0;
  let tasksDueSoon = 0;
  let awaitingSubmissionTasks = 0;
  let awaitingReviewTasks = 0;

  for (const item of items) {
    if (item.status === "done") {
      completedTasks++;
    } else if (item.status === "in_progress") {
      inProgressTasks++;
    } else {
      notStartedTasks++;
    }

    if (item.status !== "done" && item.isBlocked) {
      blockedTasks++;
    }
    if (item.isOverdue) {
      overdueTasks++;
    }
    if (item.isStale) {
      staleTasks++;
    }
    if (item.isDueToday) {
      tasksDueToday++;
    }
    if (item.isDueSoon) {
      tasksDueSoon++;
    }
    if (
      item.status !== "done" &&
      (item.deliverableStatus === "needs_submission" ||
        item.deliverableStatus === "changes_requested")
    ) {
      awaitingSubmissionTasks++;
    }
    if (item.deliverableStatus === "in_review") {
      awaitingReviewTasks++;
    }
  }

  const totalTasks = items.length;
  const completionPercentage =
    totalTasks > 0
      ? Math.round((completedTasks / totalTasks) * 10000) / 100
      : 0;

  return {
    totalTasks,
    completedTasks,
    inProgressTasks,
    notStartedTasks,
    blockedTasks,
    overdueTasks,
    staleTasks,
    tasksDueToday,
    tasksDueSoon,
    awaitingSubmissionTasks,
    awaitingReviewTasks,
    completionPercentage,
  };
}

/**
 * Enriches a single task document with live dependency/blocker summary,
 * deliverable workflow status, deadline health (overdue/due-today/due-soon),
 * and staleness health (lastActivityAt, daysSinceActivity, isStale).
 */
export async function enrichSingleTask(
  organizationId: ObjectId,
  project: ProjectDoc,
  task: TaskDoc,
  requestHeaders?: Headers,
): Promise<EnrichedTaskItem> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const projectsByHex = new Map<string, ProjectDoc>([
    [project._id.toHexString(), project],
  ]);
  const items = await hydrateEnrichedTasksInternal(
    membership.organizationId,
    [normalizeTaskDoc(task)],
    projectsByHex,
  );
  return items[0];
}

/**
 * Project-scoped task query with full Phase 5.2–5.4 filtering, sorting, and
 * health enrichment. Accessible to any authenticated member of `organizationId`.
 */
export async function queryProjectTasks(
  organizationId: ObjectId,
  projectId: ObjectId,
  options?: QueryTasksOptions,
  requestHeaders?: Headers,
): Promise<QueryTasksResult> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const orgId = membership.organizationId;
  const project = await requireProjectInOrg(membership, projectId);

  const statusFilter = validateTaskStatusFilter(options?.status);
  const priorityFilter = validateTaskPriorityFilter(options?.priority);

  let assigneeFilterMode: "all" | "unassigned" | "member" = "all";
  let assigneeIdFilter: UserId | null = null;
  if (
    options?.assigneeId !== undefined &&
    options.assigneeId !== null &&
    options.assigneeId !== "" &&
    options.assigneeId !== "all"
  ) {
    if (options.assigneeId === "null" || options.assigneeId === "unassigned") {
      assigneeFilterMode = "unassigned";
      assigneeIdFilter = null;
    } else {
      assigneeFilterMode = "member";
      assigneeIdFilter = validateAssigneeId(options.assigneeId);
    }
  }

  let parentMode: "top_level" | "subtasks" | "all" | "specific" = "top_level";
  let specificParentId: ObjectId | null = null;

  if (
    options?.parentTaskId !== undefined &&
    options.parentTaskId !== ""
  ) {
    const rawParent = options.parentTaskId;
    if (rawParent === null || rawParent === "null" || rawParent === "top_level") {
      parentMode = "top_level";
    } else if (rawParent === "all") {
      parentMode = "all";
    } else if (rawParent === "subtasks" || rawParent === "subtask") {
      parentMode = "subtasks";
    } else if (rawParent instanceof ObjectId) {
      parentMode = "specific";
      specificParentId = rawParent;
    } else if (typeof rawParent === "string") {
      const parsedParent = parseObjectId(rawParent.trim());
      if (!parsedParent) {
        throw new TenantValidationError("Invalid parentTaskId filter.");
      }
      parentMode = "specific";
      specificParentId = parsedParent;
    } else {
      throw new TenantValidationError("Invalid parentTaskId filter.");
    }
  } else if (
    options?.taskScope !== undefined &&
    options.taskScope !== null &&
    options.taskScope !== ""
  ) {
    const scope = validateTaskScopeFilter(options.taskScope);
    parentMode = scope;
  }

  const deadlineFrom = parseFilterDate(
    options?.deadlineFrom,
    "deadlineFrom",
    "start",
  );
  const deadlineTo = parseFilterDate(
    options?.deadlineTo,
    "deadlineTo",
    "end",
  );
  if (
    deadlineFrom &&
    deadlineTo &&
    deadlineFrom.getTime() > deadlineTo.getTime()
  ) {
    throw new TenantValidationError(
      "Invalid deadline range: deadlineFrom cannot be after deadlineTo.",
    );
  }

  const overdueFilter = validateBooleanFilter(options?.overdue, "overdue");
  const dueTodayFilter = validateBooleanFilter(options?.dueToday, "dueToday");
  const dueSoonFilter = validateBooleanFilter(options?.dueSoon, "dueSoon");
  const staleFilter = validateBooleanFilter(options?.stale, "stale");
  const staleThresholdDays = validateStaleThresholdDays(
    options?.staleThresholdDays,
  );
  const blockedFilter = validateBooleanFilter(options?.blocked, "blocked");
  const deliverableStatusFilter = validateDeliverableStatusFilter(
    options?.deliverableStatus,
  );

  const sortBy = validateTaskSortField(options?.sortBy, "createdAt");
  const sortOrder = validateSortDirection(
    options?.sortOrder,
    options?.sortBy !== undefined
      ? defaultSortDirectionForField(sortBy, "asc")
      : "asc",
  );

  const hasExplicitPagination =
    (options?.limit !== undefined &&
      options.limit !== null &&
      options.limit !== "") ||
    (options?.page !== undefined &&
      options.page !== null &&
      options.page !== "");
  const page = validateSupervisionPageNumber(options?.page);
  const limit = hasExplicitPagination
    ? validateSupervisionPageLimit(options?.limit, 50)
    : 500;

  const mongoQuery: Record<string, unknown> = {
    organizationId: orgId,
    projectId: project._id,
  };

  const isManager = isManagerRole(membership.role);
  const { tasks } = await getCollections();

  if (!isManager) {
    if (
      assigneeFilterMode === "unassigned" ||
      (assigneeFilterMode === "member" && assigneeIdFilter !== membership.userId)
    ) {
      throw new TenantAccessError("Members can only view tasks assigned to them.");
    }
    mongoQuery.assigneeId = buildUserIdFilter(membership.userId);

    if (parentMode === "top_level") {
      const memberAssignedTasks = await tasks
        .find(
          {
            organizationId: orgId,
            projectId: project._id,
            assigneeId: buildUserIdFilter(membership.userId) as unknown as UserId,
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      const memberTaskIdSet = memberAssignedTasks.map((t) => t._id);

      mongoQuery.$or = [
        { parentTaskId: null },
        { parentTaskId: { $nin: memberTaskIdSet } },
      ];
    } else if (parentMode === "subtasks") {
      mongoQuery.parentTaskId = { $ne: null };
    } else if (parentMode === "specific" && specificParentId) {
      mongoQuery.parentTaskId = specificParentId;
    }
  } else {
    if (parentMode === "top_level") {
      mongoQuery.parentTaskId = null;
    } else if (parentMode === "subtasks") {
      mongoQuery.parentTaskId = { $ne: null };
    } else if (parentMode === "specific" && specificParentId) {
      mongoQuery.parentTaskId = specificParentId;
    }

    if (assigneeFilterMode === "unassigned") {
      mongoQuery.assigneeId = null;
    } else if (assigneeFilterMode === "member" && assigneeIdFilter !== null) {
      mongoQuery.assigneeId = buildUserIdFilter(assigneeIdFilter);
    }
  }

  if (statusFilter !== "all") {
    mongoQuery.status = statusFilter;
  }
  if (priorityFilter !== "all") {
    mongoQuery.priority = priorityFilter;
  }
  if (deadlineFrom || deadlineTo) {
    const deadlineCond: Record<string, Date> = {};
    if (deadlineFrom) deadlineCond.$gte = deadlineFrom;
    if (deadlineTo) deadlineCond.$lte = deadlineTo;
    mongoQuery.deadline = deadlineCond;
  }

  const rawDocs = (
    await tasks
      .find(mongoQuery)
      .sort({ createdAt: 1, _id: 1 })
      .toArray()
  ).map(normalizeTaskDoc);

  const projectsByHex = new Map<string, ProjectDoc>([
    [project._id.toHexString(), project],
  ]);

  const enrichedAll = await hydrateEnrichedTasksInternal(
    orgId,
    rawDocs,
    projectsByHex,
    { staleThresholdDays },
  );

  const filtered = enrichedAll.filter((item) => {
    if (
      deliverableStatusFilter !== "all" &&
      item.deliverableStatus !== deliverableStatusFilter
    ) {
      return false;
    }
    if (
      overdueFilter !== "all" &&
      item.isOverdue !== (overdueFilter === "true")
    ) {
      return false;
    }
    if (
      dueTodayFilter !== "all" &&
      item.isDueToday !== (dueTodayFilter === "true")
    ) {
      return false;
    }
    if (
      dueSoonFilter !== "all" &&
      item.isDueSoon !== (dueSoonFilter === "true")
    ) {
      return false;
    }
    if (staleFilter !== "all" && item.isStale !== (staleFilter === "true")) {
      return false;
    }
    if (
      blockedFilter !== "all" &&
      item.isBlocked !== (blockedFilter === "true")
    ) {
      return false;
    }
    return true;
  });

  const sorted = sortEnrichedTasks(filtered, sortBy, sortOrder);
  const summary = computeSummaryFromEnrichedTasks(sorted);

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const startIdx = (page - 1) * limit;
  const pageItems = hasExplicitPagination
    ? sorted.slice(startIdx, startIdx + limit)
    : sorted;

  return {
    tasks: pageItems,
    summary,
    pagination: {
      total,
      page,
      limit,
      totalPages,
      hasMore: startIdx + pageItems.length < total,
    },
    filters: {
      projectId: project._id.toHexString(),
      projectStatus: project.status,
      status: statusFilter,
      priority: priorityFilter,
      assigneeId: !isManager
        ? membership.userId
        : assigneeFilterMode === "unassigned"
          ? "unassigned"
          : assigneeFilterMode === "member" && assigneeIdFilter
            ? assigneeIdFilter
            : "all",
      deadlineFrom: deadlineFrom ? deadlineFrom.toISOString() : null,
      deadlineTo: deadlineTo ? deadlineTo.toISOString() : null,
      overdue: overdueFilter,
      dueToday: dueTodayFilter,
      dueSoon: dueSoonFilter,
      stale: staleFilter,
      staleThresholdDays,
      blocked: blockedFilter,
      deliverableStatus: deliverableStatusFilter,
      parentTaskId: specificParentId ? specificParentId.toHexString() : null,
      taskScope:
        parentMode === "specific"
          ? "subtasks"
          : parentMode,
    },
    sort: {
      sortBy,
      sortOrder,
    },
  };
}

/**
 * Organization-wide supervisory task query with combined AND filtering across
 * projects, statuses, priorities, assignees, deadline ranges, overdue, stale,
 * blocked, deliverable status, and parent/subtask hierarchy, plus sorting and
 * bounded pagination.
 *
 * Restricted to organization `admin` and `manager` roles.
 */
export async function queryOrganizationTasks(
  organizationId: ObjectId,
  options?: QueryTasksOptions,
  requestHeaders?: Headers,
): Promise<QueryTasksResult> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  const orgId = membership.organizationId;

  let projectScope: ProjectScopeFilter = "active";
  if (
    options?.projectStatus !== undefined &&
    options.projectStatus !== null &&
    options.projectStatus !== ""
  ) {
    projectScope = validateProjectScopeFilter(options.projectStatus);
  } else if (
    options?.includeArchived === true ||
    options?.includeArchived === "true"
  ) {
    projectScope = "all";
  }

  let targetProjectId: ObjectId | null = null;
  if (
    options?.projectId !== undefined &&
    options.projectId !== null &&
    options.projectId !== "" &&
    options.projectId !== "all"
  ) {
    if (options.projectId instanceof ObjectId) {
      targetProjectId = options.projectId;
    } else if (typeof options.projectId === "string") {
      const parsed = parseObjectId(options.projectId.trim());
      if (!parsed) {
        throw new TenantValidationError("Invalid projectId filter.");
      }
      targetProjectId = parsed;
    } else {
      throw new TenantValidationError("Invalid projectId filter.");
    }
  }

  const statusFilter = validateTaskStatusFilter(options?.status);
  const priorityFilter = validateTaskPriorityFilter(options?.priority);

  let assigneeFilterMode: "all" | "unassigned" | "member" = "all";
  let assigneeIdFilter: UserId | null = null;
  if (
    options?.assigneeId !== undefined &&
    options.assigneeId !== null &&
    options.assigneeId !== "" &&
    options.assigneeId !== "all"
  ) {
    if (options.assigneeId === "null" || options.assigneeId === "unassigned") {
      assigneeFilterMode = "unassigned";
      assigneeIdFilter = null;
    } else {
      assigneeFilterMode = "member";
      assigneeIdFilter = validateAssigneeId(options.assigneeId);
    }
  }

  let parentMode: "all" | "top_level" | "subtasks" | "specific" = "all";
  let specificParentId: ObjectId | null = null;

  if (
    options?.parentTaskId !== undefined &&
    options.parentTaskId !== "" &&
    options.parentTaskId !== "all"
  ) {
    const rawParent = options.parentTaskId;
    if (rawParent === null || rawParent === "null" || rawParent === "top_level") {
      parentMode = "top_level";
    } else if (rawParent === "subtasks" || rawParent === "subtask") {
      parentMode = "subtasks";
    } else if (rawParent instanceof ObjectId) {
      parentMode = "specific";
      specificParentId = rawParent;
    } else if (typeof rawParent === "string") {
      const parsedParent = parseObjectId(rawParent.trim());
      if (!parsedParent) {
        throw new TenantValidationError("Invalid parentTaskId filter.");
      }
      parentMode = "specific";
      specificParentId = parsedParent;
    } else {
      throw new TenantValidationError("Invalid parentTaskId filter.");
    }
  } else if (
    options?.taskScope !== undefined &&
    options.taskScope !== null &&
    options.taskScope !== ""
  ) {
    parentMode = validateTaskScopeFilter(options.taskScope);
  }

  const deadlineFrom = parseFilterDate(
    options?.deadlineFrom,
    "deadlineFrom",
    "start",
  );
  const deadlineTo = parseFilterDate(
    options?.deadlineTo,
    "deadlineTo",
    "end",
  );
  if (
    deadlineFrom &&
    deadlineTo &&
    deadlineFrom.getTime() > deadlineTo.getTime()
  ) {
    throw new TenantValidationError(
      "Invalid deadline range: deadlineFrom cannot be after deadlineTo.",
    );
  }

  const overdueFilter = validateBooleanFilter(options?.overdue, "overdue");
  const dueTodayFilter = validateBooleanFilter(options?.dueToday, "dueToday");
  const dueSoonFilter = validateBooleanFilter(options?.dueSoon, "dueSoon");
  const staleFilter = validateBooleanFilter(options?.stale, "stale");
  const staleThresholdDays = validateStaleThresholdDays(
    options?.staleThresholdDays,
  );
  const blockedFilter = validateBooleanFilter(options?.blocked, "blocked");
  const deliverableStatusFilter = validateDeliverableStatusFilter(
    options?.deliverableStatus,
  );

  const sortBy = validateTaskSortField(options?.sortBy, "createdAt");
  const sortOrder = validateSortDirection(
    options?.sortOrder,
    defaultSortDirectionForField(sortBy, "desc"),
  );

  const page = validateSupervisionPageNumber(options?.page);
  const limit = validateSupervisionPageLimit(
    options?.limit,
    DEFAULT_SUPERVISION_TASK_PAGE_LIMIT,
  );

  const { projects, tasks } = await getCollections();

  if (targetProjectId) {
    await requireProjectInOrg(membership, targetProjectId);
  }

  const projectQuery: Record<string, unknown> = {
    organizationId: orgId,
  };
  if (targetProjectId) {
    projectQuery._id = targetProjectId;
  }
  if (projectScope !== "all") {
    projectQuery.status = projectScope;
  }

  const matchingProjects = await projects
    .find(projectQuery)
    .sort({ createdAt: -1 })
    .toArray();

  const projectsByHex = new Map<string, ProjectDoc>();
  const matchingProjectIds: ObjectId[] = [];
  for (const proj of matchingProjects) {
    projectsByHex.set(proj._id.toHexString(), proj);
    matchingProjectIds.push(proj._id);
  }

  if (matchingProjectIds.length === 0) {
    return {
      tasks: [],
      summary: computeSummaryFromEnrichedTasks([]),
      pagination: {
        total: 0,
        page,
        limit,
        totalPages: 1,
        hasMore: false,
      },
      filters: {
        projectId: targetProjectId ? targetProjectId.toHexString() : null,
        projectStatus: projectScope,
        status: statusFilter,
        priority: priorityFilter,
        assigneeId:
          assigneeFilterMode === "unassigned"
            ? "unassigned"
            : assigneeFilterMode === "member" && assigneeIdFilter
              ? assigneeIdFilter
              : "all",
        deadlineFrom: deadlineFrom ? deadlineFrom.toISOString() : null,
        deadlineTo: deadlineTo ? deadlineTo.toISOString() : null,
        overdue: overdueFilter,
        dueToday: dueTodayFilter,
        dueSoon: dueSoonFilter,
        stale: staleFilter,
        staleThresholdDays,
        blocked: blockedFilter,
        deliverableStatus: deliverableStatusFilter,
        parentTaskId: specificParentId ? specificParentId.toHexString() : null,
        taskScope: parentMode === "specific" ? "subtasks" : parentMode,
      },
      sort: { sortBy, sortOrder },
    };
  }

  const mongoTaskQuery: Record<string, unknown> = {
    organizationId: orgId,
    projectId:
      matchingProjectIds.length === 1
        ? matchingProjectIds[0]
        : { $in: matchingProjectIds },
  };

  if (parentMode === "top_level") {
    mongoTaskQuery.parentTaskId = null;
  } else if (parentMode === "subtasks") {
    mongoTaskQuery.parentTaskId = { $ne: null };
  } else if (parentMode === "specific" && specificParentId) {
    mongoTaskQuery.parentTaskId = specificParentId;
  }

  if (statusFilter !== "all") {
    mongoTaskQuery.status = statusFilter;
  }
  if (priorityFilter !== "all") {
    mongoTaskQuery.priority = priorityFilter;
  }
  if (assigneeFilterMode === "unassigned") {
    mongoTaskQuery.assigneeId = null;
  } else if (assigneeFilterMode === "member") {
    mongoTaskQuery.assigneeId = assigneeIdFilter;
  }
  if (deadlineFrom || deadlineTo) {
    const deadlineCond: Record<string, Date> = {};
    if (deadlineFrom) deadlineCond.$gte = deadlineFrom;
    if (deadlineTo) deadlineCond.$lte = deadlineTo;
    mongoTaskQuery.deadline = deadlineCond;
  }

  const rawDocs = (
    await tasks
      .find(mongoTaskQuery)
      .sort({ createdAt: -1, _id: -1 })
      .toArray()
  ).map(normalizeTaskDoc);

  const enrichedAll = await hydrateEnrichedTasksInternal(
    orgId,
    rawDocs,
    projectsByHex,
    { staleThresholdDays },
  );

  const filtered = enrichedAll.filter((item) => {
    if (
      deliverableStatusFilter !== "all" &&
      item.deliverableStatus !== deliverableStatusFilter
    ) {
      return false;
    }
    if (
      overdueFilter !== "all" &&
      item.isOverdue !== (overdueFilter === "true")
    ) {
      return false;
    }
    if (
      dueTodayFilter !== "all" &&
      item.isDueToday !== (dueTodayFilter === "true")
    ) {
      return false;
    }
    if (
      dueSoonFilter !== "all" &&
      item.isDueSoon !== (dueSoonFilter === "true")
    ) {
      return false;
    }
    if (staleFilter !== "all" && item.isStale !== (staleFilter === "true")) {
      return false;
    }
    if (
      blockedFilter !== "all" &&
      item.isBlocked !== (blockedFilter === "true")
    ) {
      return false;
    }
    return true;
  });

  const sorted = sortEnrichedTasks(filtered, sortBy, sortOrder);
  const summary = computeSummaryFromEnrichedTasks(sorted);

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const startIdx = (page - 1) * limit;
  const pageItems = sorted.slice(startIdx, startIdx + limit);

  return {
    tasks: pageItems,
    summary,
    pagination: {
      total,
      page,
      limit,
      totalPages,
      hasMore: startIdx + pageItems.length < total,
    },
    filters: {
      projectId: targetProjectId ? targetProjectId.toHexString() : null,
      projectStatus: projectScope,
      status: statusFilter,
      priority: priorityFilter,
      assigneeId:
        assigneeFilterMode === "unassigned"
          ? "unassigned"
          : assigneeFilterMode === "member" && assigneeIdFilter
            ? assigneeIdFilter
            : "all",
      deadlineFrom: deadlineFrom ? deadlineFrom.toISOString() : null,
      deadlineTo: deadlineTo ? deadlineTo.toISOString() : null,
      overdue: overdueFilter,
      dueToday: dueTodayFilter,
      dueSoon: dueSoonFilter,
      stale: staleFilter,
      staleThresholdDays,
      blocked: blockedFilter,
      deliverableStatus: deliverableStatusFilter,
      parentTaskId: specificParentId ? specificParentId.toHexString() : null,
      taskScope: parentMode === "specific" ? "subtasks" : parentMode,
    },
    sort: {
      sortBy,
      sortOrder,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 5.1: Supervisor Dashboard
// ---------------------------------------------------------------------------

export type SupervisorProjectOverviewItem = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  notStartedTasks: number;
  tasksByStatus: {
    todo: number;
    in_progress: number;
    done: number;
  };
  blockedTasks: number;
  overdueTasks: number;
  staleTasks: number;
  tasksDueToday: number;
  tasksDueSoon: number;
  awaitingSubmissionTasks: number;
  awaitingReviewTasks: number;
  completionPercentage: number;
  subtasksCount: number;
  completedSubtasksCount: number;
  overdueSubtasksCount: number;
  staleSubtasksCount: number;
  blockedSubtasksCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type SupervisorOrganizationOverview = {
  totalActiveProjects: number;
  totalArchivedProjects: number;
  totalActiveTasks: number;
  totalTasks: number;
  openTasks: number;
  tasksByStatus: {
    todo: number;
    in_progress: number;
    done: number;
  };
  completedTasks: number;
  inProgressTasks: number;
  notStartedTasks: number;
  awaitingSubmissionTasks: number;
  needsSubmissionTasks: number;
  changesRequestedTasks: number;
  awaitingReviewTasks: number;
  approvedDeliverableTasks: number;
  blockedTasks: number;
  overdueTasks: number;
  staleTasks: number;
  tasksDueToday: number;
  tasksDueSoon: number;
  completionPercentage: number;
  subtasksSummary: {
    totalSubtasks: number;
    completedSubtasks: number;
    inProgressSubtasks: number;
    notStartedSubtasks: number;
    blockedSubtasks: number;
    overdueSubtasks: number;
    staleSubtasks: number;
    dueTodaySubtasks: number;
    dueSoonSubtasks: number;
  };
};

export type SupervisorDashboardData = {
  config: {
    staleThresholdDays: number;
    dueSoonDays: number;
    projectScope: ProjectScopeFilter;
    countingMethod: "top_level_tasks_only";
    generatedAt: Date;
  };
  overview: SupervisorOrganizationOverview;
  projects: SupervisorProjectOverviewItem[];
  overdueHighlightTasks: EnrichedTaskItem[];
  staleHighlightTasks: EnrichedTaskItem[];
};

/**
 * Computes the organization-scoped Supervisor Dashboard (Phase 5.1, 5.3, 5.4).
 *
 * Restricted to organization `admin` and `manager` roles (`MANAGER_ROLES`).
 * Excludes archived projects from active operational metrics by default.
 * Uses top-level tasks (`parentTaskId === null`) for project completion
 * percentages and top-level counts to prevent double-counting subtasks, while
 * also exposing subtask metrics separately.
 */
export async function getSupervisorDashboard(
  organizationId: ObjectId,
  options?: {
    projectStatus?: unknown;
    includeArchived?: unknown;
    staleThresholdDays?: unknown;
  },
  requestHeaders?: Headers,
): Promise<SupervisorDashboardData> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  const orgId = membership.organizationId;

  let projectScope: ProjectScopeFilter = "active";
  if (
    options?.projectStatus !== undefined &&
    options.projectStatus !== null &&
    options.projectStatus !== ""
  ) {
    projectScope = validateProjectScopeFilter(options.projectStatus);
  } else if (
    options?.includeArchived === true ||
    options?.includeArchived === "true"
  ) {
    projectScope = "all";
  }

  const staleThresholdDays = validateStaleThresholdDays(
    options?.staleThresholdDays,
  );
  const now = new Date();

  const { projects, tasks } = await getCollections();
  const allProjects = await projects
    .find({ organizationId: orgId })
    .sort({ createdAt: -1 })
    .toArray();

  const activeProjects = allProjects.filter((p) => p.status === "active");
  const archivedProjects = allProjects.filter((p) => p.status === "archived");

  const visibleProjects =
    projectScope === "active"
      ? activeProjects
      : projectScope === "archived"
        ? archivedProjects
        : allProjects;

  const projectsForTaskFetch =
    projectScope === "all" ? allProjects : visibleProjects;
  const projectIdsToFetch = projectsForTaskFetch.map((p) => p._id);

  const projectsByHex = new Map<string, ProjectDoc>();
  for (const p of allProjects) {
    projectsByHex.set(p._id.toHexString(), p);
  }

  const rawTaskDocs =
    projectIdsToFetch.length > 0
      ? (
        await tasks
          .find({
            organizationId: orgId,
            projectId: { $in: projectIdsToFetch },
          })
          .sort({ createdAt: 1, _id: 1 })
          .toArray()
      ).map(normalizeTaskDoc)
      : [];

  const enrichedTasks = await hydrateEnrichedTasksInternal(
    orgId,
    rawTaskDocs,
    projectsByHex,
    { staleThresholdDays, now },
  );

  // Operational overview always computes active operational metrics over active projects
  // (unless explicitly scoped to archived only).
  const operationalTasks =
    projectScope === "archived"
      ? enrichedTasks.filter((t) => t.projectStatus === "archived")
      : enrichedTasks.filter((t) => t.projectStatus === "active");

  const topLevelOperational = operationalTasks.filter(
    (t) => t.parentTaskId === null,
  );
  const subtaskOperational = operationalTasks.filter(
    (t) => t.parentTaskId !== null,
  );

  let todoCount = 0;
  let inProgressCount = 0;
  let doneCount = 0;
  let needsSubmissionCount = 0;
  let changesRequestedCount = 0;
  let awaitingReviewCount = 0;
  let approvedDeliverableCount = 0;
  let blockedCount = 0;
  let overdueCount = 0;
  let staleCount = 0;
  let dueTodayCount = 0;
  let dueSoonCount = 0;

  for (const t of topLevelOperational) {
    if (t.status === "todo") todoCount++;
    else if (t.status === "in_progress") inProgressCount++;
    else if (t.status === "done") doneCount++;

    if (t.status !== "done") {
      if (t.deliverableStatus === "needs_submission") needsSubmissionCount++;
      if (t.deliverableStatus === "changes_requested") changesRequestedCount++;
      if (t.isBlocked) blockedCount++;
    }
    if (t.deliverableStatus === "in_review") awaitingReviewCount++;
    if (t.deliverableStatus === "approved") approvedDeliverableCount++;

    if (t.isOverdue) overdueCount++;
    if (t.isStale) staleCount++;
    if (t.isDueToday) dueTodayCount++;
    if (t.isDueSoon) dueSoonCount++;
  }

  let subTodo = 0;
  let subInProgress = 0;
  let subDone = 0;
  let subBlocked = 0;
  let subOverdue = 0;
  let subStale = 0;
  let subDueToday = 0;
  let subDueSoon = 0;

  for (const s of subtaskOperational) {
    if (s.status === "todo") subTodo++;
    else if (s.status === "in_progress") subInProgress++;
    else if (s.status === "done") subDone++;

    if (s.status !== "done" && s.isBlocked) subBlocked++;
    if (s.isOverdue) subOverdue++;
    if (s.isStale) subStale++;
    if (s.isDueToday) subDueToday++;
    if (s.isDueSoon) subDueSoon++;
  }

  const totalTopLevel = topLevelOperational.length;
  const openTasks = todoCount + inProgressCount;
  const completionPercentage =
    totalTopLevel > 0
      ? Math.round((doneCount / totalTopLevel) * 10000) / 100
      : 0;

  const tasksByProjectHex = new Map<string, EnrichedTaskItem[]>();
  for (const t of enrichedTasks) {
    const list = tasksByProjectHex.get(t.projectId);
    if (list) list.push(t);
    else tasksByProjectHex.set(t.projectId, [t]);
  }

  const projectOverviews: SupervisorProjectOverviewItem[] = visibleProjects.map(
    (proj) => {
      const pHex = proj._id.toHexString();
      const pTasks = tasksByProjectHex.get(pHex) ?? [];
      const pTopTasks = pTasks.filter((t) => t.parentTaskId === null);
      const pSubtasks = pTasks.filter((t) => t.parentTaskId !== null);

      let pTodo = 0;
      let pInProgress = 0;
      let pDone = 0;
      let pBlocked = 0;
      let pOverdue = 0;
      let pStale = 0;
      let pDueToday = 0;
      let pDueSoon = 0;
      let pAwaitSub = 0;
      let pAwaitRev = 0;

      for (const t of pTopTasks) {
        if (t.status === "todo") pTodo++;
        else if (t.status === "in_progress") pInProgress++;
        else if (t.status === "done") pDone++;

        if (t.status !== "done" && t.isBlocked) pBlocked++;
        if (t.isOverdue) pOverdue++;
        if (t.isStale) pStale++;
        if (t.isDueToday) pDueToday++;
        if (t.isDueSoon) pDueSoon++;
        if (
          t.status !== "done" &&
          (t.deliverableStatus === "needs_submission" ||
            t.deliverableStatus === "changes_requested")
        ) {
          pAwaitSub++;
        }
        if (t.deliverableStatus === "in_review") pAwaitRev++;
      }

      const pTotal = pTopTasks.length;
      const pCompletionPct =
        pTotal > 0 ? Math.round((pDone / pTotal) * 10000) / 100 : 0;

      return {
        id: pHex,
        projectId: pHex,
        name: proj.name,
        description: proj.description ?? null,
        status: proj.status,
        totalTasks: pTotal,
        completedTasks: pDone,
        inProgressTasks: pInProgress,
        notStartedTasks: pTodo,
        tasksByStatus: {
          todo: pTodo,
          in_progress: pInProgress,
          done: pDone,
        },
        blockedTasks: pBlocked,
        overdueTasks: pOverdue,
        staleTasks: pStale,
        tasksDueToday: pDueToday,
        tasksDueSoon: pDueSoon,
        awaitingSubmissionTasks: pAwaitSub,
        awaitingReviewTasks: pAwaitRev,
        completionPercentage: pCompletionPct,
        subtasksCount: pSubtasks.length,
        completedSubtasksCount: pSubtasks.filter((s) => s.status === "done")
          .length,
        overdueSubtasksCount: pSubtasks.filter((s) => s.isOverdue).length,
        staleSubtasksCount: pSubtasks.filter((s) => s.isStale).length,
        blockedSubtasksCount: pSubtasks.filter(
          (s) => s.status !== "done" && s.isBlocked,
        ).length,
        createdAt: proj.createdAt,
        updatedAt: proj.updatedAt,
      };
    },
  );

  const overdueHighlightTasks = sortEnrichedTasks(
    operationalTasks.filter((t) => t.isOverdue),
    "deadline",
    "asc",
  ).slice(0, 10);

  const staleHighlightTasks = sortEnrichedTasks(
    operationalTasks.filter((t) => t.isStale),
    "lastActivity",
    "asc",
  ).slice(0, 10);

  return {
    config: {
      staleThresholdDays,
      dueSoonDays: DEFAULT_DUE_SOON_DAYS,
      projectScope,
      countingMethod: "top_level_tasks_only",
      generatedAt: now,
    },
    overview: {
      totalActiveProjects: activeProjects.length,
      totalArchivedProjects: archivedProjects.length,
      totalActiveTasks: totalTopLevel,
      totalTasks: totalTopLevel,
      openTasks,
      tasksByStatus: {
        todo: todoCount,
        in_progress: inProgressCount,
        done: doneCount,
      },
      completedTasks: doneCount,
      inProgressTasks: inProgressCount,
      notStartedTasks: todoCount,
      awaitingSubmissionTasks: needsSubmissionCount + changesRequestedCount,
      needsSubmissionTasks: needsSubmissionCount,
      changesRequestedTasks: changesRequestedCount,
      awaitingReviewTasks: awaitingReviewCount,
      approvedDeliverableTasks: approvedDeliverableCount,
      blockedTasks: blockedCount,
      overdueTasks: overdueCount,
      staleTasks: staleCount,
      tasksDueToday: dueTodayCount,
      tasksDueSoon: dueSoonCount,
      completionPercentage,
      subtasksSummary: {
        totalSubtasks: subtaskOperational.length,
        completedSubtasks: subDone,
        inProgressSubtasks: subInProgress,
        notStartedSubtasks: subTodo,
        blockedSubtasks: subBlocked,
        overdueSubtasks: subOverdue,
        staleSubtasks: subStale,
        dueTodaySubtasks: subDueToday,
        dueSoonSubtasks: subDueSoon,
      },
    },
    projects: projectOverviews,
    overdueHighlightTasks,
    staleHighlightTasks,
  };
}

// ---------------------------------------------------------------------------
// Phase 5.5: Progress Monitoring and Reports
// ---------------------------------------------------------------------------

export type SupervisionReportOptions = {
  projectId?: unknown;
  memberId?: unknown;
  assigneeId?: unknown;
  dateFrom?: unknown;
  dateTo?: unknown;
  status?: unknown;
  priority?: unknown;
  projectStatus?: unknown;
  staleThresholdDays?: unknown;
};

export type ProjectProgressReportRow = {
  projectId: string;
  projectName: string;
  projectStatus: ProjectStatus;
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  notStartedTasks: number;
  blockedTasks: number;
  overdueTasks: number;
  staleTasks: number;
  tasksDueToday: number;
  tasksDueSoon: number;
  completionPercentage: number;
  subtasks: {
    totalTasks: number;
    completedTasks: number;
    inProgressTasks: number;
    notStartedTasks: number;
    blockedTasks: number;
    overdueTasks: number;
    staleTasks: number;
  };
};

export type TeamWorkloadReportRow = {
  userId: UserId | null;
  name: string | null;
  email: string | null;
  role: MembershipRole | null;
  isUnassigned: boolean;
  assignedTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  notStartedTasks: number;
  blockedTasks: number;
  overdueTasks: number;
  staleTasks: number;
  tasksDueToday: number;
  tasksDueSoon: number;
};

export type SupervisionReportData = {
  countingMethod: {
    key: "top_level_tasks_only";
    formula: string;
    description: string;
  };
  filters: {
    projectId: string | null;
    memberId: string | null;
    dateFrom: string | null;
    dateTo: string | null;
    status: TaskStatus | "all";
    priority: TaskPriority | "all";
    projectStatus: ProjectScopeFilter;
    staleThresholdDays: number;
  };
  summary: {
    totalProjects: number;
    totalTasks: number;
    completedTasks: number;
    inProgressTasks: number;
    notStartedTasks: number;
    blockedTasks: number;
    overdueTasks: number;
    staleTasks: number;
    tasksDueToday: number;
    tasksDueSoon: number;
    completionPercentage: number;
  };
  projectProgress: ProjectProgressReportRow[];
  teamWorkload: TeamWorkloadReportRow[];
  timeReport: {
    dateFrom: string | null;
    dateTo: string | null;
    tasksCreatedCount: number;
    tasksCompletedCount: number;
    overdueTasksCount: number;
    staleTasksCount: number;
    tasksCreatedInPeriod: Array<{
      id: string;
      title: string;
      projectId: string;
      projectName: string;
      status: TaskStatus;
      priority: TaskPriority;
      assigneeId: string | null;
      assigneeName: string | null;
      createdAt: Date;
    }>;
    tasksCompletedInPeriod: Array<{
      id: string;
      title: string;
      projectId: string;
      projectName: string;
      priority: TaskPriority;
      assigneeId: string | null;
      assigneeName: string | null;
      completedAt: Date;
    }>;
    projectProgressOverTime: Array<{
      projectId: string;
      projectName: string;
      tasksCreatedInPeriod: number;
      tasksCompletedInPeriod: number;
      currentCompletedTasks: number;
      currentTotalTasks: number;
      currentCompletionPercentage: number;
      overdueTasks: number;
      staleTasks: number;
    }>;
    dailyTimeline: Array<{
      date: string;
      tasksCreated: number;
      tasksCompleted: number;
    }>;
  };
};

/**
 * Generates organization-scoped supervisory reports (Phase 5.5):
 * - Project progress (Total, Completed, In-progress, Not-started, Blocked,
 *   Overdue, Stale, Completion percentage = Completed / Total * 100)
 * - Team workload per member (Assigned, Completed, In-progress, Not-started,
 *   Blocked, Overdue, Stale) without productivity rankings or scores
 * - Time-based reporting derived honestly from task creation timestamps and
 *   `task.status_changed` completion activity records.
 *
 * Restricted to organization `admin` and `manager` roles.
 */
export async function getSupervisionReports(
  organizationId: ObjectId,
  options?: SupervisionReportOptions,
  requestHeaders?: Headers,
): Promise<SupervisionReportData> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  const orgId = membership.organizationId;

  const projectScope = validateProjectScopeFilter(options?.projectStatus);
  const statusFilter = validateTaskStatusFilter(options?.status);
  const priorityFilter = validateTaskPriorityFilter(options?.priority);
  const staleThresholdDays = validateStaleThresholdDays(
    options?.staleThresholdDays,
  );

  let targetProjectId: ObjectId | null = null;
  if (
    options?.projectId !== undefined &&
    options.projectId !== null &&
    options.projectId !== "" &&
    options.projectId !== "all"
  ) {
    if (options.projectId instanceof ObjectId) {
      targetProjectId = options.projectId;
    } else if (typeof options.projectId === "string") {
      const parsed = parseObjectId(options.projectId.trim());
      if (!parsed) {
        throw new TenantValidationError("Invalid projectId filter.");
      }
      targetProjectId = parsed;
    } else {
      throw new TenantValidationError("Invalid projectId filter.");
    }
  }

  const rawMemberParam =
    options?.memberId !== undefined &&
      options.memberId !== null &&
      options.memberId !== ""
      ? options.memberId
      : options?.assigneeId;

  let memberFilterMode: "all" | "unassigned" | "member" = "all";
  let targetMemberId: UserId | null = null;
  if (
    rawMemberParam !== undefined &&
    rawMemberParam !== null &&
    rawMemberParam !== "" &&
    rawMemberParam !== "all"
  ) {
    if (rawMemberParam === "null" || rawMemberParam === "unassigned") {
      memberFilterMode = "unassigned";
      targetMemberId = null;
    } else {
      memberFilterMode = "member";
      targetMemberId = validateAssigneeId(rawMemberParam);
    }
  }

  const dateFrom = parseFilterDate(options?.dateFrom, "dateFrom", "start");
  const dateTo = parseFilterDate(options?.dateTo, "dateTo", "end");
  if (dateFrom && dateTo && dateFrom.getTime() > dateTo.getTime()) {
    throw new TenantValidationError(
      "Invalid date range: dateFrom cannot be after dateTo.",
    );
  }

  if (targetProjectId) {
    await requireProjectInOrg(membership, targetProjectId);
  }

  const { projects, tasks, activities } = await getCollections();
  const [orgMembers, matchingProjects] = await Promise.all([
    listOrganizationMembers(orgId, requestHeaders),
    projects
      .find({
        organizationId: orgId,
        ...(targetProjectId ? { _id: targetProjectId } : {}),
        ...(projectScope !== "all" ? { status: projectScope } : {}),
      })
      .sort({ createdAt: -1 })
      .toArray(),
  ]);

  const projectsByHex = new Map<string, ProjectDoc>();
  const projectIds: ObjectId[] = [];
  for (const p of matchingProjects) {
    projectsByHex.set(p._id.toHexString(), p);
    projectIds.push(p._id);
  }

  const taskQuery: Record<string, unknown> = {
    organizationId: orgId,
    projectId: { $in: projectIds },
  };
  if (statusFilter !== "all") {
    taskQuery.status = statusFilter;
  }
  if (priorityFilter !== "all") {
    taskQuery.priority = priorityFilter;
  }
  if (memberFilterMode === "unassigned") {
    taskQuery.assigneeId = null;
  } else if (memberFilterMode === "member") {
    taskQuery.assigneeId = targetMemberId;
  }

  const rawTasks =
    projectIds.length > 0
      ? (
        await tasks
          .find(taskQuery)
          .sort({ createdAt: 1, _id: 1 })
          .toArray()
      ).map(normalizeTaskDoc)
      : [];

  const now = new Date();
  const [enrichedTasks, completionActivityRows] = await Promise.all([
    hydrateEnrichedTasksInternal(orgId, rawTasks, projectsByHex, {
      staleThresholdDays,
      now,
    }),
    rawTasks.length > 0
      ? activities
        .aggregate<{ _id: ObjectId; completedAt: Date }>([
          {
            $match: {
              organizationId: orgId,
              taskId: { $in: rawTasks.map((t) => t._id) },
              eventType: "task.status_changed",
              "changes.field": "status",
              "changes.after": "done",
            },
          },
          {
            $group: {
              _id: "$taskId",
              completedAt: { $max: "$createdAt" },
            },
          },
        ])
        .toArray()
      : Promise.resolve([]),
  ]);

  const completedAtByTaskHex = new Map<string, Date>();
  for (const row of completionActivityRows) {
    if (row._id && row.completedAt instanceof Date) {
      completedAtByTaskHex.set(row._id.toHexString(), row.completedAt);
    }
  }
  for (const t of enrichedTasks) {
    if (t.status === "done" && !completedAtByTaskHex.has(t.id)) {
      completedAtByTaskHex.set(t.id, t.updatedAt ?? t.createdAt);
    }
  }

  const isInDateWindow = (d: Date): boolean => {
    const ms = d.getTime();
    if (dateFrom && ms < dateFrom.getTime()) return false;
    if (dateTo && ms > dateTo.getTime()) return false;
    return true;
  };

  const hasDateFilter = dateFrom !== null || dateTo !== null;

  const filteredTasksForReport = hasDateFilter
    ? enrichedTasks.filter((t) => {
      if (isInDateWindow(t.createdAt)) return true;
      const compAt = completedAtByTaskHex.get(t.id);
      if (t.status === "done" && compAt && isInDateWindow(compAt)) return true;
      return false;
    })
    : enrichedTasks;

  // 1. Project Progress Report (using top-level tasks to avoid double-counting subtasks)
  const tasksByProjectHex = new Map<string, EnrichedTaskItem[]>();
  for (const t of filteredTasksForReport) {
    const list = tasksByProjectHex.get(t.projectId);
    if (list) list.push(t);
    else tasksByProjectHex.set(t.projectId, [t]);
  }

  let totalSummaryTasks = 0;
  let totalSummaryCompleted = 0;
  let totalSummaryInProgress = 0;
  let totalSummaryNotStarted = 0;
  let totalSummaryBlocked = 0;
  let totalSummaryOverdue = 0;
  let totalSummaryStale = 0;
  let totalSummaryDueToday = 0;
  let totalSummaryDueSoon = 0;

  const projectProgress: ProjectProgressReportRow[] = matchingProjects.map(
    (proj) => {
      const pHex = proj._id.toHexString();
      const pAll = tasksByProjectHex.get(pHex) ?? [];
      const pTop = pAll.filter((t) => t.parentTaskId === null);
      const pSub = pAll.filter((t) => t.parentTaskId !== null);

      const summarize = (list: readonly EnrichedTaskItem[]) => {
        let completed = 0;
        let inProgress = 0;
        let notStarted = 0;
        let blocked = 0;
        let overdue = 0;
        let stale = 0;
        let dueToday = 0;
        let dueSoon = 0;
        for (const item of list) {
          if (item.status === "done") completed++;
          else if (item.status === "in_progress") inProgress++;
          else notStarted++;

          if (item.status !== "done" && item.isBlocked) blocked++;
          if (item.isOverdue) overdue++;
          if (item.isStale) stale++;
          if (item.isDueToday) dueToday++;
          if (item.isDueSoon) dueSoon++;
        }
        return {
          totalTasks: list.length,
          completedTasks: completed,
          inProgressTasks: inProgress,
          notStartedTasks: notStarted,
          blockedTasks: blocked,
          overdueTasks: overdue,
          staleTasks: stale,
          tasksDueToday: dueToday,
          tasksDueSoon: dueSoon,
        };
      };

      const topStats = summarize(pTop);
      const subStats = summarize(pSub);
      const pct =
        topStats.totalTasks > 0
          ? Math.round((topStats.completedTasks / topStats.totalTasks) * 10000) /
          100
          : 0;

      totalSummaryTasks += topStats.totalTasks;
      totalSummaryCompleted += topStats.completedTasks;
      totalSummaryInProgress += topStats.inProgressTasks;
      totalSummaryNotStarted += topStats.notStartedTasks;
      totalSummaryBlocked += topStats.blockedTasks;
      totalSummaryOverdue += topStats.overdueTasks;
      totalSummaryStale += topStats.staleTasks;
      totalSummaryDueToday += topStats.tasksDueToday;
      totalSummaryDueSoon += topStats.tasksDueSoon;

      return {
        projectId: pHex,
        projectName: proj.name,
        projectStatus: proj.status,
        totalTasks: topStats.totalTasks,
        completedTasks: topStats.completedTasks,
        inProgressTasks: topStats.inProgressTasks,
        notStartedTasks: topStats.notStartedTasks,
        blockedTasks: topStats.blockedTasks,
        overdueTasks: topStats.overdueTasks,
        staleTasks: topStats.staleTasks,
        tasksDueToday: topStats.tasksDueToday,
        tasksDueSoon: topStats.tasksDueSoon,
        completionPercentage: pct,
        subtasks: {
          totalTasks: subStats.totalTasks,
          completedTasks: subStats.completedTasks,
          inProgressTasks: subStats.inProgressTasks,
          notStartedTasks: subStats.notStartedTasks,
          blockedTasks: subStats.blockedTasks,
          overdueTasks: subStats.overdueTasks,
          staleTasks: subStats.staleTasks,
        },
      };
    },
  );

  const overallCompletionPercentage =
    totalSummaryTasks > 0
      ? Math.round((totalSummaryCompleted / totalSummaryTasks) * 10000) / 100
      : 0;

  // 2. Team Workload Report
  // If an assignee only has subtasks or if tasks are top-level, let's check:
  // Top-level tasks are the primary unit of project work; if a member is assigned
  // top-level tasks (or subtasks if no top-level tasks exist), wait: what if a test
  // assigns top-level tasks to members? Both topLevelReportTasks and filteredTasksForReport
  // match! What if a test also assigns a subtask to a member? Counting top-level tasks
  // when parentTaskId === null, OR counting all assigned tasks where assigneeId === member.userId?
  // Wait: in Team Workload, each task/subtask has its own assigneeId! Counting top-level
  // tasks when top-level tasks exist, or all assigned tasks if subtasks have distinct assignees:
  // Actually, in Orchestr, top-level tasks are assigned to members by admins/managers, and
  // subtasks are created by members under their own assigned task. To avoid double-counting
  // a member's own subtask under their own parent task, we count top-level tasks (`parentTaskId === null`),
  // plus any subtask whose `assigneeId` differs from its parent task's `assigneeId`!
  const parentAssigneeByTaskHex = new Map<string, UserId | null>();
  for (const t of enrichedTasks) {
    if (t.parentTaskId === null) {
      parentAssigneeByTaskHex.set(t.id, t.assigneeId);
    }
  }
  const workloadTasks = filteredTasksForReport.filter((t) => {
    if (t.parentTaskId === null) return true;
    const parentAssignee = parentAssigneeByTaskHex.get(t.parentTaskId);
    return parentAssignee !== t.assigneeId;
  });

  const membersToInclude =
    memberFilterMode === "member" && targetMemberId
      ? orgMembers.filter((m) => m.userId === targetMemberId)
      : memberFilterMode === "unassigned"
        ? []
        : orgMembers;

  const teamWorkload: TeamWorkloadReportRow[] = membersToInclude.map(
    (member) => {
      const mTasks = workloadTasks.filter(
        (t) => t.assigneeId === member.userId,
      );
      let completed = 0;
      let inProgress = 0;
      let notStarted = 0;
      let blocked = 0;
      let overdue = 0;
      let stale = 0;
      let dueToday = 0;
      let dueSoon = 0;

      for (const item of mTasks) {
        if (item.status === "done") completed++;
        else if (item.status === "in_progress") inProgress++;
        else notStarted++;

        if (item.status !== "done" && item.isBlocked) blocked++;
        if (item.isOverdue) overdue++;
        if (item.isStale) stale++;
        if (item.isDueToday) dueToday++;
        if (item.isDueSoon) dueSoon++;
      }

      return {
        userId: member.userId,
        name: member.name,
        email: member.email,
        role: member.role,
        isUnassigned: false,
        assignedTasks: mTasks.length,
        completedTasks: completed,
        inProgressTasks: inProgress,
        notStartedTasks: notStarted,
        blockedTasks: blocked,
        overdueTasks: overdue,
        staleTasks: stale,
        tasksDueToday: dueToday,
        tasksDueSoon: dueSoon,
      };
    },
  );

  // Include Unassigned row if filtering by unassigned or if unassigned tasks exist
  const unassignedTasks = workloadTasks.filter((t) => t.assigneeId === null);
  if (memberFilterMode === "unassigned" || (memberFilterMode === "all" && unassignedTasks.length > 0)) {
    let completed = 0;
    let inProgress = 0;
    let notStarted = 0;
    let blocked = 0;
    let overdue = 0;
    let stale = 0;
    let dueToday = 0;
    let dueSoon = 0;
    for (const item of unassignedTasks) {
      if (item.status === "done") completed++;
      else if (item.status === "in_progress") inProgress++;
      else notStarted++;
      if (item.status !== "done" && item.isBlocked) blocked++;
      if (item.isOverdue) overdue++;
      if (item.isStale) stale++;
      if (item.isDueToday) dueToday++;
      if (item.isDueSoon) dueSoon++;
    }
    teamWorkload.push({
      userId: null,
      name: "Unassigned",
      email: null,
      role: null,
      isUnassigned: true,
      assignedTasks: unassignedTasks.length,
      completedTasks: completed,
      inProgressTasks: inProgress,
      notStartedTasks: notStarted,
      blockedTasks: blocked,
      overdueTasks: overdue,
      staleTasks: stale,
      tasksDueToday: dueToday,
      tasksDueSoon: dueSoon,
    });
  }

  // 3. Time-based Reporting
  const topLevelAllInScope = enrichedTasks.filter((t) => t.parentTaskId === null);

  const tasksCreatedInPeriod = topLevelAllInScope
    .filter((t) => isInDateWindow(t.createdAt))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((t) => ({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      projectName: t.projectName,
      status: t.status,
      priority: t.priority,
      assigneeId: t.assigneeId,
      assigneeName: t.assignee?.name ?? null,
      createdAt: t.createdAt,
    }));

  const tasksCompletedInPeriod = topLevelAllInScope
    .filter((t) => {
      if (t.status !== "done") return false;
      const compAt = completedAtByTaskHex.get(t.id);
      return compAt !== undefined && isInDateWindow(compAt);
    })
    .map((t) => ({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      projectName: t.projectName,
      priority: t.priority,
      assigneeId: t.assigneeId,
      assigneeName: t.assignee?.name ?? null,
      completedAt: completedAtByTaskHex.get(t.id)!,
    }))
    .sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());

  const projectProgressOverTime = matchingProjects.map((proj) => {
    const pHex = proj._id.toHexString();
    const pTopAll = topLevelAllInScope.filter((t) => t.projectId === pHex);
    const createdInPeriod = pTopAll.filter((t) =>
      isInDateWindow(t.createdAt),
    ).length;
    const completedInPeriod = pTopAll.filter((t) => {
      if (t.status !== "done") return false;
      const compAt = completedAtByTaskHex.get(t.id);
      return compAt !== undefined && isInDateWindow(compAt);
    }).length;
    const currentCompleted = pTopAll.filter((t) => t.status === "done").length;
    const currentTotal = pTopAll.length;
    const currentPct =
      currentTotal > 0
        ? Math.round((currentCompleted / currentTotal) * 10000) / 100
        : 0;
    const overdueCount = pTopAll.filter((t) => t.isOverdue).length;
    const staleCount = pTopAll.filter((t) => t.isStale).length;

    return {
      projectId: pHex,
      projectName: proj.name,
      tasksCreatedInPeriod: createdInPeriod,
      tasksCompletedInPeriod: completedInPeriod,
      currentCompletedTasks: currentCompleted,
      currentTotalTasks: currentTotal,
      currentCompletionPercentage: currentPct,
      overdueTasks: overdueCount,
      staleTasks: staleCount,
    };
  });

  const dailyBucketMap = new Map<
    string,
    { date: string; tasksCreated: number; tasksCompleted: number }
  >();
  for (const item of tasksCreatedInPeriod) {
    const day = item.createdAt.toISOString().slice(0, 10);
    const bucket = dailyBucketMap.get(day) ?? {
      date: day,
      tasksCreated: 0,
      tasksCompleted: 0,
    };
    bucket.tasksCreated++;
    dailyBucketMap.set(day, bucket);
  }
  for (const item of tasksCompletedInPeriod) {
    const day = item.completedAt.toISOString().slice(0, 10);
    const bucket = dailyBucketMap.get(day) ?? {
      date: day,
      tasksCreated: 0,
      tasksCompleted: 0,
    };
    bucket.tasksCompleted++;
    dailyBucketMap.set(day, bucket);
  }
  const dailyTimeline = Array.from(dailyBucketMap.values()).sort((a, b) =>
    b.date.localeCompare(a.date),
  );

  return {
    countingMethod: {
      key: "top_level_tasks_only",
      formula: "Completed tasks / Total tasks * 100",
      description:
        "Top-level tasks (parentTaskId: null) are counted for project totals and completion percentages to prevent double-counting subtasks. Subtask counts are reported separately on each project.",
    },
    filters: {
      projectId: targetProjectId ? targetProjectId.toHexString() : null,
      memberId:
        memberFilterMode === "unassigned"
          ? "unassigned"
          : memberFilterMode === "member" && targetMemberId
            ? targetMemberId
            : null,
      dateFrom: dateFrom ? dateFrom.toISOString() : null,
      dateTo: dateTo ? dateTo.toISOString() : null,
      status: statusFilter,
      priority: priorityFilter,
      projectStatus: projectScope,
      staleThresholdDays,
    },
    summary: {
      totalProjects: matchingProjects.length,
      totalTasks: totalSummaryTasks,
      completedTasks: totalSummaryCompleted,
      inProgressTasks: totalSummaryInProgress,
      notStartedTasks: totalSummaryNotStarted,
      blockedTasks: totalSummaryBlocked,
      overdueTasks: totalSummaryOverdue,
      staleTasks: totalSummaryStale,
      tasksDueToday: totalSummaryDueToday,
      tasksDueSoon: totalSummaryDueSoon,
      completionPercentage: overallCompletionPercentage,
    },
    projectProgress,
    teamWorkload,
    timeReport: {
      dateFrom: dateFrom ? dateFrom.toISOString() : null,
      dateTo: dateTo ? dateTo.toISOString() : null,
      tasksCreatedCount: tasksCreatedInPeriod.length,
      tasksCompletedCount: tasksCompletedInPeriod.length,
      overdueTasksCount: totalSummaryOverdue,
      staleTasksCount: totalSummaryStale,
      tasksCreatedInPeriod,
      tasksCompletedInPeriod,
      projectProgressOverTime,
      dailyTimeline,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 6.1–6.3: Meeting Foundation (Meetings, Participants, Notes, Decisions & Action Items)
// ---------------------------------------------------------------------------

export const DEFAULT_MEETING_PAGE_LIMIT = 20;
export const MAX_MEETING_PAGE_LIMIT = 100;

export const MEETING_ARCHIVE_FILTERS = ["active", "archived", "all"] as const;
export type MeetingArchiveFilter = (typeof MEETING_ARCHIVE_FILTERS)[number];

const MEETING_TITLE_MIN_LENGTH = 1;
const MEETING_TITLE_MAX_LENGTH = 200;
const MEETING_DESCRIPTION_MAX_LENGTH = 5000;
const MEETING_NOTES_MAX_LENGTH = 20000;
const DISCUSSION_POINT_MAX_LENGTH = 5000;
const DECISION_TITLE_MAX_LENGTH = 300;
const DECISION_DESCRIPTION_MAX_LENGTH = 5000;

const ACTION_ITEM_TITLE_MIN_LENGTH = 1;
const ACTION_ITEM_TITLE_MAX_LENGTH = 300;
const ACTION_ITEM_DESCRIPTION_MAX_LENGTH = 5000;

export const ARCHIVED_MEETING_MODIFICATION_MESSAGE =
  "Cannot modify an archived meeting unless unarchiving it.";
export const ARCHIVED_MEETING_ACTION_ITEM_MESSAGE =
  "Cannot create or modify action items in an archived meeting.";

export function validateMeetingTitle(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new TenantValidationError("Meeting title must be a string.");
  }
  const trimmed = raw.trim();
  if (
    trimmed.length < MEETING_TITLE_MIN_LENGTH ||
    trimmed.length > MEETING_TITLE_MAX_LENGTH
  ) {
    throw new TenantValidationError(
      `Meeting title must be between ${MEETING_TITLE_MIN_LENGTH} and ${MEETING_TITLE_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
}

export function validateMeetingDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new TenantValidationError(
      "Meeting description must be a string or null.",
    );
  }
  if (raw.length > MEETING_DESCRIPTION_MAX_LENGTH) {
    throw new TenantValidationError(
      `Meeting description must be at most ${MEETING_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }
  return normalizeDescription(raw);
}

export function validateMeetingNotes(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new TenantValidationError("Meeting notes must be a string or null.");
  }
  if (raw.length > MEETING_NOTES_MAX_LENGTH) {
    throw new TenantValidationError(
      `Meeting notes must be at most ${MEETING_NOTES_MAX_LENGTH} characters.`,
    );
  }
  return raw.trim() === "" ? null : raw;
}

export function validateMeetingDate(raw: unknown): Date {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      throw new TenantValidationError("Meeting date must be a valid date.");
    }
    return raw;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new TenantValidationError(
      "Meeting date is required and must be a valid ISO date string.",
    );
  }
  const trimmed = raw.trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? new Date(`${trimmed}T00:00:00.000Z`)
    : new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new TenantValidationError(
      "Meeting date must be a valid ISO date string.",
    );
  }
  return parsed;
}

export function validateMeetingStatus(raw: unknown): MeetingStatus {
  if (
    typeof raw !== "string" ||
    !(MEETING_STATUSES as readonly string[]).includes(raw)
  ) {
    throw new TenantValidationError(
      `Meeting status must be one of: ${MEETING_STATUSES.join(", ")}.`,
    );
  }
  return raw as MeetingStatus;
}

export function validateMeetingStatusFilter(
  raw: unknown,
): MeetingStatus | "all" {
  if (raw === undefined || raw === null || raw === "" || raw === "all") {
    return "all";
  }
  return validateMeetingStatus(raw);
}

export function validateMeetingArchiveFilter(
  rawArchived?: unknown,
  rawIncludeArchived?: unknown,
): MeetingArchiveFilter {
  if (
    rawArchived !== undefined &&
    rawArchived !== null &&
    rawArchived !== ""
  ) {
    if (rawArchived === "active" || rawArchived === "false" || rawArchived === false) {
      return "active";
    }
    if (rawArchived === "archived" || rawArchived === "only" || rawArchived === "true" || rawArchived === true) {
      return "archived";
    }
    if (rawArchived === "all") {
      return "all";
    }
    throw new TenantValidationError(
      `Invalid archived filter "${String(rawArchived)}". Supported values: active, archived, all.`,
    );
  }
  if (
    rawIncludeArchived === true ||
    rawIncludeArchived === "true" ||
    rawIncludeArchived === "1"
  ) {
    return "all";
  }
  return "active";
}

export function validateActionItemTitle(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new TenantValidationError("Action item title must be a string.");
  }
  const trimmed = raw.trim();
  if (
    trimmed.length < ACTION_ITEM_TITLE_MIN_LENGTH ||
    trimmed.length > ACTION_ITEM_TITLE_MAX_LENGTH
  ) {
    throw new TenantValidationError(
      `Action item title must be between ${ACTION_ITEM_TITLE_MIN_LENGTH} and ${ACTION_ITEM_TITLE_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
}

export function validateActionItemDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new TenantValidationError(
      "Action item description must be a string or null.",
    );
  }
  if (raw.length > ACTION_ITEM_DESCRIPTION_MAX_LENGTH) {
    throw new TenantValidationError(
      `Action item description must be at most ${ACTION_ITEM_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }
  return normalizeDescription(raw);
}

export function validateActionItemTargetDate(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      throw new TenantValidationError(
        "Action item targetDate must be a valid Date or null.",
      );
    }
    return raw;
  }
  if (typeof raw !== "string") {
    throw new TenantValidationError(
      "Action item targetDate must be an ISO date string or null.",
    );
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? new Date(`${trimmed}T00:00:00.000Z`)
    : new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new TenantValidationError(
      "Action item targetDate must be a valid ISO date string or null.",
    );
  }
  return parsed;
}

export function validateActionItemStatus(raw: unknown): ActionItemStatus {
  if (
    typeof raw !== "string" ||
    !(ACTION_ITEM_STATUSES as readonly string[]).includes(raw)
  ) {
    throw new TenantValidationError(
      `Action item status must be one of: ${ACTION_ITEM_STATUSES.join(", ")}.`,
    );
  }
  return raw as ActionItemStatus;
}

export function validateActionItemStatusFilter(
  raw: unknown,
): ActionItemStatus | "all" {
  if (raw === undefined || raw === null || raw === "" || raw === "all") {
    return "all";
  }
  return validateActionItemStatus(raw);
}

function validateDiscussionPointContent(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new TenantValidationError("Discussion point content must be a string.");
  }
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > DISCUSSION_POINT_MAX_LENGTH) {
    throw new TenantValidationError(
      `Discussion point content must be between 1 and ${DISCUSSION_POINT_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function validateDecisionTitle(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new TenantValidationError("Decision title must be a string.");
  }
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > DECISION_TITLE_MAX_LENGTH) {
    throw new TenantValidationError(
      `Decision title must be between 1 and ${DECISION_TITLE_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function validateDecisionDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new TenantValidationError(
      "Decision description must be a string or null.",
    );
  }
  if (raw.length > DECISION_DESCRIPTION_MAX_LENGTH) {
    throw new TenantValidationError(
      `Decision description must be at most ${DECISION_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }
  return normalizeDescription(raw);
}

async function validateParticipantUserIdsInOrg(
  membership: MembershipDoc,
  rawParticipantIds: unknown,
): Promise<UserId[]> {
  if (rawParticipantIds === undefined || rawParticipantIds === null) {
    return [];
  }
  if (!Array.isArray(rawParticipantIds)) {
    throw new TenantValidationError(
      "participantIds must be an array of organization member userId strings.",
    );
  }

  const deduped: UserId[] = [];
  const seen = new Set<UserId>();
  for (const item of rawParticipantIds) {
    const uid = validateMemberUserId(item);
    if (!seen.has(uid)) {
      seen.add(uid);
      deduped.push(uid);
    }
  }

  if (deduped.length === 0) {
    return [];
  }

  const { memberships } = await getCollections();
  const matched = await memberships
    .find(
      {
        organizationId: membership.organizationId,
        userId: { $in: deduped },
      },
      { projection: { _id: 0, userId: 1 } },
    )
    .toArray();

  const validMemberIds = new Set(matched.map((m) => m.userId));
  for (const uid of deduped) {
    if (!validMemberIds.has(uid)) {
      throw new TenantValidationError(
        `Participant "${uid}" is not a member of this organization.`,
      );
    }
  }

  return deduped;
}

function parseDiscussionPointsInput(
  rawPoints: unknown,
  actorId: UserId,
  now: Date,
  existingPoints?: readonly MeetingDiscussionPointDoc[],
): MeetingDiscussionPointDoc[] {
  if (!Array.isArray(rawPoints)) {
    throw new TenantValidationError(
      "discussionPoints must be an array of discussion point items.",
    );
  }
  const existingById = new Map<string, MeetingDiscussionPointDoc>();
  for (const pt of existingPoints ?? []) {
    existingById.set(pt.id, pt);
  }

  return rawPoints.map((entry) => {
    if (typeof entry === "string") {
      const content = validateDiscussionPointContent(entry);
      return {
        id: new ObjectId().toHexString(),
        content,
        authorId: actorId,
        createdAt: now,
        updatedAt: now,
      };
    }
    if (!isPlainObject(entry)) {
      throw new TenantValidationError(
        "Each discussion point must be a string or an object with a content field.",
      );
    }
    const content = validateDiscussionPointContent(entry.content);
    const id =
      typeof entry.id === "string" && entry.id.trim().length > 0 && entry.id.trim().length <= 64
        ? entry.id.trim()
        : new ObjectId().toHexString();
    const prev = existingById.get(id);
    return {
      id,
      content,
      authorId: prev ? prev.authorId : actorId,
      createdAt: prev ? prev.createdAt : now,
      updatedAt: prev && prev.content === content ? prev.updatedAt : now,
    };
  });
}

function parseDecisionsInput(
  rawDecisions: unknown,
  actorId: UserId,
  now: Date,
  existingDecisions?: readonly MeetingDecisionDoc[],
): MeetingDecisionDoc[] {
  if (!Array.isArray(rawDecisions)) {
    throw new TenantValidationError(
      "decisions must be an array of decision items.",
    );
  }
  const existingById = new Map<string, MeetingDecisionDoc>();
  for (const dec of existingDecisions ?? []) {
    existingById.set(dec.id, dec);
  }

  return rawDecisions.map((entry) => {
    if (typeof entry === "string") {
      const title = validateDecisionTitle(entry);
      return {
        id: new ObjectId().toHexString(),
        title,
        description: null,
        decidedBy: actorId,
        createdAt: now,
        updatedAt: now,
      };
    }
    if (!isPlainObject(entry)) {
      throw new TenantValidationError(
        "Each decision must be a string or an object with title and optional description.",
      );
    }
    const title = validateDecisionTitle(entry.title ?? entry.content);
    const description = validateDecisionDescription(entry.description);
    const id =
      typeof entry.id === "string" && entry.id.trim().length > 0 && entry.id.trim().length <= 64
        ? entry.id.trim()
        : new ObjectId().toHexString();
    const prev = existingById.get(id);
    const unchanged =
      prev !== undefined &&
      prev.title === title &&
      (prev.description ?? null) === description;
    return {
      id,
      title,
      description,
      decidedBy: prev ? prev.decidedBy : actorId,
      createdAt: prev ? prev.createdAt : now,
      updatedAt: unchanged ? prev.updatedAt : now,
    };
  });
}

export type MeetingParticipantItem = {
  userId: UserId;
  name: string | null;
  email: string | null;
  role: MembershipRole | null;
};

export type MeetingDiscussionPointItem = {
  id: string;
  content: string;
  authorId: UserId;
  authorName: string | null;
  authorEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MeetingDecisionItem = {
  id: string;
  title: string;
  description: string | null;
  decidedBy: UserId;
  decidedByName: string | null;
  decidedByEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MeetingActionItemCounts = {
  total: number;
  open: number;
  inProgress: number;
  completed: number;
  cancelled: number;
};

export type MeetingEnriched = {
  _id: ObjectId;
  id: string;
  organizationId: ObjectId;
  projectId: ObjectId | null;
  projectName: string | null;
  projectStatus: ProjectStatus | null;
  title: string;
  meetingDate: Date;
  description: string | null;
  status: MeetingStatus;
  participantIds: UserId[];
  participants: MeetingParticipantItem[];
  notes: string | null;
  discussionPoints: MeetingDiscussionPointItem[];
  decisions: MeetingDecisionItem[];
  actionItemCounts: MeetingActionItemCounts;
  createdBy: UserId;
  createdByUser: {
    userId: UserId;
    name: string | null;
    email: string | null;
  };
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MeetingActionItemLinkedTaskSummary = {
  id: string;
  projectId: string;
  projectName: string | null;
  projectStatus: ProjectStatus | null;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
};

export type MeetingActionItemEnriched = {
  _id: ObjectId;
  id: string;
  organizationId: ObjectId;
  meetingId: ObjectId;
  title: string;
  description: string | null;
  ownerId: UserId | null;
  owner: {
    userId: UserId;
    name: string | null;
    email: string | null;
    role: MembershipRole | null;
  } | null;
  targetDate: Date | null;
  status: ActionItemStatus;
  createdBy: UserId;
  createdByUser: {
    userId: UserId;
    name: string | null;
    email: string | null;
  };
  completedAt: Date | null;
  linkedTaskId: ObjectId | null;
  linkedTask: MeetingActionItemLinkedTaskSummary | null;
  createdAt: Date;
  updatedAt: Date;
};

async function enrichMeetingDocs(
  organizationId: ObjectId,
  docs: readonly MeetingDoc[],
): Promise<MeetingEnriched[]> {
  if (docs.length === 0) {
    return [];
  }

  const meetingIds = docs.map((d) => d._id);
  const projectIds: ObjectId[] = [];
  const projectIdSet = new Set<string>();
  const userIdSet = new Set<UserId>();

  for (const doc of docs) {
    userIdSet.add(doc.createdBy);
    for (const pid of doc.participantIds ?? []) {
      userIdSet.add(pid);
    }
    for (const pt of doc.discussionPoints ?? []) {
      userIdSet.add(pt.authorId);
    }
    for (const dec of doc.decisions ?? []) {
      userIdSet.add(dec.decidedBy);
    }
    if (doc.projectId) {
      const pHex = doc.projectId.toHexString();
      if (!projectIdSet.has(pHex)) {
        projectIdSet.add(pHex);
        projectIds.push(doc.projectId);
      }
    }
  }

  const allUserIds = Array.from(userIdSet);
  const { memberships, projects, meetingActionItems } = await getCollections();

  const [profilesById, memberDocs, projectDocs, actionItemCountRows] =
    await Promise.all([
      lookupRegisteredUsersByIds(allUserIds),
      allUserIds.length > 0
        ? memberships
          .find(
            { organizationId, userId: { $in: allUserIds } },
            { projection: { _id: 0, userId: 1, role: 1 } },
          )
          .toArray()
        : Promise.resolve([]),
      projectIds.length > 0
        ? projects
          .find(
            { organizationId, _id: { $in: projectIds } },
            { projection: { _id: 1, name: 1, status: 1 } },
          )
          .toArray()
        : Promise.resolve([]),
      meetingActionItems
        .aggregate<{
          _id: { meetingId: ObjectId; status: ActionItemStatus };
          count: number;
        }>([
          {
            $match: {
              organizationId,
              meetingId: { $in: meetingIds },
            },
          },
          {
            $group: {
              _id: { meetingId: "$meetingId", status: "$status" },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
    ]);

  const roleByUserId = new Map<UserId, MembershipRole>();
  for (const m of memberDocs) {
    roleByUserId.set(m.userId, m.role);
  }

  const projectByHex = new Map<string, Pick<ProjectDoc, "_id" | "name" | "status">>();
  for (const p of projectDocs) {
    projectByHex.set(p._id.toHexString(), p);
  }

  const countsByMeetingHex = new Map<string, MeetingActionItemCounts>();
  for (const doc of docs) {
    countsByMeetingHex.set(doc._id.toHexString(), {
      total: 0,
      open: 0,
      inProgress: 0,
      completed: 0,
      cancelled: 0,
    });
  }
  for (const row of actionItemCountRows) {
    const mHex = row._id.meetingId.toHexString();
    const bucket = countsByMeetingHex.get(mHex);
    if (!bucket) continue;
    bucket.total += row.count;
    if (row._id.status === "open") bucket.open += row.count;
    else if (row._id.status === "in_progress") bucket.inProgress += row.count;
    else if (row._id.status === "completed") bucket.completed += row.count;
    else if (row._id.status === "cancelled") bucket.cancelled += row.count;
  }

  return docs.map((doc) => {
    const mHex = doc._id.toHexString();
    const proj = doc.projectId ? projectByHex.get(doc.projectId.toHexString()) : undefined;
    const creatorProfile = profilesById.get(doc.createdBy);
    const participantIds = Array.isArray(doc.participantIds) ? doc.participantIds : [];
    const participants: MeetingParticipantItem[] = participantIds.map((uid) => {
      const prof = profilesById.get(uid);
      return {
        userId: uid,
        name: prof?.name ?? null,
        email: prof?.email ?? null,
        role: roleByUserId.get(uid) ?? null,
      };
    });

    const discussionPoints: MeetingDiscussionPointItem[] = (
      doc.discussionPoints ?? []
    ).map((pt) => {
      const prof = profilesById.get(pt.authorId);
      return {
        id: pt.id,
        content: pt.content,
        authorId: pt.authorId,
        authorName: prof?.name ?? null,
        authorEmail: prof?.email ?? null,
        createdAt: pt.createdAt,
        updatedAt: pt.updatedAt,
      };
    });

    const decisions: MeetingDecisionItem[] = (doc.decisions ?? []).map((dec) => {
      const prof = profilesById.get(dec.decidedBy);
      return {
        id: dec.id,
        title: dec.title,
        description: dec.description ?? null,
        decidedBy: dec.decidedBy,
        decidedByName: prof?.name ?? null,
        decidedByEmail: prof?.email ?? null,
        createdAt: dec.createdAt,
        updatedAt: dec.updatedAt,
      };
    });

    return {
      _id: doc._id,
      id: mHex,
      organizationId: doc.organizationId,
      projectId: doc.projectId ?? null,
      projectName: proj?.name ?? null,
      projectStatus: proj?.status ?? null,
      title: doc.title,
      meetingDate: doc.meetingDate,
      description: doc.description ?? null,
      status: doc.status,
      participantIds,
      participants,
      notes: doc.notes ?? null,
      discussionPoints,
      decisions,
      actionItemCounts: countsByMeetingHex.get(mHex) ?? {
        total: 0,
        open: 0,
        inProgress: 0,
        completed: 0,
        cancelled: 0,
      },
      createdBy: doc.createdBy,
      createdByUser: {
        userId: doc.createdBy,
        name: creatorProfile?.name ?? null,
        email: creatorProfile?.email ?? null,
      },
      archivedAt: doc.archivedAt ?? null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  });
}

async function enrichActionItemDocs(
  organizationId: ObjectId,
  docs: readonly MeetingActionItemDoc[],
): Promise<MeetingActionItemEnriched[]> {
  if (docs.length === 0) {
    return [];
  }

  const userIdSet = new Set<UserId>();
  const actionItemIds = docs.map((d) => d._id);
  const linkedTaskIds: ObjectId[] = [];
  const linkedTaskIdHexSet = new Set<string>();

  for (const doc of docs) {
    userIdSet.add(doc.createdBy);
    if (doc.ownerId) {
      userIdSet.add(doc.ownerId);
    }
    if (doc.linkedTaskId) {
      const tHex = doc.linkedTaskId.toHexString();
      if (!linkedTaskIdHexSet.has(tHex)) {
        linkedTaskIdHexSet.add(tHex);
        linkedTaskIds.push(doc.linkedTaskId);
      }
    }
  }

  const allUserIds = Array.from(userIdSet);
  const { memberships, tasks, projects } = await getCollections();
  const taskMatchOr: Record<string, unknown>[] = [
    { sourceActionItemId: { $in: actionItemIds } },
  ];
  if (linkedTaskIds.length > 0) {
    taskMatchOr.push({ _id: { $in: linkedTaskIds } });
  }

  const [profilesById, memberDocs, linkedTaskDocs] = await Promise.all([
    lookupRegisteredUsersByIds(allUserIds),
    allUserIds.length > 0
      ? memberships
        .find(
          { organizationId, userId: { $in: allUserIds } },
          { projection: { _id: 0, userId: 1, role: 1 } },
        )
        .toArray()
      : Promise.resolve([]),
    tasks
      .find(
        {
          organizationId,
          $or: taskMatchOr,
        },
        {
          projection: {
            _id: 1,
            projectId: 1,
            title: 1,
            status: 1,
            priority: 1,
            sourceActionItemId: 1,
          },
        },
      )
      .toArray(),
  ]);

  const projectIdsToLookup: ObjectId[] = [];
  const projectIdHexSet = new Set<string>();
  const linkedTaskByHex = new Map<string, Pick<TaskDoc, "_id" | "projectId" | "title" | "status" | "priority" | "sourceActionItemId">>();
  const linkedTaskByActionItemHex = new Map<string, Pick<TaskDoc, "_id" | "projectId" | "title" | "status" | "priority" | "sourceActionItemId">>();

  for (const t of linkedTaskDocs) {
    const tHex = t._id.toHexString();
    linkedTaskByHex.set(tHex, t);
    if (t.sourceActionItemId) {
      linkedTaskByActionItemHex.set(t.sourceActionItemId.toHexString(), t);
    }
    const pHex = t.projectId.toHexString();
    if (!projectIdHexSet.has(pHex)) {
      projectIdHexSet.add(pHex);
      projectIdsToLookup.push(t.projectId);
    }
  }

  const projectDocs =
    projectIdsToLookup.length > 0
      ? await projects
        .find(
          { organizationId, _id: { $in: projectIdsToLookup } },
          { projection: { _id: 1, name: 1, status: 1 } },
        )
        .toArray()
      : [];

  const projectByHex = new Map<string, Pick<ProjectDoc, "_id" | "name" | "status">>();
  for (const p of projectDocs) {
    projectByHex.set(p._id.toHexString(), p);
  }

  const roleByUserId = new Map<UserId, MembershipRole>();
  for (const m of memberDocs) {
    roleByUserId.set(m.userId, m.role);
  }

  return docs.map((doc) => {
    const ownerProfile = doc.ownerId ? profilesById.get(doc.ownerId) : undefined;
    const creatorProfile = profilesById.get(doc.createdBy);
    const aiHex = doc._id.toHexString();
    const matchedTask =
      (doc.linkedTaskId ? linkedTaskByHex.get(doc.linkedTaskId.toHexString()) : undefined) ??
      linkedTaskByActionItemHex.get(aiHex);
    const matchedProject = matchedTask
      ? projectByHex.get(matchedTask.projectId.toHexString())
      : undefined;

    return {
      _id: doc._id,
      id: aiHex,
      organizationId: doc.organizationId,
      meetingId: doc.meetingId,
      title: doc.title,
      description: doc.description ?? null,
      ownerId: doc.ownerId ?? null,
      owner: doc.ownerId
        ? {
          userId: doc.ownerId,
          name: ownerProfile?.name ?? null,
          email: ownerProfile?.email ?? null,
          role: roleByUserId.get(doc.ownerId) ?? null,
        }
        : null,
      targetDate: doc.targetDate ?? null,
      status: doc.status,
      createdBy: doc.createdBy,
      createdByUser: {
        userId: doc.createdBy,
        name: creatorProfile?.name ?? null,
        email: creatorProfile?.email ?? null,
      },
      completedAt: doc.completedAt ?? null,
      linkedTaskId: matchedTask ? matchedTask._id : (doc.linkedTaskId ?? null),
      linkedTask: matchedTask
        ? {
          id: matchedTask._id.toHexString(),
          projectId: matchedTask.projectId.toHexString(),
          projectName: matchedProject?.name ?? null,
          projectStatus: matchedProject?.status ?? null,
          title: matchedTask.title,
          status: matchedTask.status,
          priority: matchedTask.priority,
        }
        : null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  });
}

async function requireMeetingInOrg(
  membership: MembershipDoc,
  meetingId: ObjectId,
): Promise<MeetingDoc> {
  requireObjectId(meetingId, "meetingId");
  const { meetings } = await getCollections();
  const meeting = await meetings.findOne({
    _id: meetingId,
    organizationId: membership.organizationId,
  });
  if (!meeting) {
    throw new TenantValidationError(
      "Referenced meeting does not belong to this organization.",
    );
  }
  return meeting;
}

export type CreateMeetingInput = {
  title: string;
  meetingDate: Date | string;
  description?: string | null;
  projectId?: ObjectId | string | null;
  status?: MeetingStatus;
  participantIds?: UserId[];
  notes?: string | null;
  discussionPoints?: unknown[];
  decisions?: unknown[];
};

export async function createMeeting(
  organizationId: ObjectId,
  input: CreateMeetingInput,
  requestHeaders?: Headers,
): Promise<MeetingEnriched> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  if (!isPlainObject(input)) {
    throw new TenantValidationError("Meeting input must be a plain object.");
  }

  const title = validateMeetingTitle(input.title);
  const meetingDate = validateMeetingDate(input.meetingDate);
  const description = validateMeetingDescription(input.description);
  const status =
    input.status !== undefined
      ? validateMeetingStatus(input.status)
      : "scheduled";
  const notes = validateMeetingNotes(input.notes);

  let projectId: ObjectId | null = null;
  if (
    input.projectId !== undefined &&
    input.projectId !== null &&
    input.projectId !== ""
  ) {
    const parsedProjId =
      input.projectId instanceof ObjectId
        ? input.projectId
        : typeof input.projectId === "string"
          ? parseObjectId(input.projectId.trim())
          : null;
    if (!parsedProjId) {
      throw new TenantValidationError("Invalid projectId.");
    }
    const project = await requireProjectInOrg(membership, parsedProjId);
    projectId = project._id;
  }

  const participantIds = await validateParticipantUserIdsInOrg(
    membership,
    input.participantIds,
  );

  const now = new Date();
  const discussionPoints =
    input.discussionPoints !== undefined
      ? parseDiscussionPointsInput(input.discussionPoints, membership.userId, now)
      : [];
  const decisions =
    input.decisions !== undefined
      ? parseDecisionsInput(input.decisions, membership.userId, now)
      : [];

  const doc: MeetingDoc = {
    _id: new ObjectId(),
    organizationId: membership.organizationId,
    projectId,
    title,
    meetingDate,
    description,
    status,
    participantIds,
    notes,
    discussionPoints,
    decisions,
    createdBy: membership.userId,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: doc.projectId,
    taskId: null,
    actorId: membership.userId,
    eventType: "meeting.created",
    targetType: "meeting",
    targetId: doc._id,
    summary: `Created meeting "${doc.title}"`,
    changes: [
      { field: "title", before: null, after: doc.title },
      {
        field: "meetingDate",
        before: null,
        after: doc.meetingDate.toISOString(),
      },
      { field: "status", before: null, after: doc.status },
      ...(doc.description !== null && doc.description !== undefined
        ? [{ field: "description", before: null, after: doc.description }]
        : []),
    ],
    metadata: {
      meetingTitle: doc.title,
      participantCount: doc.participantIds.length,
    },
    createdAt: now,
  });

  const { meetings, activities, organizations } = await getCollections();
  await runInTransactionOrFallback(
    async (session) => {
      await meetings.insertOne(doc, { session });
      await activities.insertOne(activityDoc, { session });
    },
    async () => {
      await meetings.insertOne(doc);
      await activities.insertOne(activityDoc);
    },
  );

  const organization = await organizations.findOne({
    _id: membership.organizationId,
  });
  if (organization && Array.isArray(doc.participantIds)) {
    const meetingDateStr = doc.meetingDate
      ? ` scheduled for ${doc.meetingDate.toISOString().slice(0, 10)}`
      : "";
    for (const participantId of doc.participantIds) {
      if (participantId !== membership.userId) {
        await createNotificationSafe({
          organizationId: membership.organizationId,
          recipientId: participantId,
          type: "meeting.participant_added",
          title: `Added to meeting: ${doc.title}`,
          message: `You were added as a participant to "${doc.title}"${meetingDateStr}.`,
          url: `/dashboard/${organization.slug}/meetings/${doc._id}`,
          entityType: "meeting",
          entityId: doc._id,
          projectId: doc.projectId ?? null,
          actorId: membership.userId,
          dedupeKey: `meeting.participant_added:${doc._id.toHexString()}:${participantId}`,
        });
      }
    }
  }

  const [enriched] = await enrichMeetingDocs(membership.organizationId, [doc]);
  return enriched;
}

export type ListMeetingsFilter = {
  search?: unknown;
  status?: unknown;
  projectId?: unknown;
  participantId?: unknown;
  archived?: unknown;
  includeArchived?: unknown;
  page?: unknown;
  limit?: unknown;
};

export type ListMeetingsResult = {
  meetings: MeetingEnriched[];
  pagination: {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
};

export async function listMeetings(
  organizationId: ObjectId,
  filter?: ListMeetingsFilter,
  requestHeaders?: Headers,
): Promise<ListMeetingsResult> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const orgId = membership.organizationId;

  const statusFilter = validateMeetingStatusFilter(filter?.status);
  const archiveFilter = validateMeetingArchiveFilter(
    filter?.archived,
    filter?.includeArchived,
  );
  const page = validateSupervisionPageNumber(filter?.page);
  const limit = validateSupervisionPageLimit(
    filter?.limit,
    DEFAULT_MEETING_PAGE_LIMIT,
  );

  const mongoQuery: Record<string, unknown> = {
    organizationId: orgId,
  };

  if (statusFilter !== "all") {
    mongoQuery.status = statusFilter;
  }

  if (archiveFilter === "active") {
    mongoQuery.archivedAt = null;
  } else if (archiveFilter === "archived") {
    mongoQuery.archivedAt = { $ne: null };
  }

  if (
    filter?.projectId !== undefined &&
    filter.projectId !== null &&
    filter.projectId !== "" &&
    filter.projectId !== "all"
  ) {
    if (filter.projectId === "none" || filter.projectId === "unassigned") {
      mongoQuery.projectId = null;
    } else {
      const parsedProjId =
        filter.projectId instanceof ObjectId
          ? filter.projectId
          : typeof filter.projectId === "string"
            ? parseObjectId(filter.projectId.trim())
            : null;
      if (!parsedProjId) {
        throw new TenantValidationError("Invalid projectId filter.");
      }
      await requireProjectInOrg(membership, parsedProjId);
      mongoQuery.projectId = parsedProjId;
    }
  }

  if (
    filter?.participantId !== undefined &&
    filter.participantId !== null &&
    filter.participantId !== "" &&
    filter.participantId !== "all"
  ) {
    const uid = validateMemberUserId(filter.participantId);
    mongoQuery.participantIds = uid;
  }

  if (filter?.search !== undefined && filter.search !== null) {
    if (typeof filter.search !== "string") {
      throw new TenantValidationError("Search query must be a string.");
    }
    const trimmedSearch = filter.search.trim();
    if (trimmedSearch.length > 200) {
      throw new TenantValidationError(
        "Search query must be at most 200 characters.",
      );
    }
    if (trimmedSearch.length > 0) {
      const escaped = escapeMongoRegex(trimmedSearch);
      const regex = { $regex: escaped, $options: "i" };
      mongoQuery.$or = [
        { title: regex },
        { description: regex },
        { notes: regex },
        { "discussionPoints.content": regex },
        { "decisions.title": regex },
      ];
    }
  }

  const { meetings } = await getCollections();
  const skip = (page - 1) * limit;

  const [totalCount, docs] = await Promise.all([
    meetings.countDocuments(mongoQuery),
    meetings
      .find(mongoQuery)
      .sort({ meetingDate: -1, createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
  ]);

  const enriched = await enrichMeetingDocs(orgId, docs);
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));

  return {
    meetings: enriched,
    pagination: {
      page,
      limit,
      totalCount,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
}

export async function getMeetingById(
  organizationId: ObjectId,
  meetingId: ObjectId,
  requestHeaders?: Headers,
): Promise<MeetingEnriched | null> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  requireObjectId(meetingId, "meetingId");
  const { meetings } = await getCollections();
  const doc = await meetings.findOne({
    _id: meetingId,
    organizationId: membership.organizationId,
  });
  if (!doc) {
    return null;
  }
  const [enriched] = await enrichMeetingDocs(membership.organizationId, [doc]);
  return enriched;
}

export type UpdateMeetingInput = {
  title?: string;
  meetingDate?: Date | string;
  description?: string | null;
  projectId?: ObjectId | string | null;
  status?: MeetingStatus;
  participantIds?: UserId[];
  notes?: string | null;
  discussionPoints?: unknown[];
  decisions?: unknown[];
};

export async function updateMeeting(
  organizationId: ObjectId,
  meetingId: ObjectId,
  input: UpdateMeetingInput,
  requestHeaders?: Headers,
): Promise<MeetingEnriched | null> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  requireObjectId(meetingId, "meetingId");
  if (!isPlainObject(input)) {
    throw new TenantValidationError(
      "Meeting update input must be a plain object.",
    );
  }

  const hasTitle = input.title !== undefined;
  const hasMeetingDate = input.meetingDate !== undefined;
  const hasDescription = input.description !== undefined;
  const hasProjectId = input.projectId !== undefined;
  const hasStatus = input.status !== undefined;
  const hasParticipantIds = input.participantIds !== undefined;
  const hasNotes = input.notes !== undefined;
  const hasDiscussionPoints = input.discussionPoints !== undefined;
  const hasDecisions = input.decisions !== undefined;

  if (
    !hasTitle &&
    !hasMeetingDate &&
    !hasDescription &&
    !hasProjectId &&
    !hasStatus &&
    !hasParticipantIds &&
    !hasNotes &&
    !hasDiscussionPoints &&
    !hasDecisions
  ) {
    throw new TenantValidationError(
      "At least one meeting field must be provided for update.",
    );
  }

  const isManager = isManagerRole(membership.role);
  const hasManagerOnlyFields =
    hasTitle ||
    hasMeetingDate ||
    hasDescription ||
    hasProjectId ||
    hasStatus ||
    hasParticipantIds;

  if (hasManagerOnlyFields && !isManager) {
    throw new TenantAccessError(
      "Only admins and managers can update meeting details or participants.",
    );
  }

  const { meetings, activities, organizations } = await getCollections();
  const existing = await meetings.findOne({
    _id: meetingId,
    organizationId: membership.organizationId,
  });
  if (!existing) {
    return null;
  }

  if (!isManager) {
    const isParticipantOrCreator =
      existing.createdBy === membership.userId ||
      (existing.participantIds ?? []).includes(membership.userId);
    if (!isParticipantOrCreator) {
      throw new TenantAccessError(
        "Only admins, managers, and meeting participants can update meeting notes and decisions.",
      );
    }
  }

  if (existing.archivedAt !== null) {
    throw new TenantValidationError(ARCHIVED_MEETING_MODIFICATION_MESSAGE);
  }

  const now = new Date();
  const updates: Partial<MeetingDoc> & { updatedAt: Date } = {
    updatedAt: now,
  };
  const changes: ActivityFieldChange[] = [];

  if (hasTitle) {
    const newTitle = validateMeetingTitle(input.title);
    if (newTitle !== existing.title) {
      updates.title = newTitle;
      changes.push({
        field: "title",
        before: existing.title,
        after: newTitle,
      });
    }
  }

  if (hasMeetingDate) {
    const newDate = validateMeetingDate(input.meetingDate);
    if (newDate.getTime() !== existing.meetingDate.getTime()) {
      updates.meetingDate = newDate;
      changes.push({
        field: "meetingDate",
        before: existing.meetingDate.toISOString(),
        after: newDate.toISOString(),
      });
    }
  }

  if (hasDescription) {
    const newDesc = validateMeetingDescription(input.description);
    if (newDesc !== (existing.description ?? null)) {
      updates.description = newDesc;
      changes.push({
        field: "description",
        before: existing.description ?? null,
        after: newDesc,
      });
    }
  }

  if (hasProjectId) {
    let targetProjId: ObjectId | null = null;
    if (input.projectId !== null && input.projectId !== "") {
      const parsedProjId =
        input.projectId instanceof ObjectId
          ? input.projectId
          : typeof input.projectId === "string"
            ? parseObjectId(input.projectId.trim())
            : null;
      if (!parsedProjId) {
        throw new TenantValidationError("Invalid projectId.");
      }
      const proj = await requireProjectInOrg(membership, parsedProjId);
      targetProjId = proj._id;
    }
    if (!sameNullableObjectId(targetProjId, existing.projectId ?? null)) {
      updates.projectId = targetProjId;
      changes.push({
        field: "projectId",
        before: existing.projectId ? existing.projectId.toHexString() : null,
        after: targetProjId ? targetProjId.toHexString() : null,
      });
    }
  }

  if (hasStatus) {
    const newStatus = validateMeetingStatus(input.status);
    if (newStatus !== existing.status) {
      updates.status = newStatus;
      changes.push({
        field: "status",
        before: existing.status,
        after: newStatus,
      });
    }
  }

  if (hasParticipantIds) {
    const newParticipants = await validateParticipantUserIdsInOrg(
      membership,
      input.participantIds,
    );
    updates.participantIds = newParticipants;
  }

  let notesOrPointsChanged = false;
  if (hasNotes) {
    const newNotes = validateMeetingNotes(input.notes);
    if (newNotes !== (existing.notes ?? null)) {
      updates.notes = newNotes;
      notesOrPointsChanged = true;
      changes.push({
        field: "notes",
        before: existing.notes ? "Updated" : null,
        after: newNotes ? "Updated" : null,
      });
    }
  }

  if (hasDiscussionPoints) {
    updates.discussionPoints = parseDiscussionPointsInput(
      input.discussionPoints,
      membership.userId,
      now,
      existing.discussionPoints,
    );
    notesOrPointsChanged = true;
  }

  let decisionsChanged = false;
  if (hasDecisions) {
    updates.decisions = parseDecisionsInput(
      input.decisions,
      membership.userId,
      now,
      existing.decisions,
    );
    decisionsChanged = true;
  }

  const effectiveTitle = updates.title ?? existing.title;
  const effectiveProjectId =
    updates.projectId !== undefined ? updates.projectId : existing.projectId;

  let eventType: ActivityEventType = "meeting.updated";
  let summary = `Updated meeting "${effectiveTitle}"`;
  if (!hasManagerOnlyFields && decisionsChanged && !notesOrPointsChanged) {
    eventType = "meeting.decision_recorded";
    summary = `Updated decisions for meeting "${effectiveTitle}"`;
  } else if (!hasManagerOnlyFields && notesOrPointsChanged) {
    eventType = "meeting.notes_updated";
    summary = `Updated notes for meeting "${effectiveTitle}"`;
  }

  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: effectiveProjectId ?? null,
    taskId: null,
    actorId: membership.userId,
    eventType,
    targetType: "meeting",
    targetId: existing._id,
    summary,
    changes,
    metadata: {
      meetingTitle: effectiveTitle,
    },
    createdAt: now,
  });

  const updatedDoc = await runInTransactionOrFallback<MeetingDoc | null>(
    async (session) => {
      const updated = await meetings.findOneAndUpdate(
        {
          _id: existing._id,
          organizationId: membership.organizationId,
          archivedAt: null,
        },
        { $set: updates },
        { returnDocument: "after", session },
      );
      if (updated) {
        await activities.insertOne(activityDoc, { session });
      }
      return updated;
    },
    async () => {
      const updated = await meetings.findOneAndUpdate(
        {
          _id: existing._id,
          organizationId: membership.organizationId,
          archivedAt: null,
        },
        { $set: updates },
        { returnDocument: "after" },
      );
      if (updated) {
        await activities.insertOne(activityDoc);
      }
      return updated;
    },
  );

  if (!updatedDoc) {
    return null;
  }

  if (hasParticipantIds && Array.isArray(updates.participantIds)) {
    const existingParticipants = Array.isArray(existing.participantIds)
      ? existing.participantIds
      : [];
    const newlyAdded = (updates.participantIds as string[]).filter(
      (p) => !existingParticipants.includes(p) && p !== membership.userId,
    );
    if (newlyAdded.length > 0) {
      const organization = await organizations.findOne({
        _id: membership.organizationId,
      });
      if (organization) {
        const meetingDateStr = updatedDoc.meetingDate
          ? ` scheduled for ${updatedDoc.meetingDate.toISOString().slice(0, 10)}`
          : "";
        for (const participantId of newlyAdded) {
          await createNotificationSafe({
            organizationId: membership.organizationId,
            recipientId: participantId,
            type: "meeting.participant_added",
            title: `Added to meeting: ${effectiveTitle}`,
            message: `You were added as a participant to "${effectiveTitle}"${meetingDateStr}.`,
            url: `/dashboard/${organization.slug}/meetings/${existing._id}`,
            entityType: "meeting",
            entityId: existing._id,
            projectId: effectiveProjectId ?? null,
            actorId: membership.userId,
            dedupeKey: `meeting.participant_added:${existing._id.toHexString()}:${participantId}:${now.getTime()}`,
          });
        }
      }
    }
  }

  const [enriched] = await enrichMeetingDocs(membership.organizationId, [
    updatedDoc,
  ]);
  return enriched;
}

export async function archiveMeeting(
  organizationId: ObjectId,
  meetingId: ObjectId,
  options?: { archived?: boolean },
  requestHeaders?: Headers,
): Promise<MeetingEnriched | null> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  requireObjectId(meetingId, "meetingId");

  const targetArchived =
    options?.archived === undefined ? true : Boolean(options.archived);

  const { meetings, activities } = await getCollections();
  const existing = await meetings.findOne({
    _id: meetingId,
    organizationId: membership.organizationId,
  });
  if (!existing) {
    return null;
  }

  const isCurrentlyArchived = existing.archivedAt !== null;
  if (isCurrentlyArchived === targetArchived) {
    const [enriched] = await enrichMeetingDocs(membership.organizationId, [
      existing,
    ]);
    return enriched;
  }

  const now = new Date();
  const newArchivedAt = targetArchived ? now : null;
  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: existing.projectId ?? null,
    taskId: null,
    actorId: membership.userId,
    eventType: targetArchived ? "meeting.archived" : "meeting.unarchived",
    targetType: "meeting",
    targetId: existing._id,
    summary: targetArchived
      ? `Archived meeting "${existing.title}"`
      : `Unarchived meeting "${existing.title}"`,
    changes: [
      {
        field: "archived",
        before: isCurrentlyArchived,
        after: targetArchived,
      },
    ],
    metadata: {
      meetingTitle: existing.title,
    },
    createdAt: now,
  });

  const updatedDoc = await runInTransactionOrFallback<MeetingDoc | null>(
    async (session) => {
      const updated = await meetings.findOneAndUpdate(
        { _id: existing._id, organizationId: membership.organizationId },
        { $set: { archivedAt: newArchivedAt, updatedAt: now } },
        { returnDocument: "after", session },
      );
      if (updated) {
        await activities.insertOne(activityDoc, { session });
      }
      return updated;
    },
    async () => {
      const updated = await meetings.findOneAndUpdate(
        { _id: existing._id, organizationId: membership.organizationId },
        { $set: { archivedAt: newArchivedAt, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (updated) {
        await activities.insertOne(activityDoc);
      }
      return updated;
    },
  );

  if (!updatedDoc) {
    return null;
  }
  const [enriched] = await enrichMeetingDocs(membership.organizationId, [
    updatedDoc,
  ]);
  return enriched;
}

export async function addMeetingParticipant(
  organizationId: ObjectId,
  meetingId: ObjectId,
  rawUserId: unknown,
  requestHeaders?: Headers,
): Promise<MeetingEnriched | null> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  requireObjectId(meetingId, "meetingId");
  const participantUserId = validateMemberUserId(rawUserId);

  const { meetings, memberships, activities, organizations } =
    await getCollections();
  const existing = await meetings.findOne({
    _id: meetingId,
    organizationId: membership.organizationId,
  });
  if (!existing) {
    return null;
  }
  if (existing.archivedAt !== null) {
    throw new TenantValidationError(ARCHIVED_MEETING_MODIFICATION_MESSAGE);
  }

  const targetMember = await memberships.findOne({
    organizationId: membership.organizationId,
    userId: participantUserId,
  });
  if (!targetMember) {
    throw new TenantValidationError(
      "Participant is not a member of this organization.",
    );
  }

  const currentParticipants = Array.isArray(existing.participantIds)
    ? existing.participantIds
    : [];
  if (currentParticipants.includes(participantUserId)) {
    const [enriched] = await enrichMeetingDocs(membership.organizationId, [
      existing,
    ]);
    return enriched;
  }

  const now = new Date();
  const nextParticipants = [...currentParticipants, participantUserId];

  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: existing.projectId ?? null,
    taskId: null,
    actorId: membership.userId,
    eventType: "meeting.participant_added",
    targetType: "meeting",
    targetId: existing._id,
    summary: `Added participant to meeting "${existing.title}"`,
    changes: [
      {
        field: "participantId",
        before: null,
        after: participantUserId,
      },
    ],
    metadata: {
      meetingTitle: existing.title,
      participantUserId,
    },
    createdAt: now,
  });

  const updatedDoc = await runInTransactionOrFallback<MeetingDoc | null>(
    async (session) => {
      const updated = await meetings.findOneAndUpdate(
        {
          _id: existing._id,
          organizationId: membership.organizationId,
          archivedAt: null,
        },
        { $set: { participantIds: nextParticipants, updatedAt: now } },
        { returnDocument: "after", session },
      );
      if (updated) {
        await activities.insertOne(activityDoc, { session });
      }
      return updated;
    },
    async () => {
      const updated = await meetings.findOneAndUpdate(
        {
          _id: existing._id,
          organizationId: membership.organizationId,
          archivedAt: null,
        },
        { $set: { participantIds: nextParticipants, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (updated) {
        await activities.insertOne(activityDoc);
      }
      return updated;
    },
  );

  if (!updatedDoc) {
    return null;
  }

  const organization = await organizations.findOne({
    _id: membership.organizationId,
  });
  if (organization && participantUserId !== membership.userId) {
    const meetingDateStr = existing.meetingDate
      ? ` scheduled for ${existing.meetingDate.toISOString().slice(0, 10)}`
      : "";
    await createNotificationSafe({
      organizationId: membership.organizationId,
      recipientId: participantUserId,
      type: "meeting.participant_added",
      title: `Added to meeting: ${existing.title}`,
      message: `You were added as a participant to "${existing.title}"${meetingDateStr}.`,
      url: `/dashboard/${organization.slug}/meetings/${existing._id}`,
      entityType: "meeting",
      entityId: existing._id,
      projectId: existing.projectId ?? null,
      actorId: membership.userId,
      dedupeKey: `meeting.participant_added:${existing._id.toHexString()}:${participantUserId}`,
    });
  }

  const [enriched] = await enrichMeetingDocs(membership.organizationId, [
    updatedDoc,
  ]);
  return enriched;
}

export async function removeMeetingParticipant(
  organizationId: ObjectId,
  meetingId: ObjectId,
  rawUserId: unknown,
  requestHeaders?: Headers,
): Promise<MeetingEnriched | null> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  requireObjectId(meetingId, "meetingId");
  const participantUserId = validateMemberUserId(rawUserId);

  const { meetings, activities } = await getCollections();
  const existing = await meetings.findOne({
    _id: meetingId,
    organizationId: membership.organizationId,
  });
  if (!existing) {
    return null;
  }
  if (existing.archivedAt !== null) {
    throw new TenantValidationError(ARCHIVED_MEETING_MODIFICATION_MESSAGE);
  }

  const currentParticipants = Array.isArray(existing.participantIds)
    ? existing.participantIds
    : [];
  if (!currentParticipants.includes(participantUserId)) {
    throw new TenantValidationError(
      "Specified user is not a participant of this meeting.",
    );
  }

  const now = new Date();
  const nextParticipants = currentParticipants.filter(
    (uid) => uid !== participantUserId,
  );

  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: existing.projectId ?? null,
    taskId: null,
    actorId: membership.userId,
    eventType: "meeting.participant_removed",
    targetType: "meeting",
    targetId: existing._id,
    summary: `Removed participant from meeting "${existing.title}"`,
    changes: [
      {
        field: "participantId",
        before: participantUserId,
        after: null,
      },
    ],
    metadata: {
      meetingTitle: existing.title,
      participantUserId,
    },
    createdAt: now,
  });

  const updatedDoc = await runInTransactionOrFallback<MeetingDoc | null>(
    async (session) => {
      const updated = await meetings.findOneAndUpdate(
        {
          _id: existing._id,
          organizationId: membership.organizationId,
          archivedAt: null,
        },
        { $set: { participantIds: nextParticipants, updatedAt: now } },
        { returnDocument: "after", session },
      );
      if (updated) {
        await activities.insertOne(activityDoc, { session });
      }
      return updated;
    },
    async () => {
      const updated = await meetings.findOneAndUpdate(
        {
          _id: existing._id,
          organizationId: membership.organizationId,
          archivedAt: null,
        },
        { $set: { participantIds: nextParticipants, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (updated) {
        await activities.insertOne(activityDoc);
      }
      return updated;
    },
  );

  if (!updatedDoc) {
    return null;
  }
  const [enriched] = await enrichMeetingDocs(membership.organizationId, [
    updatedDoc,
  ]);
  return enriched;
}

export type MutateMeetingNotesAndDecisionsInput = {
  notes?: string | null;
  discussionPoints?: unknown[];
  decisions?: unknown[];
  addDiscussionPoint?: { content: string } | string;
  updateDiscussionPoint?: { id: string; content: string };
  removeDiscussionPointId?: string;
  addDecision?: { title: string; description?: string | null } | string;
  updateDecision?: { id: string; title?: string; description?: string | null };
  removeDecisionId?: string;
};

export async function mutateMeetingNotesAndDecisions(
  organizationId: ObjectId,
  meetingId: ObjectId,
  input: MutateMeetingNotesAndDecisionsInput,
  requestHeaders?: Headers,
): Promise<MeetingEnriched | null> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  requireObjectId(meetingId, "meetingId");
  if (!isPlainObject(input)) {
    throw new TenantValidationError("Input must be a plain object.");
  }

  const { meetings, activities } = await getCollections();
  const existing = await meetings.findOne({
    _id: meetingId,
    organizationId: membership.organizationId,
  });
  if (!existing) {
    return null;
  }

  const isManager = isManagerRole(membership.role);
  const isParticipantOrCreator =
    existing.createdBy === membership.userId ||
    (existing.participantIds ?? []).includes(membership.userId);
  if (!isManager && !isParticipantOrCreator) {
    throw new TenantAccessError(
      "Only admins, managers, and meeting participants can update meeting notes and decisions.",
    );
  }

  if (existing.archivedAt !== null) {
    throw new TenantValidationError(ARCHIVED_MEETING_MODIFICATION_MESSAGE);
  }

  const now = new Date();
  let nextNotes = existing.notes ?? null;
  let nextPoints = [...(existing.discussionPoints ?? [])];
  let nextDecisions = [...(existing.decisions ?? [])];

  let touchedNotesOrPoints = false;
  let touchedDecisions = false;
  const changes: ActivityFieldChange[] = [];

  if (input.notes !== undefined) {
    nextNotes = validateMeetingNotes(input.notes);
    touchedNotesOrPoints = true;
    changes.push({
      field: "notes",
      before: existing.notes ? "Updated" : null,
      after: nextNotes ? "Updated" : null,
    });
  }

  if (input.discussionPoints !== undefined) {
    nextPoints = parseDiscussionPointsInput(
      input.discussionPoints,
      membership.userId,
      now,
      existing.discussionPoints,
    );
    touchedNotesOrPoints = true;
  }

  if (input.addDiscussionPoint !== undefined) {
    const rawPt = input.addDiscussionPoint;
    const content =
      typeof rawPt === "string"
        ? validateDiscussionPointContent(rawPt)
        : isPlainObject(rawPt)
          ? validateDiscussionPointContent(rawPt.content)
          : (() => {
            throw new TenantValidationError(
              "addDiscussionPoint must be a string or an object with content.",
            );
          })();
    nextPoints.push({
      id: new ObjectId().toHexString(),
      content,
      authorId: membership.userId,
      createdAt: now,
      updatedAt: now,
    });
    touchedNotesOrPoints = true;
    changes.push({
      field: "discussionPoint",
      before: null,
      after: content,
    });
  }

  if (input.updateDiscussionPoint !== undefined) {
    if (!isPlainObject(input.updateDiscussionPoint)) {
      throw new TenantValidationError(
        "updateDiscussionPoint must be an object with id and content.",
      );
    }
    const targetId =
      typeof input.updateDiscussionPoint.id === "string"
        ? input.updateDiscussionPoint.id.trim()
        : "";
    const content = validateDiscussionPointContent(
      input.updateDiscussionPoint.content,
    );
    const idx = nextPoints.findIndex((p) => p.id === targetId);
    if (idx === -1) {
      throw new TenantValidationError("Discussion point not found.");
    }
    const prev = nextPoints[idx];
    nextPoints[idx] = {
      ...prev,
      content,
      updatedAt: now,
    };
    touchedNotesOrPoints = true;
    changes.push({
      field: "discussionPoint",
      before: prev.content,
      after: content,
    });
  }

  if (input.removeDiscussionPointId !== undefined) {
    if (typeof input.removeDiscussionPointId !== "string") {
      throw new TenantValidationError("removeDiscussionPointId must be a string.");
    }
    const targetId = input.removeDiscussionPointId.trim();
    const prev = nextPoints.find((p) => p.id === targetId);
    if (!prev) {
      throw new TenantValidationError("Discussion point not found.");
    }
    nextPoints = nextPoints.filter((p) => p.id !== targetId);
    touchedNotesOrPoints = true;
    changes.push({
      field: "discussionPoint",
      before: prev.content,
      after: null,
    });
  }

  if (input.decisions !== undefined) {
    nextDecisions = parseDecisionsInput(
      input.decisions,
      membership.userId,
      now,
      existing.decisions,
    );
    touchedDecisions = true;
  }

  if (input.addDecision !== undefined) {
    const rawDec = input.addDecision;
    let title: string;
    let description: string | null = null;
    if (typeof rawDec === "string") {
      title = validateDecisionTitle(rawDec);
    } else if (isPlainObject(rawDec)) {
      title = validateDecisionTitle(rawDec.title);
      description = validateDecisionDescription(rawDec.description);
    } else {
      throw new TenantValidationError(
        "addDecision must be a string or an object with title.",
      );
    }
    nextDecisions.push({
      id: new ObjectId().toHexString(),
      title,
      description,
      decidedBy: membership.userId,
      createdAt: now,
      updatedAt: now,
    });
    touchedDecisions = true;
    changes.push({
      field: "meetingDecision",
      before: null,
      after: title,
    });
  }

  if (input.updateDecision !== undefined) {
    if (!isPlainObject(input.updateDecision)) {
      throw new TenantValidationError(
        "updateDecision must be an object with id.",
      );
    }
    const targetId =
      typeof input.updateDecision.id === "string"
        ? input.updateDecision.id.trim()
        : "";
    const idx = nextDecisions.findIndex((d) => d.id === targetId);
    if (idx === -1) {
      throw new TenantValidationError("Decision not found.");
    }
    const prev = nextDecisions[idx];
    const nextTitle =
      input.updateDecision.title !== undefined
        ? validateDecisionTitle(input.updateDecision.title)
        : prev.title;
    const nextDesc =
      input.updateDecision.description !== undefined
        ? validateDecisionDescription(input.updateDecision.description)
        : (prev.description ?? null);
    nextDecisions[idx] = {
      ...prev,
      title: nextTitle,
      description: nextDesc,
      updatedAt: now,
    };
    touchedDecisions = true;
    changes.push({
      field: "meetingDecision",
      before: prev.title,
      after: nextTitle,
    });
  }

  if (input.removeDecisionId !== undefined) {
    if (typeof input.removeDecisionId !== "string") {
      throw new TenantValidationError("removeDecisionId must be a string.");
    }
    const targetId = input.removeDecisionId.trim();
    const prev = nextDecisions.find((d) => d.id === targetId);
    if (!prev) {
      throw new TenantValidationError("Decision not found.");
    }
    nextDecisions = nextDecisions.filter((d) => d.id !== targetId);
    touchedDecisions = true;
    changes.push({
      field: "meetingDecision",
      before: prev.title,
      after: null,
    });
  }

  if (!touchedNotesOrPoints && !touchedDecisions) {
    throw new TenantValidationError(
      "At least one notes, discussion point, or decision update must be supplied.",
    );
  }

  const eventType: ActivityEventType =
    touchedDecisions && !touchedNotesOrPoints
      ? "meeting.decision_recorded"
      : "meeting.notes_updated";
  const summary =
    eventType === "meeting.decision_recorded"
      ? `Updated decisions in meeting "${existing.title}"`
      : `Updated notes and discussion points in meeting "${existing.title}"`;

  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: existing.projectId ?? null,
    taskId: null,
    actorId: membership.userId,
    eventType,
    targetType: "meeting",
    targetId: existing._id,
    summary,
    changes,
    metadata: {
      meetingTitle: existing.title,
    },
    createdAt: now,
  });

  const updatedDoc = await runInTransactionOrFallback<MeetingDoc | null>(
    async (session) => {
      const updated = await meetings.findOneAndUpdate(
        {
          _id: existing._id,
          organizationId: membership.organizationId,
          archivedAt: null,
        },
        {
          $set: {
            notes: nextNotes,
            discussionPoints: nextPoints,
            decisions: nextDecisions,
            updatedAt: now,
          },
        },
        { returnDocument: "after", session },
      );
      if (updated) {
        await activities.insertOne(activityDoc, { session });
      }
      return updated;
    },
    async () => {
      const updated = await meetings.findOneAndUpdate(
        {
          _id: existing._id,
          organizationId: membership.organizationId,
          archivedAt: null,
        },
        {
          $set: {
            notes: nextNotes,
            discussionPoints: nextPoints,
            decisions: nextDecisions,
            updatedAt: now,
          },
        },
        { returnDocument: "after" },
      );
      if (updated) {
        await activities.insertOne(activityDoc);
      }
      return updated;
    },
  );

  if (!updatedDoc) {
    return null;
  }
  const [enriched] = await enrichMeetingDocs(membership.organizationId, [
    updatedDoc,
  ]);
  return enriched;
}

export type ListMeetingActionItemsFilter = {
  status?: unknown;
  ownerId?: unknown;
};

export async function listMeetingActionItems(
  organizationId: ObjectId,
  meetingId: ObjectId,
  filter?: ListMeetingActionItemsFilter,
  requestHeaders?: Headers,
): Promise<MeetingActionItemEnriched[]> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const meeting = await requireMeetingInOrg(membership, meetingId);

  const statusFilter = validateActionItemStatusFilter(filter?.status);
  const mongoQuery: Record<string, unknown> = {
    organizationId: membership.organizationId,
    meetingId: meeting._id,
  };

  if (statusFilter !== "all") {
    mongoQuery.status = statusFilter;
  }

  if (
    filter?.ownerId !== undefined &&
    filter.ownerId !== "" &&
    filter.ownerId !== "all"
  ) {
    if (filter.ownerId === null || filter.ownerId === "unassigned" || filter.ownerId === "none") {
      mongoQuery.ownerId = null;
    } else {
      mongoQuery.ownerId = validateMemberUserId(filter.ownerId);
    }
  }

  const { meetingActionItems } = await getCollections();
  const docs = await meetingActionItems
    .find(mongoQuery)
    .sort({ createdAt: 1, _id: 1 })
    .toArray();

  return enrichActionItemDocs(membership.organizationId, docs);
}

export type CreateMeetingActionItemInput = {
  title: string;
  description?: string | null;
  ownerId?: UserId | null;
  targetDate?: Date | string | null;
  status?: ActionItemStatus;
};

export async function createMeetingActionItem(
  organizationId: ObjectId,
  meetingId: ObjectId,
  input: CreateMeetingActionItemInput,
  requestHeaders?: Headers,
): Promise<MeetingActionItemEnriched> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  if (!isPlainObject(input)) {
    throw new TenantValidationError("Action item input must be a plain object.");
  }

  const meeting = await requireMeetingInOrg(membership, meetingId);
  if (meeting.archivedAt !== null) {
    throw new TenantValidationError(ARCHIVED_MEETING_ACTION_ITEM_MESSAGE);
  }

  const isManager = isManagerRole(membership.role);
  const title = validateActionItemTitle(input.title);
  const description = validateActionItemDescription(input.description);
  const targetDate = validateActionItemTargetDate(input.targetDate);
  const status =
    input.status !== undefined
      ? validateActionItemStatus(input.status)
      : "open";

  let ownerId: UserId | null = null;
  if (
    input.ownerId !== undefined &&
    input.ownerId !== null &&
    input.ownerId !== ""
  ) {
    ownerId = validateMemberUserId(input.ownerId);
    await requireAssigneeInOrg(membership, ownerId);
    if (!isManager && ownerId !== membership.userId) {
      throw new TenantAccessError(
        "Only admins and managers can assign action items to other members.",
      );
    }
  }

  const now = new Date();
  const completedAt = status === "completed" ? now : null;

  const doc: MeetingActionItemDoc = {
    _id: new ObjectId(),
    organizationId: membership.organizationId,
    meetingId: meeting._id,
    title,
    description,
    ownerId,
    targetDate,
    status,
    createdBy: membership.userId,
    completedAt,
    linkedTaskId: null,
    createdAt: now,
    updatedAt: now,
  };

  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: meeting.projectId ?? null,
    taskId: null,
    actorId: membership.userId,
    eventType: "action_item.created",
    targetType: "action_item",
    targetId: doc._id,
    summary: `Created action item "${doc.title}" in meeting "${meeting.title}"`,
    changes: [
      { field: "title", before: null, after: doc.title },
      { field: "status", before: null, after: doc.status },
      { field: "ownerId", before: null, after: doc.ownerId },
      ...(doc.targetDate !== null
        ? [
          {
            field: "targetDate",
            before: null,
            after: doc.targetDate.toISOString(),
          },
        ]
        : []),
    ],
    metadata: {
      meetingId: meeting._id.toHexString(),
      meetingTitle: meeting.title,
      actionItemTitle: doc.title,
    },
    createdAt: now,
  });

  const { meetingActionItems, activities, organizations } =
    await getCollections();
  await runInTransactionOrFallback(
    async (session) => {
      await meetingActionItems.insertOne(doc, { session });
      await activities.insertOne(activityDoc, { session });
    },
    async () => {
      await meetingActionItems.insertOne(doc);
      await activities.insertOne(activityDoc);
    },
  );

  const organization = await organizations.findOne({
    _id: membership.organizationId,
  });
  if (
    organization &&
    doc.ownerId !== null &&
    doc.ownerId !== membership.userId
  ) {
    const targetDateStr = doc.targetDate
      ? ` (due ${doc.targetDate.toISOString().slice(0, 10)})`
      : "";
    await createNotificationSafe({
      organizationId: membership.organizationId,
      recipientId: doc.ownerId,
      type: "action_item.assigned",
      title: `Action item assigned: ${doc.title}`,
      message: `You were assigned the action item "${doc.title}" from meeting "${meeting.title}"${targetDateStr}.`,
      url: `/dashboard/${organization.slug}/meetings/${meeting._id}`,
      entityType: "action_item",
      entityId: doc._id,
      projectId: meeting.projectId ?? null,
      actorId: membership.userId,
      dedupeKey: `action_item.assigned:${doc._id.toHexString()}:${doc.ownerId}`,
    });
  }

  const [enriched] = await enrichActionItemDocs(membership.organizationId, [
    doc,
  ]);
  return enriched;
}

export type UpdateMeetingActionItemInput = {
  title?: string;
  description?: string | null;
  ownerId?: UserId | null;
  targetDate?: Date | string | null;
  status?: ActionItemStatus;
};

export async function updateMeetingActionItem(
  organizationId: ObjectId,
  meetingId: ObjectId,
  actionItemId: ObjectId,
  input: UpdateMeetingActionItemInput,
  requestHeaders?: Headers,
): Promise<MeetingActionItemEnriched | null> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  requireObjectId(meetingId, "meetingId");
  requireObjectId(actionItemId, "actionItemId");
  if (!isPlainObject(input)) {
    throw new TenantValidationError(
      "Action item update input must be a plain object.",
    );
  }

  const hasTitle = input.title !== undefined;
  const hasDescription = input.description !== undefined;
  const hasOwnerId = input.ownerId !== undefined;
  const hasTargetDate = input.targetDate !== undefined;
  const hasStatus = input.status !== undefined;

  if (
    !hasTitle &&
    !hasDescription &&
    !hasOwnerId &&
    !hasTargetDate &&
    !hasStatus
  ) {
    throw new TenantValidationError(
      "At least one action item field must be provided for update.",
    );
  }

  const meeting = await requireMeetingInOrg(membership, meetingId);
  if (meeting.archivedAt !== null) {
    throw new TenantValidationError(ARCHIVED_MEETING_ACTION_ITEM_MESSAGE);
  }

  const { meetingActionItems, activities, organizations } =
    await getCollections();
  const existing = await meetingActionItems.findOne({
    _id: actionItemId,
    organizationId: membership.organizationId,
    meetingId: meeting._id,
  });
  if (!existing) {
    return null;
  }

  const isManager = isManagerRole(membership.role);
  if (!isManager) {
    const canMemberEdit =
      existing.ownerId === membership.userId ||
      existing.createdBy === membership.userId ||
      (meeting.participantIds ?? []).includes(membership.userId);
    if (!canMemberEdit) {
      throw new TenantAccessError(
        "Members can only update action items assigned to them, created by them, or in meetings they participate in.",
      );
    }
  }

  const now = new Date();
  const updates: Partial<MeetingActionItemDoc> & { updatedAt: Date } = {
    updatedAt: now,
  };
  const changes: ActivityFieldChange[] = [];

  if (hasTitle) {
    const nextTitle = validateActionItemTitle(input.title);
    if (nextTitle !== existing.title) {
      updates.title = nextTitle;
      changes.push({
        field: "title",
        before: existing.title,
        after: nextTitle,
      });
    }
  }

  if (hasDescription) {
    const nextDesc = validateActionItemDescription(input.description);
    if (nextDesc !== (existing.description ?? null)) {
      updates.description = nextDesc;
      changes.push({
        field: "description",
        before: existing.description ?? null,
        after: nextDesc,
      });
    }
  }

  if (hasOwnerId) {
    let nextOwnerId: UserId | null = null;
    if (input.ownerId !== null && input.ownerId !== "") {
      nextOwnerId = validateMemberUserId(input.ownerId);
      await requireAssigneeInOrg(membership, nextOwnerId);
    }
    if (nextOwnerId !== (existing.ownerId ?? null)) {
      if (
        !isManager &&
        nextOwnerId !== null &&
        nextOwnerId !== membership.userId
      ) {
        throw new TenantAccessError(
          "Only admins and managers can assign action items to other members.",
        );
      }
      updates.ownerId = nextOwnerId;
      changes.push({
        field: "ownerId",
        before: existing.ownerId ?? null,
        after: nextOwnerId,
      });
    }
  }

  if (hasTargetDate) {
    const nextTargetDate = validateActionItemTargetDate(input.targetDate);
    const prevTime = existing.targetDate ? existing.targetDate.getTime() : null;
    const nextTime = nextTargetDate ? nextTargetDate.getTime() : null;
    if (prevTime !== nextTime) {
      updates.targetDate = nextTargetDate;
      changes.push({
        field: "targetDate",
        before: existing.targetDate ? existing.targetDate.toISOString() : null,
        after: nextTargetDate ? nextTargetDate.toISOString() : null,
      });
    }
  }

  let statusChanged = false;
  if (hasStatus) {
    const nextStatus = validateActionItemStatus(input.status);
    if (nextStatus !== existing.status) {
      updates.status = nextStatus;
      updates.completedAt = nextStatus === "completed" ? now : null;
      statusChanged = true;
      changes.push({
        field: "status",
        before: existing.status,
        after: nextStatus,
      });
    }
  }

  const effectiveTitle = updates.title ?? existing.title;
  const eventType: ActivityEventType = statusChanged
    ? "action_item.status_changed"
    : "action_item.updated";
  const summary = statusChanged
    ? `Changed status of action item "${effectiveTitle}" to ${updates.status}`
    : `Updated action item "${effectiveTitle}"`;

  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: meeting.projectId ?? null,
    taskId: null,
    actorId: membership.userId,
    eventType,
    targetType: "action_item",
    targetId: existing._id,
    summary,
    changes,
    metadata: {
      meetingId: meeting._id.toHexString(),
      meetingTitle: meeting.title,
      actionItemTitle: effectiveTitle,
    },
    createdAt: now,
  });

  const updatedDoc = await runInTransactionOrFallback<MeetingActionItemDoc | null>(
    async (session) => {
      const updated = await meetingActionItems.findOneAndUpdate(
        {
          _id: existing._id,
          organizationId: membership.organizationId,
          meetingId: meeting._id,
        },
        { $set: updates },
        { returnDocument: "after", session },
      );
      if (updated) {
        await activities.insertOne(activityDoc, { session });
      }
      return updated;
    },
    async () => {
      const updated = await meetingActionItems.findOneAndUpdate(
        {
          _id: existing._id,
          organizationId: membership.organizationId,
          meetingId: meeting._id,
        },
        { $set: updates },
        { returnDocument: "after" },
      );
      if (updated) {
        await activities.insertOne(activityDoc);
      }
      return updated;
    },
  );

  if (!updatedDoc) {
    return null;
  }

  const organization = await organizations.findOne({
    _id: membership.organizationId,
  });
  if (
    organization &&
    updates.ownerId !== undefined &&
    updates.ownerId !== null &&
    updates.ownerId !== (existing.ownerId ?? null) &&
    updates.ownerId !== membership.userId
  ) {
    const effectiveItemTitle = updates.title ?? existing.title;
    const effectiveTargetDate =
      updates.targetDate !== undefined ? updates.targetDate : existing.targetDate;
    const targetDateStr = effectiveTargetDate
      ? ` (due ${effectiveTargetDate.toISOString().slice(0, 10)})`
      : "";
    await createNotificationSafe({
      organizationId: membership.organizationId,
      recipientId: updates.ownerId,
      type: "action_item.assigned",
      title: `Action item assigned: ${effectiveItemTitle}`,
      message: `You were assigned the action item "${effectiveItemTitle}" from meeting "${meeting.title}"${targetDateStr}.`,
      url: `/dashboard/${organization.slug}/meetings/${meeting._id}`,
      entityType: "action_item",
      entityId: existing._id,
      projectId: meeting.projectId ?? null,
      actorId: membership.userId,
      dedupeKey: `action_item.assigned:${existing._id.toHexString()}:${updates.ownerId}:${updates.updatedAt.getTime()}`,
    });
  }

  const [enriched] = await enrichActionItemDocs(membership.organizationId, [
    updatedDoc,
  ]);
  return enriched;
}

export async function getMeetingActionItemById(
  organizationId: ObjectId,
  meetingId: ObjectId,
  actionItemId: ObjectId,
  requestHeaders?: Headers,
): Promise<MeetingActionItemEnriched | null> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  requireObjectId(meetingId, "meetingId");
  requireObjectId(actionItemId, "actionItemId");

  const meeting = await requireMeetingInOrg(membership, meetingId);
  const { meetingActionItems } = await getCollections();
  const doc = await meetingActionItems.findOne({
    _id: actionItemId,
    organizationId: membership.organizationId,
    meetingId: meeting._id,
  });
  if (!doc) {
    return null;
  }
  const [enriched] = await enrichActionItemDocs(membership.organizationId, [
    doc,
  ]);
  return enriched;
}

export type ConvertMeetingActionItemInput = {
  projectId?: ObjectId | string | null;
  priority?: TaskPriority;
  status?: TaskStatus;
  approvalRequired?: boolean;
};

export type ConvertMeetingActionItemResult = {
  actionItem: MeetingActionItemEnriched;
  task: EnrichedTaskItem;
  created: boolean;
};

function parseConversionProjectId(raw: unknown): ObjectId | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (raw instanceof ObjectId) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") {
      return null;
    }
    const parsed = parseObjectId(trimmed);
    if (!parsed) {
      throw new TenantValidationError("Invalid projectId.");
    }
    return parsed;
  }
  throw new TenantValidationError("Invalid projectId.");
}

function buildActionItemTaskCreatedActivityDoc(params: {
  organizationId: ObjectId;
  projectId: ObjectId;
  actorId: UserId;
  meeting: MeetingDoc;
  actionItem: MeetingActionItemDoc;
  taskDoc: TaskDoc;
  createdAt: Date;
}): ActivityDoc {
  const { organizationId, projectId, actorId, meeting, actionItem, taskDoc, createdAt } =
    params;
  return buildActivityDoc({
    organizationId,
    projectId,
    taskId: taskDoc._id,
    actorId,
    eventType: "task.created",
    targetType: "task",
    targetId: taskDoc._id,
    summary: `Created task "${taskDoc.title}" from meeting action item`,
    changes: [
      { field: "title", before: null, after: taskDoc.title },
      ...(taskDoc.description !== null && taskDoc.description !== undefined
        ? [{ field: "description", before: null, after: taskDoc.description }]
        : []),
      { field: "status", before: null, after: taskDoc.status },
      { field: "priority", before: null, after: taskDoc.priority },
      { field: "assigneeId", before: null, after: taskDoc.assigneeId },
      ...(taskDoc.deadline !== null
        ? [
          {
            field: "deadline",
            before: null,
            after: taskDoc.deadline.toISOString(),
          },
        ]
        : []),
      {
        field: "approvalRequired",
        before: null,
        after: taskDoc.approvalRequired === true,
      },
      {
        field: "sourceMeetingId",
        before: null,
        after: meeting._id.toHexString(),
      },
      {
        field: "sourceActionItemId",
        before: null,
        after: actionItem._id.toHexString(),
      },
    ],
    metadata: {
      taskTitle: taskDoc.title,
      parentTaskId: null,
      isSubtask: false,
      sourceMeetingId: meeting._id.toHexString(),
      sourceMeetingTitle: meeting.title,
      sourceActionItemId: actionItem._id.toHexString(),
      sourceActionItemTitle: actionItem.title,
    },
    createdAt,
  });
}

function buildActionItemConvertedActivityDoc(params: {
  organizationId: ObjectId;
  project: ProjectDoc;
  actorId: UserId;
  meeting: MeetingDoc;
  actionItem: MeetingActionItemDoc;
  taskDoc: TaskDoc;
  createdAt: Date;
}): ActivityDoc {
  const { organizationId, project, actorId, meeting, actionItem, taskDoc, createdAt } =
    params;
  return buildActivityDoc({
    organizationId,
    projectId: project._id,
    taskId: taskDoc._id,
    actorId,
    eventType: "action_item.converted_to_task",
    targetType: "action_item",
    targetId: actionItem._id,
    summary: `Converted action item "${actionItem.title}" from meeting "${meeting.title}" to task "${taskDoc.title}"`,
    changes: [
      {
        field: "linkedTaskId",
        before: null,
        after: taskDoc._id.toHexString(),
      },
    ],
    metadata: {
      meetingId: meeting._id.toHexString(),
      meetingTitle: meeting.title,
      actionItemId: actionItem._id.toHexString(),
      actionItemTitle: actionItem.title,
      taskId: taskDoc._id.toHexString(),
      taskTitle: taskDoc.title,
      projectId: project._id.toHexString(),
      projectName: project.name,
    },
    createdAt,
  });
}

async function recoverExistingConvertedActionItem(params: {
  organizationId: ObjectId;
  actorId: UserId;
  meeting: MeetingDoc;
  actionItem: MeetingActionItemDoc;
}): Promise<ConvertMeetingActionItemResult | null> {
  const { organizationId, actorId, meeting, actionItem } = params;
  const { meetingActionItems, tasks, projects, activities } = await getCollections();

  const taskOrFilters: Record<string, unknown>[] = [
    { sourceActionItemId: actionItem._id },
  ];
  if (actionItem.linkedTaskId) {
    taskOrFilters.push({ _id: actionItem.linkedTaskId });
  }

  const foundTaskRaw = await tasks.findOne({
    organizationId,
    $or: taskOrFilters,
  });
  if (!foundTaskRaw) {
    return null;
  }

  let taskDoc = normalizeTaskDoc(foundTaskRaw);
  const now = new Date();

  // Repair task back-reference fields if missing from a partial standalone write.
  if (
    !taskDoc.sourceMeetingId ||
    !taskDoc.sourceMeetingId.equals(meeting._id) ||
    !taskDoc.sourceActionItemId ||
    !taskDoc.sourceActionItemId.equals(actionItem._id)
  ) {
    const repairedTask = await tasks.findOneAndUpdate(
      { _id: taskDoc._id, organizationId },
      {
        $set: {
          sourceMeetingId: meeting._id,
          sourceActionItemId: actionItem._id,
          updatedAt: now,
        },
      },
      { returnDocument: "after" },
    );
    if (repairedTask) {
      taskDoc = normalizeTaskDoc(repairedTask);
    }
  }

  // Repair action item forward-reference if missing from a partial standalone write.
  let currentActionItem = actionItem;
  if (
    !currentActionItem.linkedTaskId ||
    !currentActionItem.linkedTaskId.equals(taskDoc._id)
  ) {
    const repairedActionItem = await meetingActionItems.findOneAndUpdate(
      {
        _id: actionItem._id,
        organizationId,
        meetingId: meeting._id,
      },
      {
        $set: {
          linkedTaskId: taskDoc._id,
          updatedAt: now,
        },
      },
      { returnDocument: "after" },
    );
    if (repairedActionItem) {
      currentActionItem = repairedActionItem;
    } else {
      currentActionItem = {
        ...currentActionItem,
        linkedTaskId: taskDoc._id,
      };
    }
  }

  const project = await projects.findOne({
    _id: taskDoc.projectId,
    organizationId,
  });

  // Ensure both conversion activities exist without duplicating on retry.
  const [existingTaskCreatedActivity, existingConvertedActivity] =
    await Promise.all([
      activities.findOne({
        organizationId,
        targetType: "task",
        targetId: taskDoc._id,
        eventType: "task.created",
      }),
      activities.findOne({
        organizationId,
        targetType: "action_item",
        targetId: currentActionItem._id,
        eventType: "action_item.converted_to_task",
      }),
    ]);

  const missingActivities: ActivityDoc[] = [];
  if (!existingTaskCreatedActivity) {
    missingActivities.push(
      buildActionItemTaskCreatedActivityDoc({
        organizationId,
        projectId: taskDoc.projectId,
        actorId,
        meeting,
        actionItem: currentActionItem,
        taskDoc,
        createdAt: taskDoc.createdAt ?? now,
      }),
    );
  }
  if (!existingConvertedActivity && project) {
    missingActivities.push(
      buildActionItemConvertedActivityDoc({
        organizationId,
        project,
        actorId,
        meeting,
        actionItem: currentActionItem,
        taskDoc,
        createdAt: taskDoc.createdAt ?? now,
      }),
    );
  }
  if (missingActivities.length > 0) {
    await activities.insertMany(missingActivities);
  }

  const projectsByHex = new Map<string, ProjectDoc>();
  if (project) {
    projectsByHex.set(project._id.toHexString(), project);
  }

  const [[enrichedActionItem], [enrichedTask]] = await Promise.all([
    enrichActionItemDocs(organizationId, [currentActionItem]),
    hydrateEnrichedTasksInternal(organizationId, [taskDoc], projectsByHex),
  ]);

  return {
    actionItem: enrichedActionItem,
    task: enrichedTask,
    created: false,
  };
}

export async function convertMeetingActionItemToTask(
  organizationId: ObjectId,
  meetingId: ObjectId,
  actionItemId: ObjectId,
  input?: ConvertMeetingActionItemInput,
  requestHeaders?: Headers,
): Promise<ConvertMeetingActionItemResult | null> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  requireObjectId(meetingId, "meetingId");
  requireObjectId(actionItemId, "actionItemId");
  if (input !== undefined && !isPlainObject(input)) {
    throw new TenantValidationError(
      "Action item conversion input must be a plain object.",
    );
  }

  const meeting = await requireMeetingInOrg(membership, meetingId);
  const { meetingActionItems, tasks, activities, organizations } =
    await getCollections();
  const existingActionItem = await meetingActionItems.findOne({
    _id: actionItemId,
    organizationId: membership.organizationId,
    meetingId: meeting._id,
  });
  if (!existingActionItem) {
    return null;
  }

  const isManager = isManagerRole(membership.role);
  if (!isManager) {
    const canMemberConvert =
      existingActionItem.ownerId === membership.userId ||
      existingActionItem.createdBy === membership.userId ||
      meeting.createdBy === membership.userId ||
      (meeting.participantIds ?? []).includes(membership.userId);
    if (!canMemberConvert) {
      throw new TenantAccessError(
        "Members can only convert action items assigned to them, created by them, or in meetings they participate in.",
      );
    }
    if (input?.approvalRequired !== undefined) {
      throw new TenantAccessError(
        "Only admins and managers can set or change task approval requirements.",
      );
    }
    if (
      existingActionItem.ownerId !== null &&
      existingActionItem.ownerId !== undefined &&
      existingActionItem.ownerId !== membership.userId
    ) {
      throw new TenantAccessError(
        "Only admins and managers can assign tasks to other members.",
      );
    }
  }

  const requestedProjectId = parseConversionProjectId(input?.projectId);
  if (requestedProjectId !== null) {
    await requireProjectInOrg(membership, requestedProjectId);
  }
  if (
    meeting.projectId !== null &&
    requestedProjectId !== null &&
    !requestedProjectId.equals(meeting.projectId)
  ) {
    throw new TenantValidationError(
      "Cannot override the project of a meeting that is already associated with a project.",
    );
  }

  // Idempotent pre-check & recovery: if a linked task already exists for this
  // action item, repair any missing reference/activity and return it without
  // creating a duplicate task.
  const existingResult = await recoverExistingConvertedActionItem({
    organizationId: membership.organizationId,
    actorId: membership.userId,
    meeting,
    actionItem: existingActionItem,
  });
  if (existingResult) {
    return existingResult;
  }

  if (meeting.archivedAt !== null) {
    throw new TenantValidationError(ARCHIVED_MEETING_ACTION_ITEM_MESSAGE);
  }

  const targetProjectId = meeting.projectId ?? requestedProjectId;
  if (targetProjectId === null) {
    throw new TenantValidationError(
      "A projectId is required to convert an action item when the meeting is not associated with a project.",
    );
  }

  const project = await requireProjectInOrg(membership, targetProjectId);
  if (project.status === "archived") {
    throw new TenantValidationError(
      "Cannot create tasks in an archived project.",
    );
  }

  const title = validateTaskTitle(existingActionItem.title);
  const description = validateTaskDescription(
    existingActionItem.description ?? null,
  );
  const status =
    input?.status !== undefined ? validateTaskStatus(input.status) : "todo";
  const priority =
    input?.priority !== undefined
      ? validateTaskPriority(input.priority)
      : "medium";
  const approvalRequired =
    input?.approvalRequired !== undefined
      ? validateTaskApprovalRequired(input.approvalRequired)
      : true;

  if (status === "done" && approvalRequired) {
    throw new TenantValidationError(
      TASK_APPROVAL_REQUIRED_NO_DELIVERABLE_MESSAGE,
    );
  }

  const deadline = existingActionItem.targetDate
    ? validateTaskDeadline(existingActionItem.targetDate)
    : null;

  let assigneeId: UserId | null = null;
  if (
    existingActionItem.ownerId !== null &&
    existingActionItem.ownerId !== undefined
  ) {
    assigneeId = validateAssigneeId(existingActionItem.ownerId);
    if (assigneeId !== null) {
      await requireAssigneeInOrg(membership, assigneeId);
    }
  }

  const now = new Date();
  const taskDoc: TaskDoc = {
    _id: new ObjectId(),
    organizationId: membership.organizationId,
    projectId: project._id,
    parentTaskId: null,
    title,
    description,
    status,
    priority,
    assigneeId,
    createdBy: membership.userId,
    deadline,
    approvalRequired,
    sourceMeetingId: meeting._id,
    sourceActionItemId: existingActionItem._id,
    createdAt: now,
    updatedAt: now,
  };

  const taskCreatedActivityDoc = buildActionItemTaskCreatedActivityDoc({
    organizationId: membership.organizationId,
    projectId: project._id,
    actorId: membership.userId,
    meeting,
    actionItem: existingActionItem,
    taskDoc,
    createdAt: now,
  });

  const convertedActivityDoc = buildActionItemConvertedActivityDoc({
    organizationId: membership.organizationId,
    project,
    actorId: membership.userId,
    meeting,
    actionItem: existingActionItem,
    taskDoc,
    createdAt: now,
  });

  let updatedActionItem: MeetingActionItemDoc | null = null;
  try {
    updatedActionItem = await runInTransactionOrFallback<MeetingActionItemDoc | null>(
      async (session) => {
        const claimed = await meetingActionItems.findOneAndUpdate(
          {
            _id: existingActionItem._id,
            organizationId: membership.organizationId,
            meetingId: meeting._id,
            $or: [
              { linkedTaskId: null },
              { linkedTaskId: { $exists: false } },
            ],
          },
          {
            $set: {
              linkedTaskId: taskDoc._id,
              updatedAt: now,
            },
          },
          { returnDocument: "after", session },
        );
        if (!claimed) {
          return null;
        }
        await tasks.insertOne(taskDoc, { session });
        await activities.insertMany(
          [taskCreatedActivityDoc, convertedActivityDoc],
          { session },
        );
        return claimed;
      },
      async () => {
        await tasks.insertOne(taskDoc);
        const claimed = await meetingActionItems.findOneAndUpdate(
          {
            _id: existingActionItem._id,
            organizationId: membership.organizationId,
            meetingId: meeting._id,
          },
          {
            $set: {
              linkedTaskId: taskDoc._id,
              updatedAt: now,
            },
          },
          { returnDocument: "after" },
        );
        await activities.insertMany([
          taskCreatedActivityDoc,
          convertedActivityDoc,
        ]);
        return claimed;
      },
    );
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const recovered = await recoverExistingConvertedActionItem({
        organizationId: membership.organizationId,
        actorId: membership.userId,
        meeting,
        actionItem: existingActionItem,
      });

      if (recovered) {
        return recovered;
      }
    }
    throw err;
  }

  if (!updatedActionItem) {
    const recovered = await recoverExistingConvertedActionItem({
      organizationId: membership.organizationId,
      actorId: membership.userId,
      meeting,
      actionItem: existingActionItem,
    });
    if (recovered) {
      return recovered;
    }
    return null;
  }

  const projectsByHex = new Map<string, ProjectDoc>([
    [project._id.toHexString(), project],
  ]);

  if (taskDoc.assigneeId !== null && taskDoc.assigneeId !== membership.userId) {
    const organization = await organizations.findOne({
      _id: membership.organizationId,
    });
    if (organization) {
      await createNotificationSafe({
        organizationId: membership.organizationId,
        recipientId: taskDoc.assigneeId,
        type: "task.assigned",
        title: `Task assigned: ${taskDoc.title}`,
        message: `You were assigned to "${taskDoc.title}" in project "${project.name}" (converted from meeting action item).`,
        url: `/dashboard/${organization.slug}/projects/${project._id}#task-${taskDoc._id}`,
        entityType: "task",
        entityId: taskDoc._id,
        projectId: project._id,
        actorId: membership.userId,
        dedupeKey: `task.assigned:${taskDoc._id.toHexString()}:${taskDoc.assigneeId}`,
      });
    }
  }

  const [[enrichedActionItem], [enrichedTask]] = await Promise.all([
    enrichActionItemDocs(membership.organizationId, [updatedActionItem]),
    hydrateEnrichedTasksInternal(
      membership.organizationId,
      [taskDoc],
      projectsByHex,
    ),
  ]);

  return {
    actionItem: enrichedActionItem,
    task: enrichedTask,
    created: true,
  };
}

// ============================================================================
// Blocker Reporting & Lifecycle Foundation
// ============================================================================

/**
 * Computes a deterministic normalized fingerprint for general blocker descriptions.
 * Trims whitespace, collapses internal whitespace, converts to lowercase, and hashes
 * using SHA-256 to ensure fixed key length in unique indexes and avoid index limits.
 */
export function computeBlockerDescriptionFingerprint(description: string): string {
  const normalized = description.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

let blockerIndexesEnsured = false;
async function ensureBlockerIndexesSafe(
  blockersColl: import("mongodb").Collection<BlockerDoc>,
): Promise<void> {
  if (blockerIndexesEnsured) return;
  try {
    await blockersColl.createIndexes([
      {
        key: {
          organizationId: 1,
          projectId: 1,
          taskId: 1,
          dependencyTaskId: 1,
        },
        name: "uniq_open_task_dependency_blocker",
        unique: true,
        partialFilterExpression: {
          status: "open",
          type: "task_dependency",
          dependencyTaskId: { $type: "objectId" },
        },
      },
      {
        key: {
          organizationId: 1,
          projectId: 1,
          taskId: 1,
          descriptionFingerprint: 1,
        },
        name: "uniq_open_general_blocker_fingerprint",
        unique: true,
        partialFilterExpression: {
          status: "open",
          type: "general",
          descriptionFingerprint: { $type: "string" },
        },
      },
    ]);
    blockerIndexesEnsured = true;
  } catch {
    // Non-fatal if index creation fails due to permissions or race condition.
  }
}

export type BlockerItem = {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  taskTitle: string | null;
  reporterId: string;
  reporter: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
  type: BlockerType;
  dependencyTaskId: string | null;
  dependencyTaskTitle: string | null;
  description: string;
  impact: string;
  status: BlockerStatus;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateBlockerInput = {
  projectId: ObjectId | string;
  taskId: ObjectId | string;
  type: BlockerType;
  dependencyTaskId?: ObjectId | string | null;
  description: string;
  impact: string;
};

export type ListProjectBlockersOptions = {
  status?: BlockerStatus | "all";
  taskId?: ObjectId | string;
  type?: BlockerType;
  cursor?: string | null;
  limit?: number;
};

export type ListProjectBlockersResult = {
  blockers: BlockerItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

function toBlockerItem(
  doc: BlockerDoc,
  taskTitlesById?: Map<string, string>,
  reportersById?: Map<string, { name: string | null; email: string | null }>,
): BlockerItem {
  const taskHex = doc.taskId.toHexString();
  const depHex = doc.dependencyTaskId ? doc.dependencyTaskId.toHexString() : null;
  const reporterProfile = reportersById?.get(doc.reporterId);

  return {
    id: doc._id.toHexString(),
    organizationId: doc.organizationId.toHexString(),
    projectId: doc.projectId.toHexString(),
    taskId: taskHex,
    taskTitle: taskTitlesById?.get(taskHex) ?? null,
    reporterId: doc.reporterId,
    reporter: reporterProfile
      ? {
          id: doc.reporterId,
          name: reporterProfile.name ?? null,
          email: reporterProfile.email ?? null,
        }
      : null,
    type: doc.type,
    dependencyTaskId: depHex,
    dependencyTaskTitle: depHex ? (taskTitlesById?.get(depHex) ?? null) : null,
    description: doc.description,
    impact: doc.impact,
    status: doc.status,
    resolutionNote: doc.resolutionNote ?? null,
    resolvedBy: doc.resolvedBy ?? null,
    resolvedAt: doc.resolvedAt ? doc.resolvedAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

async function hydrateBlockerItems(
  organizationId: ObjectId,
  docs: BlockerDoc[],
): Promise<BlockerItem[]> {
  if (docs.length === 0) return [];
  const { tasks } = await getCollections();

  const taskIdsSet = new Set<string>();
  const reporterIdsSet = new Set<string>();

  for (const doc of docs) {
    taskIdsSet.add(doc.taskId.toHexString());
    if (doc.dependencyTaskId) {
      taskIdsSet.add(doc.dependencyTaskId.toHexString());
    }
    if (doc.reporterId) {
      reporterIdsSet.add(doc.reporterId);
    }
  }

  const taskObjectIds = Array.from(taskIdsSet).map((hex) => new ObjectId(hex));
  const reporterIds = Array.from(reporterIdsSet);

  const [taskDocs, reportersMap] = await Promise.all([
    tasks
      .find(
        { organizationId, _id: { $in: taskObjectIds } },
        { projection: { _id: 1, title: 1 } },
      )
      .toArray(),
    lookupRegisteredUsersByIds(reporterIds),
  ]);

  const taskTitlesMap = new Map<string, string>();
  for (const t of taskDocs) {
    taskTitlesMap.set(t._id.toHexString(), t.title);
  }

  return docs.map((doc) => toBlockerItem(doc, taskTitlesMap, reportersMap));
}

/**
 * Creates a blocker report against a task within an organization and project.
 * Ordinary Members can only report against tasks assigned to them.
 * Managers and platform admins can report against any task in the project.
 */
export async function createBlockerReport(
  organizationId: ObjectId,
  input: CreateBlockerInput,
  requestHeaders?: Headers,
): Promise<BlockerItem> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );

  const parsedProjectId =
    typeof input.projectId === "string"
      ? parseObjectId(input.projectId)
      : input.projectId;
  if (!parsedProjectId) {
    throw new TenantValidationError("Invalid project ID.");
  }

  const project = await requireProjectInOrg(membership, parsedProjectId);
  if (project.status === "archived") {
    throw new TenantValidationError(
      "Cannot report blockers in an archived project.",
    );
  }

  const parsedTaskId =
    typeof input.taskId === "string"
      ? parseObjectId(input.taskId)
      : input.taskId;
  if (!parsedTaskId) {
    throw new TenantValidationError("Invalid task ID.");
  }

  const task = await requireTaskInProjectAndOrg(
    membership,
    project._id,
    parsedTaskId,
  );
  if (task.status === "done") {
    throw new TenantValidationError("Cannot report blockers on a completed task.");
  }

  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only report blockers for tasks assigned to them.",
    );
  }

  if (input.type !== "task_dependency" && input.type !== "general") {
    throw new TenantValidationError(
      "Blocker type must be 'task_dependency' or 'general'.",
    );
  }

  let depTaskId: ObjectId | null = null;
  if (input.type === "task_dependency") {
    if (!input.dependencyTaskId) {
      throw new TenantValidationError(
        "A linked dependency task is required for task dependency blockers.",
      );
    }
    depTaskId =
      typeof input.dependencyTaskId === "string"
        ? parseObjectId(input.dependencyTaskId)
        : input.dependencyTaskId;
    if (!depTaskId) {
      throw new TenantValidationError("Invalid dependency task ID.");
    }
    if (depTaskId.equals(task._id)) {
      throw new TenantValidationError("A task cannot be blocked by itself.");
    }
    await requireTaskInProjectAndOrg(membership, project._id, depTaskId);
  } else {
    if (input.dependencyTaskId) {
      throw new TenantValidationError(
        "Linked dependency task cannot be set for general blockers.",
      );
    }
  }

  const description = input.description?.trim();
  if (!description || description.length < 3 || description.length > 5000) {
    throw new TenantValidationError(
      "Blocker description must be between 3 and 5000 characters.",
    );
  }

  const impact = input.impact?.trim();
  if (!impact || impact.length < 3 || impact.length > 5000) {
    throw new TenantValidationError(
      "Blocker impact must be between 3 and 5000 characters.",
    );
  }

  const { blockers, activities, memberships: membershipsColl, organizations } =
    await getCollections();

  await ensureBlockerIndexesSafe(blockers);

  const descriptionFingerprint =
    input.type === "general"
      ? computeBlockerDescriptionFingerprint(description)
      : null;

  // Prevent duplicate open blockers (fast-path application check + unique partial indexes)
  if (input.type === "task_dependency" && depTaskId) {
    const existing = await blockers.findOne({
      organizationId: membership.organizationId,
      projectId: project._id,
      taskId: task._id,
      dependencyTaskId: depTaskId,
      status: "open",
    });
    if (existing) {
      throw new TenantValidationError(
        "An open blocker is already reported for this dependency task.",
      );
    }
  } else {
    const existing = await blockers.findOne({
      organizationId: membership.organizationId,
      projectId: project._id,
      taskId: task._id,
      type: "general",
      $or: [
        { descriptionFingerprint },
        { description },
      ],
      status: "open",
    });
    if (existing) {
      throw new TenantValidationError(
        "An identical open blocker is already reported for this task.",
      );
    }
  }

  const now = new Date();
  const blockerDoc: BlockerDoc = {
    _id: new ObjectId(),
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
    reporterId: membership.userId,
    type: input.type,
    dependencyTaskId: depTaskId,
    description,
    impact,
    status: "open",
    descriptionFingerprint,
    resolutionNote: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  // Record activity history
  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
    actorId: membership.userId,
    eventType: "blocker.reported",
    targetType: "blocker",
    targetId: blockerDoc._id,
    summary: `Reported ${input.type === "task_dependency" ? "dependency" : "general"} blocker on "${task.title}": ${description.slice(0, 80)}`,
    changes: [
      { field: "status", before: null, after: "open" },
      { field: "type", before: null, after: input.type },
    ],
    metadata: {
      blockerType: input.type,
      taskTitle: task.title,
      dependencyTaskId: depTaskId ? depTaskId.toHexString() : null,
    },
    createdAt: now,
  });

  try {
    await runInTransactionOrFallback(
      async (session) => {
        await blockers.insertOne(blockerDoc, { session });
        await activities.insertOne(activityDoc, { session });
      },
      async () => {
        await blockers.insertOne(blockerDoc);
        await activities.insertOne(activityDoc);
      },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      if (input.type === "task_dependency") {
        throw new TenantValidationError(
          "An open blocker is already reported for this dependency task.",
        );
      }
      throw new TenantValidationError(
        "An identical open blocker is already reported for this task.",
      );
    }
    throw error;
  }

  // Notify organization managers (avoiding reporter)
  try {
    const organization = await organizations.findOne({
      _id: membership.organizationId,
    });
    if (organization) {
      const adminOrManagerMembers = await membershipsColl
        .find({
          organizationId: membership.organizationId,
          role: { $in: ["admin", "manager"] },
          userId: { $ne: membership.userId },
        })
        .toArray();

      const recipientUserIds = new Set<string>();
      for (const m of adminOrManagerMembers) {
        const normalized = normalizeUserIdValue(m.userId);
        if (normalized && normalized !== membership.userId) {
          recipientUserIds.add(normalized);
        }
      }

      if (recipientUserIds.size > 0) {
        const userProfiles = await lookupRegisteredUsersByIds([
          membership.userId,
        ]);
        const reporterUser = userProfiles.get(membership.userId);
        const reporterName =
          reporterUser?.name?.trim() ||
          reporterUser?.email?.trim() ||
          "A team member";

        const title = `New blocker reported: ${task.title}`;
        const message = `${reporterName} reported a ${input.type === "task_dependency" ? "task dependency" : "general"} blocker on task "${task.title}" in project "${project.name}". Impact: "${impact.slice(0, 150)}".`;
        const url = `/dashboard/${encodeURIComponent(organization.slug)}/projects/${project._id}#task-${task._id}`;

        for (const recipientId of recipientUserIds) {
          await createNotificationSafe({
            organizationId: membership.organizationId,
            recipientId,
            type: "blocker.reported",
            title,
            message,
            url,
            entityType: "blocker",
            entityId: blockerDoc._id,
            projectId: project._id,
            actorId: membership.userId,
            dedupeKey: `blocker.reported:${blockerDoc._id.toHexString()}:${recipientId}`,
          });
        }
      }
    }
  } catch {
    // Best-effort notification delivery
  }

  const [hydrated] = await hydrateBlockerItems(membership.organizationId, [
    blockerDoc,
  ]);
  return hydrated;
}

/**
 * Lists blockers for a project (managers and admins only).
 */
export async function listProjectBlockers(
  organizationId: ObjectId,
  projectId: ObjectId,
  options?: ListProjectBlockersOptions,
  requestHeaders?: Headers,
): Promise<ListProjectBlockersResult> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);

  const limit = Math.min(Math.max(Number(options?.limit) || 20, 1), 100);
  const cursor = parseActivityCursor(options?.cursor);

  const filter: Record<string, unknown> = {
    organizationId: membership.organizationId,
    projectId: project._id,
  };

  if (options?.status && options.status !== "all") {
    filter.status = options.status;
  }
  if (options?.taskId) {
    const parsedTaskId =
      typeof options.taskId === "string"
        ? parseObjectId(options.taskId)
        : options.taskId;
    if (parsedTaskId) {
      filter.taskId = parsedTaskId;
    }
  }
  if (options?.type) {
    filter.type = options.type;
  }

  if (cursor) {
    filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
    ];
  }

  const { blockers } = await getCollections();
  const docs = await blockers
    .find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();

  const hasMore = docs.length > limit;
  const pageDocs = hasMore ? docs.slice(0, limit) : docs;
  const nextCursor =
    hasMore && pageDocs.length > 0
      ? encodeActivityCursor(pageDocs[pageDocs.length - 1])
      : null;

  const items = await hydrateBlockerItems(membership.organizationId, pageDocs);
  return {
    blockers: items,
    nextCursor,
    hasMore,
  };
}

/**
 * Lists blockers for a specific task.
 * Ordinary members can only list blockers on tasks assigned to them.
 * Managers and platform admins can list blockers for any task.
 */
export async function listTaskBlockers(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  options?: {
    status?: BlockerStatus | "all";
    cursor?: string | null;
    limit?: number;
  },
  requestHeaders?: Headers,
): Promise<ListProjectBlockersResult> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);
  const task = await requireTaskInProjectAndOrg(
    membership,
    project._id,
    taskId,
  );

  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only view blockers for tasks assigned to them.",
    );
  }

  const limit = Math.min(Math.max(Number(options?.limit) || 20, 1), 100);
  const cursor = parseActivityCursor(options?.cursor);

  const filter: Record<string, unknown> = {
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
  };

  if (options?.status && options.status !== "all") {
    filter.status = options.status;
  }

  if (cursor) {
    filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
    ];
  }

  const { blockers } = await getCollections();
  const docs = await blockers
    .find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();

  const hasMore = docs.length > limit;
  const pageDocs = hasMore ? docs.slice(0, limit) : docs;
  const nextCursor =
    hasMore && pageDocs.length > 0
      ? encodeActivityCursor(pageDocs[pageDocs.length - 1])
      : null;

  const items = await hydrateBlockerItems(membership.organizationId, pageDocs);
  return {
    blockers: items,
    nextCursor,
    hasMore,
  };
}

/**
 * Resolves an open blocker report (managers and admins only).
 */
export async function resolveBlocker(
  organizationId: ObjectId,
  projectId: ObjectId,
  blockerId: ObjectId,
  resolutionNote?: string | null,
  requestHeaders?: Headers,
): Promise<BlockerItem> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);

  const { blockers, activities, tasks } = await getCollections();
  const blocker = await blockers.findOne({
    _id: blockerId,
    organizationId: membership.organizationId,
    projectId: project._id,
  });

  if (!blocker) {
    throw new TenantValidationError(
      "Referenced blocker does not belong to this organization or project.",
    );
  }

  if (blocker.status === "resolved") {
    throw new TenantValidationError("Blocker is already resolved.");
  }

  if (blocker.status === "dismissed") {
    throw new TenantValidationError(
      "Cannot resolve a dismissed blocker. Reopen or create a new blocker.",
    );
  }

  const note =
    resolutionNote !== undefined && resolutionNote !== null
      ? resolutionNote.trim()
      : null;
  if (note && note.length > 5000) {
    throw new TenantValidationError(
      "Resolution note must not exceed 5000 characters.",
    );
  }

  const now = new Date();
  const task = await tasks.findOne({ _id: blocker.taskId });
  const taskTitle = task?.title ?? "task";

  const updatedDoc = await runInTransactionOrFallback<BlockerDoc | null>(
    async (session) => {
      const updated = await blockers.findOneAndUpdate(
        {
          _id: blocker._id,
          organizationId: membership.organizationId,
          projectId: project._id,
          status: "open",
        },
        {
          $set: {
            status: "resolved",
            resolutionNote: note,
            resolvedBy: membership.userId,
            resolvedAt: now,
            updatedAt: now,
          },
        },
        { returnDocument: "after", session },
      );
      if (!updated) {
        return null;
      }

      const activityDoc = buildActivityDoc({
        organizationId: membership.organizationId,
        projectId: project._id,
        taskId: blocker.taskId,
        actorId: membership.userId,
        eventType: "blocker.resolved",
        targetType: "blocker",
        targetId: blocker._id,
        summary: `Resolved blocker on "${taskTitle}"`,
        changes: [
          { field: "status", before: "open", after: "resolved" },
          ...(note ? [{ field: "resolutionNote", before: null, after: note }] : []),
        ],
        metadata: {
          resolutionNote: note,
          taskTitle,
        },
        createdAt: now,
      });
      await activities.insertOne(activityDoc, { session });
      return updated;
    },
    async () => {
      const updated = await blockers.findOneAndUpdate(
        {
          _id: blocker._id,
          organizationId: membership.organizationId,
          projectId: project._id,
          status: "open",
        },
        {
          $set: {
            status: "resolved",
            resolutionNote: note,
            resolvedBy: membership.userId,
            resolvedAt: now,
            updatedAt: now,
          },
        },
        { returnDocument: "after" },
      );
      if (!updated) {
        return null;
      }

      const activityDoc = buildActivityDoc({
        organizationId: membership.organizationId,
        projectId: project._id,
        taskId: blocker.taskId,
        actorId: membership.userId,
        eventType: "blocker.resolved",
        targetType: "blocker",
        targetId: blocker._id,
        summary: `Resolved blocker on "${taskTitle}"`,
        changes: [
          { field: "status", before: "open", after: "resolved" },
          ...(note ? [{ field: "resolutionNote", before: null, after: note }] : []),
        ],
        metadata: {
          resolutionNote: note,
          taskTitle,
        },
        createdAt: now,
      });
      await activities.insertOne(activityDoc);
      return updated;
    },
  );

  if (!updatedDoc) {
    const current = await blockers.findOne({
      _id: blocker._id,
      organizationId: membership.organizationId,
      projectId: project._id,
    });
    if (current?.status === "dismissed") {
      throw new TenantValidationError(
        "Cannot resolve a dismissed blocker. Reopen or create a new blocker.",
      );
    }
    throw new TenantValidationError("Blocker is already resolved.");
  }

  const [hydrated] = await hydrateBlockerItems(membership.organizationId, [
    updatedDoc,
  ]);
  return hydrated;
}

/**
 * Dismisses an open blocker report (managers and admins only).
 */
export async function dismissBlocker(
  organizationId: ObjectId,
  projectId: ObjectId,
  blockerId: ObjectId,
  resolutionNote?: string | null,
  requestHeaders?: Headers,
): Promise<BlockerItem> {
  const membership = await requireMembership(
    organizationId,
    MANAGER_ROLES,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);

  const { blockers, activities, tasks } = await getCollections();
  const blocker = await blockers.findOne({
    _id: blockerId,
    organizationId: membership.organizationId,
    projectId: project._id,
  });

  if (!blocker) {
    throw new TenantValidationError(
      "Referenced blocker does not belong to this organization or project.",
    );
  }

  if (blocker.status === "dismissed") {
    throw new TenantValidationError("Blocker is already dismissed.");
  }

  if (blocker.status === "resolved") {
    throw new TenantValidationError(
      "Cannot dismiss an already resolved blocker.",
    );
  }

  const note =
    resolutionNote !== undefined && resolutionNote !== null
      ? resolutionNote.trim()
      : null;
  if (note && note.length > 5000) {
    throw new TenantValidationError(
      "Resolution note must not exceed 5000 characters.",
    );
  }

  const now = new Date();
  const task = await tasks.findOne({ _id: blocker.taskId });
  const taskTitle = task?.title ?? "task";

  const updatedDoc = await runInTransactionOrFallback<BlockerDoc | null>(
    async (session) => {
      const updated = await blockers.findOneAndUpdate(
        {
          _id: blocker._id,
          organizationId: membership.organizationId,
          projectId: project._id,
          status: "open",
        },
        {
          $set: {
            status: "dismissed",
            resolutionNote: note,
            resolvedBy: membership.userId,
            resolvedAt: now,
            updatedAt: now,
          },
        },
        { returnDocument: "after", session },
      );
      if (!updated) {
        return null;
      }

      const activityDoc = buildActivityDoc({
        organizationId: membership.organizationId,
        projectId: project._id,
        taskId: blocker.taskId,
        actorId: membership.userId,
        eventType: "blocker.dismissed",
        targetType: "blocker",
        targetId: blocker._id,
        summary: `Dismissed blocker on "${taskTitle}"`,
        changes: [
          { field: "status", before: "open", after: "dismissed" },
          ...(note ? [{ field: "resolutionNote", before: null, after: note }] : []),
        ],
        metadata: {
          resolutionNote: note,
          taskTitle,
        },
        createdAt: now,
      });
      await activities.insertOne(activityDoc, { session });
      return updated;
    },
    async () => {
      const updated = await blockers.findOneAndUpdate(
        {
          _id: blocker._id,
          organizationId: membership.organizationId,
          projectId: project._id,
          status: "open",
        },
        {
          $set: {
            status: "dismissed",
            resolutionNote: note,
            resolvedBy: membership.userId,
            resolvedAt: now,
            updatedAt: now,
          },
        },
        { returnDocument: "after" },
      );
      if (!updated) {
        return null;
      }

      const activityDoc = buildActivityDoc({
        organizationId: membership.organizationId,
        projectId: project._id,
        taskId: blocker.taskId,
        actorId: membership.userId,
        eventType: "blocker.dismissed",
        targetType: "blocker",
        targetId: blocker._id,
        summary: `Dismissed blocker on "${taskTitle}"`,
        changes: [
          { field: "status", before: "open", after: "dismissed" },
          ...(note ? [{ field: "resolutionNote", before: null, after: note }] : []),
        ],
        metadata: {
          resolutionNote: note,
          taskTitle,
        },
        createdAt: now,
      });
      await activities.insertOne(activityDoc);
      return updated;
    },
  );

  if (!updatedDoc) {
    const current = await blockers.findOne({
      _id: blocker._id,
      organizationId: membership.organizationId,
      projectId: project._id,
    });
    if (current?.status === "resolved") {
      throw new TenantValidationError(
        "Cannot dismiss an already resolved blocker.",
      );
    }
    throw new TenantValidationError("Blocker is already dismissed.");
  }

  const [hydrated] = await hydrateBlockerItems(membership.organizationId, [
    updatedDoc,
  ]);
  return hydrated;
}

/**
 * Retrieves a single blocker report by ID.
 * Members can view only if they are the reporter or assigned to the task.
 * Managers and admins can view any blocker in the project.
 */
export async function getBlockerById(
  organizationId: ObjectId,
  projectId: ObjectId,
  blockerId: ObjectId,
  requestHeaders?: Headers,
): Promise<BlockerItem> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);

  const { blockers, tasks } = await getCollections();
  const blocker = await blockers.findOne({
    _id: blockerId,
    organizationId: membership.organizationId,
    projectId: project._id,
  });

  if (!blocker) {
    throw new TenantValidationError(
      "Referenced blocker does not belong to this organization or project.",
    );
  }

  if (!isManagerRole(membership.role)) {
    const task = await tasks.findOne({
      _id: blocker.taskId,
      organizationId: membership.organizationId,
    });
    const isReporter = blocker.reporterId === membership.userId;
    const isAssignee = task && task.assigneeId === membership.userId;
    if (!isReporter && !isAssignee) {
      throw new TenantAccessError(
        "Members can only view blockers for tasks assigned to them.",
      );
    }
  }

  const [hydrated] = await hydrateBlockerItems(membership.organizationId, [
    blocker,
  ]);
  return hydrated;
}




