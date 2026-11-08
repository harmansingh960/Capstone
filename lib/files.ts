import "server-only";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ObjectId } from "mongodb";
import { getCollections } from "@/lib/collections";
import {
  type FileDoc,
  type FileStatus,
  type FileAttachmentType,
  type FileStorageProvider,
} from "@/lib/schema";
import {
  requireMembership,
  requireProjectInOrg,
  requireTaskInProjectAndOrg,
  isManagerRole,
  TenantAccessError,
  TenantValidationError,
  buildActivityDoc,
} from "@/lib/tenancy";
import {
  getStorageClient,
  getStorageBucketName,
  isStorageConfigured,
  StorageConfigurationError,
} from "@/lib/storage";

export { StorageConfigurationError, isStorageConfigured } from "@/lib/storage";

const MB = 1024 * 1024;

export type AllowedFileTypeCategory =
  | "image"
  | "pdf"
  | "office"
  | "archive"
  | "video";

export interface AllowedFileTypeRule {
  mimeType: string;
  extensions: readonly string[];
  category: AllowedFileTypeCategory;
  maxSizeBytes: number;
}

export const ALLOWED_FILE_RULES: readonly AllowedFileTypeRule[] = [
  // Images (Max 25 MB)
  {
    mimeType: "image/jpeg",
    extensions: [".jpg", ".jpeg"],
    category: "image",
    maxSizeBytes: 25 * MB,
  },
  {
    mimeType: "image/png",
    extensions: [".png"],
    category: "image",
    maxSizeBytes: 25 * MB,
  },
  {
    mimeType: "image/webp",
    extensions: [".webp"],
    category: "image",
    maxSizeBytes: 25 * MB,
  },

  // PDF (Max 50 MB)
  {
    mimeType: "application/pdf",
    extensions: [".pdf"],
    category: "pdf",
    maxSizeBytes: 50 * MB,
  },

  // Office Documents (Max 50 MB)
  {
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
    category: "office",
    maxSizeBytes: 50 * MB,
  },
  {
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: [".xlsx"],
    category: "office",
    maxSizeBytes: 50 * MB,
  },
  {
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extensions: [".pptx"],
    category: "office",
    maxSizeBytes: 50 * MB,
  },

  // Archives (Max 100 MB)
  {
    mimeType: "application/zip",
    extensions: [".zip"],
    category: "archive",
    maxSizeBytes: 100 * MB,
  },
  {
    mimeType: "application/x-zip-compressed",
    extensions: [".zip"],
    category: "archive",
    maxSizeBytes: 100 * MB,
  },
  {
    mimeType: "application/gzip",
    extensions: [".tar.gz", ".tgz", ".gz"],
    category: "archive",
    maxSizeBytes: 100 * MB,
  },
  {
    mimeType: "application/x-gzip",
    extensions: [".tar.gz", ".tgz", ".gz"],
    category: "archive",
    maxSizeBytes: 100 * MB,
  },

  // Videos (Max 250 MB)
  {
    mimeType: "video/mp4",
    extensions: [".mp4"],
    category: "video",
    maxSizeBytes: 250 * MB,
  },
  {
    mimeType: "video/webm",
    extensions: [".webm"],
    category: "video",
    maxSizeBytes: 250 * MB,
  },
  {
    mimeType: "video/quicktime",
    extensions: [".mov"],
    category: "video",
    maxSizeBytes: 250 * MB,
  },
] as const;

export const INLINE_ALLOWED_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "video/mp4",
  "video/webm",
]);

export type FileDto = {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  deliverableId: string | null;
  attachmentType: FileAttachmentType;
  storageProvider: FileStorageProvider | null;
  originalFilename: string;
  sanitizedFilename: string;
  mimeType: string;
  fileSize: number;
  uploadedBy: string;
  status: FileStatus;
  externalUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toFileDto(file: FileDoc): FileDto {
  return {
    id: file._id.toHexString(),
    organizationId: file.organizationId.toHexString(),
    projectId: file.projectId.toHexString(),
    taskId: file.taskId.toHexString(),
    deliverableId: file.deliverableId ? file.deliverableId.toHexString() : null,
    attachmentType: file.attachmentType,
    storageProvider: file.storageProvider ?? null,
    originalFilename: file.originalFilename,
    sanitizedFilename: file.sanitizedFilename,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    uploadedBy: file.uploadedBy,
    status: file.status,
    externalUrl: file.externalUrl ?? null,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

export function sanitizeFilename(rawFilename: string): string {
  const trimmed = rawFilename.trim();
  if (!trimmed) {
    throw new TenantValidationError("Filename cannot be empty.");
  }
  const basename = trimmed.split(/[/\\]/).pop() || "file";
  const sanitized = basename
    .replace(/[\x00-\x1f\x7f-\x9f"\\/]/g, "_")
    .trim();
  if (!sanitized) {
    throw new TenantValidationError("Invalid filename.");
  }
  return sanitized.length > 255 ? sanitized.slice(0, 255) : sanitized;
}

export interface FileValidationResult {
  originalFilename: string;
  sanitizedFilename: string;
  safeExtension: string;
  mimeType: string;
  fileSize: number;
  category: AllowedFileTypeCategory;
}

export function validateFileForUpload(
  filename: string,
  mimeType: string,
  fileSize: number,
): FileValidationResult {
  const sanitized = sanitizeFilename(filename);

  if (
    typeof fileSize !== "number" ||
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0
  ) {
    throw new TenantValidationError(
      "File size must be a positive integer in bytes. Empty files cannot be uploaded.",
    );
  }

  const normalizedMime = mimeType.trim().toLowerCase();
  const lowerName = sanitized.toLowerCase();

  const matchedRule = ALLOWED_FILE_RULES.find((rule) => {
    if (rule.mimeType !== normalizedMime) return false;
    return rule.extensions.some((ext) => lowerName.endsWith(ext));
  });

  if (!matchedRule) {
    throw new TenantValidationError(
      `Unsupported file type or extension mismatch. File "${sanitized}" with MIME type "${normalizedMime}" is not permitted. Approved categories: images (JPG, PNG, WebP), PDFs, office documents (DOCX, XLSX, PPTX), archives (ZIP, TAR.GZ), and videos (MP4, WebM, MOV).`,
    );
  }

  if (fileSize > matchedRule.maxSizeBytes) {
    const maxMb = matchedRule.maxSizeBytes / MB;
    throw new TenantValidationError(
      `File "${sanitized}" (${(fileSize / MB).toFixed(1)} MB) exceeds the maximum allowed limit of ${maxMb} MB for ${matchedRule.category} files.`,
    );
  }

  const matchedExt =
    matchedRule.extensions.find((ext) => lowerName.endsWith(ext)) ||
    matchedRule.extensions[0];

  return {
    originalFilename: sanitized,
    sanitizedFilename: sanitized,
    safeExtension: matchedExt.replace(/^\./, ""),
    mimeType: matchedRule.mimeType,
    fileSize,
    category: matchedRule.category,
  };
}

export type AuthorizeUploadInput = {
  filename: string;
  mimeType: string;
  fileSize: number;
};

export type AuthorizeUploadResult = {
  fileId: string;
  uploadUrl: string;
  expiresIn: number;
  filename: string;
  mimeType: string;
  fileSize: number;
};

export async function authorizeFileUpload(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  input: AuthorizeUploadInput,
  requestHeaders?: Headers,
): Promise<AuthorizeUploadResult> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);
  if (project.status === "archived") {
    throw new TenantValidationError(
      "Cannot upload files in an archived project.",
    );
  }

  const task = await requireTaskInProjectAndOrg(
    membership,
    project._id,
    taskId,
  );

  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only upload files to tasks assigned to them.",
    );
  }

  if (task.status === "done") {
    throw new TenantValidationError(
      "Cannot upload files to a completed task. Reopen the task first.",
    );
  }

  const validated = validateFileForUpload(
    input.filename,
    input.mimeType,
    input.fileSize,
  );

  if (!isStorageConfigured()) {
    throw new StorageConfigurationError(
      "File storage service is not configured. Uploads are unavailable.",
    );
  }

  const fileId = new ObjectId();
  const randomUuid = crypto.randomUUID();
  const storageKey = `orgs/${membership.organizationId.toHexString()}/tasks/${task._id.toHexString()}/${fileId.toHexString()}/${randomUuid}.${validated.safeExtension}`;
  let bucketName: string;
  let s3Client: S3Client;
  try {
    bucketName = getStorageBucketName();
    s3Client = getStorageClient();
  } catch (error) {
    if (error instanceof StorageConfigurationError) {
      throw error;
    }
    throw new StorageConfigurationError(
      "File storage service configuration could not be loaded.",
    );
  }
  const expiresIn = 900; // 15 minutes

  const putCommand = new PutObjectCommand({
    Bucket: bucketName,
    Key: storageKey,
    ContentType: validated.mimeType,
  });

  const uploadUrl = await getSignedUrl(s3Client, putCommand, { expiresIn });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);

  // Enforces SCH-B2-01: attachmentType upload has storageProvider, bucketName, storageKey, externalUrl: null
  const fileDoc: FileDoc = {
    _id: fileId,
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
    deliverableId: null,
    attachmentType: "upload",
    storageProvider: "backblaze_b2",
    bucketName,
    storageKey,
    externalUrl: null,
    originalFilename: validated.originalFilename,
    sanitizedFilename: validated.sanitizedFilename,
    mimeType: validated.mimeType,
    fileSize: validated.fileSize,
    checksum: null,
    uploadedBy: membership.userId,
    status: "pending",
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };

  const { files: filesColl } = await getCollections();
  await filesColl.insertOne(fileDoc);

  return {
    fileId: fileId.toHexString(),
    uploadUrl,
    expiresIn,
    filename: validated.sanitizedFilename,
    mimeType: validated.mimeType,
    fileSize: validated.fileSize,
  };
}

export async function confirmFileUpload(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  fileId: ObjectId,
  requestHeaders?: Headers,
): Promise<FileDto> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);
  const task = await requireTaskInProjectAndOrg(
    membership,
    project._id,
    taskId,
  );

  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only confirm uploads for tasks assigned to them.",
    );
  }

  const { files: filesColl, activities: activitiesColl } =
    await getCollections();

  const file = await filesColl.findOne({
    _id: fileId,
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
  });

  if (!file) {
    throw new TenantValidationError("File record not found.");
  }

  if (
    !isManagerRole(membership.role) &&
    file.uploadedBy !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only confirm uploads initiated by themselves.",
    );
  }

  // Idempotent: if already confirmed/uploaded, return immediately without duplicate activity
  if (file.status === "uploaded" || file.status === "attached") {
    return toFileDto(file);
  }

  if (file.status !== "pending") {
    throw new TenantValidationError(
      `File cannot be confirmed because it has status "${file.status}".`,
    );
  }

  if (file.attachmentType !== "upload" || !file.storageKey) {
    throw new TenantValidationError(
      "Only storage upload attachments can be confirmed via storage verification.",
    );
  }

  if (!isStorageConfigured()) {
    throw new StorageConfigurationError(
      "File storage service is not configured. File confirmation is unavailable.",
    );
  }

  // Verify object existence in Backblaze B2 using HeadObjectCommand
  let s3Client: S3Client;
  let bucketName: string;
  try {
    s3Client = getStorageClient();
    bucketName = file.bucketName || getStorageBucketName();
  } catch (error) {
    if (error instanceof StorageConfigurationError) {
      throw error;
    }
    throw new StorageConfigurationError(
      "File storage service configuration could not be loaded.",
    );
  }
  let headResult;
  try {
    const headCommand = new HeadObjectCommand({
      Bucket: bucketName,
      Key: file.storageKey,
    });
    headResult = await s3Client.send(headCommand);
  } catch (err: unknown) {
    const errObj = err as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    if (
      errObj.name === "NotFound" ||
      errObj.$metadata?.httpStatusCode === 404
    ) {
      throw new TenantValidationError(
        "Uploaded object was not found in storage. Ensure browser upload has completed before confirming.",
      );
    }
    throw new Error(
      `Storage verification failed: ${err instanceof Error ? err.message : "Unknown storage error"}`,
    );
  }

  const actualSize = headResult.ContentLength;
  if (
    typeof actualSize !== "number" ||
    !Number.isSafeInteger(actualSize) ||
    actualSize <= 0
  ) {
    throw new TenantValidationError(
      "Uploaded storage object is empty or has invalid size.",
    );
  }

  // Look up matched rule using server-side metadata stored during upload authorization
  const normalizedMime = file.mimeType.trim().toLowerCase();
  const lowerName = file.sanitizedFilename.toLowerCase();
  const matchedRule = ALLOWED_FILE_RULES.find((rule) => {
    if (rule.mimeType !== normalizedMime) return false;
    return rule.extensions.some((ext) => lowerName.endsWith(ext));
  });

  if (!matchedRule) {
    throw new TenantValidationError(
      `File "${file.sanitizedFilename}" does not match any permitted file rule.`,
    );
  }

  // Enforce category maximum size limit on the actual stored object length
  if (actualSize > matchedRule.maxSizeBytes) {
    try {
      const deleteCommand = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: file.storageKey,
      });
      await s3Client.send(deleteCommand);
    } catch {
      // Best-effort cleanup
    }

    const maxMb = matchedRule.maxSizeBytes / MB;
    throw new TenantValidationError(
      `Uploaded object for "${file.originalFilename}" (${(actualSize / MB).toFixed(1)} MB) exceeds the maximum allowed limit of ${maxMb} MB for ${matchedRule.category} files.`,
    );
  }

  // Verify actual size is consistent with declared pending file size (tolerance of 5% or 1 KB)
  const sizeDiff = Math.abs(actualSize - file.fileSize);
  const maxAllowedVariance = Math.max(1024, Math.floor(file.fileSize * 0.05));
  if (sizeDiff > maxAllowedVariance) {
    try {
      const deleteCommand = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: file.storageKey,
      });
      await s3Client.send(deleteCommand);
    } catch {
      // Best-effort cleanup
    }

    throw new TenantValidationError(
      `Uploaded object size (${actualSize} bytes) does not match the authorized file size (${file.fileSize} bytes).`,
    );
  }

  const now = new Date();
  const checksum = headResult.ETag ? headResult.ETag.replace(/"/g, "") : null;

  await filesColl.updateOne(
    { _id: file._id, status: "pending" },
    {
      $set: {
        status: "uploaded",
        fileSize: actualSize,
        checksum,
        updatedAt: now,
      },
      $unset: {
        expiresAt: "",
      },
    },
  );

  const updatedDoc = (await filesColl.findOne({ _id: file._id }))!;

  // Record operational activity history
  const activityDoc = buildActivityDoc({
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
    actorId: membership.userId,
    eventType: "file.uploaded",
    targetType: "file",
    targetId: file._id,
    summary: `Uploaded file "${file.originalFilename}" (${(actualSize / (1024 * 1024)).toFixed(1)} MB) for "${task.title}"`,
    metadata: {
      fileId: file._id.toHexString(),
      filename: file.sanitizedFilename,
      fileSize: actualSize,
      mimeType: file.mimeType,
      taskTitle: task.title,
    },
    createdAt: now,
  });

  await activitiesColl.insertOne(activityDoc);

  return toFileDto(updatedDoc);
}

export async function listTaskFiles(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  options?: { status?: FileStatus | FileStatus[] },
  requestHeaders?: Headers,
): Promise<FileDto[]> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);
  const task = await requireTaskInProjectAndOrg(
    membership,
    project._id,
    taskId,
  );

  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only view files for tasks assigned to them.",
    );
  }

  const { files: filesColl } = await getCollections();

  const query: Record<string, unknown> = {
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
  };

  if (options?.status) {
    if (Array.isArray(options.status)) {
      query.status = { $in: options.status };
    } else {
      query.status = options.status;
    }
  } else {
    // Default: exclude deleted and deletion-pending files
    query.status = { $nin: ["deleted", "deletion_pending"] };
  }

  const docs = await filesColl.find(query).sort({ createdAt: -1 }).toArray();

  return docs.map(toFileDto);
}

export interface GetDownloadUrlResult {
  downloadUrl: string;
  filename: string;
  mimeType: string;
  disposition: "inline" | "attachment";
  expiresIn: number;
}

export async function getDownloadUrl(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  fileId: ObjectId,
  requestedDisposition?: string | null,
  requestHeaders?: Headers,
): Promise<GetDownloadUrlResult> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);
  const task = await requireTaskInProjectAndOrg(
    membership,
    project._id,
    taskId,
  );

  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only download files for tasks assigned to them.",
    );
  }

  const { files: filesColl } = await getCollections();

  const file = await filesColl.findOne({
    _id: fileId,
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
  });

  if (!file) {
    throw new TenantValidationError("File not found.");
  }

  if (file.status === "deleted" || file.status === "deletion_pending") {
    throw new TenantValidationError("Cannot download a deleted file.");
  }

  if (file.status === "failed") {
    throw new TenantValidationError("Cannot download a failed upload.");
  }

  if (file.status === "pending") {
    throw new TenantValidationError(
      "File upload is pending and has not been confirmed.",
    );
  }

  if (file.attachmentType === "google_drive") {
    if (!file.externalUrl) {
      throw new TenantValidationError(
        "Google Drive attachment is missing external URL.",
      );
    }
    return {
      downloadUrl: file.externalUrl,
      filename: file.originalFilename,
      mimeType: file.mimeType,
      disposition: "inline",
      expiresIn: 0,
    };
  }

  if (!file.storageKey) {
    throw new TenantValidationError("File storage key is missing.");
  }

  if (!isStorageConfigured()) {
    throw new StorageConfigurationError(
      "File storage service is not configured. File download is unavailable.",
    );
  }

  const disposition: "inline" | "attachment" =
    requestedDisposition?.toLowerCase() === "inline" &&
    INLINE_ALLOWED_MIMES.has(file.mimeType)
      ? "inline"
      : "attachment";

  const safeFilename = file.sanitizedFilename.replace(/["\r\n\\]/g, "_");
  let bucketName: string;
  let s3Client: S3Client;
  try {
    bucketName = file.bucketName || getStorageBucketName();
    s3Client = getStorageClient();
  } catch (error) {
    if (error instanceof StorageConfigurationError) {
      throw error;
    }
    throw new StorageConfigurationError(
      "File storage service configuration could not be loaded.",
    );
  }
  const expiresIn = 900; // 15 minutes
  const getCommand = new GetObjectCommand({
    Bucket: bucketName,
    Key: file.storageKey,
    ResponseContentDisposition: `${disposition}; filename="${safeFilename}"`,
    ResponseContentType: file.mimeType,
  });

  const downloadUrl = await getSignedUrl(s3Client, getCommand, { expiresIn });

  return {
    downloadUrl,
    filename: file.originalFilename,
    mimeType: file.mimeType,
    disposition,
    expiresIn,
  };
}

export const MAX_CLEANUP_ATTEMPTS = 10;

function sanitizeStorageErrorMessage(error: unknown): string {
  if (!error) return "Unknown storage error.";
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(
      /(?:key|secret|token|password|auth|credential)[\w-]*\s*[:=]\s*[^\s,;]+/gi,
      "<redacted>",
    )
    .replace(/https?:\/\/[^\s/$.?#].[^\s]*/gi, "<redacted-url>")
    .slice(0, 500);
}

export interface DeleteTaskFileResult {
  success: boolean;
  remoteStatus: "deleted" | "pending";
}

export async function deleteTaskFile(
  organizationId: ObjectId,
  projectId: ObjectId,
  taskId: ObjectId,
  fileId: ObjectId,
  requestHeaders?: Headers,
): Promise<DeleteTaskFileResult> {
  const membership = await requireMembership(
    organizationId,
    undefined,
    requestHeaders,
  );
  const project = await requireProjectInOrg(membership, projectId);
  if (project.status === "archived") {
    throw new TenantValidationError(
      "Cannot delete files in an archived project.",
    );
  }

  const task = await requireTaskInProjectAndOrg(
    membership,
    project._id,
    taskId,
  );

  if (
    !isManagerRole(membership.role) &&
    task.assigneeId !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only delete files for tasks assigned to them.",
    );
  }

  const { files: filesColl, activities: activitiesColl } =
    await getCollections();

  const file = await filesColl.findOne({
    _id: fileId,
    organizationId: membership.organizationId,
    projectId: project._id,
    taskId: task._id,
  });

  if (!file) {
    throw new TenantValidationError("File not found.");
  }

  if (
    !isManagerRole(membership.role) &&
    file.uploadedBy !== membership.userId
  ) {
    throw new TenantAccessError(
      "Members can only delete files uploaded by themselves.",
    );
  }

  if (file.status === "attached") {
    throw new TenantValidationError(
      "Cannot delete a file that is attached to a submitted deliverable. Historical deliverable attachments are preserved.",
    );
  }

  if (file.status === "deleted") {
    return { success: true, remoteStatus: "deleted" };
  }
  if (file.status === "deletion_pending") {
    return { success: true, remoteStatus: "pending" };
  }

  const now = new Date();
  const rawStorageKey = file.storageKey;
  const isUploadType = file.attachmentType === "upload";
  const hasRemoteKey =
    typeof rawStorageKey === "string" && rawStorageKey.trim() !== "";

  if (!isUploadType || !hasRemoteKey) {
    // External link or no B2 storage key: immediate safe logical deletion
    await filesColl.updateOne(
      { _id: file._id },
      {
        $set: {
          status: "deleted",
          storageKey: null,
          updatedAt: now,
        },
        $unset: {
          expiresAt: "",
          cleanupLockedUntil: "",
          cleanupLeaseToken: "",
          cleanupError: "",
        },
      },
    );

    const activityDoc = buildActivityDoc({
      organizationId: membership.organizationId,
      projectId: project._id,
      taskId: task._id,
      actorId: membership.userId,
      eventType: "file.deleted",
      targetType: "file",
      targetId: file._id,
      summary: `Deleted staged file "${file.originalFilename}" from "${task.title}"`,
      metadata: {
        fileId: file._id.toHexString(),
        filename: file.sanitizedFilename,
        taskTitle: task.title,
        remoteStatus: "deleted",
      },
      createdAt: now,
    });

    await activitiesColl.insertOne(activityDoc);

    return { success: true, remoteStatus: "deleted" };
  }

  // Explicitly narrowed storage key
  const validatedStorageKey: string = rawStorageKey.trim();

  if (!isStorageConfigured()) {
    // Storage credentials missing: do not pretend deleted, preserve metadata and storageKey, queue for retry
    await filesColl.updateOne(
      { _id: file._id },
      {
        $set: {
          status: "deletion_pending",
          cleanupAttempts: 0,
          cleanupError:
            "Storage credentials unavailable; remote B2 deletion is pending.",
          updatedAt: now,
        },
        $unset: {
          expiresAt: "",
          cleanupLockedUntil: "",
          cleanupLeaseToken: "",
        },
      },
    );

    const activityDoc = buildActivityDoc({
      organizationId: membership.organizationId,
      projectId: project._id,
      taskId: task._id,
      actorId: membership.userId,
      eventType: "file.deleted",
      targetType: "file",
      targetId: file._id,
      summary: `Queued deletion for staged file "${file.originalFilename}" from "${task.title}"`,
      metadata: {
        fileId: file._id.toHexString(),
        filename: file.sanitizedFilename,
        taskTitle: task.title,
        remoteStatus: "pending",
      },
      createdAt: now,
    });

    await activitiesColl.insertOne(activityDoc);

    return { success: true, remoteStatus: "pending" };
  }

  // Bucket identity safety check: never delete from an assumed bucket
  const rawBucketName = file.bucketName;
  const hasExplicitBucket =
    typeof rawBucketName === "string" && rawBucketName.trim() !== "";

  if (!hasExplicitBucket) {
    // Missing bucket metadata: preserve storageKey and record administrator-inspectable error
    await filesColl.updateOne(
      { _id: file._id },
      {
        $set: {
          status: "deletion_pending",
          cleanupAttempts: 1,
          cleanupError:
            "Missing bucket metadata; remote deletion halted to prevent cross-bucket deletion.",
          updatedAt: now,
        },
        $unset: {
          expiresAt: "",
          cleanupLockedUntil: "",
          cleanupLeaseToken: "",
        },
      },
    );

    const activityDoc = buildActivityDoc({
      organizationId: membership.organizationId,
      projectId: project._id,
      taskId: task._id,
      actorId: membership.userId,
      eventType: "file.deleted",
      targetType: "file",
      targetId: file._id,
      summary: `Queued deletion for staged file "${file.originalFilename}" from "${task.title}"`,
      metadata: {
        fileId: file._id.toHexString(),
        filename: file.sanitizedFilename,
        taskTitle: task.title,
        remoteStatus: "pending",
      },
      createdAt: now,
    });

    await activitiesColl.insertOne(activityDoc);

    return { success: true, remoteStatus: "pending" };
  }

  const validatedBucketName: string = rawBucketName.trim();

  // Storage is configured and bucket identity is confirmed: attempt remote B2 deletion
  let s3Deleted = false;
  let s3Error: unknown = null;

  try {
    const s3Client = getStorageClient();
    const deleteCommand = new DeleteObjectCommand({
      Bucket: validatedBucketName,
      Key: validatedStorageKey,
    });
    await s3Client.send(deleteCommand);
    s3Deleted = true;
  } catch (err: unknown) {
    const errObj = err as {
      name?: string;
      Code?: string;
      $metadata?: { httpStatusCode?: number };
    };
    if (
      errObj.name === "NotFound" ||
      errObj.name === "NoSuchKey" ||
      errObj.Code === "NoSuchKey" ||
      errObj.$metadata?.httpStatusCode === 404
    ) {
      // Treat an already-missing B2 object as successful deletion
      s3Deleted = true;
    } else {
      s3Deleted = false;
      s3Error = err;
    }
  }

  if (s3Deleted) {
    // Remote deletion confirmed: clear storageKey and mark deleted
    await filesColl.updateOne(
      { _id: file._id },
      {
        $set: {
          status: "deleted",
          storageKey: null,
          updatedAt: now,
        },
        $unset: {
          expiresAt: "",
          cleanupLockedUntil: "",
          cleanupLeaseToken: "",
          cleanupError: "",
        },
      },
    );

    const activityDoc = buildActivityDoc({
      organizationId: membership.organizationId,
      projectId: project._id,
      taskId: task._id,
      actorId: membership.userId,
      eventType: "file.deleted",
      targetType: "file",
      targetId: file._id,
      summary: `Deleted staged file "${file.originalFilename}" from "${task.title}"`,
      metadata: {
        fileId: file._id.toHexString(),
        filename: file.sanitizedFilename,
        taskTitle: task.title,
        remoteStatus: "deleted",
      },
      createdAt: now,
    });

    await activitiesColl.insertOne(activityDoc);

    return { success: true, remoteStatus: "deleted" };
  } else {
    // Remote deletion failed: preserve metadata, record deletion_pending and sanitized error
    const sanitizedErr = sanitizeStorageErrorMessage(s3Error);
    await filesColl.updateOne(
      { _id: file._id },
      {
        $set: {
          status: "deletion_pending",
          cleanupAttempts: (file.cleanupAttempts || 0) + 1,
          cleanupError: sanitizedErr,
          updatedAt: now,
        },
        $unset: {
          expiresAt: "",
          cleanupLockedUntil: "",
          cleanupLeaseToken: "",
        },
      },
    );

    const activityDoc = buildActivityDoc({
      organizationId: membership.organizationId,
      projectId: project._id,
      taskId: task._id,
      actorId: membership.userId,
      eventType: "file.deleted",
      targetType: "file",
      targetId: file._id,
      summary: `Queued deletion for staged file "${file.originalFilename}" from "${task.title}"`,
      metadata: {
        fileId: file._id.toHexString(),
        filename: file.sanitizedFilename,
        taskTitle: task.title,
        remoteStatus: "pending",
      },
      createdAt: now,
    });

    await activitiesColl.insertOne(activityDoc);

    return { success: true, remoteStatus: "pending" };
  }
}

export type CleanupExpiredPendingResult = {
  cleanedCount: number;
  deletedS3Count: number;
  retryableErrorCount: number;
  errors: string[];
};

export type CleanupExpiredPendingOptions = {
  isCronAuthorized?: boolean;
  batchSize?: number;
};

/**
 * Server-side maintenance function to clean up abandoned expired pending upload
 * records and safely delete any corresponding orphaned Backblaze B2 S3 storage objects,
 * as well as retrying pending remote deletions for logically deleted files.
 *
 * Explicit eligibility requirements:
 * 1. File status is "pending" (with expiresAt <= now and not attached to a deliverable)
 *    OR "deletion_pending" (with cleanupAttempts < MAX_CLEANUP_ATTEMPTS).
 * 2. Concurrency protection: Atomically acquires a 5-minute lease (cleanupLockedUntil)
 *    with a unique leaseToken to prevent concurrent maintenance runners from colliding.
 * 3. B2 S3 deletion is executed BEFORE the record status is updated to "deleted".
 * 4. Treats an already-missing B2 object (404 / NoSuchKey) as successful deletion.
 * 5. If S3 deletion fails with an unexpected error, metadata is preserved, storageKey is
 *    NOT cleared, cleanupError and cleanupAttempts are recorded, the lease is released,
 *    and the record remains in "deletion_pending" for subsequent retries.
 * 6. Storage metadata (storageKey) is cleared only after confirmed remote deletion.
 */
export async function cleanupExpiredPendingUploads(
  organizationId: ObjectId,
  requestHeaders?: Headers,
  options?: CleanupExpiredPendingOptions,
): Promise<CleanupExpiredPendingResult> {
  if (!options?.isCronAuthorized) {
    const membership = await requireMembership(
      organizationId,
      undefined,
      requestHeaders,
    );

    if (!isManagerRole(membership.role)) {
      throw new TenantAccessError(
        "Only organization admins and managers can run maintenance cleanup.",
      );
    }
  }

  const { files: filesColl } = await getCollections();
  const now = new Date();
  const batchSize = Math.min(Math.max(options?.batchSize ?? 50, 1), 200);

  // Find eligible candidate expired pending uploads or retryable deletion-pending files
  const candidates = await filesColl
    .find({
      organizationId,
      $or: [
        {
          status: "pending",
          expiresAt: { $lte: now },
          $or: [{ deliverableId: null }, { deliverableId: { $exists: false } }],
        },
        {
          status: "deletion_pending",
          $or: [
            { cleanupAttempts: { $lt: MAX_CLEANUP_ATTEMPTS } },
            { cleanupAttempts: { $exists: false } },
          ],
        },
      ],
      $and: [
        {
          $or: [
            { cleanupLockedUntil: null },
            { cleanupLockedUntil: { $exists: false } },
            { cleanupLockedUntil: { $lte: now } },
          ],
        },
      ],
    })
    .limit(batchSize)
    .toArray();

  let cleanedCount = 0;
  let deletedS3Count = 0;
  let retryableErrorCount = 0;
  const errors: string[] = [];

  let s3Client: S3Client | null = null;
  if (isStorageConfigured()) {
    try {
      s3Client = getStorageClient();
    } catch {
      s3Client = null;
    }
  }

  const lockDurationMs = 5 * 60 * 1000; // 5 minutes
  const lockedUntil = new Date(now.getTime() + lockDurationMs);

  for (const candidate of candidates) {
    const leaseToken = randomUUID();

    // Atomically acquire lock lease for this record
    const lockedFile = await filesColl.findOneAndUpdate(
      {
        _id: candidate._id,
        organizationId,
        status: candidate.status,
        $and: [
          {
            $or: [
              { cleanupLockedUntil: null },
              { cleanupLockedUntil: { $exists: false } },
              { cleanupLockedUntil: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: {
          cleanupLockedUntil: lockedUntil,
          cleanupLeaseToken: leaseToken,
          updatedAt: now,
        },
      },
      { returnDocument: "after" },
    );

    if (!lockedFile) {
      // Race: claimed by another worker or state changed
      continue;
    }

    try {
      let s3Deleted = false;
      let s3Failed = false;
      let s3ErrorMessage: string | null = null;

      // If the file has a storageKey in B2, attempt to remove the orphaned object first
      const rawStorageKey = lockedFile.storageKey;
      const isUploadType = lockedFile.attachmentType === "upload";
      const hasRemoteKey =
        typeof rawStorageKey === "string" && rawStorageKey.trim() !== "";

      if (isUploadType && hasRemoteKey) {
        const validatedStorageKey: string = rawStorageKey.trim();
        const rawBucketName = lockedFile.bucketName;
        const hasExplicitBucket =
          typeof rawBucketName === "string" && rawBucketName.trim() !== "";

        if (!s3Client) {
          s3Failed = true;
          s3ErrorMessage =
            "Storage client is unavailable; cannot clean B2 object.";
        } else if (!hasExplicitBucket) {
          s3Failed = true;
          s3ErrorMessage =
            "Missing bucket metadata; remote deletion skipped to protect storage integrity.";
        } else {
          const validatedBucketName: string = rawBucketName.trim();
          try {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: validatedBucketName,
              Key: validatedStorageKey,
            });
            await s3Client.send(deleteCommand);
            s3Deleted = true;
            deletedS3Count++;
          } catch (err: unknown) {
            const errObj = err as {
              name?: string;
              Code?: string;
              $metadata?: { httpStatusCode?: number };
            };
            if (
              errObj.name === "NotFound" ||
              errObj.name === "NoSuchKey" ||
              errObj.Code === "NoSuchKey" ||
              errObj.$metadata?.httpStatusCode === 404
            ) {
              // B2 object was never uploaded by browser or was already deleted
              s3Deleted = true;
              deletedS3Count++;
            } else {
              s3Failed = true;
              s3ErrorMessage = sanitizeStorageErrorMessage(err);
            }
          }
        }
      } else {
        // External link or no B2 storage key
        s3Deleted = true;
      }

      if (s3Failed) {
        // Preserve metadata, record failure, increment attempts, release lease for retry
        retryableErrorCount++;
        errors.push(
          `Failed to delete B2 object for file ${lockedFile._id.toHexString()}: ${s3ErrorMessage}`,
        );
        const nextAttempts = (lockedFile.cleanupAttempts || 0) + 1;
        const finalError =
          nextAttempts >= MAX_CLEANUP_ATTEMPTS
            ? `Max cleanup attempts (${MAX_CLEANUP_ATTEMPTS}) exceeded: ${s3ErrorMessage}`
            : s3ErrorMessage;

        // Only release lease and record error if this worker still holds the lease token
        await filesColl.updateOne(
          {
            _id: lockedFile._id,
            cleanupLeaseToken: leaseToken,
          },
          {
            $set: {
              cleanupError: finalError,
              cleanupAttempts: nextAttempts,
              updatedAt: new Date(),
            },
            $unset: {
              cleanupLockedUntil: "",
              cleanupLeaseToken: "",
            },
          },
        );
        continue;
      }

      if (s3Deleted) {
        // S3 object successfully deleted (or not present). Mark record as deleted and clear storageKey.
        try {
          const updateResult = await filesColl.updateOne(
            {
              _id: lockedFile._id,
              cleanupLeaseToken: leaseToken,
            },
            {
              $set: {
                status: "deleted",
                storageKey: null,
                updatedAt: new Date(),
              },
              $unset: {
                expiresAt: "",
                cleanupLockedUntil: "",
                cleanupLeaseToken: "",
                cleanupError: "",
              },
            },
          );
          if (updateResult.matchedCount > 0) {
            cleanedCount++;
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Database error";
          errors.push(
            `Failed to update status for file ${lockedFile._id.toHexString()}: ${message}`,
          );
        }
      }
    } catch (unexpectedErr: unknown) {
      const msg = sanitizeStorageErrorMessage(unexpectedErr);
      retryableErrorCount++;
      errors.push(`Error cleaning file ${lockedFile._id.toHexString()}: ${msg}`);
      try {
        await filesColl.updateOne(
          {
            _id: lockedFile._id,
            cleanupLeaseToken: leaseToken,
          },
          {
            $set: {
              cleanupError: msg,
              cleanupAttempts: (lockedFile.cleanupAttempts || 0) + 1,
              updatedAt: new Date(),
            },
            $unset: {
              cleanupLockedUntil: "",
              cleanupLeaseToken: "",
            },
          },
        );
      } catch {
        // Ignore secondary update error
      }
    }
  }

  return {
    cleanedCount,
    deletedS3Count,
    retryableErrorCount,
    errors,
  };
}

