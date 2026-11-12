# Orchestr — Version 8.6
## Post Phase 8.5 Improvements, Workflow Refinements & Activity Permissions

**Project:** Orchestr  
**Version:** 8.6  
**Previous Phase:** 8.5 — File Upload and Media Management  
**Focus:** Task usability, pagination, activity visibility, and authorization security  
**Status:** Implementations completed; verification status documented individually.

---

# 1. Overview

Version 8.6 contains improvements implemented after Phase 8.5.

The purpose of this version is to improve task management usability, reduce unnecessary screen clutter, and strengthen activity visibility permissions across Members, Managers, and Admins.

This version includes five major improvements:

1. Subtask creation interface repair.
2. Task-list pagination.
3. Role-based Task Activity visibility.
4. Role-based Project Activity visibility.
5. Organization Activity access restrictions and TypeScript repair.

These changes build on the existing Orchestr architecture without introducing a new database system or changing the underlying task and deliverable workflow.

---

# 2. Subtask Button and Form Visibility Repair

## Problem

Managers and Admins could click the `+ Subtask` button, but the interface appeared unresponsive.

The underlying React state was updating correctly. However, the subtask creation form was rendered below several large sections:

- Task Deliverables
- Task Dependencies
- Task Activity

This placed the form hundreds of pixels below the visible viewport.

As a result, users could click the button without seeing any visible response.

## Implemented solution

The subtask section and creation form were relocated directly beneath the parent task header.

Additional improvements:

- Added a form reference using `useRef`.
- Added automatic scrolling using `scrollIntoView`.
- Added automatic focus to the subtask title input.
- Preserved the existing form validation.
- Preserved entered data when creation fails.
- Preserved cancellation behavior.

## Role restrictions

| Role | Create subtask |
|---|---|
| Member | Not allowed |
| Manager | Allowed |
| Admin | Allowed |

Authorization is enforced at three levels:

- UI visibility.
- API authorization.
- Service-layer authorization.

Members cannot bypass the restriction by sending direct API requests.

## Verification

<badge color="success">Independently verified</badge>

Reported verification results:

- Manager and Admin form visibility: PASS.
- Automatic focus and scrolling: PASS.
- Subtask creation: PASS.
- Validation and error preservation: PASS.
- Member UI restriction: PASS.
- Member API restriction: HTTP 403.
- Existing task data preserved: PASS.
- TypeScript, lint, and build: PASS.

---

# 3. Task Pagination — 10 Tasks Per Page

## Objective

Reduce screen clutter by limiting the number of top-level tasks displayed simultaneously.

## Implemented behavior

The primary project task list now displays a maximum of 10 top-level tasks per page.

Pagination includes:

- Previous button.
- Next button.
- Current page indicator.
- Total page count.
- Visible task range.
- Correct final-page behavior.
- Empty-result handling.

Example:

```text
Showing 1–10 of 24 tasks

[Previous]  Page 1 of 3  [Next]
```

## Pagination logic

The implementation uses local React state:

- `TASKS_PER_PAGE = 10`
- `currentPage` tracks the selected page.
- `totalPages` calculates the number of pages.
- `paginatedTasks` contains the tasks displayed on the current page.

Only the rendering of the existing top-level task collection is paginated.

## Preserved functionality

Pagination does not independently paginate:

- Subtasks.
- Deliverables.
- Reviews.
- Dependencies.
- Blockers.
- Activity history.

Existing search, filtering, sorting, task counts, and task interactions are intended to remain unchanged.

## Scope

Only the primary project task-list component was modified.

**File:**

`app/dashboard/[slug]/projects/[projectId]/tasks-client.tsx`

No changes were reported to:

- Backend APIs.
- Database collections.
- Database schemas.
- Database indexes.
- Dashboard task lists.
- Supervision task lists.

## Verification status

<badge color="warning">Independent verification pending</badge>

Implementation was reported complete. The independent verification report for pagination has not yet been provided.

---

# 4. Role-Based Task Activity Visibility

## Objective

Restrict Task Activity visibility according to the user's organization role.

The purpose is to prevent Members and Managers from seeing activity entries that they are not authorized to access.

## 4.1 Member visibility

Members can:

- View Task Activity on tasks assigned to them.
- See activity entries created by themselves.

Members cannot see:

- Manager-created activity.
- Admin-created activity.
- Activity created by other Members.
- Task Activity belonging to another Member's assigned task.

## 4.2 Manager visibility

Managers can see:

- Their own activity on authorized tasks.
- Activity created by the Member assigned to the task, provided the Member belongs to the same organization.

Managers cannot see:

- Admin-created activity.
- Activity created by other Managers.

If a task is unassigned or assigned to another elevated role, the Manager sees only their own activity on that task.

## 4.3 Admin visibility

Organization Admins can see all Task Activity entries within their authorized organization.

This includes activity created by:

- Members.
- Managers.
- Admins.

## Implementation

The principal service function is:

`listTaskActivity`

Location:

`lib/tenancy.ts`

The task activity API uses authenticated session information and returns only authorized activity records.

The filtering is performed server-side at the database query level.

## Verification

The later independent activity-permissions report confirmed:

- Member sees only their own activity on their assigned task: PASS.
- Member cannot access another Member's task activity: PASS.
- Manager sees their own and assigned Member activity: PASS.
- Admin activity is excluded from Manager results: PASS.
- Admin sees all authorized task activity: PASS.
- Direct API authorization: PASS.

---

# 5. Organization Activity Restrictions

## Objective

Prevent Managers and Members from accessing the Organization Activity timeline.

Organization Activity is reserved for organization Admins.

## Implemented behavior

For Managers and Members:

- Organization Activity section is hidden.
- Initial activity requests are suppressed.
- Refresh controls are unavailable.
- Load More controls are unavailable.
- Direct API requests are rejected.
- Service-layer access is denied.

For organization Admins:

- Existing Organization Activity functionality is preserved.
- All activity within the authorized organization remains visible.

## Implementation

Files modified:

`app/dashboard/[slug]/projects-client.tsx`

`app/api/organizations/[slug]/activity/route.ts`

`lib/tenancy.ts`

The UI checks the organization role before rendering Organization Activity.

The API and service layers independently enforce Admin-only access.

Unauthorized requests return:

```http
403 Forbidden
```

---

# 6. Role-Based Project Activity Visibility

## Objective

Allow Managers to monitor their own work and the work performed by Members assigned to tasks within their projects, without exposing Admin or other Manager activity.

## 6.1 Manager visibility

Managers can see:

- Activity created by themselves.
- Activity created by Members assigned to tasks in the project.
- Activity created by Members assigned to subtasks in the project.

Managers cannot see:

- Admin-created activity.
- Activity created by other Managers.
- Activity from unassigned Members.
- Activity from Members assigned only to another project.
- Activity from another organization.
- Member activity without a verifiable task association.

### Project-level activities without task association

Examples include:

- Project creation.
- Project title changes.
- Project description changes.
- Project archiving.
- Project unarchiving.

Managers can see these activities only when they created them.

## 6.2 Admin visibility

Organization Admins retain complete Project Activity visibility within their authorized organization.

## 6.3 Member visibility

Member Project Activity access remains restricted under the existing authorization rules.

The implementation preserves the existing HTTP 403 behavior for Members.

## Implementation

Primary service function:

`listProjectActivity`

Location:

`lib/tenancy.ts`

The service:

1. Retrieves tasks and subtasks in the authorized project.
2. Identifies assigned user IDs.
3. Validates those users against organization memberships.
4. Includes only users with the `member` role.
5. Builds server-side MongoDB filters.
6. Returns activity only from authorized actors and tasks.

No new manager hierarchy or `managerId` field was introduced.

The existing organization membership and task assignment model determines Manager visibility.

---

# 7. Cursor Pagination Security Repair

During independent verification, an issue was identified in the existing activity cursor-pagination logic.

## Problem

A cursor condition could overwrite an existing top-level `$or` authorization filter.

This could compromise the intended role-based filtering on subsequent activity pages.

## Implemented solution

Authorization and cursor conditions are combined using MongoDB `$and`.

Conceptually:

```typescript
filter.$and = [
  { $or: authorizationConditions },
  { $or: cursorConditions }
];
```

This preserves both conditions during pagination.

## Expected behavior

- Authorization applies to the first page.
- Authorization applies to every subsequent page.
- `hasMore` reflects authorized records only.
- `nextCursor` is derived from authorized results.
- Unauthorized activity cannot appear on later pages.
- Authorized records are not duplicated or skipped during normal pagination.

## Independent verification

<badge color="success">PASS</badge>

A Manager Project Activity test with seven authorized records was executed using a page limit of three.

| Page | Records | hasMore |
|---|---:|---|
| Page 1 | 3 | true |
| Page 2 | 3 | true |
| Page 3 | 1 | false |

Results:

- Seven unique authorized records returned.
- No skipped records.
- No duplicate records.
- Zero Admin activity leaks across cursor boundaries.

---

# 8. TypeScript Membership Query Repair

The first independent verification identified a TypeScript compilation error in:

`lib/tenancy.ts`

Inside:

`listProjectActivity`

## Root cause

The membership lookup used an array typed as:

`Array<string | ObjectId>`

However, the existing `MembershipDoc.userId` field is declared as a string.

This caused MongoDB's TypeScript filter validation to fail with error TS2769.

## Implemented solution

The unnecessary `userIdMatchers` array and ObjectId conversion were removed.

The existing normalized `candidateAssigneeIds` array is already `string[]`.

The membership query now uses:

```typescript
userId: { $in: candidateAssigneeIds }
```

This matches the existing membership type.

## Scope

Only `lib/tenancy.ts` was changed for this repair.

No activity authorization rules or database structures were intentionally changed.

## Technical verification

The implementation report provided these results:

| Command | Result |
|---|---|
| `npx tsc --noEmit` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS |

Lint reported two pre-existing warnings in `tasks-client.tsx`.

---

# 9. Files Modified in Version 8.6

The reported changes span the following files:

| File | Purpose |
|---|---|
| `app/dashboard/[slug]/projects/[projectId]/tasks-client.tsx` | Subtask form relocation, subtask visibility, task pagination, Task Activity and Project Activity presentation |
| `app/dashboard/[slug]/projects-client.tsx` | Organization Activity visibility |
| `app/api/organizations/[slug]/activity/route.ts` | Organization Activity API authorization |
| `app/api/organizations/[slug]/projects/[projectId]/activity/route.ts` | Project Activity API authorization |
| `app/api/organizations/[slug]/projects/[projectId]/tasks/[taskId]/activity/route.ts` | Task Activity API authorization |
| `lib/tenancy.ts` | Server-side activity authorization, filtering, pagination security, and membership query repair |

The same file may have been modified in multiple implementation batches.

This list represents the reported cumulative scope, not an independently inspected Git diff.

---

# 10. Security and Data Integrity

The Version 8.6 changes prioritize server-side access control.

Security characteristics include:

- Session-derived user identity.
- Verified organization membership.
- Task assignment validation.
- Server-side activity filtering.
- Organization-scoped access.
- Direct API authorization.
- Protected cursor pagination.
- Unauthorized activity excluded from response payloads.

The implementation did not introduce a new activity database or delete existing activity records.

The independent verification report confirmed:

| Database item | Reported result |
|---|---|
| Tasks | 2, unchanged |
| Activities | 10, unchanged |
| Memberships | 4, unchanged |
| Temporary test sessions | Cleaned up |

No database schema or index changes were reported for these changes.

---

# 11. Regression Protection

The following existing Orchestr functionality was intentionally preserved:

- Task creation.
- Task editing.
- Task assignment.
- Task status updates.
- Subtask creation and display.
- Deliverable uploads.
- Deliverable submissions.
- Deliverable reviews and approvals.
- Task dependencies.
- Prerequisite display.
- Blocker functionality.
- Meetings and action items.
- Notifications.
- File management from Phase 8.5.
- Task Activity event generation.
- Existing activity descriptions and timestamps.

The changes are intended to affect task-list presentation and activity visibility, not the underlying business workflows.

---

# 12. Verification Status

| Feature | Reported status |
|---|---|
| Subtask button repair | Independently verified PASS |
| Member subtask restriction | Independently verified PASS |
| Task pagination implementation | Implementation reported complete; independent verification pending |
| Task Activity visibility | Independently verified in activity regression tests |
| Manager Organization Activity restriction | Independently verified PASS |
| Manager Project Activity filtering | Independently verified PASS |
| Admin activity visibility | Independently verified PASS |
| Member activity restrictions | Independently verified PASS |
| Cursor pagination authorization | Independently verified PASS |
| TypeScript repair | Reported PASS |
| Lint | Reported PASS |
| Production build | Reported PASS |

**Important:** The pagination feature's independent verification is still pending. The post-TypeScript-repair command results were reported by the implementation agent; a separate independent rerun of all tests after that repair should not be assumed.

---

# 13. Scope Limitations

Version 8.6 does not include:

- A new organization hierarchy.
- A dedicated Manager-to-Member relationship field.
- A new activity event system.
- Activity deletion or archival.
- Changes to the Phase 8.5 storage architecture.
- Google Drive OAuth or API integration.
- A new database system.
- A new notification framework.
- A complete visual redesign.

The existing membership and task assignment architecture continues to determine activity access.

---

# 14. Version 8.6 Completion Summary

Version 8.6 builds on Phase 8.5 by improving the usability and security of Orchestr's existing task and activity workflows.

The major improvements are:

1. Repaired the Manager/Admin subtask creation interface.
2. Restricted Member subtask creation.
3. Introduced 10-task pagination in the primary project task list.
4. Added role-based Task Activity visibility.
5. Restricted Organization Activity to organization Admins.
6. Introduced Manager-specific Project Activity filtering.
7. Preserved Admin activity visibility.
8. Secured cursor pagination against authorization filter overwrites.
9. Repaired a TypeScript membership-query incompatibility.

**Version:** 8.6  
**Previous milestone:** Phase 8.5 — File Upload and Media Management  
**Next planned phase:** Phase 8.6 — UI/UX Refinement

---

*Document: Version_8.6.md*  
*Project: Orchestr*  
*Purpose: Post-Phase 8.5 implementation documentation and technical handover*