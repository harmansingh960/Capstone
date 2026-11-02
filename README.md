# Orchestr v0.3 — Data Foundation and Workflow Management

## Overview

Orchestr v0.3 introduces the core organizational and workflow management capabilities of the Orchestr platform.

The primary objective of this phase was to move Orchestr beyond its initial authentication foundation and establish a functional system where organizations can manage their members, projects, tasks, deliverables, reviews, and work progress through a centralized platform.

This phase establishes the application's multi-organization data foundation, role-based access control (RBAC), project and task management workflows, deliverable submission, review and approval mechanisms, and organization membership management.

The implementation focuses on maintaining a shared operational source of truth while ensuring that users can only perform actions permitted by their organization membership and role.

---

## 1. Technology Stack

The v0.3 implementation uses the existing application stack:

| Component | Technology |
|---|---|
| Framework | Next.js 16.4.3 (App Router) |
| Frontend | React 19.3 |
| Language | TypeScript (strict mode) |
| Styling | Tailwind CSS v4 |
| Database | MongoDB Atlas |
| Database Driver | Official MongoDB Node.js Driver |
| Authentication | Better Auth 1.7.14 |
| Validation | Zod and server-side runtime validation |
| Deployment Preparation | Docker and Docker Compose |
| Version Control | Git and GitHub |

The application uses the official MongoDB driver directly. Mongoose and Prisma are not used.

---

## 2. Database Architecture and Data Foundation

A structured MongoDB data foundation was implemented to support organizations and their operational workflows.

### Application Collections

Six application-owned MongoDB collections were introduced:

| Collection | Purpose |
|---|---|
| `organizations` | Stores organization information and unique organization slugs. |
| `memberships` | Connects users to organizations and stores their organization-specific roles. |
| `projects` | Stores projects belonging to organizations. |
| `tasks` | Stores project tasks, subtasks, assignments, deadlines, priorities, and statuses. |
| `deliverables` | Stores work submissions associated with tasks. |
| `reviews` | Stores approval decisions and review comments for submitted deliverables. |

Better Auth maintains its own authentication collections separately.

### Organization-Based Data Isolation

The application follows an organization-scoped data model.

- Each project belongs to an organization.
- Each task belongs to an organization and project.
- Each deliverable belongs to an organization, project, and task.
- Each review belongs to an organization, project, task, and deliverable.
- Membership records determine which users can access an organization.

Organization ownership is checked before accessing or modifying related resources.

User IDs are stored as strings in application references to remain compatible with Better Auth session identities.

### Database Schema and Indexes

The following modules were introduced:

- `lib/schema.ts` — Defines application data types, validators, collection schemas, index definitions, and database setup.
- `lib/collections.ts` — Provides typed access to application-owned MongoDB collections.
- `lib/tenancy.ts` — Contains organization membership checks, tenant-scoped data operations, validation, and workflow authorization.
- `scripts/db-setup.mjs` — Provides the database initialization command.

The database setup process is additive and idempotent. It creates or updates the required collections, validators, and indexes without intentionally deleting existing application documents.

The `db:setup` command was verified against the development database.

### Indexes

The implementation includes indexes supporting:

- Unique organization slugs.
- Unique user membership within an organization.
- Project listing by organization, status, and creation date.
- Task listing by organization, project, parent task, and status.
- Parent-task lookup.
- Task assignment and deadline queries.
- Deliverable history by organization, project, task, and creation date.
- Review history by organization, task, deliverable, and creation date.

---

## 3. Authentication and Authorization

The existing Better Auth authentication system was integrated with the new organization and workflow functionality.

### Session-Based Authentication

All protected operations derive the acting user's identity from the server-side Better Auth session.

Client-provided user IDs are not trusted for sensitive identity fields such as:

- `createdBy`
- `submittedBy`
- `reviewerId`

The backend derives these values from the authenticated session.

### Organization Membership

A centralized membership verification mechanism was implemented through `requireMembership()`.

This ensures that organization-scoped operations verify both:

1. The authenticated user has an active membership in the requested organization.
2. The user's role permits the requested operation.

Unauthorized or non-existent organization access returns a consistent `404 Organization not found` response to reduce organization enumeration.

### Role-Based Access Control

Three organization roles are supported:

| Role | Responsibilities |
|---|---|
| Admin | Full organization administration, membership management, project and task management, assignment, deliverable submission, and reviews. |
| Manager | Project management, task creation and assignment, workflow management, and deliverable reviews. Cannot manage organization membership. |
| Member | Access to organization work, updates to assigned tasks, permitted subtask creation, and deliverable submission for assigned tasks. |

### Permission Summary

| Operation | Admin | Manager | Member |
|---|---|---|---|
| View organization projects and tasks | Yes | Yes | Yes |
| View organization members | Yes | Yes | Yes |
| Add organization members | Yes | No | No |
| Change member roles | Yes | No | No |
| Remove members | Yes | No | No |
| Create projects | Yes | Yes | No |
| Edit and archive projects | Yes | Yes | No |
| Create top-level tasks | Yes | Yes | No |
| Create subtasks | Yes | Yes | Restricted |
| Assign or reassign tasks | Yes | Yes | No |
| Change task priority and deadline | Yes | Yes | No |
| Configure approval requirements | Yes | Yes | No |
| Update assigned task status | Yes | Yes | Yes |
| Submit deliverables | Yes | Yes | Assigned tasks only |
| Review deliverables | Yes | Yes | No |

Member restrictions are enforced by backend authorization logic, not only by hiding frontend controls.

---

## 4. Organization Management

Organization creation and access management were implemented.

### Features

- Create an organization using its name and optional custom slug.
- Automatically generate a slug when one is not supplied.
- Validate and normalize organization slugs.
- Reject reserved or invalid slugs.
- Prevent duplicate organization slugs.
- List organizations belonging to the authenticated user.
- Retrieve an organization only when the user has membership.
- Automatically assign the organization creator the `admin` role.
- Display the user's organizations on the dashboard.
- Provide organization-specific navigation and workspace access.

### Organization APIs

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/organizations` | List the authenticated user's organizations. |
| POST | `/api/organizations` | Create an organization. |

Organization-specific project and membership APIs are described in their respective sections.

---

## 5. Project Management

A project management layer was implemented within each organization.

### Features

- Create projects.
- View organization projects.
- Edit project names and descriptions.
- Archive projects.
- Unarchive projects.
- Filter projects by active, archived, or all.
- Restrict project creation and management to admins and managers.
- Prevent normal task and workflow mutations in archived projects.

Projects are always associated with their owning organization.

### Project APIs

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/organizations/{slug}/projects` | List organization projects. |
| POST | `/api/organizations/{slug}/projects` | Create a project. |
| PATCH | `/api/organizations/{slug}/projects/{projectId}` | Update project details or status. |

---

## 6. Task Management

Task management is one of the central capabilities introduced in v0.3.

### Task Features

- Create top-level project tasks.
- Create subtasks under existing tasks.
- Assign tasks to organization members.
- Support unassigned tasks.
- Set task titles and descriptions.
- Set task priorities.
- Set deadlines.
- Track task statuses.
- Filter tasks by status, parent task, and assignee.
- View tasks and subtasks within a project workspace.
- Restrict task operations according to organization roles.

### Task Statuses

The task workflow supports:

- `todo`
- `in_progress`
- `done`

### Task Priorities

The task model supports priority levels, including:

- `low`
- `medium`
- `high`
- `urgent`

### Subtask Restrictions

- Admins and managers can create and manage subtasks.
- Members can create subtasks only under eligible top-level tasks assigned to them.
- Member-created subtasks are assigned to the creating member.
- Members cannot create top-level tasks.
- Members cannot reassign tasks or change restricted task properties.

### Task APIs

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/organizations/{slug}/projects/{projectId}/tasks` | List project tasks and apply supported filters. |
| POST | `/api/organizations/{slug}/projects/{projectId}/tasks` | Create a task or permitted subtask. |
| PATCH | `/api/organizations/{slug}/projects/{projectId}/tasks/{taskId}` | Update task details and status. |

---

## 7. Deliverable Submission

A deliverable submission mechanism was introduced to connect actual work outputs with their corresponding tasks.

### Features

- Submit a deliverable against a task or subtask.
- Include a textual description.
- Include an external URL.
- Support description-only or URL-only submissions.
- View deliverable history for a task.
- Associate each submission with its authenticated submitter.
- Restrict member submissions to tasks assigned to them.
- Prevent new submissions to completed tasks.
- Prevent submissions in archived projects.

### URL Validation

Deliverable URLs are validated on the backend.

Only HTTP and HTTPS protocols are accepted. Unsafe schemes such as `javascript:` and `data:` are rejected.

External links are also validated before rendering in the frontend and use safe link attributes.

### Deliverable API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/organizations/{slug}/projects/{projectId}/tasks/{taskId}/deliverables` | List task deliverables. |
| POST | `/api/organizations/{slug}/projects/{projectId}/tasks/{taskId}/deliverables` | Submit a deliverable. |

---

## 8. Deliverable Reviews and Approval Workflow

A review mechanism was implemented to support supervisor and manager approval of submitted work.

### Review Features

- Admins and managers can review deliverables.
- Members cannot approve or reject their own deliverables through the review API.
- Review decisions support:
  - `approved`
  - `changes_requested`
- Review comments can be attached to decisions.
- Review history is retained.
- Reviews are associated with the relevant deliverable and task.
- Reviews cannot be created against completed tasks.
- Review operations are blocked for archived projects.

### Review API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/organizations/{slug}/projects/{projectId}/tasks/{taskId}/deliverables/{deliverableId}/reviews` | Retrieve review history. |
| POST | `/api/organizations/{slug}/projects/{projectId}/tasks/{taskId}/deliverables/{deliverableId}/reviews` | Submit a review decision. |

### Approval-Driven Task Completion

An approval requirement was added to the task model through the `approvalRequired` field.

New tasks and subtasks default to requiring approval.

Admins and managers can configure this requirement. Members cannot change it.

When approval is required:

1. A deliverable must be submitted.
2. A manager or admin must review the latest deliverable.
3. The latest review for that deliverable must have the decision `approved`.
4. Only then can the task transition to `done`.

If the latest deliverable has no review, has a `changes_requested` decision, or has not been approved, the backend rejects completion with `409 Conflict`.

Submitting a newer deliverable invalidates the approval of an older deliverable for completion purposes.

When approval is optional, a task can be completed without an approved deliverable.

### Completed Task Restrictions

Once a task is completed:

- New deliverables cannot be submitted.
- New reviews cannot be created.
- The task must be reopened before further submission or review activity.

Legacy tasks without the `approvalRequired` field are treated as approval-optional for backward compatibility.

---

## 9. Organization Membership Management

A dedicated membership management feature was introduced in Phase 3.8.

### Features

- View organization members.
- Display member names, email addresses, user IDs, and organization roles.
- Add an existing registered Better Auth user by email.
- Assign `manager` or `member` when adding a user.
- Change an existing member's role.
- Remove a user's organization membership.
- Preserve the user's underlying Better Auth account when membership is removed.
- Prevent duplicate memberships.
- Prevent removal or demotion of the last organization admin.
- Restrict membership mutations to admins.
- Allow managers and members to view the organization member list without mutation controls.

The add-member operation only accepts an existing registered account. It does not create a new Better Auth account.

### Last-Admin Protection

The application prevents an organization from losing its last admin through role demotion or membership removal.

MongoDB transactions are used for these operations. The implementation rechecks the acting admin's role within the transaction and uses a write to the parent organization document to serialize competing last-admin mutations.

The transaction path was verified against the development Atlas replica set.

### Historical Task Assignments

Removing a member deletes their organization membership but does not delete their Better Auth account or historical task records.

If a removed member was previously assigned a task, the historical assignee reference remains intact and is displayed as `Former member`.

This preserves task history and avoids losing information about previous work assignments.

### Membership APIs

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/organizations/{slug}/members` | List organization members. |
| POST | `/api/organizations/{slug}/members` | Add an existing registered user. |
| PATCH | `/api/organizations/{slug}/members/{userId}` | Update a member's organization role. |
| DELETE | `/api/organizations/{slug}/members/{userId}` | Remove organization membership. |

---

## 10. Frontend Workspaces and User Interface

Functional dashboard and workspace interfaces were introduced for the new backend capabilities.

### Implemented Interfaces

- Organization dashboard.
- Organization creation form.
- Organization-specific workspace.
- Project listing and management interface.
- Project task workspace.
- Task and subtask creation and editing controls.
- Task status and priority displays.
- Deliverable submission interface.
- Deliverable and review history.
- Approval requirement indicators.
- Review controls for admins and managers.
- Organization members page.
- Membership management controls for admins.
- Read-only membership view for managers and members.
- Former-member assignment display.

### UI and Interaction Behavior

The interfaces include:

- Loading states.
- Empty states.
- API error messages.
- Retry behavior where implemented.
- Duplicate-submission protection.
- Confirmation before member removal.
- Role-based visibility of administrative controls.
- Refreshing data after successful mutations.
- Safe external deliverable links.

Server-side page access checks are used for protected organization workspaces.

---

## 11. API Security and Data Validation

Security and tenant isolation were incorporated throughout the v0.3 implementation.

### Centralized Security Measures

- Server-side Better Auth session verification.
- Centralized organization membership checks.
- Role-based backend authorization.
- Organization-scoped MongoDB queries.
- Cross-document ownership validation.
- Strict ObjectId parsing for resource identifiers.
- Runtime validation of request fields.
- Plain-object checks for request bodies.
- Explicit allowlists for create and update operations.
- Rejection of unknown request fields.
- Safe error responses.
- Server-only modules for database and authentication code.
- Separation of application collections from Better Auth collections.
- Safe projection of user profile fields when listing members.
- Validation of deliverable URLs.

Client-supplied actor identity and unauthorized update fields are not accepted as substitutes for server-side authorization.

---

## 12. Development Database and Setup Verification

The v0.3 database foundation was verified against the development MongoDB Atlas database.

### Development Database

`orchestr_dev`

### Verification Results

- MongoDB Atlas connection succeeded.
- All six application-owned collections were present.
- Required indexes were verified.
- Database setup completed successfully.
- Re-running `npm run db:setup` produced an unchanged result.
- No application documents were mutated by the verification rerun.
- Atlas replica-set transaction support was confirmed.
- The application health endpoint returned a successful database connection response.

The development database was kept separate from the intended production database.

---

## 13. Testing and Verification

A multi-stage verification process was completed across the v0.3 implementation.

### Static Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | PASS |
| `npm run lint` | PASS |
| Database setup rerun | PASS |
| Database index verification | PASS |
| Atlas transaction verification | PASS |

### Live Workflow Verification

The implementation was tested against the development database through live application and API workflows.

Verified scenarios included:

1. Organization creation.
2. Project creation and updates.
3. Admin task creation and assignment.
4. Deliverable submission and persistence.
5. Review creation and history retrieval.
6. Approval-required task completion restrictions.
7. Approval-optional task completion.
8. New deliverable superseding an earlier approval.
9. Restrictions on submissions and reviews for completed tasks.
10. Archived project read-only behavior.
11. Cross-organization access restrictions.
12. Adding existing users to organizations.
13. Updating member roles.
14. Duplicate membership rejection.
15. Unknown user and invalid role rejection.
16. Last-admin demotion and removal protection.
17. Membership removal while preserving historical assignments.
18. Manager and member restrictions on membership management.
19. Member restrictions on project and top-level task creation.
20. Member restrictions on unassigned tasks.
21. Member restrictions on priority, deadline, assignee, and approval configuration.
22. Permitted subtask creation by members.
23. Member deliverable submission.
24. Manager approval and subsequent member task completion.

### Multi-Role Verification

Three roles were tested using separate development accounts:

- Admin
- Manager
- Member

The verification confirmed that backend permissions were enforced through API requests, including direct requests that bypassed frontend controls.

### Verification Outcome

All reported live scenarios passed.

No critical, high, or medium application code issues were identified in the Phase 3.9 review.

---

## 14. Production Readiness and Remaining Work

The v0.3 application functionality and development verification are complete according to the Phase 3 verification reports.

However, production deployment requires additional operational hardening.

| Item | Status |
|---|---|
| Core organization and workflow functionality | Completed |
| Authentication and RBAC review | Passed |
| Organization data isolation review | Passed |
| Development database verification | Passed |
| TypeScript and lint verification | Passed |
| Production environment variables | Required before production |
| Production HTTPS origin and cookie configuration | Required before production |
| Authentication and sensitive API rate limiting | Recommended before production |
| HTTP security headers | Recommended before production |
| Production Atlas network restrictions | Required before production |
| Production database backups and recovery arrangements | Recommended before production |
| Production deployment verification | Pending |

Previously exposed credentials and authentication secrets must be rotated before production use. Production database access must be restricted to the required network sources.

The application should not be considered production-deployed solely because its development workflows and static checks have passed.

---

## 15. Git and Release Status

The Phase 3.9 review identified the following repository state:

- Active development branch: `hawkeye_work`.
- Previous release tag: `v0.2.0`.
- Latest reported commit at review time: `a6b3a04`.
- Phase 3.2–3.8 implementation changes were still uncommitted in the working tree.

The v0.3 release commit, push, and `v0.3.0` tag were therefore left pending.

The release should be tagged only after the intended implementation files are reviewed, committed, and pushed to the appropriate remote branch.

---

## 16. Phase 3 Completion Summary

Orchestr v0.3 establishes the first complete organization-based workflow foundation for the application.

The phase introduces:

- Multi-organization support.
- Organization membership and role management.
- Admin, manager, and member permissions.
- Project creation and management.
- Task and subtask management.
- Task assignment and progress tracking.
- Deliverable submission.
- Review and approval workflows.
- Approval-driven task completion.
- Historical assignment preservation.
- Tenant-scoped API access.
- MongoDB schema validation and indexing.
- Development database setup and verification.

The resulting system provides a functional foundation for coordinating organizational work through structured projects, assigned tasks, deliverables, and review processes rather than relying entirely on fragmented communication channels.

**Phase 3 implementation and reported development verification: PASSED.**

**v0.3.0 Git release checkpoint: PENDING.**