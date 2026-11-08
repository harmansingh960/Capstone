# Orchestr — Phase 8.5
## File Upload, Media Management & Storage Infrastructure

**Project:** Orchestr  
**Phase:** 8.5  
**Status:** Implementation complete; live Backblaze B2 integration verification pending  
**Storage Provider:** Backblaze B2 (S3-compatible API)  
**Storage Access:** Private bucket with presigned URLs

---

## 1. Overview

Phase 8.5 introduces secure file upload, storage, retrieval, preview, and deletion capabilities to Orchestr.

The objective is to allow team members to submit work-related files directly through tasks and deliverables, while allowing Managers and Admins to review submitted materials.

This phase extends Orchestr's task and deliverable workflow with file management capabilities without requiring users to rely exclusively on external file-sharing services.

Google Drive links are also supported as external deliverable references.

## 2. Objectives

- Provide secure file uploads for task deliverables.
- Store files in private cloud storage.
- Support multiple file formats.
- Allow Members to upload files to their assigned tasks.
- Allow Managers and Admins to preview and download submitted files.
- Integrate uploaded files with deliverable submissions.
- Support Google Drive links alongside uploaded files.
- Prevent unauthorized access to stored files.
- Clean up expired and unattached uploads.
- Provide retryable file deletion when remote storage operations fail.

## 3. Technology and Infrastructure

| Component | Technology |
|---|---|
| Application | Next.js App Router |
| Language | TypeScript |
| Database | MongoDB Atlas |
| Database Driver | Official MongoDB Node.js Driver |
| Object Storage | Backblaze B2 |
| Storage API | S3-compatible API |
| Storage SDK | AWS SDK for JavaScript |
| Authentication | Better Auth |
| Validation | Zod |
| File Access | Short-lived presigned URLs |

### Storage configuration

The application uses a private Backblaze B2 bucket.

The configured storage setup uses:

- Bucket: `orchestr-files`
- Region: `eu-central-003`
- Endpoint: `https://s3.eu-central-003.backblazeb2.com`
- Bucket visibility: Private
- Encryption: Backblaze-managed encryption
- Object Lock: Disabled

The application must not make the bucket publicly accessible.

## 4. Architecture

The file management architecture separates application authorization from object storage.

### Upload workflow

1. A Member selects files from a task.
2. The application validates the user's permissions.
3. The server validates file type, size, and filename.
4. The server generates a short-lived presigned upload URL.
5. The browser uploads the file directly to Backblaze B2.
6. The client confirms the upload with the application.
7. The server verifies the uploaded object using storage metadata.
8. The file record is stored in MongoDB.
9. The file can be associated with a deliverable submission.

### Download workflow

1. An authorized user requests a file.
2. The server validates organization membership and file access permissions.
3. The server generates a short-lived presigned download URL.
4. The browser retrieves the file from private storage.

### Important architectural principle

The application server manages authorization and file metadata. The browser communicates directly with object storage for file transfer using temporary presigned URLs.

Storage credentials must never be exposed to the browser.

## 5. Supported File Types and Limits

| File type | Maximum size |
|---|---:|
| JPG / JPEG | 25 MB |
| PNG | 25 MB |
| WebP | 25 MB |
| PDF | 50 MB |
| Office documents | 50 MB |
| ZIP | 100 MB |
| TAR.GZ / TGZ / GZ | 100 MB |
| MP4 | 250 MB |
| WebM | 250 MB |
| MOV | 250 MB |

Additional restrictions:

- Maximum 10 files per deliverable.
- Maximum combined deliverable size: 500 MB.
- SVG files are excluded.
- File names are sanitized before storage.
- File type and size allowlists are enforced server-side.

## 6. Implemented Features

### 6.1 Storage infrastructure

- Server-only Backblaze B2 storage client.
- AWS S3-compatible SDK integration.
- Explicit production storage configuration.
- Private bucket access.
- Presigned upload and download URLs.
- Storage metadata verification.
- File storage abstraction in `lib/storage.ts`.

### 6.2 Secure file management

The file management implementation includes:

- File type validation.
- File size validation.
- Filename sanitization.
- Presigned upload URL generation.
- Upload confirmation.
- Object existence verification.
- File listing.
- Authorized downloads.
- File deletion.
- Safe file metadata DTOs.
- Organization-level access enforcement.

### 6.3 Member upload interface

The task interface supports:

- File picker.
- Drag-and-drop uploads.
- Upload progress indicators.
- Upload retries.
- Upload confirmation.
- Staging files before deliverable submission.
- Multiple file uploads.

### 6.4 Manager and Admin review interface

Authorized reviewers can:

- View submitted files.
- Preview supported image files.
- Preview PDF documents.
- Preview supported video formats.
- Download submitted files.
- Review deliverables through the existing approval workflow.

### 6.5 Google Drive integration

Google Drive links can be included as deliverable references.

The implementation recognizes Drive links and supports submissions combining uploaded files and external links.

**Scope limitation:** This is link-based integration. Google OAuth and direct Google Drive API integration are not included.

### 6.6 Expired upload cleanup

The cleanup system handles expired and unattached pending uploads.

It includes:

- Expiration checks.
- Cleanup leases.
- Random lease tokens.
- Concurrent worker protection.
- Bounded retry attempts.
- Idempotent handling of already-missing remote objects.

### 6.7 Retryable deletion lifecycle

A deletion lifecycle repair introduced the `deletion_pending` state.

When a remote deletion fails or storage configuration is unavailable:

- The database retains the file's storage metadata.
- The file is marked `deletion_pending`.
- The object is not incorrectly treated as deleted.
- Cleanup can retry the remote deletion.
- Storage metadata is cleared only after confirmed deletion.
- Missing remote objects are treated as successful deletion when appropriate.

This prevents orphaned remote files caused by prematurely marking failed deletions as complete.

## 7. API Endpoints

The implementation includes the following file-management API operations:

| Operation | Endpoint |
|---|---|
| Generate upload URL | `/api/organizations/[slug]/files/upload-url` |
| Confirm upload | `/api/organizations/[slug]/files/confirm` |
| List files | `/api/organizations/[slug]/files` |
| Download file | `/api/organizations/[slug]/files/[fileId]/download` |
| Delete file | `/api/organizations/[slug]/files/[fileId]` |

Deliverable submission APIs support associating uploaded file IDs with submissions.

Exact HTTP methods and request schemas should be checked against the current route implementations.

## 8. Database and File Lifecycle

File metadata is stored in MongoDB. The actual file contents remain in Backblaze B2.

The implementation uses file records and indexes to support:

- Organization-scoped file access.
- Pending upload tracking.
- File association with deliverables.
- Expired upload cleanup.
- Retryable deletion.
- Cleanup concurrency protection.

### File lifecycle states

| State | Meaning |
|---|---|
| Pending | Upload initiated but not yet confirmed |
| Active | Upload confirmed and available for authorized use |
| Deletion pending | Remote deletion needs retry |
| Deleted | Remote deletion confirmed |

The database retains the metadata required to retry failed remote deletion operations.

## 9. Security

Security requirements for Phase 8.5 include:

1. Backblaze B2 bucket remains private.
2. Storage credentials remain server-side.
3. Presigned URLs are short-lived.
4. Organization membership is checked before file access.
5. Unauthorized users cannot retrieve protected files.
6. File types and sizes are validated on the server.
7. Filenames are sanitized.
8. File metadata responses exclude sensitive storage credentials.
9. Cleanup operations use leases and concurrency protection.
10. Failed deletions retain the information needed for retries.

### Environment variables

Configure the following variables in the local environment:

```env
B2_KEY_ID=
B2_APPLICATION_KEY=
B2_ENDPOINT=
B2_BUCKET_NAME=
B2_REGION=
```

Supported fallback aliases:

```env
B2_APPLICATION_KEY_ID=
B2_APPLICATION_KEY_SECRET=
```

Use the canonical variable names wherever possible.

**Important:**
- Never commit `.env.local`.
- Never commit real storage credentials.
- Keep `.env.example` limited to placeholders.
- Never change the bucket to public access.
- Production must use explicit bucket, region, and endpoint configuration.
- Do not share credentials in chat, screenshots, or logs.

## 10. CORS Configuration

The private Backblaze B2 bucket requires suitable CORS configuration for browser-based transfers.

The configured policy should:

- Allow only the required application origins.
- Support `PUT`, `GET`, and `HEAD`.
- Expose the `ETag` response header.
- Avoid wildcard origins in production.
- Preserve private bucket visibility.

Local development and production origins must be configured separately where necessary.

## 11. Testing and Verification

The implementation has undergone independent code-level verification.

| Component | Reported result |
|---|---|
| Storage infrastructure | PASS |
| Secure file APIs | PASS |
| Member upload interface | PASS |
| Manager/Admin review interface | PASS |
| Google Drive link handling | PASS |
| Pending upload cleanup | PASS |
| Retryable deletion lifecycle | PASS |
| TypeScript checks | PASS |
| Lint checks | PASS, with a previously reported pre-existing image warning |
| Production build | PASS |

Independent verification also covered deletion concurrency, retry limits, lease-token protection, legacy file records, authorization, and metadata preservation.

### Outstanding live integration verification

**Real Backblaze B2 upload and download testing remains pending.**

Code-level tests do not prove that the deployed or local environment can successfully communicate with the actual B2 bucket.

The following still require live verification:

- Correct credentials and environment configuration.
- Browser upload through the actual B2 CORS policy.
- Upload confirmation against the real object.
- Authorized download and preview.
- Actual remote deletion.
- Retry behavior after a real storage failure.

## 12. Known Scope Limitations

Phase 8.5 does not include:

- Google OAuth.
- Direct Google Drive API integration.
- Public file sharing.
- A public storage bucket.
- Advanced media editing.
- Video transcoding.
- Image processing pipelines.
- Antivirus scanning.
- Enterprise document management.
- A dedicated background worker infrastructure.

These may be considered separately if real usage demonstrates a need.

## 13. Relationship With the Core Orchestr Workflow

Phase 8.5 extends the existing task and deliverable workflow.

The intended operational process is:

1. Manager creates a project.
2. Manager assigns tasks to Members.
3. Members complete assigned work.
4. Members upload files or provide Google Drive links.
5. Members submit their deliverables.
6. Managers or Admins preview and review submitted work.
7. Reviewers approve or request changes.
8. Task completion follows the existing deliverable approval rules.

This keeps files connected to the work they represent rather than treating file storage as a separate system.

## 14. Completion Summary

Phase 8.5 establishes the foundation for secure file handling in Orchestr.

The implemented capabilities cover storage infrastructure, secure upload and download APIs, Member upload UI, Manager/Admin review UI, Google Drive link recognition, pending upload cleanup, and retryable file deletion.

**Implementation status:** Complete according to the reported independent code-verification results.

**Remaining work:** Live Backblaze B2 integration verification and any production-specific configuration checks.

---

*Document: Orchestr Phase 8.5 README*  
*Purpose: Technical documentation and project handover*  
*Status reflects reported implementation and verification results, not an independently inspected live deployment.*