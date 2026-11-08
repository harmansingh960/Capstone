import "server-only";
import { getDb } from "@/lib/db";
import {
  COLLECTIONS,
  type ActivityDoc,
  type BlockerDoc,
  type DeliverableDoc,
  type FileDoc,
  type MeetingActionItemDoc,
  type MeetingDoc,
  type MembershipDoc,
  type NotificationDoc,
  type OrganizationDoc,
  type ProjectDoc,
  type RateLimitDoc,
  type ReviewDoc,
  type TaskDependencyDoc,
  type TaskDoc,
} from "@/lib/schema";

/**
 * Low-level typed handles to the app-owned collections (never Better Auth's).
 * Prefer the tenant-scoped data-access functions in `@/lib/tenancy` for
 * project, task, dependency, deliverable, review, activity, and meeting operations so
 * session auth, `organizationId` scoping, and cross-document invariants are
 * always enforced.
 */
export async function getCollections() {
  const db = await getDb();
  return {
    organizations: db.collection<OrganizationDoc>(COLLECTIONS.organizations),
    memberships: db.collection<MembershipDoc>(COLLECTIONS.memberships),
    projects: db.collection<ProjectDoc>(COLLECTIONS.projects),
    tasks: db.collection<TaskDoc>(COLLECTIONS.tasks),
    taskDependencies: db.collection<TaskDependencyDoc>(
      COLLECTIONS.taskDependencies,
    ),
    deliverables: db.collection<DeliverableDoc>(COLLECTIONS.deliverables),
    reviews: db.collection<ReviewDoc>(COLLECTIONS.reviews),
    blockers: db.collection<BlockerDoc>(COLLECTIONS.blockers),
    activities: db.collection<ActivityDoc>(COLLECTIONS.activities),
    meetings: db.collection<MeetingDoc>(COLLECTIONS.meetings),
    meetingActionItems: db.collection<MeetingActionItemDoc>(
      COLLECTIONS.meetingActionItems,
    ),
    notifications: db.collection<NotificationDoc>(COLLECTIONS.notifications),
    rateLimits: db.collection<RateLimitDoc>(COLLECTIONS.rateLimits),
    files: db.collection<FileDoc>(COLLECTIONS.files),
  };
}
