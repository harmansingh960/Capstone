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

// Plural names keep app-owned collections visually separate from Better Auth's
// singular ones, and avoid clashing with its organization plugin
// (`organization`, `member`, `invitation`) if that is ever enabled.
export const COLLECTIONS = {
  organizations: "organizations",
  memberships: "memberships",
  projects: "projects",
  tasks: "tasks",
  deliverables: "deliverables",
  reviews: "reviews",
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
