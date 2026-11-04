import "server-only";
import { ObjectId, type Filter } from "mongodb";
import { getCollections } from "@/lib/collections";
import {
  NOTIFICATION_ENTITY_TYPES,
  NOTIFICATION_TYPES,
  type NotificationDoc,
  type NotificationEntityType,
  type NotificationType,
  type ProjectDoc,
  type UserId,
} from "@/lib/schema";
import {
  computeTaskDeadlineHealth,
  encodeActivityCursor,
  parseActivityCursor,
  parseObjectId,
  requireMembership,
  TenantValidationError,
} from "@/lib/tenancy";
import { isSafeNotificationPath } from "@/lib/notification-dto";

// Phase 7 Batch 1: in-app notification storage and recipient-scoped access.
//
// Tenant/recipient boundary rules enforced by this module:
//   1. The recipient is always the authenticated session user, resolved via
//      `requireMembership()` (Better Auth session + organization membership).
//      No function here accepts a client-supplied recipient ID for reads or
//      mark-as-read mutations.
//   2. Every query and mutation is scoped by BOTH
//      `organizationId: membership.organizationId` and
//      `recipientId: membership.userId`, so a user can never read or modify
//      another user's notifications, nor notifications in another organization,
//      even when a valid notification ID is known.
//   3. A notification that exists but belongs to someone else is
//      indistinguishable from a missing one (`null` → 404 at the route layer).

export {
  NOTIFICATION_ENTITY_TYPES,
  NOTIFICATION_TYPES,
  type NotificationEntityType,
  type NotificationType,
};

export const DEFAULT_NOTIFICATION_PAGE_LIMIT = 20;
export const MAX_NOTIFICATION_PAGE_LIMIT = 50;

export const NOTIFICATION_READ_FILTERS = ["all", "unread", "read"] as const;
export type NotificationReadFilter = (typeof NOTIFICATION_READ_FILTERS)[number];

/** Server-side notification view. Never includes the recipient's ID. */
export type NotificationItem = {
  id: string;
  organizationId: string;
  type: NotificationType;
  title: string;
  message: string;
  url: string | null;
  entityType: NotificationEntityType | null;
  entityId: string | null;
  projectId: string | null;
  actorId: UserId | null;
  dedupeKey: string | null;
  createdAt: Date;
  readAt: Date | null;
};

export type NotificationPage = {
  notifications: NotificationItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type ListNotificationsOptions = {
  limit?: unknown;
  cursor?: unknown;
  status?: unknown;
};

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export function validateNotificationLimit(rawLimit: unknown): number {
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
    return DEFAULT_NOTIFICATION_PAGE_LIMIT;
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
    num > MAX_NOTIFICATION_PAGE_LIMIT
  ) {
    throw new TenantValidationError(
      `Invalid limit: must be an integer between 1 and ${MAX_NOTIFICATION_PAGE_LIMIT}.`,
    );
  }
  return num;
}

export function validateNotificationReadFilter(
  raw: unknown,
): NotificationReadFilter {
  if (raw === undefined || raw === null || raw === "") {
    return "all";
  }
  if (
    typeof raw !== "string" ||
    !(NOTIFICATION_READ_FILTERS as readonly string[]).includes(raw.trim())
  ) {
    throw new TenantValidationError(
      `Invalid status filter: must be one of ${NOTIFICATION_READ_FILTERS.join(", ")}.`,
    );
  }
  return raw.trim() as NotificationReadFilter;
}

/** Strictly parses a notification ID from an untrusted route parameter. */
export function parseNotificationId(raw: string): ObjectId | null {
  return parseObjectId(raw);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeNullableObjectId(value: unknown): string | null {
  if (value instanceof ObjectId) return value.toHexString();
  if (typeof value === "string" && /^[a-f0-9]{24}$/i.test(value)) return value;
  return null;
}

function toNotificationItem(doc: NotificationDoc): NotificationItem {
  return {
    id: doc._id instanceof ObjectId ? doc._id.toHexString() : String(doc._id),
    organizationId:
      doc.organizationId instanceof ObjectId
        ? doc.organizationId.toHexString()
        : String(doc.organizationId),
    type: doc.type,
    title: doc.title,
    message: doc.message,
    url: typeof doc.url === "string" && doc.url !== "" ? doc.url : null,
    entityType: doc.entityType ?? null,
    entityId: serializeNullableObjectId(doc.entityId),
    projectId: serializeNullableObjectId(doc.projectId),
    actorId: doc.actorId ?? null,
    dedupeKey: doc.dedupeKey ?? null,
    createdAt: doc.createdAt,
    readAt: doc.readAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Recipient-scoped reads
// ---------------------------------------------------------------------------

/**
 * Lists the signed-in user's notifications in `organizationId`, newest first,
 * with cursor pagination and an optional read-state filter.
 */
export async function listNotifications(
  organizationId: ObjectId,
  options?: ListNotificationsOptions,
  requestHeaders?: Headers,
): Promise<NotificationPage> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const limit = validateNotificationLimit(options?.limit);
  const cursor = parseActivityCursor(options?.cursor);
  const status = validateNotificationReadFilter(options?.status);

  const filter: Filter<NotificationDoc> = {
    organizationId: membership.organizationId,
    recipientId: membership.userId,
  };
  if (status === "unread") {
    filter.readAt = null;
  } else if (status === "read") {
    filter.readAt = { $type: "date" };
  }
  if (cursor) {
    filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
    ];
  }

  const { notifications } = await getCollections();
  const docs = await notifications
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

  return {
    notifications: pageDocs.map(toNotificationItem),
    nextCursor,
    hasMore,
  };
}

/** Returns the signed-in user's unread notification count in `organizationId`. */
export async function getUnreadNotificationCount(
  organizationId: ObjectId,
  requestHeaders?: Headers,
): Promise<number> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const { notifications } = await getCollections();
  return notifications.countDocuments({
    organizationId: membership.organizationId,
    recipientId: membership.userId,
    readAt: null,
  });
}

// ---------------------------------------------------------------------------
// Recipient-scoped mutations
// ---------------------------------------------------------------------------

/**
 * Marks one of the signed-in user's notifications as read. Idempotent: an
 * already-read notification keeps its original `readAt`. Returns `null` when
 * the notification does not exist in this organization for this recipient.
 */
export async function markNotificationRead(
  organizationId: ObjectId,
  notificationId: ObjectId,
  requestHeaders?: Headers,
): Promise<NotificationItem | null> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  if (!(notificationId instanceof ObjectId)) {
    throw new TenantValidationError("Invalid notification ID.");
  }

  const scope = {
    _id: notificationId,
    organizationId: membership.organizationId,
    recipientId: membership.userId,
  };

  const { notifications } = await getCollections();
  const updated = await notifications.findOneAndUpdate(
    { ...scope, readAt: null },
    { $set: { readAt: new Date() } },
    { returnDocument: "after" },
  );
  if (updated) {
    return toNotificationItem(updated);
  }

  const existing = await notifications.findOne(scope);
  return existing ? toNotificationItem(existing) : null;
}

/**
 * Marks all of the signed-in user's unread notifications in `organizationId`
 * as read. Returns the number of notifications that changed state.
 */
export async function markAllNotificationsRead(
  organizationId: ObjectId,
  requestHeaders?: Headers,
): Promise<{ updatedCount: number }> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const { notifications } = await getCollections();
  const result = await notifications.updateMany(
    {
      organizationId: membership.organizationId,
      recipientId: membership.userId,
      readAt: null,
    },
    { $set: { readAt: new Date() } },
  );
  return { updatedCount: result.modifiedCount };
}

// ---------------------------------------------------------------------------
// Internal creation primitive (server-only; NOT exposed through any API route)
// ---------------------------------------------------------------------------

export type CreateNotificationInput = {
  organizationId: ObjectId | string;
  recipientId: UserId;
  type: NotificationType;
  title: string;
  message: string;
  url?: string | null;
  entityType?: NotificationEntityType | null;
  entityId?: ObjectId | string | null;
  projectId?: ObjectId | string | null;
  actorId?: UserId | null;
  dedupeKey?: string | null;
  dryRun?: boolean;
};

export type NotificationCreationOutcome = "created" | "duplicate";

export type CreateNotificationResult = {
  notification: NotificationItem;
  outcome: NotificationCreationOutcome;
  created: boolean;
};

export type NotificationSafeOutcome = "created" | "duplicate" | "failed";

export type CreateNotificationSafeResult = {
  success: boolean;
  outcome: NotificationSafeOutcome;
  notification: NotificationItem | null;
  error?: unknown;
};

const NOTIFICATION_TITLE_MAX_LENGTH = 200;
const NOTIFICATION_MESSAGE_MAX_LENGTH = 2000;

function requireBoundedText(
  raw: unknown,
  fieldName: string,
  maxLength: number,
): string {
  if (typeof raw !== "string") {
    throw new TenantValidationError(`Notification ${fieldName} must be a string.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > maxLength) {
    throw new TenantValidationError(
      `Notification ${fieldName} must be between 1 and ${maxLength} characters.`,
    );
  }
  return trimmed;
}

/**
 * Persists a single notification for `recipientId` in `organizationId`.
 * Returns the notification item along with an outcome indicating whether the document
 * was newly inserted ("created") or already existed due to dedupeKey collision ("duplicate").
 */
export async function createNotificationWithOutcome(
  input: CreateNotificationInput,
): Promise<CreateNotificationResult> {
  const organizationId =
    input.organizationId instanceof ObjectId
      ? input.organizationId
      : typeof input.organizationId === "string"
        ? parseObjectId(input.organizationId)
        : null;
  if (!organizationId) {
    throw new TenantValidationError("Invalid organizationId.");
  }
  if (
    typeof input.recipientId !== "string" ||
    input.recipientId.trim() === "" ||
    input.recipientId.length > 128
  ) {
    throw new TenantValidationError("Invalid notification recipient.");
  }
  if (!(NOTIFICATION_TYPES as readonly string[]).includes(input.type)) {
    throw new TenantValidationError("Invalid notification type.");
  }
  const title = requireBoundedText(
    input.title,
    "title",
    NOTIFICATION_TITLE_MAX_LENGTH,
  );
  const message = requireBoundedText(
    input.message,
    "message",
    NOTIFICATION_MESSAGE_MAX_LENGTH,
  );

  const entityType = input.entityType ?? null;
  if (
    entityType !== null &&
    !(NOTIFICATION_ENTITY_TYPES as readonly string[]).includes(entityType)
  ) {
    throw new TenantValidationError("Invalid notification entity type.");
  }

  let entityId: ObjectId | null = null;
  if (input.entityId !== undefined && input.entityId !== null) {
    if (input.entityId instanceof ObjectId) {
      entityId = input.entityId;
    } else if (typeof input.entityId === "string") {
      entityId = parseObjectId(input.entityId);
      if (!entityId) {
        throw new TenantValidationError("Invalid notification entity ID.");
      }
    } else {
      throw new TenantValidationError("Invalid notification entity ID.");
    }
  }

  let projectId: ObjectId | null = null;
  if (input.projectId !== undefined && input.projectId !== null) {
    if (input.projectId instanceof ObjectId) {
      projectId = input.projectId;
    } else if (typeof input.projectId === "string") {
      projectId = parseObjectId(input.projectId);
      if (!projectId) {
        throw new TenantValidationError("Invalid notification project ID.");
      }
    } else {
      throw new TenantValidationError("Invalid notification project ID.");
    }
  }

  const actorId = input.actorId ?? null;
  if (
    actorId !== null &&
    (typeof actorId !== "string" || actorId.trim() === "" || actorId.length > 128)
  ) {
    throw new TenantValidationError("Invalid notification actor.");
  }

  let dedupeKey: string | null = null;
  if (input.dedupeKey !== undefined && input.dedupeKey !== null) {
    if (
      typeof input.dedupeKey !== "string" ||
      input.dedupeKey.trim() === "" ||
      input.dedupeKey.length > 256
    ) {
      throw new TenantValidationError("Invalid notification dedupeKey.");
    }
    dedupeKey = input.dedupeKey.trim();
  }

  const { organizations, memberships, notifications } = await getCollections();
  const organization = await organizations.findOne({ _id: organizationId });
  if (!organization) {
    throw new TenantValidationError("Organization not found.");
  }

  const url = input.url ?? null;
  if (url !== null && !isSafeNotificationPath(url, organization.slug)) {
    throw new TenantValidationError(
      "Notification URL must be an internal path within this organization's dashboard.",
    );
  }

  const memberIds = actorId !== null && actorId !== input.recipientId
    ? [input.recipientId, actorId]
    : [input.recipientId];
  const memberCount = await memberships.countDocuments({
    organizationId: organization._id,
    userId: { $in: memberIds },
  });
  if (memberCount !== memberIds.length) {
    throw new TenantValidationError(
      "Notification recipient and actor must be members of this organization.",
    );
  }

  const doc: NotificationDoc = {
    _id: new ObjectId(),
    organizationId: organization._id,
    recipientId: input.recipientId,
    type: input.type,
    title,
    message,
    url,
    entityType,
    entityId,
    projectId,
    actorId,
    dedupeKey,
    createdAt: new Date(),
    readAt: null,
  };

  if (input.dryRun) {
    if (dedupeKey !== null) {
      const existingDoc = await notifications.findOne({
        organizationId: organization._id,
        recipientId: input.recipientId,
        dedupeKey,
      });
      if (existingDoc) {
        return {
          notification: toNotificationItem(existingDoc),
          outcome: "duplicate",
          created: false,
        };
      }
    }
    return {
      notification: toNotificationItem(doc),
      outcome: "created",
      created: true,
    };
  }

  try {
    await notifications.insertOne(doc);
    return {
      notification: toNotificationItem(doc),
      outcome: "created",
      created: true,
    };
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 11000 &&
      dedupeKey !== null
    ) {
      const existingDoc = await notifications.findOne({
        organizationId: organization._id,
        recipientId: input.recipientId,
        dedupeKey,
      });
      if (existingDoc) {
        return {
          notification: toNotificationItem(existingDoc),
          outcome: "duplicate",
          created: false,
        };
      }
    }
    throw error;
  }
}

/**
 * Persists a single notification for `recipientId` in `organizationId`.
 *
 * Intended for server-side event handlers introduced in Phase 7 Batch 2; it is
 * deliberately not reachable from any route handler in Batch 1. It validates
 * the payload and verifies that the recipient (and actor, if given) are
 * members of the organization, and that `url` is an internal path inside this
 * organization's dashboard. Callers are responsible for having authorized the
 * originating action.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<NotificationItem> {
  const result = await createNotificationWithOutcome(input);
  return result.notification;
}

/**
 * Safely creates a notification with detailed outcome without throwing uncaught exceptions.
 * Returns `{ success: true, outcome: "created" | "duplicate", notification }` or
 * `{ success: false, outcome: "failed", notification: null, error }`.
 */
export async function createNotificationSafeWithOutcome(
  input: CreateNotificationInput,
): Promise<CreateNotificationSafeResult> {
  try {
    const result = await createNotificationWithOutcome(input);
    return {
      success: true,
      outcome: result.outcome,
      notification: result.notification,
    };
  } catch (error) {
    console.warn("[notifications] Failed to create notification safely:", error);
    return {
      success: false,
      outcome: "failed",
      notification: null,
      error,
    };
  }
}

/**
 * Safely creates a notification without throwing uncaught exceptions to the caller.
 * Intended for event-driven workflow hooks so that notification delivery
 * issues never abort or corrupt the primary business operation.
 */
export async function createNotificationSafe(
  input: CreateNotificationInput,
): Promise<NotificationItem | null> {
  const result = await createNotificationSafeWithOutcome(input);
  return result.notification;
}

export type GenerateDeadlineRemindersOptions = {
  now?: Date;
  actorId?: UserId | null;
  dryRun?: boolean;
};

export type GenerateDeadlineRemindersResult = {
  matchedTasks: number;
  generated: number;
  skipped: number;
  dryRun: boolean;
  referenceDate: string;
  organizationId: string;
  scannedTasksCount: number;
  remindersCreated: number;
  remindersSkipped: number;
};

/**
 * Evaluates all active incomplete tasks with deadlines in non-archived projects
 * within the given organization, generating idempotent deadline reminder notifications
 * for assigned users.
 *
 * Reminder Windows:
 * 1. "overdue": Task deadline has passed (evaluated per UTC calendar day).
 * 2. "due_today": Task is due on the current UTC calendar day.
 * 3. "due_soon": Task deadline is within the next 3 days (dueSoonDays = 3).
 *
 * Idempotency:
 * Each reminder notification uses a deterministic dedupeKey incorporating:
 * - taskId
 * - reminder window ('overdue' | 'due_today' | 'due_soon')
 * - UTC date bucket (YYYY-MM-DD) for overdue / due_today, or target deadline date for due_soon.
 *
 * The MongoDB partial unique index on (organizationId, recipientId, dedupeKey)
 * guarantees that repeated or concurrent runs never create duplicate reminders.
 */
export async function generateDeadlineRemindersForOrganization(
  organizationId: ObjectId,
  options?: GenerateDeadlineRemindersOptions,
): Promise<GenerateDeadlineRemindersResult> {
  const { organizations, projects, tasks } = await getCollections();
  const organization = await organizations.findOne({ _id: organizationId });
  if (!organization) {
    throw new TenantValidationError("Organization not found.");
  }

  const now = options?.now ?? new Date();
  const dryRun = Boolean(options?.dryRun);
  const referenceDate = now.toISOString();
  const utcDay = referenceDate.slice(0, 10);

  // 1. Find all active (non-archived) projects in this organization
  const activeProjects = await projects
    .find({
      organizationId: organization._id,
      status: { $ne: "archived" },
    })
    .toArray();

  if (activeProjects.length === 0) {
    return {
      matchedTasks: 0,
      generated: 0,
      skipped: 0,
      dryRun,
      referenceDate,
      organizationId: organization._id.toHexString(),
      scannedTasksCount: 0,
      remindersCreated: 0,
      remindersSkipped: 0,
    };
  }

  const projectMap = new Map<string, ProjectDoc>();
  for (const p of activeProjects) {
    projectMap.set(p._id.toHexString(), p);
  }

  const activeProjectIds = activeProjects.map((p) => p._id);

  // 2. Query incomplete tasks with an assignee and deadline in active projects
  const candidateTasks = await tasks
    .find({
      organizationId: organization._id,
      projectId: { $in: activeProjectIds },
      status: { $ne: "done" },
      assigneeId: { $ne: null },
      deadline: { $ne: null },
    })
    .toArray();

  let matchedTasks = 0;
  let generated = 0;
  let skipped = 0;

  for (const task of candidateTasks) {
    if (!task.assigneeId || !task.deadline) {
      continue;
    }

    const project = projectMap.get(task.projectId.toHexString());
    if (!project) {
      continue;
    }

    const health = computeTaskDeadlineHealth(task, project.status, now);

    let windowType: "overdue" | "due_today" | "due_soon" | null = null;
    let title = "";
    let message = "";
    let dedupeKey = "";

    const deadlineIsoDate = task.deadline.toISOString().slice(0, 10);

    if (health.isOverdue) {
      windowType = "overdue";
      title = `Task overdue: ${task.title}`;
      message = `Task "${task.title}" in project "${project.name}" is overdue (was due ${deadlineIsoDate}).`;
      dedupeKey = `deadline.reminder:${task._id.toHexString()}:overdue:${utcDay}`;
    } else if (health.isDueToday) {
      windowType = "due_today";
      title = `Deadline today: ${task.title}`;
      message = `Task "${task.title}" in project "${project.name}" is due today.`;
      dedupeKey = `deadline.reminder:${task._id.toHexString()}:due_today:${utcDay}`;
    } else if (health.isDueSoon) {
      windowType = "due_soon";
      title = `Upcoming deadline: ${task.title}`;
      message = `Task "${task.title}" in project "${project.name}" is due on ${deadlineIsoDate}.`;
      dedupeKey = `deadline.reminder:${task._id.toHexString()}:due_soon:${deadlineIsoDate}`;
    }

    if (!windowType) {
      continue;
    }

    matchedTasks++;
    const url = `/dashboard/${organization.slug}/projects/${project._id}#task-${task._id}`;

    const outcomeResult = await createNotificationSafeWithOutcome({
      organizationId: organization._id,
      recipientId: task.assigneeId,
      type: "deadline.reminder",
      title,
      message,
      url,
      entityType: "task",
      entityId: task._id,
      projectId: project._id,
      actorId: options?.actorId ?? null,
      dedupeKey,
      dryRun,
    });

    if (outcomeResult.outcome === "created") {
      generated++;
    } else if (outcomeResult.outcome === "duplicate") {
      skipped++;
    }
  }

  return {
    matchedTasks,
    generated,
    skipped,
    dryRun,
    referenceDate,
    organizationId: organization._id.toHexString(),
    scannedTasksCount: candidateTasks.length,
    remindersCreated: generated,
    remindersSkipped: skipped,
  };
}

