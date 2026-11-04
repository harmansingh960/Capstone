// Orchestr core data model: document types, MongoDB validators and indexes.
//
// Self-contained on purpose (only depends on `mongodb` types) so it can be
// imported by app code and by `scripts/db-setup.mjs` without the Next.js
// bundler. Better Auth owns the `user`, `session`, `account` and `verification`
// collections; nothing here duplicates or modifies them.
import type { Db, IndexDescription, ObjectId } from "mongodb";

/**
 * A Better Auth user id, exactly as exposed by `session.user.id` (a string).
 * Stored as a string in app documents so they don't depend on how Better Auth
 * stores its own `_id` (currently ObjectId, but configurable, e.g. UUIDs).
 */
export type UserId = string;

export const MEMBERSHIP_ROLES = ["admin", "manager", "member"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const PROJECT_STATUSES = ["active", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

// Deliberately minimal. Extending is additive: add a value here and re-run
// `npm run db:setup` to update the validator.
export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const REVIEW_DECISIONS = ["approved", "changes_requested"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const TASK_DELIVERABLE_STATUSES = [
  "needs_submission",
  "in_review",
  "changes_requested",
  "approved",
] as const;
export type TaskDeliverableStatus = (typeof TASK_DELIVERABLE_STATUSES)[number];

export const MEETING_STATUSES = [
  "scheduled",
  "completed",
  "cancelled",
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const ACTION_ITEM_STATUSES = [
  "open",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];

export const ACTIVITY_TARGET_TYPES = [
  "project",
  "task",
  "subtask",
  "dependency",
  "deliverable",
  "review",
  "meeting",
  "action_item",
] as const;
export type ActivityTargetType = (typeof ACTIVITY_TARGET_TYPES)[number];

export const ACTIVITY_EVENT_TYPES = [
  "project.created",
  "project.updated",
  "project.archived",
  "project.unarchived",
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
  "meeting.created",
  "meeting.updated",
  "meeting.archived",
  "meeting.unarchived",
  "meeting.participant_added",
  "meeting.participant_removed",
  "meeting.notes_updated",
  "meeting.decision_recorded",
  "action_item.created",
  "action_item.updated",
  "action_item.status_changed",
  "action_item.converted_to_task",
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

// In-app notification categories (Phase 7). Notification *generation* is not
// part of Phase 7 Batch 1; these values define the storage contract only.
// Extending is additive: add a value here and re-run `npm run db:setup`.
export const NOTIFICATION_TYPES = [
  "task.assigned",
  "task.updated",
  "deliverable.submitted",
  "review.decided",
  "meeting.participant_added",
  "action_item.assigned",
  "deadline.reminder",
  "general",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Kinds of organization-owned records a notification may reference. */
export const NOTIFICATION_ENTITY_TYPES = [
  "project",
  "task",
  "deliverable",
  "review",
  "meeting",
  "action_item",
] as const;
export type NotificationEntityType = (typeof NOTIFICATION_ENTITY_TYPES)[number];

// Plural names keep app-owned collections visually separate from Better Auth's
// singular ones, and avoid clashing with its organization plugin
// (`organization`, `member`, `invitation`) if that is ever enabled.
export const COLLECTIONS = {
  organizations: "organizations",
  memberships: "memberships",
  projects: "projects",
  tasks: "tasks",
  taskDependencies: "task_dependencies",
  deliverables: "deliverables",
  reviews: "reviews",
  activities: "activities",
  meetings: "meetings",
  meetingActionItems: "meeting_action_items",
  notifications: "notifications",
} as const;

export const DEFAULT_MONGODB_DB = "orchestr";

/**
 * Resolves the target MongoDB database name consistently across the Next.js
 * runtime (`lib/db.ts`) and `scripts/db-setup.mjs`:
 *   1. Explicit `MONGODB_DB` environment variable (trimmed, non-empty).
 *   2. Database path segment in `MONGODB_URI`, when present.
 *   3. `DEFAULT_MONGODB_DB` ("orchestr").
 */
export function resolveMongoDbName(
  env: { readonly MONGODB_DB?: string; readonly MONGODB_URI?: string; readonly [key: string]: string | undefined } = process.env,
): string {
  const explicitDb = env.MONGODB_DB?.trim();
  if (explicitDb) {
    return explicitDb;
  }

  const uri = env.MONGODB_URI?.trim();
  if (uri) {
    const beforeQuery = uri.split(/[?#]/, 1)[0] ?? "";
    const match = /^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^/?#]+)$/i.exec(beforeQuery);
    const rawDbPath = match?.[1]?.trim();
    if (rawDbPath) {
      try {
        return decodeURIComponent(rawDbPath);
      } catch {
        return rawDbPath;
      }
    }
  }

  return DEFAULT_MONGODB_DB;
}

type Timestamps = { createdAt: Date; updatedAt: Date };

export type OrganizationDoc = Timestamps & {
  _id: ObjectId;
  name: string;
  /** URL-safe, globally unique identifier, e.g. `acme-design`. */
  slug: string;
  createdBy: UserId;
};

export type MembershipDoc = Timestamps & {
  _id: ObjectId;
  organizationId: ObjectId;
  userId: UserId;
  role: MembershipRole;
};

export type ProjectDoc = Timestamps & {
  _id: ObjectId;
  organizationId: ObjectId;
  name: string;
  description?: string | null;
  status: ProjectStatus;
  createdBy: UserId;
};

/**
 * Tasks and subtasks share one collection. A subtask is a task whose
 * `parentTaskId` is set; top-level tasks store `null` (always present, so
 * `{ parentTaskId: null }` queries use the index). `organizationId` is copied
 * from the project so every query can be tenant-scoped without a join.
 * Write helpers normalize optional `description` values to `string | null`,
 * while `description` and `approvalRequired` remain optional in the validator
 * so pre-existing documents lacking those fields can still be partially
 * updated safely (with missing `approvalRequired` treated as `false`).
 */
export type TaskDoc = Timestamps & {
  _id: ObjectId;
  organizationId: ObjectId;
  projectId: ObjectId;
  parentTaskId: ObjectId | null;
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: UserId | null;
  createdBy: UserId;
  deadline: Date | null;
  approvalRequired: boolean;
  sourceMeetingId?: ObjectId | null;
  sourceActionItemId?: ObjectId | null;
};

/**
 * A deliverable submission for a task or subtask within a project and
 * organization. `submittedBy` is always derived from the authenticated session
 * user. `description` and `url` are optional in the schema and normalized to
 * `string | null` on write.
 */
export type DeliverableDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  projectId: ObjectId;
  taskId: ObjectId;
  submittedBy: UserId;
  description?: string | null;
  url?: string | null;
  createdAt: Date;
};

/**
 * A review decision recorded against a specific deliverable within the same
 * organization, project, and task. `reviewerId` is always derived from the
 * authenticated session user.
 */
export type ReviewDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  projectId: ObjectId;
  taskId: ObjectId;
  deliverableId: ObjectId;
  reviewerId: UserId;
  decision: ReviewDecision;
  comment?: string | null;
  createdAt: Date;
};

/**
 * A directed dependency edge between two tasks within the same organization
 * and project: `taskId` depends on `prerequisiteTaskId` (i.e. `prerequisiteTaskId`
 * must reach `status === "done"` for `taskId` not to be blocked by it).
 * Stored in a dedicated collection (`task_dependencies`) so routine task field
 * updates never overwrite dependency edges and duplicate edges are prevented by
 * a compound unique index.
 */
export type TaskDependencyDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  projectId: ObjectId;
  taskId: ObjectId;
  prerequisiteTaskId: ObjectId;
  createdBy: UserId;
  createdAt: Date;
};

export type ActivityFieldValue = string | number | boolean | null;

export type ActivityFieldChange = {
  field: string;
  before: ActivityFieldValue;
  after: ActivityFieldValue;
};

/**
 * Append-only organization-scoped audit/activity record.
 * `actorId` is always derived from the authenticated Better Auth session.
 * Never edited or deleted through application APIs.
 */
export type ActivityDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  projectId: ObjectId | null;
  taskId: ObjectId | null;
  actorId: UserId;
  eventType: ActivityEventType;
  targetType: ActivityTargetType;
  targetId: ObjectId;
  summary: string;
  changes: ActivityFieldChange[];
  metadata?: Record<string, ActivityFieldValue> | null;
  createdAt: Date;
};

export type MeetingDiscussionPointDoc = {
  id: string;
  content: string;
  authorId: UserId;
  createdAt: Date;
  updatedAt: Date;
};

export type MeetingDecisionDoc = {
  id: string;
  title: string;
  description?: string | null;
  decidedBy: UserId;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Organization-scoped meeting record (Phase 6.1 & 6.2).
 * `participantIds` references organization member `userId` strings; Better Auth
 * user profiles are never duplicated here.
 */
export type MeetingDoc = Timestamps & {
  _id: ObjectId;
  organizationId: ObjectId;
  projectId: ObjectId | null;
  title: string;
  meetingDate: Date;
  description?: string | null;
  status: MeetingStatus;
  participantIds: UserId[];
  notes?: string | null;
  discussionPoints: MeetingDiscussionPointDoc[];
  decisions: MeetingDecisionDoc[];
  createdBy: UserId;
  archivedAt: Date | null;
};

/**
 * Organization-scoped meeting action item record (Phase 6.3).
 * Belongs to a specific `meetingId` within the same `organizationId`.
 */
export type MeetingActionItemDoc = Timestamps & {
  _id: ObjectId;
  organizationId: ObjectId;
  meetingId: ObjectId;
  title: string;
  description?: string | null;
  ownerId: UserId | null;
  targetDate: Date | null;
  status: ActionItemStatus;
  createdBy: UserId;
  completedAt: Date | null;
  linkedTaskId?: ObjectId | null;
};

/**
 * Organization-scoped in-app notification for exactly one recipient (Phase 7).
 * `recipientId` is a Better Auth user id; every read and write is scoped by
 * both `organizationId` and `recipientId`, with the recipient always derived
 * from the authenticated session on the read/mark-read paths.
 * `url`, when present, is an internal app path (e.g. `/dashboard/acme/...`).
 * `readAt` is `null` while unread and always present.
 */
export type NotificationDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  recipientId: UserId;
  type: NotificationType;
  title: string;
  message: string;
  url?: string | null;
  entityType?: NotificationEntityType | null;
  entityId?: ObjectId | null;
  projectId?: ObjectId | null;
  actorId?: UserId | null;
  dedupeKey?: string | null;
  createdAt: Date;
  readAt: Date | null;
};

// ---------------------------------------------------------------------------
// Validators ($jsonSchema). They enforce per-document shape only. Cross-document
// rules (see docs on each data-access function) must be enforced in app code:
//   - project/task organizationId matches its parent's organizationId
//   - a subtask's parent is a top-level task in the same project
//   - assigneeId belongs to a member of the same organization
//   - every organization keeps at least one admin
// Unknown fields are allowed so new fields can ship before the validator is
// updated; types and validators still constrain the known fields.
// ---------------------------------------------------------------------------

const userId = { bsonType: "string", minLength: 1, maxLength: 128 };
const objectId = { bsonType: "objectId" };
const date = { bsonType: "date" };
const timestamps = { createdAt: date, updatedAt: date };

type CollectionDefinition = {
  name: string;
  schema: Record<string, unknown>;
  indexes: IndexDescription[];
};

export const COLLECTION_DEFINITIONS: readonly CollectionDefinition[] = [
  {
    name: COLLECTIONS.organizations,
    schema: {
      bsonType: "object",
      required: ["name", "slug", "createdBy", "createdAt", "updatedAt"],
      properties: {
        name: { bsonType: "string", minLength: 1, maxLength: 120 },
        slug: {
          bsonType: "string",
          minLength: 2,
          maxLength: 50,
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        },
        createdBy: userId,
        ...timestamps,
      },
    },
    indexes: [{ key: { slug: 1 }, name: "slug_unique", unique: true }],
  },
  {
    name: COLLECTIONS.memberships,
    schema: {
      bsonType: "object",
      required: ["organizationId", "userId", "role", "createdAt", "updatedAt"],
      properties: {
        organizationId: objectId,
        userId,
        role: { enum: [...MEMBERSHIP_ROLES] },
        ...timestamps,
      },
    },
    indexes: [
      // One membership per user per org; also serves "members of org X".
      {
        key: { organizationId: 1, userId: 1 },
        name: "org_user_unique",
        unique: true,
      },
      // "Which organizations does this user belong to?"
      { key: { userId: 1 }, name: "user" },
    ],
  },
  {
    name: COLLECTIONS.projects,
    schema: {
      bsonType: "object",
      required: ["organizationId", "name", "status", "createdBy", "createdAt", "updatedAt"],
      properties: {
        organizationId: objectId,
        name: { bsonType: "string", minLength: 1, maxLength: 200 },
        description: { bsonType: ["string", "null"], maxLength: 5000 },
        status: { enum: [...PROJECT_STATUSES] },
        createdBy: userId,
        ...timestamps,
      },
    },
    indexes: [
      // List an org's active/archived projects, newest first.
      { key: { organizationId: 1, status: 1, createdAt: -1 }, name: "org_status_created" },
    ],
  },
  {
    name: COLLECTIONS.tasks,
    schema: {
      bsonType: "object",
      required: [
        "organizationId",
        "projectId",
        "parentTaskId",
        "title",
        "status",
        "priority",
        "assigneeId",
        "createdBy",
        "deadline",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        organizationId: objectId,
        projectId: objectId,
        parentTaskId: { bsonType: ["objectId", "null"] },
        title: { bsonType: "string", minLength: 1, maxLength: 300 },
        description: { bsonType: ["string", "null"], maxLength: 10000 },
        status: { enum: [...TASK_STATUSES] },
        priority: { enum: [...TASK_PRIORITIES] },
        assigneeId: { bsonType: ["string", "null"], minLength: 1, maxLength: 128 },
        createdBy: userId,
        deadline: { bsonType: ["date", "null"] },
        approvalRequired: { bsonType: "bool" },
        sourceMeetingId: { bsonType: ["objectId", "null"] },
        sourceActionItemId: { bsonType: ["objectId", "null"] },
        ...timestamps,
      },
    },
    indexes: [
      // A project's top-level tasks (parentTaskId: null), optionally by status.
      {
        key: { organizationId: 1, projectId: 1, parentTaskId: 1, status: 1 },
        name: "org_project_parent_status",
      },
      // Subtasks of a task. Partial: top-level tasks (null) aren't indexed.
      {
        key: { parentTaskId: 1 },
        name: "parent",
        partialFilterExpression: { parentTaskId: { $type: "objectId" } },
      },
      // "My tasks" in an org, by status, ordered by deadline.
      {
        key: { organizationId: 1, assigneeId: 1, status: 1, deadline: 1 },
        name: "org_assignee_status_deadline",
      },
      // At most one converted task per source meeting action item in an org.
      {
        key: { organizationId: 1, sourceActionItemId: 1 },
        name: "org_source_action_item_unique",
        unique: true,
        partialFilterExpression: { sourceActionItemId: { $type: "objectId" } },
      },
      // Tasks converted from a given meeting within an org.
      {
        key: { organizationId: 1, sourceMeetingId: 1 },
        name: "org_source_meeting",
        partialFilterExpression: { sourceMeetingId: { $type: "objectId" } },
      },
    ],
  },
  {
    name: COLLECTIONS.deliverables,
    schema: {
      bsonType: "object",
      required: [
        "organizationId",
        "projectId",
        "taskId",
        "submittedBy",
        "createdAt",
      ],
      properties: {
        organizationId: objectId,
        projectId: objectId,
        taskId: objectId,
        submittedBy: userId,
        description: { bsonType: ["string", "null"], maxLength: 10000 },
        url: { bsonType: ["string", "null"], maxLength: 2048 },
        createdAt: date,
      },
    },
    indexes: [
      // Deliverables for a task within an org and project, ordered by submission time.
      {
        key: { organizationId: 1, projectId: 1, taskId: 1, createdAt: -1 },
        name: "org_project_task_created",
      },
    ],
  },
  {
    name: COLLECTIONS.reviews,
    schema: {
      bsonType: "object",
      required: [
        "organizationId",
        "projectId",
        "taskId",
        "deliverableId",
        "reviewerId",
        "decision",
        "createdAt",
      ],
      properties: {
        organizationId: objectId,
        projectId: objectId,
        taskId: objectId,
        deliverableId: objectId,
        reviewerId: userId,
        decision: { enum: [...REVIEW_DECISIONS] },
        comment: { bsonType: ["string", "null"], maxLength: 10000 },
        createdAt: date,
      },
    },
    indexes: [
      // Reviews for a deliverable or task within an org, ordered by review time.
      {
        key: { organizationId: 1, taskId: 1, deliverableId: 1, createdAt: -1 },
        name: "org_task_deliverable_created",
      },
    ],
  },
  {
    name: COLLECTIONS.taskDependencies,
    schema: {
      bsonType: "object",
      required: [
        "organizationId",
        "projectId",
        "taskId",
        "prerequisiteTaskId",
        "createdBy",
        "createdAt",
      ],
      properties: {
        organizationId: objectId,
        projectId: objectId,
        taskId: objectId,
        prerequisiteTaskId: objectId,
        createdBy: userId,
        createdAt: date,
      },
    },
    indexes: [
      // One dependency edge per (organizationId, projectId, taskId, prerequisiteTaskId);
      // also serves "prerequisites of task X in project P".
      {
        key: {
          organizationId: 1,
          projectId: 1,
          taskId: 1,
          prerequisiteTaskId: 1,
        },
        name: "org_project_task_prereq_unique",
        unique: true,
      },
      // Reverse lookup: "which tasks in project P depend on prerequisite task Y?"
      {
        key: {
          organizationId: 1,
          projectId: 1,
          prerequisiteTaskId: 1,
          taskId: 1,
        },
        name: "org_project_prereq_task",
      },
    ],
  },
  {
    name: COLLECTIONS.activities,
    schema: {
      bsonType: "object",
      required: [
        "organizationId",
        "projectId",
        "taskId",
        "actorId",
        "eventType",
        "targetType",
        "targetId",
        "summary",
        "changes",
        "createdAt",
      ],
      properties: {
        organizationId: objectId,
        projectId: { bsonType: ["objectId", "null"] },
        taskId: { bsonType: ["objectId", "null"] },
        actorId: userId,
        eventType: { enum: [...ACTIVITY_EVENT_TYPES] },
        targetType: { enum: [...ACTIVITY_TARGET_TYPES] },
        targetId: objectId,
        summary: { bsonType: "string", minLength: 1, maxLength: 1000 },
        changes: {
          bsonType: "array",
          items: {
            bsonType: "object",
            required: ["field", "before", "after"],
            properties: {
              field: { bsonType: "string", minLength: 1, maxLength: 100 },
              before: { bsonType: ["string", "number", "bool", "null"] },
              after: { bsonType: ["string", "number", "bool", "null"] },
            },
          },
        },
        metadata: { bsonType: ["object", "null"] },
        createdAt: date,
      },
    },
    indexes: [
      // Organization activity timeline, newest first with deterministic tie-breaker.
      {
        key: { organizationId: 1, createdAt: -1, _id: -1 },
        name: "org_created_id",
      },
      // Project activity timeline within an organization, newest first.
      {
        key: { organizationId: 1, projectId: 1, createdAt: -1, _id: -1 },
        name: "org_project_created_id",
      },
      // Task activity timeline within an organization and project, newest first.
      {
        key: {
          organizationId: 1,
          projectId: 1,
          taskId: 1,
          createdAt: -1,
          _id: -1,
        },
        name: "org_project_task_created_id",
      },
    ],
  },
  {
    name: COLLECTIONS.meetings,
    schema: {
      bsonType: "object",
      required: [
        "organizationId",
        "projectId",
        "title",
        "meetingDate",
        "status",
        "participantIds",
        "discussionPoints",
        "decisions",
        "createdBy",
        "archivedAt",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        organizationId: objectId,
        projectId: { bsonType: ["objectId", "null"] },
        title: { bsonType: "string", minLength: 1, maxLength: 200 },
        meetingDate: date,
        description: { bsonType: ["string", "null"], maxLength: 5000 },
        status: { enum: [...MEETING_STATUSES] },
        participantIds: {
          bsonType: "array",
          items: userId,
        },
        notes: { bsonType: ["string", "null"], maxLength: 20000 },
        discussionPoints: {
          bsonType: "array",
          items: {
            bsonType: "object",
            required: ["id", "content", "authorId", "createdAt", "updatedAt"],
            properties: {
              id: { bsonType: "string", minLength: 1, maxLength: 64 },
              content: { bsonType: "string", minLength: 1, maxLength: 5000 },
              authorId: userId,
              createdAt: date,
              updatedAt: date,
            },
          },
        },
        decisions: {
          bsonType: "array",
          items: {
            bsonType: "object",
            required: ["id", "title", "decidedBy", "createdAt", "updatedAt"],
            properties: {
              id: { bsonType: "string", minLength: 1, maxLength: 64 },
              title: { bsonType: "string", minLength: 1, maxLength: 300 },
              description: { bsonType: ["string", "null"], maxLength: 5000 },
              decidedBy: userId,
              createdAt: date,
              updatedAt: date,
            },
          },
        },
        createdBy: userId,
        archivedAt: { bsonType: ["date", "null"] },
        ...timestamps,
      },
    },
    indexes: [
      // Organization and meeting date (newest first with deterministic tie-breaker).
      {
        key: { organizationId: 1, meetingDate: -1, _id: -1 },
        name: "org_meeting_date_id",
      },
      // Organization and meeting status.
      {
        key: { organizationId: 1, status: 1, meetingDate: -1 },
        name: "org_status_meeting_date",
      },
      // Organization and meeting title search/sort.
      {
        key: { organizationId: 1, title: 1 },
        name: "org_title",
      },
      // Meeting ID and participant ID lookup.
      {
        key: { _id: 1, participantIds: 1 },
        name: "meeting_participants",
      },
      // Project-scoped meetings within an organization.
      {
        key: { organizationId: 1, projectId: 1, meetingDate: -1 },
        name: "org_project_meeting_date",
      },
    ],
  },
  {
    name: COLLECTIONS.meetingActionItems,
    schema: {
      bsonType: "object",
      required: [
        "organizationId",
        "meetingId",
        "title",
        "ownerId",
        "targetDate",
        "status",
        "createdBy",
        "completedAt",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        organizationId: objectId,
        meetingId: objectId,
        title: { bsonType: "string", minLength: 1, maxLength: 300 },
        description: { bsonType: ["string", "null"], maxLength: 5000 },
        ownerId: {
          bsonType: ["string", "null"],
          minLength: 1,
          maxLength: 128,
        },
        targetDate: { bsonType: ["date", "null"] },
        status: { enum: [...ACTION_ITEM_STATUSES] },
        createdBy: userId,
        completedAt: { bsonType: ["date", "null"] },
        linkedTaskId: { bsonType: ["objectId", "null"] },
        ...timestamps,
      },
    },
    indexes: [
      // Meeting ID and action-item status.
      {
        key: { meetingId: 1, status: 1, createdAt: 1 },
        name: "meeting_status_created",
      },
      // Organization and action-item owner.
      {
        key: { organizationId: 1, ownerId: 1, status: 1 },
        name: "org_owner_status",
      },
      // Organization and meeting chronological listing.
      {
        key: { organizationId: 1, meetingId: 1, createdAt: 1, _id: 1 },
        name: "org_meeting_created_id",
      },
      // At most one action item linked to a given task within an org.
      {
        key: { organizationId: 1, linkedTaskId: 1 },
        name: "org_linked_task_unique",
        unique: true,
        partialFilterExpression: { linkedTaskId: { $type: "objectId" } },
      },
    ],
  },
  {
    name: COLLECTIONS.notifications,
    schema: {
      bsonType: "object",
      required: [
        "organizationId",
        "recipientId",
        "type",
        "title",
        "message",
        "createdAt",
        "readAt",
      ],
      properties: {
        organizationId: objectId,
        recipientId: userId,
        type: { enum: [...NOTIFICATION_TYPES] },
        title: { bsonType: "string", minLength: 1, maxLength: 200 },
        message: { bsonType: "string", minLength: 1, maxLength: 2000 },
        url: { bsonType: ["string", "null"], maxLength: 2048 },
        entityType: {
          bsonType: ["string", "null"],
          enum: [...NOTIFICATION_ENTITY_TYPES, null],
        },
        entityId: { bsonType: ["objectId", "null"] },
        projectId: { bsonType: ["objectId", "null"] },
        actorId: { bsonType: ["string", "null"], minLength: 1, maxLength: 128 },
        dedupeKey: { bsonType: ["string", "null"], minLength: 1, maxLength: 256 },
        createdAt: date,
        readAt: { bsonType: ["date", "null"] },
      },
    },
    indexes: [
      // A recipient's notifications in an org, newest first with deterministic
      // tie-breaker (unfiltered list + cursor pagination).
      {
        key: { organizationId: 1, recipientId: 1, createdAt: -1, _id: -1 },
        name: "org_recipient_created_id",
      },
      // Unread/read filtered lists, unread count (`readAt: null`) and
      // mark-all-as-read (`updateMany({ ..., readAt: null })`).
      {
        key: {
          organizationId: 1,
          recipientId: 1,
          readAt: 1,
          createdAt: -1,
          _id: -1,
        },
        name: "org_recipient_read_created_id",
      },
      // Unique deduplication index for idempotent event notifications.
      {
        key: {
          organizationId: 1,
          recipientId: 1,
          dedupeKey: 1,
        },
        name: "org_recipient_dedupe_unique",
        unique: true,
        partialFilterExpression: { dedupeKey: { $type: "string" } },
      },
    ],
  },
];

export type SchemaSetupResult = {
  collection: string;
  action: "created" | "validator-updated" | "unchanged";
  indexes: string[];
};

/**
 * Idempotently creates the app collections with validators and indexes.
 * Never drops collections or indexes, and never touches documents. An index
 * whose name already exists with a different definition fails loudly instead
 * of being replaced.
 */
export async function ensureSchema(db: Db): Promise<SchemaSetupResult[]> {
  const existing = new Map(
    (await db.listCollections({}, { nameOnly: false }).toArray()).map((info) => [
      info.name,
      "options" in info ? (info.options as { validator?: unknown }) : {},
    ]),
  );

  const results: SchemaSetupResult[] = [];
  for (const def of COLLECTION_DEFINITIONS) {
    const validator = { $jsonSchema: def.schema };
    let action: SchemaSetupResult["action"] = "unchanged";

    if (!existing.has(def.name)) {
      await db.createCollection(def.name, {
        validator,
        validationLevel: "strict",
        validationAction: "error",
      });
      action = "created";
    } else if (
      JSON.stringify(existing.get(def.name)?.validator) !== JSON.stringify(validator)
    ) {
      // Requires the collMod privilege (e.g. dbAdmin); only runs when the
      // validator actually changed, so routine re-runs don't need it.
      await db.command({
        collMod: def.name,
        validator,
        validationLevel: "strict",
        validationAction: "error",
      });
      action = "validator-updated";
    }

    const indexes = await db.collection(def.name).createIndexes(def.indexes);
    results.push({ collection: def.name, action, indexes });
  }
  return results;
}
