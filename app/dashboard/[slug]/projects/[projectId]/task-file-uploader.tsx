"use client";

import React, { useState, useRef, useCallback } from "react";

export type FileSummary = {
  id: string;
  organizationId?: string;
  projectId?: string;
  taskId?: string;
  deliverableId?: string | null;
  uploadedBy?: string;
  originalFilename: string;
  sanitizedFilename?: string;
  mimeType: string;
  category?: string;
  fileSize: number;
  attachmentType?: "upload" | "google_drive";
  storageProvider?: string | null;
  externalUrl?: string | null;
  status?: "pending" | "uploaded" | "attached" | "deleted";
  createdAt: string;
  updatedAt?: string;
};

export type StagedUploadStatus =
  | "idle"
  | "authorizing"
  | "uploading"
  | "confirming"
  | "uploaded"
  | "removing"
  | "error";

export type StagedFile = {
  localId: string;
  file: File;
  name: string;
  size: number;
  mimeType: string;
  category: string;
  status: StagedUploadStatus;
  progress: number;
  error: string | null;
  fileId: string | null;
  confirmedFile: FileSummary | null;
  xhr?: XMLHttpRequest | null;
  removalError?: boolean;
};

export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MB = 1024 * 1024;

export const MAX_ATTACHMENTS_PER_DELIVERABLE = 10;
export const MAX_AGGREGATE_ATTACHMENTS_BYTES = 500 * MB;

interface AllowedClientRule {
  category: string;
  mimeType: string;
  extensions: readonly string[];
  maxSizeBytes: number;
}

export const CLIENT_ALLOWED_RULES: readonly AllowedClientRule[] = [
  // Images (Max 25 MB) - SVG explicitly excluded
  {
    category: "image",
    mimeType: "image/jpeg",
    extensions: [".jpg", ".jpeg"],
    maxSizeBytes: 25 * MB,
  },
  {
    category: "image",
    mimeType: "image/png",
    extensions: [".png"],
    maxSizeBytes: 25 * MB,
  },
  {
    category: "image",
    mimeType: "image/webp",
    extensions: [".webp"],
    maxSizeBytes: 25 * MB,
  },

  // PDF (Max 50 MB)
  {
    category: "pdf",
    mimeType: "application/pdf",
    extensions: [".pdf"],
    maxSizeBytes: 50 * MB,
  },

  // Office Documents (Max 50 MB)
  {
    category: "office",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
    maxSizeBytes: 50 * MB,
  },
  {
    category: "office",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: [".xlsx"],
    maxSizeBytes: 50 * MB,
  },
  {
    category: "office",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extensions: [".pptx"],
    maxSizeBytes: 50 * MB,
  },

  // Archives (Max 100 MB)
  {
    category: "archive",
    mimeType: "application/zip",
    extensions: [".zip"],
    maxSizeBytes: 100 * MB,
  },
  {
    category: "archive",
    mimeType: "application/x-zip-compressed",
    extensions: [".zip"],
    maxSizeBytes: 100 * MB,
  },
  {
    category: "archive",
    mimeType: "application/gzip",
    extensions: [".tar.gz", ".tgz", ".gz"],
    maxSizeBytes: 100 * MB,
  },
  {
    category: "archive",
    mimeType: "application/x-gzip",
    extensions: [".tar.gz", ".tgz", ".gz"],
    maxSizeBytes: 100 * MB,
  },

  // Videos (Max 250 MB)
  {
    category: "video",
    mimeType: "video/mp4",
    extensions: [".mp4"],
    maxSizeBytes: 250 * MB,
  },
  {
    category: "video",
    mimeType: "video/webm",
    extensions: [".webm"],
    maxSizeBytes: 250 * MB,
  },
  {
    category: "video",
    mimeType: "video/quicktime",
    extensions: [".mov"],
    maxSizeBytes: 250 * MB,
  },
];

export const ACCEPTED_FILE_EXTENSIONS =
  ".jpg,.jpeg,.png,.webp,.pdf,.docx,.xlsx,.pptx,.zip,.tar.gz,.tgz,.gz,.mp4,.webm,.mov";

const EXTENSION_FALLBACK_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".tar.gz": "application/gzip",
  ".tgz": "application/gzip",
  ".gz": "application/gzip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

export function resolveClientMime(file: File): {
  mimeType: string;
  rule: AllowedClientRule | null;
  error: string | null;
} {
  const lowerName = file.name.toLowerCase();

  // Explicit SVG rejection
  if (lowerName.endsWith(".svg") || file.type === "image/svg+xml") {
    return {
      mimeType: "image/svg+xml",
      rule: null,
      error:
        "SVG files are not permitted for security reasons (stored script prevention).",
    };
  }

  // Determine effective MIME type, with extension fallback if browser provided generic or empty MIME
  let effectiveMime = file.type.trim().toLowerCase();
  for (const [ext, mime] of Object.entries(EXTENSION_FALLBACK_MIME)) {
    if (lowerName.endsWith(ext)) {
      if (
        !effectiveMime ||
        effectiveMime === "application/octet-stream" ||
        effectiveMime === "binary/octet-stream"
      ) {
        effectiveMime = mime;
      }
      break;
    }
  }

  // Find matching rule
  const rule =
    CLIENT_ALLOWED_RULES.find((r) => {
      if (r.mimeType !== effectiveMime) return false;
      return r.extensions.some((ext) => lowerName.endsWith(ext));
    }) || null;

  if (!rule) {
    return {
      mimeType: effectiveMime || "application/octet-stream",
      rule: null,
      error:
        "Unsupported file format. Approved categories: images (JPG, PNG, WebP), PDFs, Office (DOCX, XLSX, PPTX), archives (ZIP, TAR.GZ), and videos (MP4, WebM, MOV).",
    };
  }

  if (file.size <= 0) {
    return {
      mimeType: rule.mimeType,
      rule,
      error: "File is empty (0 bytes). Empty files cannot be uploaded.",
    };
  }

  if (file.size > rule.maxSizeBytes) {
    const maxMb = rule.maxSizeBytes / MB;
    return {
      mimeType: rule.mimeType,
      rule,
      error: `File (${formatFileSize(file.size)}) exceeds the maximum allowed limit of ${maxMb} MB for ${rule.category} files.`,
    };
  }

  return {
    mimeType: rule.mimeType,
    rule,
    error: null,
  };
}

export function getFileCategory(mimeType: string, filename?: string): string {
  const lowerMime = (mimeType || "").toLowerCase();
  const lowerName = (filename || "").toLowerCase();
  const rule = CLIENT_ALLOWED_RULES.find((r) => {
    if (r.mimeType === lowerMime) return true;
    if (lowerName && r.extensions.some((ext) => lowerName.endsWith(ext))) return true;
    return false;
  });
  return rule ? rule.category : "file";
}

export type TaskFileUploaderProps = {
  organizationSlug: string;
  projectId: string;
  taskId: string;
  disabled?: boolean;
  stagedFiles: StagedFile[];
  onStagedFilesChange: (
    files: StagedFile[] | ((prev: StagedFile[]) => StagedFile[]),
  ) => void;
};

export function TaskFileUploader({
  organizationSlug,
  projectId,
  taskId,
  disabled = false,
  stagedFiles,
  onStagedFilesChange,
}: TaskFileUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deletingIdsRef = useRef<Set<string>>(new Set());
  const cancelledUploadsRef = useRef<Set<string>>(new Set());

  const startUpload = useCallback(
    async (targetLocalId: string, currentFile: File, mimeType: string, category: string) => {
      cancelledUploadsRef.current.delete(targetLocalId);

      onStagedFilesChange((prev) =>
        prev.map((f) =>
          f.localId === targetLocalId
            ? { ...f, status: "authorizing", progress: 0, error: null, removalError: false }
            : f,
        ),
      );

      // Step 1: Request presigned upload URL from Orchestr backend
      let fileId: string | null = null;
      let uploadUrl: string;
      let authorizedMime: string;

      try {
        const uploadUrlEndpoint = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/files/upload-url`;
        const res = await fetch(uploadUrlEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: currentFile.name,
            mimeType,
            fileSize: currentFile.size,
          }),
        });

        if (cancelledUploadsRef.current.has(targetLocalId)) {
          if (res.ok) {
            try {
              const data = (await res.json()) as { fileId?: string };
              if (data.fileId) {
                const deleteEndpoint = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(data.fileId)}`;
                void fetch(deleteEndpoint, { method: "DELETE" }).catch(() => {});
              }
            } catch {
              // ignore
            }
          }
          return;
        }

        if (!res.ok) {
          let errorMsg = "Failed to obtain upload authorization.";
          try {
            const errData = (await res.json()) as { error?: string };
            if (errData.error) errorMsg = errData.error;
          } catch {
            // Use fallback
          }
          onStagedFilesChange((prev) =>
            prev.map((f) =>
              f.localId === targetLocalId
                ? { ...f, status: "error", error: errorMsg, removalError: false }
                : f,
            ),
          );
          return;
        }

        const data = (await res.json()) as {
          fileId: string;
          uploadUrl: string;
          mimeType: string;
        };
        fileId = data.fileId;
        uploadUrl = data.uploadUrl;
        authorizedMime = data.mimeType || mimeType;

        if (cancelledUploadsRef.current.has(targetLocalId)) {
          if (fileId) {
            const deleteEndpoint = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}`;
            void fetch(deleteEndpoint, { method: "DELETE" }).catch(() => {});
          }
          return;
        }

        onStagedFilesChange((prev) =>
          prev.map((f) =>
            f.localId === targetLocalId
              ? { ...f, fileId, status: "uploading", progress: 0, removalError: false }
              : f,
          ),
        );
      } catch {
        if (cancelledUploadsRef.current.has(targetLocalId)) {
          return;
        }
        onStagedFilesChange((prev) =>
          prev.map((f) =>
            f.localId === targetLocalId
              ? {
                  ...f,
                  status: "error",
                  error: "Network error requesting upload authorization.",
                  removalError: false,
                }
              : f,
          ),
        );
        return;
      }

      if (cancelledUploadsRef.current.has(targetLocalId)) {
        return;
      }

      // Step 2: Upload binary directly from browser to Backblaze B2 via presigned PUT
      const xhr = new XMLHttpRequest();
      onStagedFilesChange((prev) =>
        prev.map((f) =>
          f.localId === targetLocalId ? { ...f, xhr } : f,
        ),
      );

      const putSuccess = await new Promise<boolean>((resolve) => {
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", authorizedMime);

        xhr.upload.onprogress = (event) => {
          if (cancelledUploadsRef.current.has(targetLocalId)) return;
          if (event.lengthComputable && event.total > 0) {
            const pct = Math.min(
              100,
              Math.max(1, Math.round((event.loaded / event.total) * 100)),
            );
            onStagedFilesChange((prev) =>
              prev.map((f) =>
                f.localId === targetLocalId ? { ...f, progress: pct } : f,
              ),
            );
          }
        };

        xhr.onload = () => {
          if (cancelledUploadsRef.current.has(targetLocalId)) {
            resolve(false);
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(true);
          } else {
            onStagedFilesChange((prev) =>
              prev.map((f) =>
                f.localId === targetLocalId
                  ? {
                      ...f,
                      status: "error",
                      error: `Storage upload failed with HTTP status ${xhr.status}.`,
                      xhr: null,
                      removalError: false,
                    }
                  : f,
              ),
            );
            resolve(false);
          }
        };

        xhr.onerror = () => {
          if (cancelledUploadsRef.current.has(targetLocalId)) {
            resolve(false);
            return;
          }
          onStagedFilesChange((prev) =>
            prev.map((f) =>
              f.localId === targetLocalId
                ? {
                    ...f,
                    status: "error",
                    error: "Network error transferring file to storage.",
                    xhr: null,
                    removalError: false,
                  }
                : f,
            ),
          );
          resolve(false);
        };

        xhr.onabort = () => {
          resolve(false);
        };

        xhr.send(currentFile);
      });

      if (!putSuccess || cancelledUploadsRef.current.has(targetLocalId)) {
        return;
      }

      // Step 3: Confirm upload with Orchestr backend
      onStagedFilesChange((prev) =>
        prev.map((f) =>
          f.localId === targetLocalId
            ? { ...f, status: "confirming", progress: 100, xhr: null, removalError: false }
            : f,
        ),
      );

      try {
        const confirmEndpoint = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId!)}/confirm`;
        const confirmRes = await fetch(confirmEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        if (cancelledUploadsRef.current.has(targetLocalId)) {
          return;
        }

        if (!confirmRes.ok) {
          let errorMsg = "Server failed to verify storage upload.";
          try {
            const errData = (await confirmRes.json()) as { error?: string };
            if (errData.error) errorMsg = errData.error;
          } catch {
            // Use fallback
          }
          onStagedFilesChange((prev) =>
            prev.map((f) =>
              f.localId === targetLocalId
                ? { ...f, status: "error", error: errorMsg, removalError: false }
                : f,
            ),
          );
          return;
        }

        const confirmData = (await confirmRes.json()) as {
          file?: FileSummary;
        };

        if (cancelledUploadsRef.current.has(targetLocalId)) {
          return;
        }

        onStagedFilesChange((prev) =>
          prev.map((f) =>
            f.localId === targetLocalId
              ? {
                  ...f,
                  status: "uploaded",
                  progress: 100,
                  confirmedFile: confirmData.file || null,
                  category: confirmData.file?.category || category,
                  error: null,
                  removalError: false,
                }
              : f,
          ),
        );
      } catch {
        if (cancelledUploadsRef.current.has(targetLocalId)) {
          return;
        }
        onStagedFilesChange((prev) =>
          prev.map((f) =>
            f.localId === targetLocalId
              ? {
                  ...f,
                  status: "error",
                  error: "Network error confirming upload with server.",
                  removalError: false,
                }
              : f,
          ),
        );
      }
    },
    [onStagedFilesChange, organizationSlug, projectId, taskId],
  );

  const handleFilesSelected = useCallback(
    (selectedFiles: File[]) => {
      setGeneralError(null);
      if (selectedFiles.length === 0) return;

      const currentCount = stagedFiles.length;
      if (currentCount + selectedFiles.length > MAX_ATTACHMENTS_PER_DELIVERABLE) {
        setGeneralError(
          `You can attach at most ${MAX_ATTACHMENTS_PER_DELIVERABLE} files per deliverable submission. (${currentCount} already selected).`,
        );
        return;
      }

      const currentTotalBytes = stagedFiles.reduce(
        (sum, f) => sum + f.size,
        0,
      );
      const newTotalBytes = selectedFiles.reduce(
        (sum, f) => sum + f.size,
        0,
      );

      if (currentTotalBytes + newTotalBytes > MAX_AGGREGATE_ATTACHMENTS_BYTES) {
        setGeneralError(
          `Aggregate file size exceeds the 500 MB limit per deliverable submission. (${formatFileSize(currentTotalBytes + newTotalBytes)} total).`,
        );
        return;
      }

      const newStagedFiles: StagedFile[] = [];

      for (const file of selectedFiles) {
        // Skip duplicate names already in the staging list
        if (stagedFiles.some((f) => f.name === file.name && f.size === file.size)) {
          continue;
        }

        const validation = resolveClientMime(file);
        const localId = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        if (validation.error || !validation.rule) {
          newStagedFiles.push({
            localId,
            file,
            name: file.name,
            size: file.size,
            mimeType: validation.mimeType,
            category: "unknown",
            status: "error",
            progress: 0,
            error: validation.error || "File format not supported.",
            fileId: null,
            confirmedFile: null,
          });
        } else {
          const staged: StagedFile = {
            localId,
            file,
            name: file.name,
            size: file.size,
            mimeType: validation.rule.mimeType,
            category: validation.rule.category,
            status: "idle",
            progress: 0,
            error: null,
            fileId: null,
            confirmedFile: null,
          };
          newStagedFiles.push(staged);
        }
      }

      if (newStagedFiles.length === 0) {
        return;
      }

      onStagedFilesChange((prev) => [...prev, ...newStagedFiles]);

      // Automatically trigger upload for valid idle files
      for (const item of newStagedFiles) {
        if (item.status === "idle") {
          void startUpload(item.localId, item.file, item.mimeType, item.category);
        }
      }
    },
    [onStagedFilesChange, stagedFiles, startUpload],
  );

  const handleRemove = useCallback(
    async (localId: string) => {
      if (deletingIdsRef.current.has(localId)) return;

      const target = stagedFiles.find((f) => f.localId === localId);
      if (!target) return;

      cancelledUploadsRef.current.add(localId);

      // Abort active upload if in progress
      if (target.xhr) {
        try {
          target.xhr.abort();
        } catch {
          // ignore abort error
        }
      }

      // If no server-side file record exists yet, remove locally immediately
      if (!target.fileId) {
        onStagedFilesChange((prev) => prev.filter((f) => f.localId !== localId));
        return;
      }

      // File has a server-side fileId: initiate server deletion
      deletingIdsRef.current.add(localId);

      onStagedFilesChange((prev) =>
        prev.map((f) =>
          f.localId === localId
            ? { ...f, status: "removing", error: null, xhr: null, removalError: false }
            : f,
        ),
      );

      const deleteEndpoint = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(target.fileId)}`;

      try {
        const res = await fetch(deleteEndpoint, { method: "DELETE" });

        if (res.ok) {
          onStagedFilesChange((prev) => prev.filter((f) => f.localId !== localId));
        } else {
          let errorMsg = `Server returned status ${res.status}.`;
          try {
            const data = (await res.json()) as { error?: string };
            if (data.error) errorMsg = data.error;
          } catch {
            // fallback
          }

          onStagedFilesChange((prev) =>
            prev.map((f) =>
              f.localId === localId
                ? {
                    ...f,
                    status: "error",
                    error: `Failed to remove file from server: ${errorMsg}`,
                    removalError: true,
                  }
                : f,
            ),
          );
        }
      } catch {
        onStagedFilesChange((prev) =>
          prev.map((f) =>
            f.localId === localId
              ? {
                  ...f,
                  status: "error",
                  error: "Network error while removing file from server. Please retry.",
                  removalError: true,
                }
              : f,
          ),
        );
      } finally {
        deletingIdsRef.current.delete(localId);
      }
    },
    [onStagedFilesChange, organizationSlug, projectId, stagedFiles, taskId],
  );

  const handleRetry = useCallback(
    (localId: string) => {
      const target = stagedFiles.find((f) => f.localId === localId);
      if (!target) return;
      if (target.removalError) {
        void handleRemove(localId);
      } else {
        void startUpload(target.localId, target.file, target.mimeType, target.category);
      }
    },
    [handleRemove, stagedFiles, startUpload],
  );

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  };

  const onDragLeave = () => {
    setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesSelected(Array.from(e.dataTransfer.files));
    }
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFilesSelected(Array.from(e.target.files));
      // Reset input value so the same file can be selected again if removed
      e.target.value = "";
    }
  };

  const totalBytes = stagedFiles.reduce((sum, f) => sum + f.size, 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-zinc-600 dark:text-zinc-400 font-medium">
          File Attachments ({stagedFiles.length}/{MAX_ATTACHMENTS_PER_DELIVERABLE}
          {stagedFiles.length > 0 ? `, ${formatFileSize(totalBytes)}` : ""}):
        </span>
        <span className="text-[10px] text-zinc-500">
          Max 10 files, 500 MB aggregate
        </span>
      </div>

      {/* Drag & Drop Zone */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => !disabled && fileInputRef.current?.click()}
        className={`flex flex-col items-center justify-center gap-1 rounded border-2 border-dashed p-3 text-center transition-colors cursor-pointer ${
          isDragging
            ? "border-blue-500 bg-blue-50/50 dark:border-blue-400 dark:bg-blue-950/20"
            : disabled
              ? "border-zinc-200 bg-zinc-50 opacity-60 cursor-not-allowed dark:border-zinc-800 dark:bg-zinc-900"
              : "border-zinc-300 bg-white hover:border-zinc-400 hover:bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800/40"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_FILE_EXTENSIONS}
          disabled={disabled}
          onChange={onFileInputChange}
          className="hidden"
        />
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          Drop work files here, or <span className="text-blue-600 underline dark:text-blue-400">browse</span>
        </span>
        <span className="text-[10px] text-zinc-500">
          Images (JPG, PNG, WebP ≤ 25MB) • PDFs (≤ 50MB) • Office (DOCX, XLSX, PPTX ≤ 50MB) • Archives (ZIP, TAR.GZ ≤ 100MB) • Videos (MP4, WebM, MOV ≤ 250MB)
        </span>
      </div>

      {generalError && (
        <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">
          {generalError}
        </p>
      )}

      {/* Staged files list */}
      {stagedFiles.length > 0 && (
        <ul className="flex flex-col gap-1.5 mt-1">
          {stagedFiles.map((staged) => {
            return (
              <li
                key={staged.localId}
                className="flex flex-col gap-1 rounded border border-zinc-200 bg-zinc-50/80 p-2 text-xs dark:border-zinc-800 dark:bg-zinc-900/60"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium truncate text-zinc-800 dark:text-zinc-200">
                      {staged.name}
                    </span>
                    <span className="text-[10px] text-zinc-500 shrink-0">
                      ({formatFileSize(staged.size)})
                    </span>
                    <span className="rounded bg-zinc-200/70 px-1.5 py-0.2 text-[9px] font-medium uppercase tracking-wider text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 shrink-0">
                      {staged.category}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* Status badge */}
                    {staged.status === "authorizing" && (
                      <span className="text-[11px] text-blue-600 dark:text-blue-400 animate-pulse">
                        Authorizing…
                      </span>
                    )}
                    {staged.status === "uploading" && (
                      <span className="text-[11px] text-blue-600 dark:text-blue-400">
                        {staged.progress}%
                      </span>
                    )}
                    {staged.status === "confirming" && (
                      <span className="text-[11px] text-amber-600 dark:text-amber-400 animate-pulse">
                        Verifying…
                      </span>
                    )}
                    {staged.status === "removing" && (
                      <span className="text-[11px] text-amber-600 dark:text-amber-400 animate-pulse">
                        Removing…
                      </span>
                    )}
                    {staged.status === "uploaded" && (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300">
                        Ready ✓
                      </span>
                    )}
                    {staged.status === "error" && (
                      <button
                        type="button"
                        onClick={() => handleRetry(staged.localId)}
                        disabled={disabled}
                        className="rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-60 dark:border-red-800 dark:bg-red-950/60 dark:text-red-300"
                      >
                        {staged.removalError ? "Retry removal" : "Retry"}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => void handleRemove(staged.localId)}
                      disabled={disabled || staged.status === "removing"}
                      aria-label={`Remove ${staged.name}`}
                      className="rounded p-0.5 text-zinc-400 hover:text-zinc-700 disabled:opacity-40 dark:hover:text-zinc-200"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Progress bar when uploading */}
                {staged.status === "uploading" && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div
                      className="h-full bg-blue-600 transition-all duration-150 dark:bg-blue-500"
                      style={{ width: `${staged.progress}%` }}
                    />
                  </div>
                )}

                {/* Error message */}
                {staged.status === "error" && staged.error && (
                  <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">
                    {staged.error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
