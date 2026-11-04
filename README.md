## Phase 7 — Notifications

Phase 7 introduces an in-app notification system to keep organization members informed about important changes and upcoming deadlines across Orchestr.

The system includes a notification center, unread tracking, event-driven notification generation, and a protected endpoint for generating deadline reminders.

### 1. In-App Notification Center

Implemented a centralized notification system with:

- Notification bell with unread count.
- Notification dropdown and dedicated notification center page.
- All, Unread, and Read notification filters.
- Individual notification read status updates.
- Mark all notifications as read.
- Pagination for notification history.
- Polling to refresh unread counts.
- Safe links to relevant organization, project, task, meeting, and workflow pages.
- Empty states and error handling.

The notification center is available at:

`/dashboard/[slug]/notifications`

The notification bell is integrated into the main dashboard and relevant organization pages, including projects, meetings, members, and supervision.

### 2. Supported Notification Events

Notifications are generated for important workflow events:

| Event | Trigger |
|---|---|
| `task.assigned` | A task is assigned or reassigned to a member |
| `task.updated` | Important task details are changed |
| `deliverable.submitted` | A member submits a deliverable |
| `review.decided` | A reviewer approves or requests changes |
| `meeting.participant_added` | A member is added to a meeting |
| `action_item.assigned` | A meeting action item is assigned |
| `deadline.reminder` | A deadline reminder is generated |
| `general` | General-purpose notification type |

Notifications are sent to relevant recipients while excluding the actor where appropriate.

No notification is generated for unchanged task values or assignments that do not represent a new assignment.

### 3. Deadline Reminders

Added a protected endpoint for generating deadline reminder notifications:

`POST /api/organizations/[slug]/notifications/reminders`

The endpoint:

- Identifies tasks matching the deadline reminder criteria.
- Uses existing task deadline health calculations.
- Supports authenticated administrator and manager access.
- Supports cron-secret authentication through:
  - `x-orchestr-cron-secret`
  - `Authorization: Bearer <secret>`
- Supports dry-run execution to preview reminders without modifying database records.
- Returns structured generation metrics.

Supported dry-run inputs:

- Query parameter: `dryRun=true`
- Query parameter: `dry_run=true`
- JSON body: `{"dryRun": true}`
- JSON body: `{"dry_run": true}`

The response includes:

- `matchedTasks`
- `generated`
- `skipped`
- `dryRun`
- `referenceDate`

Configure a cron secret using `ORCHESTR_CRON_SECRET` or `CRON_SECRET` in the deployment environment.

### 4. Duplicate Prevention

Implemented notification deduplication using a `dedupeKey` and a partial unique MongoDB index:

`org_recipient_dedupe_unique`

The index uses:

- `organizationId`
- `recipientId`
- `dedupeKey`

This prevents duplicate notifications for the same recipient and event key.

Duplicate-key errors are handled safely, allowing repeated or concurrent reminder generation without creating duplicate records.

### 5. Database and Schema

Added the `notifications` collection with:

- Notification type.
- Organization ID.
- Recipient ID.
- Actor ID, where applicable.
- Entity type and entity ID.
- Title and message.
- Read status.
- Optional deduplication key.
- Creation timestamp.

Added validation and indexes for notification retrieval, unread counts, recipient-scoped queries, and deduplication.

Run the database setup command to apply schema and index changes:

```bash
npm run db:setup
```

### 6. API Endpoints

Implemented notification APIs for:

- Retrieving notifications.
- Retrieving unread notification counts.
- Marking an individual notification as read.
- Marking all notifications as read.
- Generating deadline reminders.

The API supports pagination and read-status filtering.

### 7. Security and Access Control

The notification system follows organization-level tenancy and recipient-level access controls.

- Notification recipients are derived from the authenticated session.
- Users can only retrieve and update their own notifications.
- Queries are scoped by organization and recipient.
- Cross-organization notification access is prevented.
- Notification DTOs do not expose raw database documents or recipient IDs.
- Notification links are validated and restricted to safe organization dashboard paths.
- Reminder generation requires valid administrator/manager authentication or the configured cron secret.
- Dry-run mode does not bypass authentication or authorization.

### 8. Verification Results

Phase 7 was independently verified in two batches.

**Batch 1 — In-App Notifications**

- 36/36 verification checks passed.
- Notification schema and indexes verified.
- API retrieval, pagination, filtering, and read operations verified.
- Tenant isolation and recipient access controls verified.
- Safe notification links verified.
- Notification UI and regression checks passed.

**Batch 2 — Event-Driven Notification Generation**

- 30/30 targeted verification checks passed.
- TypeScript: 0 errors.
- ESLint: 0 errors and warnings.
- Production build completed successfully.
- Notification creation and duplicate handling verified.
- Event-driven notification triggers verified.
- Reminder endpoint authorization verified.
- Concurrent reminder generation verified.
- Dry-run behavior verified with no database writes.
- Test data cleanup verified.

### 9. Known Limitation

Notification delivery currently uses best-effort dispatch.

There is no durable notification outbox, background retry worker, or guaranteed retry mechanism yet. If notification persistence fails after a business operation has already committed, the corresponding notification may be lost.

A durable outbox and retry mechanism can be introduced in a future reliability improvement.

### Phase 7 Status

**Complete — Implementation and independent verification passed.**

Phase 7 provides the notification foundation required for team members and supervisors to stay informed about task assignments, workflow changes, reviews, meeting participation, action-item assignments, and upcoming deadlines.