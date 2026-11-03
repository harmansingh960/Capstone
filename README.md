# Phase 5 — Supervision & Reports

**Status:** Completed and independently verified  
**Version:** Phase 5  
**Scope:** Phases 5.1–5.5

## 1. Overview

Phase 5 introduces organization-wide supervision and reporting capabilities to Orchestr.

It provides administrators and managers with a centralized view of organizational operations, project health, task progress, overdue work, inactive tasks, team workload, and time-based reports.

The objective is to help supervisors identify delays, monitor team performance, understand project progress, and make informed operational decisions without relying on fragmented manual updates.

## 2. Features Implemented

### 5.1 — Supervisor Dashboard

Added a dedicated **Supervision & Reports** dashboard for organization administrators and managers.

The dashboard provides:

- Active project count.
- Total task count.
- To Do, In Progress, and Completed task counts.
- Overdue task count.
- Stale task count.
- Blocked task count.
- Tasks awaiting submission.
- Tasks awaiting review.
- Tasks due today.
- Tasks due soon.
- Project-level operational health summaries.
- Overdue and stale task attention queues.

Project summaries include task counts and completion percentages.

**Completion calculation:**

`Completion % = (Completed top-level tasks / Total top-level tasks) × 100`

Subtasks are excluded from top-level completion calculations and reported separately to avoid double-counting.

### 5.2 — Advanced Task Filters & Sorting

Implemented organization-wide and project-level task filtering.

Supported filters include:

- Project.
- Task status.
- Priority.
- Assignee.
- Deadline range.
- Overdue status.
- Due-today status.
- Due-soon status.
- Stale status.
- Blocked status.
- Deliverable status.
- Parent task and subtask scope.

Multiple filters can be combined using AND logic.

Supported sorting:

- Deadline.
- Priority.
- Creation date.
- Last meaningful activity.
- Task status.

Additional functionality:

- Ascending and descending sorting.
- Pagination.
- Page-size validation.
- Filter reset.
- Server-side query validation.

### 5.3 — Overdue & Due-Date Detection

Overdue and deadline health are calculated dynamically when task data is requested.

Supported deadline states:

| State | Meaning |
|---|---|
| `overdue` | Deadline has passed and task is incomplete |
| `due_today` | Task is due on the current UTC calendar day |
| `due_soon` | Deadline falls within the next seven UTC calendar days |
| `upcoming` | Deadline is beyond the due-soon window |
| `no_deadline` | No deadline is assigned |
| `completed` | Task is completed |
| `archived` | Task belongs to an archived project |

Rules:

- Completed tasks are not classified as overdue.
- Tasks in archived projects are excluded from overdue and due-soon calculations.
- Tasks without deadlines are not overdue.
- Date-only deadlines stored at midnight UTC are evaluated through the end of that UTC calendar day.
- Explicit timestamps are compared directly.
- The default due-soon window is seven UTC calendar days.

No redundant overdue or due-soon boolean fields are stored in MongoDB.

### 5.4 — Stale Task Detection

Implemented activity-backed task inactivity monitoring.

Default stale threshold:

`DEFAULT_STALE_THRESHOLD_DAYS = 7`

The threshold can be configured between 1 and 365 days.

Last meaningful activity is calculated using the existing `activities` collection.

Meaningful activity includes:

- Task creation.
- Subtask creation.
- Task updates.
- Status changes.
- Priority changes.
- Assignee changes.
- Deadline changes.
- Approval requirement changes.
- Dependency additions and removals.
- Deliverable submissions.
- Review approvals.
- Changes-requested decisions.
- Updated review decisions.

If no matching activity exists, the system falls back to:

`task.updatedAt ?? task.createdAt`

A task is considered stale when:

`Current time - Last meaningful activity >= Stale threshold`

Stale detection applies only to incomplete tasks in active projects.

The implementation uses batched activity aggregation rather than performing an individual activity query for every task.

### 5.5 — Progress Monitoring & Reports

Implemented supervision reporting for project progress, team workload, and time-based task activity.

**Project progress reports**

- Total top-level tasks.
- Completed tasks.
- Incomplete tasks.
- Completion percentage.
- Separate subtask summaries.

**Team workload reports**

- Assigned task counts by team member.
- Workload distribution.
- Unassigned task counts.

**Time-based reports**

- Tasks created within a selected date range.
- Tasks completed within a selected date range.
- Overdue task counts.
- Stale task counts.

Completion reporting uses task creation timestamps and `task.status_changed` activity records, with an `updatedAt` fallback for older completed tasks.

Historical reporting limitations are retained where the underlying records do not contain complete historical information.

## 3. API Routes

### Supervisor dashboard

`GET /api/organizations/[slug]/supervision`

Returns:

- Organization operational metrics.
- Project health summaries.
- Overdue task highlights.
- Stale task highlights.

Access: Admin and Manager.

### Organization-wide supervision task explorer

`GET /api/organizations/[slug]/supervision/tasks`

Returns filtered, sorted, enriched, and paginated organization-wide task results.

Access: Admin and Manager.

### Organization task alias

`GET /api/organizations/[slug]/tasks`

Provides the organization-wide task endpoint through the supervision task route.

### Supervision reports

`GET /api/organizations/[slug]/supervision/reports`

Returns project progress, team workload, and time-based reporting data.

Access: Admin and Manager.

### Organization reports alias

`GET /api/organizations/[slug]/reports`

Provides the organization reports endpoint through the supervision reports route.

### Project task listing

`GET /api/organizations/[slug]/projects/[projectId]/tasks`

Supports advanced project-level filters, sorting, pagination, and enriched task health information.

### Project task creation

`POST /api/organizations/[slug]/projects/[projectId]/tasks`

Preserves existing task creation functionality and validation.

### Task updates

`PATCH /api/organizations/[slug]/projects/[projectId]/tasks/[taskId]`

Returns updated task information with enriched health fields and serialized assignee data.

## 4. Backend Architecture

The majority of Phase 5 business logic is implemented in:

`lib/tenancy.ts`

Important helpers include:

| Helper | Responsibility |
|---|---|
| `computeTaskDeadlineHealth` | Dynamic deadline classification |
| `computeTaskStaleHealth` | Stale task calculation |
| `getTasksLastActivityMap` | Batched task activity lookup |
| `enrichSingleTask` | Enriches task data with health and related information |
| `sortEnrichedTasks` | Deterministic task sorting |
| `queryProjectTasks` | Project-level filtering and pagination |
| `queryOrganizationTasks` | Organization-wide supervisory task queries |
| `getSupervisorDashboard` | Dashboard aggregation |
| `getSupervisionReports` | Progress, workload, and time-based reports |
| `serializeTaskAssignee` | Maps backend assignee data to client-facing DTO format |

### Task enrichment

Enriched task responses can include:

- `isOverdue`
- `isDueToday`
- `isDueSoon`
- `deadlineState`
- `isStale`
- `lastActivityAt`
- `daysSinceActivity`
- `projectName`
- `projectStatus`
- `parentTaskTitle`
- `assignee`

Assignee serialization maps the backend `userId` field to the client-facing `id` field while preserving the member's name, email, and role.

## 5. Database and Indexes

**Schema changes:** None required.

Phase 5 reuses existing MongoDB collections:

- `organizations`
- `memberships`
- `projects`
- `tasks`
- `task_dependencies`
- `deliverables`
- `reviews`
- `activities`

Existing compound indexes are reused for task filtering, deadline queries, assignment lookup, project scoping, and activity retrieval.

No redundant overdue or stale fields are persisted.

## 6. Security and Permissions

Phase 5 preserves the existing authentication, organization membership, and role-based authorization architecture.

**Admin**
- Full organization supervision access.
- Dashboard and reporting access.
- Organization-wide task exploration.

**Manager**
- Full organization supervision access.
- Dashboard and reporting access.
- Organization-wide task exploration.

**Member**
- Cannot access organization-wide supervision dashboards or reports.
- Can continue using permitted project-level task filters and health indicators.

Security controls include:

- Better Auth session verification.
- Server-side role enforcement.
- Organization-scoped database queries.
- Cross-organization resource isolation.
- Rejection of unauthorized project IDs.
- Validation of filter and sorting parameters.
- Read-only dashboard and report aggregation.

Unauthorized members receive a 403 response from supervisory APIs. Non-members receive a not-found response for organization-scoped resources.

## 7. UI Implementation

Added the supervision page:

`/dashboard/[slug]/supervision`

Main sections:

1. Organization Operational Overview.
2. Project Health & Operational Summary.
3. Overdue Attention Queue.
4. Stale Attention Queue.
5. Advanced Project & Task Explorer.
6. Progress Monitoring.
7. Team Workload.
8. Time-Based Reports.

Navigation links are displayed for admin and manager roles.

Project task pages also display task health badges and last meaningful activity information.

The supervision interface supports responsive layouts for narrower mobile viewports.

## 8. Independent Verification Results

Phase 5 underwent two independent verification passes.

### Initial backend verification

| Test area | Result |
|---|---:|
| Backend integration tests | 55/55 passed |
| Supervisor dashboard calculations | PASS |
| Advanced filters and sorting | PASS |
| Overdue detection | PASS |
| Stale detection | PASS |
| Progress and workload reports | PASS |
| Authentication and tenant isolation | PASS |
| Focused Phase 4 regression | PASS |

The first verification identified frontend integration issues, which were corrected in a separate implementation pass.

### Final targeted verification

| Check | Result |
|---|---:|
| TypeScript (`npx tsc --noEmit`) | PASS — 0 errors |
| ESLint (`npm run lint`) | PASS — 0 errors, 0 warnings |
| Supervision page compilation | PASS |
| Admin dashboard access | PASS |
| Manager dashboard access | PASS |
| Member access restriction | PASS |
| Assignee serialization | PASS — all 5 locations |
| Time-report contract | PASS |
| Browser rendering and hydration | PASS |
| Interactive dashboard controls | PASS |
| Mobile responsive layout | PASS |
| Focused Phase 4 regression | PASS |

**Final Phase 5 verification status: PASS.**

## 9. Completion Summary

Phase 5 establishes the supervisory and reporting layer of Orchestr.

The system now supports organization-wide operational visibility, project health monitoring, deadline tracking, inactivity detection, advanced task exploration, team workload reporting, and progress monitoring.

All Phase 5.1–5.5 functionality has been independently verified.

**Next planned development phase: Phase 6 — Meetings & Action Items.**