import "server-only";
import { headers } from "next/headers";
import { ObjectId, type ClientSession } from "mongodb";
import { getAuth } from "@/lib/auth";
import { getCollections } from "@/lib/collections";
import { getDb, getMongoClient } from "@/lib/db";
import {
  MEMBERSHIP_ROLES,
  PROJECT_STATUSES,
  REVIEW_DECISIONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type DeliverableDoc,
  type MembershipDoc,
  type MembershipRole,
  type OrganizationDoc,
  type ProjectDoc,
  type ProjectStatus,
  type ReviewDecision,
  type ReviewDoc,
  type TaskDoc,
  type TaskPriority,
  type TaskStatus,
  type UserId,
} from "@/lib/schema";

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
  return code === 20 || code === 303 || codeName === "IllegalOperation";
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

  const { projects } = await getCollections();
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
  await projects.insertOne(doc);
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

  const { projects } = await getCollections();
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

  return projects.findOneAndUpdate(
    { _id: projectId, organizationId: membership.organizationId },
    { $set: updates },
    { returnDocument: "after" },
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

  const { tasks } = await getCollections();
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
  await tasks.insertOne(doc);
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
  const { tasks } = await getCollections();

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

  const updated = await tasks.findOneAndUpdate(
    { _id: taskId, organizationId: orgId },
    { $set: updates },
    { returnDocument: "after" },
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

function validateReviewComment(comment: unknown): string | null {
  if (comment === undefined || comment === null) {
    return null;
  }
  if (typeof comment !== "string") {
    throw new TenantValidationError("Review comment must be a string or null.");
  }
  if (comment.length > REVIEW_COMMENT_MAX_LENGTH) {
    throw new TenantValidationError(
      `Review comment must be at most ${REVIEW_COMMENT_MAX_LENGTH} characters.`,
    );
  }
  return normalizeDescription(comment);
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

  const { deliverables } = await getCollections();
  const doc: DeliverableDoc = {
    _id: new ObjectId(),
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
    submittedBy: membership.userId,
    description,
    url,
    createdAt: new Date(),
  };
  await deliverables.insertOne(doc);
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
  const comment = validateReviewComment(input.comment);

  const { reviews } = await getCollections();
  const doc: ReviewDoc = {
    _id: new ObjectId(),
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: deliverable.taskId,
    deliverableId: deliverable._id,
    reviewerId: membership.userId,
    decision,
    comment,
    createdAt: new Date(),
  };
  await reviews.insertOne(doc);
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
