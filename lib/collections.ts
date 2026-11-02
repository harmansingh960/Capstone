import "server-only";
import { getDb } from "@/lib/db";
import {
  COLLECTIONS,
  type DeliverableDoc,
  type MembershipDoc,
  type OrganizationDoc,
  type ProjectDoc,
  type ReviewDoc,
  type TaskDoc,
} from "@/lib/schema";

/**
 * Low-level typed handles to the app-owned collections (never Better Auth's).
 * Prefer the tenant-scoped data-access functions in `@/lib/tenancy` for
 * project, task, deliverable, and review operations so session auth,
 * `organizationId` scoping, and cross-document invariants are always enforced.
 */
export async function getCollections() {
  const db = await getDb();
  return {
    organizations: db.collection<OrganizationDoc>(COLLECTIONS.organizations),
    memberships: db.collection<MembershipDoc>(COLLECTIONS.memberships),
    projects: db.collection<ProjectDoc>(COLLECTIONS.projects),
    tasks: db.collection<TaskDoc>(COLLECTIONS.tasks),
    deliverables: db.collection<DeliverableDoc>(COLLECTIONS.deliverables),
    reviews: db.collection<ReviewDoc>(COLLECTIONS.reviews),
  };
}
