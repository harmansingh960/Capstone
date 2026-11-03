# Orchestr — Phase 4: Workflow Management

## Overview

Phase 4 completes Orchestr's core workflow-management functionality.

It introduces task dependencies, blocker tracking, improved deliverable and review workflows, review transparency, and a complete activity history and audit trail.

The objective is to provide teams with a transparent workflow in which members can understand what needs to be done, what is blocked, what requires review, and what has happened throughout a project's lifecycle.

## Phase 4 Completion Status

| Subphase | Feature | Status |
|---|---|---|
| 4.1 | Task Dependencies and Blockers | Complete |
| 4.2 | Deliverable Workflow Improvements | Complete |
| 4.3 | Review-Flow Improvements | Complete |
| 4.4 | Activity History and Audit Trail | Complete |

## 1. Phase 4.1 — Task Dependencies and Blockers

### Features
- Create dependencies between tasks.
- Support multiple prerequisites.
- Prevent self-dependencies.
- Prevent circular dependencies.
- Detect blocked tasks dynamically.
- Automatically reflect prerequisite completion.
- Restore blocked status when a prerequisite is reopened.
- Allow Admins and Managers to manage dependencies.
- Keep dependency information visible to Members.
- Prevent dependency mutations in archived projects.

### Blocker behavior

A task is considered blocked when one or more prerequisite tasks are not completed.

Blocked status is derived dynamically rather than stored as a separate manually maintained task status.

## 2. Phase 4.2 — Deliverable Workflow Improvements

### Features
- Submit deliverables against tasks and subtasks.
- Preserve complete submission history.
- Identify the current submission.
- Identify superseded submissions.
- Require feedback when requesting changes.
- Support revised deliverable submissions.
- Display previous review feedback.
- Derive deliverable status at task level.
- Filter tasks by deliverable status.
- Retrieve deliverables and reviews efficiently using batched queries.

### Deliverable statuses

- Needs Submission
- In Review
- Changes Requested
- Approved

Task completion continues to depend on the latest deliverable's approval when approval is required.

## 3. Phase 4.3 — Review-Flow Improvements

### Features
- Deliverable review queue through status filters.
- Submission numbering.
- Revision identification.
- Previous-review feedback context.
- Reviewer identity and timestamps.
- Self-review indicator.
- Self-approved indicator.
- Latest decision indicator.
- Updated decision indicator.
- Preserve all historical review decisions.

### Review transparency

Reviews are displayed newest first.

Earlier decisions remain visible and are never overwritten by subsequent reviews.

Self-review is identified when the reviewer and deliverable submitter are the same user.

## 4. Phase 4.4 — Activity History and Audit Trail

### Activity recording

Orchestr records activity for:

**Projects**
- Project created.
- Project updated.
- Project archived.
- Project unarchived.

**Tasks and subtasks**
- Created.
- Updated.
- Status changed.
- Priority changed.
- Assignee changed.
- Deadline changed.
- Approval requirement changed.

**Dependencies**
- Dependency added.
- Dependency removed.

**Deliverables and reviews**
- Deliverable submitted.
- Review approved.
- Changes requested.
- Review decision updated.

### Activity timelines

Activity can be viewed at three levels:

1. Organization activity.
2. Project activity.
3. Task and subtask activity.

Activity entries include:
- Actor identity.
- Event type.
- Description.
- Timestamp.
- Relevant before-and-after changes.
- Related project or task context.

### Technical characteristics

- Organization-scoped activity records.
- Append-only application behavior.
- Server-derived actor identity.
- MongoDB schema validation.
- Compound indexes for timeline retrieval.
- Deterministic newest-first ordering.
- Cursor-based pagination.
- Batched actor and membership hydration.
- Read-only activity API endpoints.
- Tenant isolation and membership verification.

### Activity API endpoints

Organization:
`GET /api/organizations/[slug]/activity`

Project:
`GET /api/organizations/[slug]/projects/[projectId]/activity`

Task:
`GET /api/organizations/[slug]/projects/[projectId]/tasks/[taskId]/activity`

Default activity page size: 25

Maximum activity page size: 100

## 5. Permissions and Security

Phase 4 preserves existing Orchestr authentication and authorization rules.

- Authentication is handled through Better Auth.
- Actor identity is derived from the authenticated session.
- Organization membership is verified before accessing organization resources.
- Activity retrieval is tenant-scoped.
- Activity endpoints are read-only.
- Members cannot approve deliverables.
- Only authorized roles can manage dependencies and reviews.
- Archived projects preserve historical read access while restricting mutations.

## 6. Database Changes

Phase 4 introduced the `activities` collection.

Activity indexes:

- `org_created_id`
- `org_project_created_id`
- `org_project_task_created_id`

The activity collection uses MongoDB document validation.

Activity writes use the existing transaction wrapper. MongoDB Atlas replica-set transactions provide atomicity between domain mutations and their activity records.

Standalone MongoDB fallback does not provide equivalent multi-document transaction guarantees.

## 7. Verification Summary

Reported verification results:

| Area | Result |
|---|---|
| Phase 4.1 dependency verification | Passed |
| Phase 4.2 deliverable verification | Passed |
| Phase 4.3 review verification | 12/12 passed |
| Phase 4.4 activity verification | 50/50 passed |
| Phase 4.4 targeted fixes | 9/9 passed |
| TypeScript | Passed |
| ESLint | Passed |

Phase 4.4 verification was performed against the development database `orchestr_dev`.

These results reflect the reported verification runs and do not replace production deployment testing.

## 8. Phase 4 Completion

Phase 4 is functionally complete.

Orchestr now supports:
- Task dependencies and blocker tracking.
- Deliverable submissions and revisions.
- Review and approval workflows.
- Transparent review history.
- Organization, project and task activity timelines.
- Historical activity and audit records.

## 9. Next Development Phase

**Phase 5 — Supervision**

Planned functionality:
- Supervisor dashboard.
- Advanced task and project filters.
- Overdue-task detection.
- Stale-task detection.
- Progress monitoring.
- Reporting and operational visibility.

