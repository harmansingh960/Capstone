"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, type SubmitEvent } from "react";
import type { MeetingDto } from "@/lib/meeting-dto";
import type {
  MeetingStatus,
  MembershipRole,
  ProjectStatus,
} from "@/lib/schema";

type ProjectOption = {
  id: string;
  name: string;
  status: ProjectStatus;
};

type MemberOption = {
  userId: string;
  role: MembershipRole;
  name: string | null;
  email: string | null;
};

type PaginationState = {
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
};

type MeetingsClientProps = {
  organizationSlug: string;
  role: MembershipRole;
  currentUserId: string;
  initialMeetings: MeetingDto[];
  initialPagination: PaginationState;
  projects: ProjectOption[];
  members: MemberOption[];
};

const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
};

const MEETING_STATUS_CLASSES: Record<MeetingStatus, string> = {
  scheduled:
    "bg-blue-100 text-blue-800 dark:bg-blue-950/70 dark:text-blue-300",
  completed:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300",
  cancelled:
    "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

function formatMeetingDateTime(isoDate: string): string {
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
  });
}

function defaultDateTimeLocal(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
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
    // Ignore non-JSON error body
  }
  if (response.status === 401) {
    return "Your session has expired. Please sign in again.";
  }
  if (response.status === 403) {
    return "You do not have permission to perform this action.";
  }
  if (response.status === 404) {
    return "The requested meeting or organization could not be found.";
  }
  return fallbackMessage;
}

export function MeetingsClient({
  organizationSlug,
  role,
  currentUserId,
  initialMeetings,
  initialPagination,
  projects,
  members,
}: MeetingsClientProps) {
  const router = useRouter();
  const canManage = role === "admin" || role === "manager";
  const baseApiUrl = `/api/organizations/${encodeURIComponent(organizationSlug)}/meetings`;

  const [meetings, setMeetings] = useState<MeetingDto[]>(initialMeetings);
  const [pagination, setPagination] =
    useState<PaginationState>(initialPagination);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | MeetingStatus>("all");
  const [archiveFilter, setArchiveFilter] = useState<
    "active" | "archived" | "all"
  >("active");
  const [projectFilter, setProjectFilter] = useState<string>("all");

  // Create Meeting form state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createDate, setCreateDate] = useState<string>(() =>
    defaultDateTimeLocal(),
  );
  const [createStatus, setCreateStatus] = useState<MeetingStatus>("scheduled");
  const [createProjectId, setCreateProjectId] = useState<string>("");
  const [createDescription, setCreateDescription] = useState("");
  const [createParticipantIds, setCreateParticipantIds] = useState<string[]>([
    currentUserId,
  ]);
  const [createNotes, setCreateNotes] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const createInFlight = useRef(false);

  const fetchMeetings = useCallback(
    async (opts: {
      search: string;
      status: "all" | MeetingStatus;
      archived: "active" | "archived" | "all";
      projectId: string;
      page: number;
    }) => {
      setListLoading(true);
      setListError(null);
      const params = new URLSearchParams();
      if (opts.search.trim() !== "") {
        params.set("search", opts.search.trim());
      }
      if (opts.status !== "all") {
        params.set("status", opts.status);
      }
      params.set("archived", opts.archived);
      if (opts.projectId !== "all") {
        params.set("projectId", opts.projectId);
      }
      params.set("page", String(opts.page));
      params.set("limit", "20");

      try {
        const response = await fetch(`${baseApiUrl}?${params.toString()}`, {
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
            "Failed to load meetings.",
          );
          setListError(message);
          return;
        }

        const data = (await response.json()) as {
          meetings?: MeetingDto[];
          pagination?: PaginationState;
        };
        setMeetings(Array.isArray(data.meetings) ? data.meetings : []);
        if (data.pagination) {
          setPagination(data.pagination);
        }
      } catch {
        setListError("Could not reach the server. Please try again.");
      } finally {
        setListLoading(false);
      }
    },
    [baseApiUrl, router],
  );

  function handleSearchSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void fetchMeetings({
      search: searchQuery,
      status: statusFilter,
      archived: archiveFilter,
      projectId: projectFilter,
      page: 1,
    });
  }

  function handleStatusFilterChange(nextStatus: "all" | MeetingStatus) {
    setStatusFilter(nextStatus);
    void fetchMeetings({
      search: searchQuery,
      status: nextStatus,
      archived: archiveFilter,
      projectId: projectFilter,
      page: 1,
    });
  }

  function handleArchiveFilterChange(
    nextArchive: "active" | "archived" | "all",
  ) {
    setArchiveFilter(nextArchive);
    void fetchMeetings({
      search: searchQuery,
      status: statusFilter,
      archived: nextArchive,
      projectId: projectFilter,
      page: 1,
    });
  }

  function handleProjectFilterChange(nextProjectId: string) {
    setProjectFilter(nextProjectId);
    void fetchMeetings({
      search: searchQuery,
      status: statusFilter,
      archived: archiveFilter,
      projectId: nextProjectId,
      page: 1,
    });
  }

  function toggleCreateParticipant(userId: string) {
    setCreateParticipantIds((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId],
    );
  }

  async function onCreateMeeting(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || createInFlight.current) return;
    createInFlight.current = true;
    setCreateLoading(true);
    setCreateError(null);
    setActionError(null);
    setActionSuccess(null);

    const parsedDate = new Date(createDate);
    const isoDate = Number.isNaN(parsedDate.getTime())
      ? createDate
      : parsedDate.toISOString();

    try {
      const response = await fetch(baseApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: createTitle.trim(),
          meetingDate: isoDate,
          status: createStatus,
          projectId: createProjectId === "" ? null : createProjectId,
          description:
            createDescription.trim() === "" ? null : createDescription.trim(),
          participantIds: createParticipantIds,
          notes: createNotes.trim() === "" ? null : createNotes.trim(),
        }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not create meeting.",
        );
        setCreateError(message);
        return;
      }

      const data = (await response.json()) as { meeting?: MeetingDto };
      setCreateTitle("");
      setCreateDescription("");
      setCreateNotes("");
      setCreateProjectId("");
      setCreateStatus("scheduled");
      setCreateParticipantIds([currentUserId]);
      setShowCreateForm(false);
      setActionSuccess(
        data.meeting
          ? `Created meeting "${data.meeting.title}".`
          : "Meeting created.",
      );
      await fetchMeetings({
        search: searchQuery,
        status: statusFilter,
        archived: archiveFilter,
        projectId: projectFilter,
        page: 1,
      });
      router.refresh();
    } catch {
      setCreateError("Could not reach the server. Please try again.");
    } finally {
      createInFlight.current = false;
      setCreateLoading(false);
    }
  }

  async function onToggleArchiveMeeting(
    meeting: MeetingDto,
    targetArchived: boolean,
  ) {
    if (!canManage || archivingId) return;
    setArchivingId(meeting.id);
    setActionError(null);
    setActionSuccess(null);

    try {
      const response = await fetch(
        `${baseApiUrl}/${encodeURIComponent(meeting.id)}/archive`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: targetArchived }),
        },
      );

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not update meeting archive state.",
        );
        setActionError(message);
        return;
      }

      setActionSuccess(
        targetArchived
          ? `Archived meeting "${meeting.title}".`
          : `Unarchived meeting "${meeting.title}".`,
      );
      await fetchMeetings({
        search: searchQuery,
        status: statusFilter,
        archived: archiveFilter,
        projectId: projectFilter,
        page: pagination.page,
      });
      router.refresh();
    } catch {
      setActionError("Could not reach the server. Please try again.");
    } finally {
      setArchivingId(null);
    }
  }

  const inputClassName =
    "w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white";

  return (
    <div className="flex flex-col gap-6">
      {/* Top Toolbar: Search, Filters & Create Button */}
      <section className="flex flex-col gap-4 rounded border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <form
            onSubmit={handleSearchSubmit}
            className="flex flex-1 items-center gap-2"
          >
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search meetings by title, purpose, notes, or decisions…"
              aria-label="Search meetings"
              data-testid="meetings-search-input"
              className={inputClassName}
            />
            <button
              type="submit"
              disabled={listLoading}
              className="shrink-0 rounded bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Search
            </button>
            {searchQuery.trim() !== "" && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  void fetchMeetings({
                    search: "",
                    status: statusFilter,
                    archived: archiveFilter,
                    projectId: projectFilter,
                    page: 1,
                  });
                }}
                className="shrink-0 rounded border border-zinc-300 px-2.5 py-2 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Clear
              </button>
            )}
          </form>

          {canManage && (
            <button
              type="button"
              data-testid="toggle-create-meeting-btn"
              onClick={() => setShowCreateForm((prev) => !prev)}
              className="rounded bg-black px-3.5 py-2 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              {showCreateForm ? "Cancel" : "+ New meeting"}
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 pt-3 text-xs dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-600 dark:text-zinc-400">
              Status:
            </span>
            <div
              role="group"
              aria-label="Filter meetings by status"
              className="flex items-center gap-1 rounded border border-zinc-200 p-0.5 dark:border-zinc-800"
            >
              {(
                ["all", "scheduled", "completed", "cancelled"] as const
              ).map((opt) => {
                const active = statusFilter === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={listLoading}
                    onClick={() => handleStatusFilterChange(opt)}
                    className={`rounded px-2 py-1 capitalize transition-colors ${
                      active
                        ? "bg-black font-medium text-white dark:bg-white dark:text-black"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    }`}
                  >
                    {opt === "all" ? "All" : MEETING_STATUS_LABELS[opt]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
              <span>Project:</span>
              <select
                value={projectFilter}
                onChange={(e) => handleProjectFilterChange(e.target.value)}
                aria-label="Filter meetings by project"
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
              >
                <option value="all">All projects</option>
                <option value="none">Organization-wide (no project)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.status === "archived" ? " (archived)" : ""}
                  </option>
                ))}
              </select>
            </label>

            <div
              role="group"
              aria-label="Filter meetings by archive state"
              className="flex items-center gap-1 rounded border border-zinc-200 p-0.5 dark:border-zinc-800"
            >
              {(["active", "archived", "all"] as const).map((opt) => {
                const active = archiveFilter === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={listLoading}
                    onClick={() => handleArchiveFilterChange(opt)}
                    className={`rounded px-2 py-1 capitalize transition-colors ${
                      active
                        ? "bg-black font-medium text-white dark:bg-white dark:text-black"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    }`}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Create Meeting Form */}
      {canManage && showCreateForm && (
        <form
          onSubmit={onCreateMeeting}
          data-testid="create-meeting-form"
          className="flex flex-col gap-4 rounded border border-zinc-200 bg-zinc-50/50 p-5 dark:border-zinc-800 dark:bg-zinc-900/40"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Create meeting</h2>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span>Meeting title *</span>
              <input
                type="text"
                required
                maxLength={200}
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                placeholder="Weekly Sprint Planning & Architecture Sync"
                className={inputClassName}
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span>Meeting date &amp; time *</span>
              <input
                type="datetime-local"
                required
                value={createDate}
                onChange={(e) => setCreateDate(e.target.value)}
                className={inputClassName}
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span>Status</span>
              <select
                value={createStatus}
                onChange={(e) =>
                  setCreateStatus(e.target.value as MeetingStatus)
                }
                className={inputClassName}
              >
                <option value="scheduled">Scheduled</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span>
                Associated project{" "}
                <span className="text-zinc-500">(optional)</span>
              </span>
              <select
                value={createProjectId}
                onChange={(e) => setCreateProjectId(e.target.value)}
                className={inputClassName}
              >
                <option value="">None (organization-wide meeting)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.status === "archived" ? " (archived)" : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span>
                Purpose / Description{" "}
                <span className="text-zinc-500">(optional)</span>
              </span>
              <textarea
                rows={2}
                maxLength={5000}
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder="Agenda, goals, and context for this meeting…"
                className={inputClassName}
              />
            </label>

            <div className="flex flex-col gap-1.5 text-sm sm:col-span-2">
              <span>
                Participants{" "}
                <span className="text-xs text-zinc-500">
                  ({createParticipantIds.length} selected)
                </span>
              </span>
              <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto rounded border border-zinc-200 bg-white p-2.5 dark:border-zinc-700 dark:bg-zinc-900">
                {members.map((member) => {
                  const selected = createParticipantIds.includes(member.userId);
                  const display =
                    member.name ?? member.email ?? member.userId;
                  return (
                    <label
                      key={member.userId}
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded border px-2.5 py-1 text-xs transition-colors ${
                        selected
                          ? "border-black bg-zinc-900 text-white dark:border-white dark:bg-zinc-100 dark:text-black"
                          : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleCreateParticipant(member.userId)}
                        className="sr-only"
                      />
                      <span>{display}</span>
                      <span className="opacity-70">({member.role})</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span>
                Initial meeting notes{" "}
                <span className="text-zinc-500">(optional)</span>
              </span>
              <textarea
                rows={3}
                maxLength={20000}
                value={createNotes}
                onChange={(e) => setCreateNotes(e.target.value)}
                placeholder="Initial meeting notes or preparation notes…"
                className={inputClassName}
              />
            </label>
          </div>

          {createError && (
            <p role="alert" className="text-sm text-red-600">
              {createError}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={createLoading}
              className="rounded bg-black px-4 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-white dark:text-black"
            >
              {createLoading ? "Creating meeting…" : "Create meeting"}
            </button>
            <button
              type="button"
              disabled={createLoading}
              onClick={() => setShowCreateForm(false)}
              className="rounded border border-zinc-300 px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Alerts */}
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
        <p
          role="status"
          className="text-sm text-emerald-600 dark:text-emerald-400"
        >
          {actionSuccess}
        </p>
      )}

      {/* Meetings List */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">
            Meeting Records ({pagination.totalCount})
          </h2>
        </div>

        {listLoading ? (
          <p className="rounded border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 dark:border-zinc-700">
            Loading meetings…
          </p>
        ) : meetings.length === 0 ? (
          <p
            data-testid="meetings-empty-state"
            className="rounded border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 dark:border-zinc-700"
          >
            No meetings match the current filters.
          </p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="meetings-list">
            {meetings.map((meeting) => {
              const isArchived = meeting.archivedAt !== null;
              const isBusy = archivingId === meeting.id;
              return (
                <li
                  key={meeting.id}
                  data-testid={`meeting-card-${meeting.id}`}
                  className="flex flex-col gap-3 rounded border border-zinc-200 p-4 dark:border-zinc-800"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-medium">
                          <Link
                            href={`/dashboard/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meeting.id)}`}
                            className="hover:underline"
                          >
                            {meeting.title}
                          </Link>
                        </h3>
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-medium ${MEETING_STATUS_CLASSES[meeting.status]}`}
                        >
                          {MEETING_STATUS_LABELS[meeting.status]}
                        </span>
                        {isArchived && (
                          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                            Archived
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                        <span>
                          Date: {formatMeetingDateTime(meeting.meetingDate)}
                        </span>
                        {meeting.projectId && (
                          <span>
                            Project:{" "}
                            <Link
                              href={`/dashboard/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(meeting.projectId)}`}
                              className="font-medium text-zinc-700 underline dark:text-zinc-300"
                            >
                              {meeting.projectName ?? "Linked project"}
                            </Link>
                          </span>
                        )}
                      </div>

                      {meeting.description ? (
                        <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">
                          {meeting.description}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2">
                      <Link
                        href={`/dashboard/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meeting.id)}`}
                        className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        Open meeting →
                      </Link>
                      {canManage && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void onToggleArchiveMeeting(meeting, !isArchived)
                          }
                          className="rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          {isBusy
                            ? "Updating…"
                            : isArchived
                              ? "Unarchive"
                              : "Archive"}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Summary Metrics Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-2.5 text-xs text-zinc-500 dark:border-zinc-800/80">
                    <div className="flex flex-wrap items-center gap-3">
                      <span>
                        Participants:{" "}
                        <strong className="font-medium text-zinc-700 dark:text-zinc-300">
                          {meeting.participants.length}
                        </strong>
                      </span>
                      <span>
                        Discussion points:{" "}
                        <strong className="font-medium text-zinc-700 dark:text-zinc-300">
                          {meeting.discussionPoints.length}
                        </strong>
                      </span>
                      <span>
                        Decisions:{" "}
                        <strong className="font-medium text-zinc-700 dark:text-zinc-300">
                          {meeting.decisions.length}
                        </strong>
                      </span>
                      <span>
                        Action items:{" "}
                        <strong className="font-medium text-zinc-700 dark:text-zinc-300">
                          {meeting.actionItemCounts.total}
                        </strong>
                        {meeting.actionItemCounts.total > 0 && (
                          <span className="ml-1 text-zinc-400">
                            ({meeting.actionItemCounts.open} open,{" "}
                            {meeting.actionItemCounts.inProgress} in progress,{" "}
                            {meeting.actionItemCounts.completed} completed)
                          </span>
                        )}
                      </span>
                    </div>

                    <span>
                      Created by{" "}
                      {meeting.createdByUser.name ??
                        meeting.createdByUser.email ??
                        meeting.createdBy}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Pagination Controls */}
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-zinc-200 pt-3 text-xs dark:border-zinc-800">
            <span className="text-zinc-500">
              Page {pagination.page} of {pagination.totalPages} (
              {pagination.totalCount} total)
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!pagination.hasPrevPage || listLoading}
                onClick={() =>
                  void fetchMeetings({
                    search: searchQuery,
                    status: statusFilter,
                    archived: archiveFilter,
                    projectId: projectFilter,
                    page: pagination.page - 1,
                  })
                }
                className="rounded border border-zinc-300 px-2.5 py-1 text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!pagination.hasNextPage || listLoading}
                onClick={() =>
                  void fetchMeetings({
                    search: searchQuery,
                    status: statusFilter,
                    archived: archiveFilter,
                    projectId: projectFilter,
                    page: pagination.page + 1,
                  })
                }
                className="rounded border border-zinc-300 px-2.5 py-1 text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

