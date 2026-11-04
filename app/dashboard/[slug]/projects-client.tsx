"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type SubmitEvent } from "react";
import type {
  ActivityEventType,
  MembershipRole,
  ProjectStatus,
} from "@/lib/schema";

type OrgActivityFieldChange = {
  field: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
  beforeDisplay: string;
  afterDisplay: string;
};

type OrgActivityEntry = {
  id: string;
  projectId: string | null;
  taskId: string | null;
  eventType: ActivityEventType;
  actorId: string;
  actor: {
    userId: string;
    name: string | null;
    email: string | null;
    role: MembershipRole | null;
    label: string;
  };
  summary: string;
  changes: OrgActivityFieldChange[];
  createdAt: string;
};

const ORG_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  title: "Title",
  description: "Description",
  status: "Status",
  priority: "Priority",
  assigneeId: "Assignee",
  deadline: "Deadline",
  approvalRequired: "Approval requirement",
  parentTaskId: "Parent task",
  prerequisiteTaskId: "Prerequisite",
  submissionNumber: "Submission",
  decision: "Review decision",
  meetingDate: "Meeting date",
  projectId: "Project",
  participantId: "Participant",
  notes: "Notes",
  discussionPoint: "Discussion point",
  meetingDecision: "Decision",
  ownerId: "Owner",
  targetDate: "Target date",
  archived: "Archived",
  linkedTaskId: "Linked task",
  sourceMeetingId: "Source meeting",
  sourceActionItemId: "Source action item",
};

function formatActivityTimestamp(isoDate: string): string {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }
  return parsed.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

export type ProjectSummary = {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
};

type StatusFilter = "all" | ProjectStatus;

type ProjectsClientProps = {
  organizationSlug: string;
  role: MembershipRole;
  initialProjects: ProjectSummary[];
};

function formatCreatedDate(isoDate: string): string {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }
  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

async function readApiError(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data?.error === "string" && data.error.trim() !== "") {
      return data.error;
    }
  } catch {
    // Ignore non-JSON error bodies and use status-specific fallback.
  }

  if (response.status === 401) {
    return "Your session has expired. Please sign in again.";
  }
  if (response.status === 403) {
    return "You do not have permission to perform this action.";
  }
  if (response.status === 404) {
    return "The requested organization or project could not be found.";
  }
  if (response.status === 409) {
    return "This action conflicts with the project's current status.";
  }
  return fallbackMessage;
}

export function ProjectsClient({
  organizationSlug,
  role,
  initialProjects,
}: ProjectsClientProps) {
  const router = useRouter();
  const canManage = role === "admin" || role === "manager";

  const [projects, setProjects] = useState<ProjectSummary[]>(initialProjects);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Create project form state
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const createInFlight = useRef(false);

  // Edit / lifecycle state
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const actionInFlight = useRef(false);

  // Organization activity timeline state
  const [orgActivities, setOrgActivities] = useState<OrgActivityEntry[]>([]);
  const [orgActivityCursor, setOrgActivityCursor] = useState<string | null>(
    null,
  );
  const [orgActivityLoading, setOrgActivityLoading] = useState(true);
  const [orgActivityLoadingMore, setOrgActivityLoadingMore] = useState(false);
  const [orgActivityError, setOrgActivityError] = useState<string | null>(null);

  const baseApiUrl = `/api/organizations/${encodeURIComponent(organizationSlug)}/projects`;
  const orgActivityApiUrl = `/api/organizations/${encodeURIComponent(organizationSlug)}/activity`;

  const refreshOrgActivity = useCallback(async () => {
    setOrgActivityLoading(true);
    setOrgActivityError(null);
    try {
      const response = await fetch(`${orgActivityApiUrl}?limit=15`, {
        method: "GET",
        cache: "no-store",
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Unable to load organization activity.",
        );
        setOrgActivityError(message);
        return;
      }

      const data = (await response.json()) as {
        activities?: OrgActivityEntry[];
        nextCursor?: string | null;
      };
      setOrgActivities(Array.isArray(data.activities) ? data.activities : []);
      setOrgActivityCursor(
        typeof data.nextCursor === "string" ? data.nextCursor : null,
      );
    } catch {
      setOrgActivityError(
        "Could not load organization activity. Please try again.",
      );
    } finally {
      setOrgActivityLoading(false);
    }
  }, [orgActivityApiUrl, router]);

  const loadMoreOrgActivity = useCallback(async () => {
    if (!orgActivityCursor || orgActivityLoadingMore) return;
    setOrgActivityLoadingMore(true);
    setOrgActivityError(null);

    try {
      const params = new URLSearchParams({
        limit: "15",
        cursor: orgActivityCursor,
      });
      const response = await fetch(
        `${orgActivityApiUrl}?${params.toString()}`,
        {
          method: "GET",
          cache: "no-store",
        },
      );

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Unable to load more organization activity.",
        );
        setOrgActivityError(message);
        return;
      }

      const data = (await response.json()) as {
        activities?: OrgActivityEntry[];
        nextCursor?: string | null;
      };
      const incoming = Array.isArray(data.activities) ? data.activities : [];
      setOrgActivities((prev) => {
        const seen = new Set(prev.map((a) => a.id));
        const merged = [...prev];
        for (const item of incoming) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            merged.push(item);
          }
        }
        return merged;
      });
      setOrgActivityCursor(
        typeof data.nextCursor === "string" ? data.nextCursor : null,
      );
    } catch {
      setOrgActivityError(
        "Could not load more organization activity. Please try again.",
      );
    } finally {
      setOrgActivityLoadingMore(false);
    }
  }, [orgActivityApiUrl, orgActivityCursor, orgActivityLoadingMore, router]);

  useEffect(() => {
    let cancelled = false;

    async function fetchInitialOrgActivity() {
      try {
        const response = await fetch(`${orgActivityApiUrl}?limit=15`, {
          method: "GET",
          cache: "no-store",
        });

        if (response.status === 401) {
          router.push("/login");
          return;
        }

        if (!response.ok) {
          const message = await readApiError(
            response,
            "Unable to load organization activity.",
          );
          if (!cancelled) {
            setOrgActivityError(message);
          }
          return;
        }

        const data = (await response.json()) as {
          activities?: OrgActivityEntry[];
          nextCursor?: string | null;
        };
        if (!cancelled) {
          setOrgActivities(
            Array.isArray(data.activities) ? data.activities : [],
          );
          setOrgActivityCursor(
            typeof data.nextCursor === "string" ? data.nextCursor : null,
          );
          setOrgActivityError(null);
        }
      } catch {
        if (!cancelled) {
          setOrgActivityError(
            "Could not load organization activity. Please try again.",
          );
        }
      } finally {
        if (!cancelled) {
          setOrgActivityLoading(false);
        }
      }
    }

    void fetchInitialOrgActivity();

    return () => {
      cancelled = true;
    };
  }, [orgActivityApiUrl, router]);

  async function refreshProjects(filter: StatusFilter) {
    setListLoading(true);
    setListError(null);
    const query =
      filter === "all" ? "" : `?status=${encodeURIComponent(filter)}`;

    try {
      const response = await fetch(`${baseApiUrl}${query}`, {
        method: "GET",
        cache: "no-store",
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Failed to load projects. Please try again.",
        );
        setListError(message);
        return;
      }

      const data = (await response.json()) as { projects?: ProjectSummary[] };
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch {
      setListError("Could not reach the server. Please try again.");
    } finally {
      setListLoading(false);
    }
  }

  async function onFilterChange(nextFilter: StatusFilter) {
    setStatusFilter(nextFilter);
    setActionError(null);
    setActionSuccess(null);
    await refreshProjects(nextFilter);
  }

  async function onCreateProject(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || createInFlight.current) return;
    createInFlight.current = true;
    setCreateError(null);
    setCreateSuccess(null);
    setActionError(null);
    setActionSuccess(null);
    setCreateLoading(true);

    const trimmedName = createName.trim();
    const trimmedDescription = createDescription.trim();
    const payload: { name: string; description?: string | null } = {
      name: trimmedName,
      description: trimmedDescription === "" ? null : createDescription,
    };

    try {
      const response = await fetch(baseApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not create project. Please try again.",
        );
        setCreateError(message);
        return;
      }

      setCreateName("");
      setCreateDescription("");
      setCreateSuccess("Project created.");
      await refreshProjects(statusFilter);
      void refreshOrgActivity();
      router.refresh();
    } catch {
      setCreateError("Could not reach the server. Please try again.");
    } finally {
      createInFlight.current = false;
      setCreateLoading(false);
    }
  }

  function startEditing(project: ProjectSummary) {
    if (!canManage || project.status === "archived") return;
    setEditingProjectId(project.id);
    setEditName(project.name);
    setEditDescription(project.description ?? "");
    setActionError(null);
    setActionSuccess(null);
    setCreateSuccess(null);
  }

  function cancelEditing() {
    setEditingProjectId(null);
    setEditName("");
    setEditDescription("");
  }

  async function onSaveEdit(
    event: SubmitEvent<HTMLFormElement>,
    projectId: string,
  ) {
    event.preventDefault();
    if (!canManage || actionInFlight.current) return;
    actionInFlight.current = true;
    setActionError(null);
    setActionSuccess(null);
    setCreateSuccess(null);
    setActionLoadingId(projectId);

    const trimmedName = editName.trim();
    const trimmedDescription = editDescription.trim();

    try {
      const response = await fetch(
        `${baseApiUrl}/${encodeURIComponent(projectId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmedName,
            description: trimmedDescription === "" ? null : editDescription,
          }),
        },
      );

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not update project. Please try again.",
        );
        setActionError(message);
        if (response.status === 409 || response.status === 404) {
          setEditingProjectId(null);
          await refreshProjects(statusFilter);
        }
        return;
      }

      setEditingProjectId(null);
      setActionSuccess("Project updated.");
      await refreshProjects(statusFilter);
      void refreshOrgActivity();
      router.refresh();
    } catch {
      setActionError("Could not reach the server. Please try again.");
    } finally {
      actionInFlight.current = false;
      setActionLoadingId(null);
    }
  }

  async function onToggleArchive(
    project: ProjectSummary,
    targetStatus: ProjectStatus,
  ) {
    if (!canManage || actionInFlight.current) return;
    actionInFlight.current = true;
    setActionError(null);
    setActionSuccess(null);
    setCreateSuccess(null);
    setActionLoadingId(project.id);

    try {
      const response = await fetch(
        `${baseApiUrl}/${encodeURIComponent(project.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: targetStatus }),
        },
      );

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not update project status. Please try again.",
        );
        setActionError(message);
        return;
      }

      if (editingProjectId === project.id) {
        setEditingProjectId(null);
      }
      setActionSuccess(
        targetStatus === "archived"
          ? `Archived "${project.name}".`
          : `Unarchived "${project.name}".`,
      );
      await refreshProjects(statusFilter);
      void refreshOrgActivity();
      router.refresh();
    } catch {
      setActionError("Could not reach the server. Please try again.");
    } finally {
      actionInFlight.current = false;
      setActionLoadingId(null);
    }
  }

  const inputClassName =
    "w-full rounded border border-zinc-300 px-3 py-2 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white";

  const visibleProjects =
    statusFilter === "all"
      ? projects
      : projects.filter((project) => project.status === statusFilter);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">Projects</h2>
          <div
            role="group"
            aria-label="Filter projects by status"
            className="flex items-center gap-1 rounded border border-zinc-200 p-1 text-xs dark:border-zinc-800"
          >
            {(["active", "archived", "all"] as const).map((filterOption) => {
              const isSelected = statusFilter === filterOption;
              return (
                <button
                  key={filterOption}
                  type="button"
                  disabled={listLoading}
                  onClick={() => void onFilterChange(filterOption)}
                  className={`rounded px-2.5 py-1 capitalize transition-colors ${
                    isSelected
                      ? "bg-black font-medium text-white dark:bg-white dark:text-black"
                      : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  }`}
                >
                  {filterOption}
                </button>
              );
            })}
          </div>
        </div>

        {listError && (
          <p role="alert" className="text-sm text-red-600">
            {listError}
          </p>
        )}
        {actionError && (
          <p role="alert" className="text-sm text-red-600">
            {actionError}
          </p>
        )}
        {actionSuccess && (
          <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
            {actionSuccess}
          </p>
        )}

        {listLoading ? (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
            Loading projects…
          </p>
        ) : visibleProjects.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
            {statusFilter === "active"
              ? "No active projects found."
              : statusFilter === "archived"
                ? "No archived projects found."
                : "No projects have been created for this organization yet."}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {visibleProjects.map((project) => {
              const isEditing = editingProjectId === project.id;
              const isBusy = actionLoadingId === project.id;
              const isArchived = project.status === "archived";

              return (
                <li
                  key={project.id}
                  className="flex flex-col gap-3 rounded border border-zinc-200 p-4 dark:border-zinc-800"
                >
                  {isEditing ? (
                    <form
                      onSubmit={(event) => void onSaveEdit(event, project.id)}
                      className="flex flex-col gap-3"
                    >
                      <label className="flex flex-col gap-1 text-sm">
                        Project name
                        <input
                          type="text"
                          required
                          maxLength={200}
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          className={inputClassName}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        <span>
                          Description{" "}
                          <span className="text-zinc-500">(optional)</span>
                        </span>
                        <textarea
                          rows={3}
                          maxLength={5000}
                          value={editDescription}
                          onChange={(event) =>
                            setEditDescription(event.target.value)
                          }
                          className={inputClassName}
                        />
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          type="submit"
                          disabled={isBusy}
                          className="rounded bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
                        >
                          {isBusy ? "Saving…" : "Save changes"}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={cancelEditing}
                          className="rounded border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex flex-col gap-1">
                          <h3 className="font-medium">
                            <Link
                              href={`/dashboard/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(project.id)}`}
                              className="hover:underline"
                            >
                              {project.name}
                            </Link>
                          </h3>
                          {project.description ? (
                            <p className="whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">
                              {project.description}
                            </p>
                          ) : (
                            <p className="text-xs italic text-zinc-400 dark:text-zinc-500">
                              No description provided.
                            </p>
                          )}
                        </div>
                        <span
                          className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium capitalize ${
                            isArchived
                              ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                              : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                          }`}
                        >
                          {project.status}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-2 text-xs text-zinc-500 dark:border-zinc-800/80">
                        <span>Created {formatCreatedDate(project.createdAt)}</span>

                        <div className="flex items-center gap-2">
                          <Link
                            href={`/dashboard/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(project.id)}`}
                            className="rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          >
                            View tasks →
                          </Link>
                          {canManage && (
                            <>
                              {!isArchived && (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => startEditing(project)}
                                  className="rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                >
                                  Edit
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  void onToggleArchive(
                                    project,
                                    isArchived ? "active" : "archived",
                                  )
                                }
                                className="rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                              >
                                {isBusy
                                  ? "Updating…"
                                  : isArchived
                                    ? "Unarchive"
                                    : "Archive"}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canManage && (
        <form
          onSubmit={onCreateProject}
          className="flex flex-col gap-3 rounded border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <h2 className="text-lg font-medium">Create project</h2>
          <label className="flex flex-col gap-1 text-sm">
            Project name
            <input
              name="name"
              type="text"
              required
              maxLength={200}
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="Website Redesign"
              className={inputClassName}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>
              Description <span className="text-zinc-500">(optional)</span>
            </span>
            <textarea
              name="description"
              rows={3}
              maxLength={5000}
              value={createDescription}
              onChange={(event) => setCreateDescription(event.target.value)}
              placeholder="Goals, scope, and key deliverables…"
              className={inputClassName}
            />
          </label>
          {createError && (
            <p role="alert" className="text-sm text-red-600">
              {createError}
            </p>
          )}
          {createSuccess && (
            <p
              role="status"
              className="text-sm text-emerald-600 dark:text-emerald-400"
            >
              {createSuccess}
            </p>
          )}
          <button
            type="submit"
            disabled={createLoading}
            className="self-start rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-60 dark:bg-white dark:text-black"
          >
            {createLoading ? "Creating project…" : "Create project"}
          </button>
        </form>
      )}

      <section
        aria-label="Organization Activity"
        className="flex flex-col gap-3 rounded border border-zinc-200 p-4 dark:border-zinc-800"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium">Organization Activity</h2>
            <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {orgActivities.length}
            </span>
          </div>
          <button
            type="button"
            disabled={orgActivityLoading || orgActivityLoadingMore}
            onClick={() => void refreshOrgActivity()}
            className="rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {orgActivityLoading
              ? "Loading…"
              : orgActivityError
                ? "Retry"
                : "Refresh"}
          </button>
        </div>

        {orgActivityError && (
          <p role="alert" className="text-sm text-red-600">
            {orgActivityError}
          </p>
        )}

        {orgActivityLoading && orgActivities.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
            Loading organization activity…
          </p>
        ) : orgActivities.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
            No activity recorded for this organization yet.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <ol className="flex flex-col gap-2">
              {orgActivities.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-col gap-1.5 rounded border border-zinc-200/80 bg-zinc-50/70 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900/50"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">
                      {entry.summary}
                    </span>
                    <span className="text-zinc-500">
                      {formatActivityTimestamp(entry.createdAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-zinc-500">
                    <span>
                      By{" "}
                      <strong className="font-normal text-zinc-700 dark:text-zinc-300">
                        {entry.actor?.name ?? entry.actorId}
                        {entry.actor?.role ? ` · ${entry.actor.role}` : ""}
                      </strong>
                    </span>
                  </div>
                  {Array.isArray(entry.changes) && entry.changes.length > 0 && (
                    <ul className="mt-0.5 flex flex-col gap-1 border-l-2 border-zinc-200 pl-2.5 text-[11px] text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                      {entry.changes.map((change, idx) => {
                        const fieldLabel =
                          ORG_FIELD_LABELS[change.field] ?? change.field;
                        const isTransition =
                          change.before !== null && change.after !== null;
                        return (
                          <li
                            key={`${entry.id}-${change.field}-${idx}`}
                            className="flex flex-wrap items-center gap-1"
                          >
                            <span className="font-medium text-zinc-700 dark:text-zinc-300">
                              {fieldLabel}:
                            </span>
                            {isTransition ||
                            entry.eventType.endsWith("_changed") ||
                            entry.eventType.endsWith(".updated") ||
                            entry.eventType === "project.archived" ||
                            entry.eventType === "project.unarchived" ||
                            entry.eventType === "review.decision_updated" ? (
                              <>
                                <span className="rounded bg-zinc-200/70 px-1.5 py-0.5 text-zinc-700 line-through dark:bg-zinc-800 dark:text-zinc-400">
                                  {change.beforeDisplay}
                                </span>
                                <span aria-hidden="true">→</span>
                                <span className="rounded bg-emerald-100/70 px-1.5 py-0.5 font-medium text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300">
                                  {change.afterDisplay}
                                </span>
                              </>
                            ) : (
                              <span className="rounded bg-zinc-200/60 px-1.5 py-0.5 font-medium text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                                {change.afterDisplay}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
            {orgActivityCursor && (
              <button
                type="button"
                disabled={orgActivityLoadingMore}
                onClick={() => void loadMoreOrgActivity()}
                className="self-start rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {orgActivityLoadingMore
                  ? "Loading more…"
                  : "Load more activity"}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

