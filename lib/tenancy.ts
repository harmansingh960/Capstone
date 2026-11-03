import "server-only";
import { headers } from "next/headers";
import { ObjectId, type ClientSession } from "mongodb";
import { getAuth } from "@/lib/auth";
import { getCollections } from "@/lib/collections";
import { getDb, getMongoClient } from "@/lib/db";
import {
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_TARGET_TYPES,
  MEMBERSHIP_ROLES,
  PROJECT_STATUSES,
  REVIEW_DECISIONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type ActivityDoc,
  type ActivityEventType,
  type ActivityFieldChange,
  type ActivityFieldValue,
  type ActivityTargetType,
  type DeliverableDoc,
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
  type UserId,
} from "@/lib/schema";

export {
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_TARGET_TYPES,
  TASK_DELIVERABLE_STATUSES,
  type ActivityDoc,
  type ActivityEventType,
  type ActivityFieldChange,
  type ActivityFieldValue,
  type ActivityTargetType,
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

function validateAssigneeId(assigneeId: unknown): UserId | null {
  if (assigneeId === null) {
    return null;
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
  const userId = session?.user?.id;
  if (!userId) {
    throw new TenantAccessError("Authentication required.");
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
  const membership = await memberships.findOne({ organizationId, userId });
  if (!membership || (allowedRoles && !allowedRoles.includes(membership.role))) {
    throw new TenantAccessError();
  }
  return membership;
}

const ADMIN_ROLES: readonly MembershipRole[] = ["admin"];
const MANAGER_ROLES: readonly MembershipRole[] = ["admin", "manager"];

function isManagerRole(role: MembershipRole): boolean {
  return MANAGER_ROLES.includes(role);
}

function sameNullableObjectId(a: ObjectId | null, b: ObjectId | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a instanceof ObjectId && b instanceof ObjectId && a.equals(b);
}

// ---------------------------------------------------------------------------
// Cross-document tenant validators (module-private; require verified membership)
// ---------------------------------------------------------------------------

/** Verifies that `projectId` exists and belongs to `membership.organizationId`. */
async function requireProjectInOrg(
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
    userId: validatedAssigneeId,
  });
  if (!assigneeMembership) {
    throw new TenantValidationError("Assignee is not a member of this organization.");
  }
  return assigneeMembership;
}

/**
 * Verifies that `taskId` exists in `membership.organizationId` and belongs
 * to `projectId`.
 */
async function requireTaskInProjectAndOrg(
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
 * Creates a new organization owned by the authenticated session user and
 * inserts their initial `"admin"` membership. Cleans up the organization
 * document if the membership insert fails.
 */
export async function createOrganization(
  input: CreateOrganizationInput,
  requestHeaders?: Headers,
): Promise<UserOrganization> {
  const userId = await requireSessionUserId(requestHeaders);

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

export const ADDABLE_MEMBERSHIP_ROLES = ["manager", "member"] as const;
export type AddableMembershipRole = (typeof ADDABLE_MEMBERSHIP_ROLES)[number];

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

const BETTER_AUTH_USER_COLLECTION = "user";
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
      { _id: { $in: idMatchers } },
      { projection: { _id: 1, id: 1, name: 1, email: 1 } },
    )
    .toArray();

  for (const doc of docs) {
    const profile = toSafeUserProfile(doc);
    if (profile) {
      result.set(profile.userId, { name: profile.name, email: profile.email });
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

type BuildActivityInput = {
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

function buildActivityDoc(input: BuildActivityInput): ActivityDoc {
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

  const profilesById = await lookupRegisteredUsersByIds(
    orgMemberships.map((doc) => doc.userId),
  );

  return orgMemberships.map((doc) => {
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
 * Adds an existing registered user to `organizationId` with role `manager` or
 * `member`. Restricted to organization `admin`s. Looks up the user by email in
 * Better Auth's `user` collection and derives `userId` strictly from the matched
 * database record (never trusting a caller-supplied user ID).
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

  const adminMembership = await requireMembership(
    organizationId,
    ADMIN_ROLES,
    resolvedHeaders,
  );

  const normalizedEmail = validateMemberEmail(rawEmail);
  const role = validateAddableMemberRole(rawRole);

  const registeredUser = await findRegisteredUserByEmail(normalizedEmail);
  if (!registeredUser) {
    throw new TenantValidationError(
      "No registered user found with that email address.",
    );
  }

  const { memberships } = await getCollections();
  const existingMembership = await memberships.findOne({
    organizationId: adminMembership.organizationId,
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
    organizationId: adminMembership.organizationId,
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

  return {
    ...membershipDoc,
    name: registeredUser.name,
    email: registeredUser.email,
  };
}

/**
 * Updates an organization member's role (`admin`, `manager`, or `member`).
 * Restricted to organization `admin`s (preventing managers or members from
 * granting themselves admin privileges). Serializes admin demotions per
 * organization so the last admin of an organization can never be demoted, even
 * under concurrent requests. Returns `null` if `userId` is not a member of the
 * organization.
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
  return {
    ...doc,
    approvalRequired: doc.approvalRequired === true,
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
  assigneeId?: UserId | null;
  deliverableStatus?: DeliverableStatusFilter;
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

  if (!isManager && parentTaskId === null) {
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
    const parentTask = await requireTopLevelParentTaskInProject(
      membership,
      project._id,
      parentTaskId,
    );
    if (!isManager && parentTask.assigneeId !== membership.userId) {
      throw new TenantAccessError(
        "Members can only create subtasks under tasks assigned to them.",
      );
    }
  }

  const requestedAssigneeId =
    input.assigneeId === undefined
      ? null
      : validateAssigneeId(input.assigneeId);

  let assigneeId: UserId | null;
  if (isManager) {
    assigneeId = requestedAssigneeId;
    if (assigneeId !== null) {
      await requireAssigneeInOrg(membership, assigneeId);
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

  const { tasks, activities } = await getCollections();
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
  return doc ? normalizeTaskDoc(doc) : null;
}

export async function listProjectTasks(
  organizationId: ObjectId,
  projectId: ObjectId,
  filter?: ListProjectTasksFilter,
  requestHeaders?: Headers,
): Promise<TaskDoc[]> {
  const membership = await requireMembership(organizationId, undefined, requestHeaders);
  const orgId = membership.organizationId;
  await requireProjectInOrg(membership, projectId);

  let parentTaskIdFilter: ObjectId | null = null;
  let statusFilter: TaskStatus | undefined;
  let hasAssigneeFilter = false;
  let assigneeIdFilter: UserId | null = null;
  let deliverableStatusFilter: DeliverableStatusFilter = "all";

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
    if (filter.status !== undefined) {
      statusFilter = validateTaskStatus(filter.status);
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
  }

  const { tasks } = await getCollections();
  const docs = await tasks
    .find({
      organizationId: orgId,
      projectId,
      parentTaskId: parentTaskIdFilter,
      ...(statusFilter !== undefined ? { status: statusFilter } : {}),
      ...(hasAssigneeFilter ? { assigneeId: assigneeIdFilter } : {}),
    })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();

  if (deliverableStatusFilter !== "all") {
    const statuses = await getTasksDeliverableStatuses(
      orgId,
      projectId,
      docs,
      requestHeaders,
    );
    const filteredDocs = filterTasksByDeliverableStatus(
      docs,
      statuses,
      deliverableStatusFilter,
    );
    return filteredDocs.map(normalizeTaskDoc);
  }

  return docs.map(normalizeTaskDoc);
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
  const docs = await tasks
    .find({
      organizationId: orgId,
      projectId: parentTask.projectId,
      parentTaskId: parentTask._id,
    })
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
  const { tasks, taskDependencies, activities } = await getCollections();

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

  const validatedAssigneeId = hasAssigneeId
    ? validateAssigneeId(input.assigneeId)
    : existing.assigneeId;
  const assigneeChanged =
    hasAssigneeId && validatedAssigneeId !== existing.assigneeId;

  const priorityOrDeadlineSupplied = hasPriority || hasDeadline;

  if (!isManager) {
    if (existing.assigneeId !== membership.userId) {
      throw new TenantAccessError("Members can only modify tasks assigned to them.");
    }
    if (projectChanged || parentChanged) {
      throw new TenantAccessError(
        "Only admins and managers can change a task's project or parent hierarchy.",
      );
    }
    if (assigneeChanged) {
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
    await requireAssigneeInOrg(membership, validatedAssigneeId);
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

function validateDeliverableUrl(url: unknown): string | null {
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
): Promise<DeliverableDoc> {
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

  const description = validateDeliverableDescription(input.description);
  const url = validateDeliverableUrl(input.url);

  if (description === null && url === null) {
    throw new TenantValidationError(
      "A deliverable must include a description or a URL.",
    );
  }

  const { deliverables, activities } = await getCollections();
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
    },
    createdAt: now,
  });

  await runInTransactionOrFallback(
    async (session) => {
      await deliverables.insertOne(doc, { session });
      await activities.insertOne(activityDoc, { session });
    },
    async () => {
      await deliverables.insertOne(doc);
      await activities.insertOne(activityDoc);
    },
  );
  return doc;
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
): Promise<DeliverableDoc[]> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  await requireProjectInOrg(membership, projectId);
  await requireTaskInProjectAndOrg(membership, projectId, taskId);

  const { deliverables } = await getCollections();
  return deliverables
    .find({
      organizationId: membership.organizationId,
      projectId,
      taskId,
    })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();
}

export type DeliverableWithReviewsDoc = DeliverableDoc & {
  reviews: ReviewDoc[];
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
  await requireTaskInProjectAndOrg(membership, projectId, taskId);

  const { deliverables, reviews } = await getCollections();
  const orgId = membership.organizationId;

  const [delivDocs, reviewDocs] = await Promise.all([
    deliverables
      .find({ organizationId: orgId, projectId, taskId })
      .sort({ createdAt: -1, _id: -1 })
      .toArray(),
    reviews
      .find({ organizationId: orgId, projectId, taskId })
      .sort({ createdAt: -1, _id: -1 })
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

  return delivDocs.map((d) => ({
    ...d,
    reviews: reviewsByDeliverableId.get(d._id.toHexString()) ?? [],
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

  const { reviews, activities } = await getCollections();
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
  await requireTaskInProjectAndOrg(membership, projectId, taskId);
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
  await requireTaskInProjectAndOrg(membership, projectId, taskId);

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
  await requireTaskInProjectAndOrg(membership, projectId, taskId);

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
  if (field === "assigneeId") {
    if (value === null || value === "") {
      return "Unassigned";
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

  if (field === "deadline") {
    if (value === null || value === "") {
      return "No deadline";
    }
    return String(value).slice(0, 10);
  }

  if (field === "approvalRequired") {
    if (value === null) return null;
    return value === true ? "Required" : "Not required";
  }

  if (field === "status") {
    if (value === null) return null;
    if (typeof value === "string" && value in ACTIVITY_STATUS_LABELS) {
      return ACTIVITY_STATUS_LABELS[value as TaskStatus];
    }
    if (value === "active") return "Active";
    if (value === "archived") return "Archived";
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
      if (change.field === "assigneeId") {
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
    filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
    ];
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
 * cursor pagination. Accessible to any authenticated member of `organizationId`.
 */
export async function listOrganizationActivity(
  organizationId: ObjectId,
  options?: ListActivityOptions,
  requestHeaders?: Headers,
): Promise<ActivityPage> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  return queryPaginatedActivities(membership.organizationId, {}, options);
}

/**
 * Lists project-scoped activity (including all task, subtask, dependency,
 * deliverable, and review events within the project) in deterministic
 * newest-first order with cursor pagination. Preserves read access on archived
 * projects.
 */
export async function listProjectActivity(
  organizationId: ObjectId,
  projectId: ObjectId,
  options?: ListActivityOptions,
  requestHeaders?: Headers,
): Promise<ActivityPage> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);
  return queryPaginatedActivities(
    membership.organizationId,
    { projectId: project._id },
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
  return queryPaginatedActivities(
    membership.organizationId,
    { projectId: project._id, taskId: task._id },
    options,
  );
}
