"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, type SubmitEvent } from "react";
import type {
  MeetingActionItemDto,
  MeetingDecisionDto,
  MeetingDiscussionPointDto,
  MeetingDto,
} from "@/lib/meeting-dto";
import type {
  ActionItemStatus,
  MeetingStatus,
  MembershipRole,
  ProjectStatus,
  TaskStatus,
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

type MeetingDetailClientProps = {
  organizationSlug: string;
  organizationName: string;
  role: MembershipRole;
  currentUserId: string;
  initialMeeting: MeetingDto;
  initialActionItems: MeetingActionItemDto[];
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

const ACTION_ITEM_STATUS_LABELS: Record<ActionItemStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

const ACTION_ITEM_STATUS_CLASSES: Record<ActionItemStatus, string> = {
  open: "bg-blue-100 text-blue-800 dark:bg-blue-950/70 dark:text-blue-300",
  in_progress:
    "bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300",
  completed:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300",
  cancelled:
    "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

const LINKED_TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

const LINKED_TASK_STATUS_CLASSES: Record<TaskStatus, string> = {
  todo: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  in_progress:
    "bg-blue-100 text-blue-800 dark:bg-blue-950/70 dark:text-blue-300",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300",
};

function formatDateTime(isoDate: string): string {
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

function formatDateOnly(isoDate: string | null): string {
  if (!isoDate) return "No target date";
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function isoToDateTimeLocal(isoDate: string): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function isoToDateInput(isoDate: string | null): string {
  if (!isoDate) return "";
  return isoDate.slice(0, 10);
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
    return "The requested record could not be found.";
  }
  if (response.status === 409) {
    return "Cannot modify an archived meeting.";
  }
  return fallbackMessage;
}

export function MeetingDetailClient({
  organizationSlug,
  role,
  currentUserId,
  initialMeeting,
  initialActionItems,
  projects,
  members,
}: MeetingDetailClientProps) {
  const router = useRouter();
  const canManage = role === "admin" || role === "manager";

  const [meeting, setMeeting] = useState<MeetingDto>(initialMeeting);
  const [actionItems, setActionItems] =
    useState<MeetingActionItemDto[]>(initialActionItems);

  const isArchived = meeting.archivedAt !== null;
  const isParticipantOrCreator =
    meeting.createdBy === currentUserId ||
    meeting.participantIds.includes(currentUserId);
  const canEditNotesAndDecisions =
    !isArchived && (canManage || isParticipantOrCreator);

  const meetingApiUrl = `/api/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meeting.id)}`;
  const archiveApiUrl = `${meetingApiUrl}/archive`;
  const participantsApiUrl = `${meetingApiUrl}/participants`;
  const notesApiUrl = `${meetingApiUrl}/notes`;
  const actionItemsApiUrl = `${meetingApiUrl}/action-items`;

  // Global status/error banners
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  // 1. Edit Meeting Metadata state
  const [editingMeeting, setEditingMeeting] = useState(false);
  const [editTitle, setEditTitle] = useState(meeting.title);
  const [editDate, setEditDate] = useState(() =>
    isoToDateTimeLocal(meeting.meetingDate),
  );
  const [editStatus, setEditStatus] = useState<MeetingStatus>(meeting.status);
  const [editProjectId, setEditProjectId] = useState<string>(
    meeting.projectId ?? "",
  );
  const [editDescription, setEditDescription] = useState<string>(
    meeting.description ?? "",
  );
  const [editMeetingBusy, setEditMeetingBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);

  // 2. Participant management state
  const [selectedNewParticipantId, setSelectedNewParticipantId] = useState("");
  const [participantBusy, setParticipantBusy] = useState(false);

  // 3. Discussion Points state
  const [newPointContent, setNewPointContent] = useState("");
  const [editingPointId, setEditingPointId] = useState<string | null>(null);
  const [editingPointContent, setEditingPointContent] = useState("");
  const [pointBusy, setPointBusy] = useState(false);

  // 4. Meeting Notes state
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState<string>(meeting.notes ?? "");
  const [notesBusy, setNotesBusy] = useState(false);

  // 5. Decisions state
  const [newDecisionTitle, setNewDecisionTitle] = useState("");
  const [newDecisionDescription, setNewDecisionDescription] = useState("");
  const [editingDecisionId, setEditingDecisionId] = useState<string | null>(
    null,
  );
  const [editingDecisionTitle, setEditingDecisionTitle] = useState("");
  const [editingDecisionDescription, setEditingDecisionDescription] =
    useState("");
  const [decisionBusy, setDecisionBusy] = useState(false);

  // 6. Action Items state & filters
  const [actionStatusFilter, setActionStatusFilter] = useState<
    "all" | ActionItemStatus
  >("all");
  const [actionOwnerFilter, setActionOwnerFilter] = useState<string>("all");
  const [actionItemsLoading, setActionItemsLoading] = useState(false);

  const [newActionTitle, setNewActionTitle] = useState("");
  const [newActionDescription, setNewActionDescription] = useState("");
  const [newActionOwnerId, setNewActionOwnerId] = useState<string>("");
  const [newActionTargetDate, setNewActionTargetDate] = useState<string>("");
  const [newActionStatus, setNewActionStatus] =
    useState<ActionItemStatus>("open");
  const [createActionBusy, setCreateActionBusy] = useState(false);

  const [editingActionId, setEditingActionId] = useState<string | null>(null);
  const [editActionTitle, setEditActionTitle] = useState("");
  const [editActionDescription, setEditActionDescription] = useState("");
  const [editActionOwnerId, setEditActionOwnerId] = useState<string>("");
  const [editActionTargetDate, setEditActionTargetDate] = useState<string>("");
  const [editActionStatus, setEditActionStatus] =
    useState<ActionItemStatus>("open");
  const [actionItemBusyId, setActionItemBusyId] = useState<string | null>(null);
  const [convertingActionItemId, setConvertingActionItemId] = useState<
    string | null
  >(null);
  const [selectedConvertProjectId, setSelectedConvertProjectId] =
    useState<string>("");

  const createActionInFlight = useRef(false);
  const convertActionInFlight = useRef<Set<string>>(new Set());

  const refreshMeetingAndActionItems = useCallback(
    async (statusFilterVal = actionStatusFilter, ownerFilterVal = actionOwnerFilter) => {
      try {
        const params = new URLSearchParams();
        if (statusFilterVal !== "all") {
          params.set("status", statusFilterVal);
        }
        if (ownerFilterVal !== "all") {
          params.set("ownerId", ownerFilterVal);
        }
        const query = params.toString() ? `?${params.toString()}` : "";

        const [meetingRes, itemsRes] = await Promise.all([
          fetch(meetingApiUrl, { method: "GET", cache: "no-store" }),
          fetch(`${actionItemsApiUrl}${query}`, {
            method: "GET",
            cache: "no-store",
          }),
        ]);

        if (meetingRes.status === 401 || itemsRes.status === 401) {
          router.push("/login");
          return;
        }

        if (meetingRes.ok) {
          const mData = (await meetingRes.json()) as { meeting?: MeetingDto };
          if (mData.meeting) {
            setMeeting(mData.meeting);
          }
        }
        if (itemsRes.ok) {
          const aData = (await itemsRes.json()) as {
            actionItems?: MeetingActionItemDto[];
          };
          if (Array.isArray(aData.actionItems)) {
            setActionItems(aData.actionItems);
          }
        }
      } catch {
        // Ignore background refresh error
      }
    },
    [actionItemsApiUrl, actionOwnerFilter, actionStatusFilter, meetingApiUrl, router],
  );

  // --- 1. Meeting Metadata Handlers ---
  function startEditingMeeting() {
    if (!canManage || isArchived) return;
    setEditTitle(meeting.title);
    setEditDate(isoToDateTimeLocal(meeting.meetingDate));
    setEditStatus(meeting.status);
    setEditProjectId(meeting.projectId ?? "");
    setEditDescription(meeting.description ?? "");
    setEditingMeeting(true);
    setBannerError(null);
    setBannerSuccess(null);
  }

  async function onSaveMeetingDetails(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || editMeetingBusy) return;
    setEditMeetingBusy(true);
    setBannerError(null);
    setBannerSuccess(null);

    const parsedDate = new Date(editDate);
    const isoDate = Number.isNaN(parsedDate.getTime())
      ? editDate
      : parsedDate.toISOString();

    try {
      const response = await fetch(meetingApiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          meetingDate: isoDate,
          status: editStatus,
          projectId: editProjectId === "" ? null : editProjectId,
          description:
            editDescription.trim() === "" ? null : editDescription.trim(),
        }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not update meeting details.",
        );
        setBannerError(message);
        return;
      }

      const data = (await response.json()) as { meeting?: MeetingDto };
      if (data.meeting) {
        setMeeting(data.meeting);
      }
      setEditingMeeting(false);
      setBannerSuccess("Meeting details updated.");
      router.refresh();
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setEditMeetingBusy(false);
    }
  }

  async function onToggleArchive(targetArchived: boolean) {
    if (!canManage || archiveBusy) return;
    setArchiveBusy(true);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(archiveApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: targetArchived }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not update archive status.",
        );
        setBannerError(message);
        return;
      }

      const data = (await response.json()) as { meeting?: MeetingDto };
      if (data.meeting) {
        setMeeting(data.meeting);
      }
      setEditingMeeting(false);
      setEditingNotes(false);
      setEditingPointId(null);
      setEditingDecisionId(null);
      setEditingActionId(null);
      setBannerSuccess(
        targetArchived ? "Meeting archived." : "Meeting unarchived.",
      );
      router.refresh();
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setArchiveBusy(false);
    }
  }

  // --- 2. Participant Handlers ---
  const nonParticipantMembers = members.filter(
    (m) => !meeting.participantIds.includes(m.userId),
  );

  async function onAddParticipant(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || isArchived || participantBusy || !selectedNewParticipantId)
      return;
    setParticipantBusy(true);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(participantsApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: selectedNewParticipantId }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not add participant.",
        );
        setBannerError(message);
        return;
      }

      const data = (await response.json()) as { meeting?: MeetingDto };
      if (data.meeting) {
        setMeeting(data.meeting);
      }
      setSelectedNewParticipantId("");
      setBannerSuccess("Participant added to meeting.");
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setParticipantBusy(false);
    }
  }

  async function onRemoveParticipant(userId: string) {
    if (!canManage || isArchived || participantBusy) return;
    setParticipantBusy(true);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(
        `${participantsApiUrl}?userId=${encodeURIComponent(userId)}`,
        {
          method: "DELETE",
        },
      );

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not remove participant.",
        );
        setBannerError(message);
        return;
      }

      const data = (await response.json()) as { meeting?: MeetingDto };
      if (data.meeting) {
        setMeeting(data.meeting);
      }
      setBannerSuccess("Participant removed from meeting.");
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setParticipantBusy(false);
    }
  }

  // --- 3. Discussion Points Handlers ---
  async function onAddDiscussionPoint(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEditNotesAndDecisions || pointBusy || !newPointContent.trim())
      return;
    setPointBusy(true);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(notesApiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addDiscussionPoint: { content: newPointContent.trim() },
        }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not add discussion point.",
        );
        setBannerError(message);
        return;
      }

      const data = (await response.json()) as { meeting?: MeetingDto };
      if (data.meeting) {
        setMeeting(data.meeting);
      }
      setNewPointContent("");
      setBannerSuccess("Discussion point recorded.");
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setPointBusy(false);
    }
  }

  async function onSaveEditDiscussionPoint(
    event: SubmitEvent<HTMLFormElement>,
    pointId: string,
  ) {
    event.preventDefault();
    if (
      !canEditNotesAndDecisions ||
      pointBusy ||
      !editingPointContent.trim()
    ) {
      return;
    }
    setPointBusy(true);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(notesApiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updateDiscussionPoint: {
            id: pointId,
            content: editingPointContent.trim(),
          },
        }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not update discussion point.",
        );
        setBannerError(message);
        return;
      }

      const data = (await response.json()) as { meeting?: MeetingDto };
      if (data.meeting) {
        setMeeting(data.meeting);
      }
      setEditingPointId(null);
      setEditingPointContent("");
      setBannerSuccess("Discussion point updated.");
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setPointBusy(false);
    }
  }

  async function onRemoveDiscussionPoint(pointId: string) {
    if (!canEditNotesAndDecisions || pointBusy) return;
    setPointBusy(true);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(notesApiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          removeDiscussionPointId: pointId,
        }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not remove discussion point.",
        );
        setBannerError(message);
        return;
      }

      const data = (await response.json()) as { meeting?: MeetingDto };
      if (data.meeting) {
        setMeeting(data.meeting);
      }
      setBannerSuccess("Discussion point removed.");
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setPointBusy(false);
    }
  }

  // --- 4. General Meeting Notes Handlers ---
  async function onSaveNotes(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEditNotesAndDecisions || notesBusy) return;
    setNotesBusy(true);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(notesApiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: notesDraft.trim() === "" ? null : notesDraft,
        }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not save meeting notes.",
        );
        setBannerError(message);
        return;
      }

      const data = (await response.json()) as { meeting?: MeetingDto };
      if (data.meeting) {
        setMeeting(data.meeting);
        setNotesDraft(data.meeting.notes ?? "");
      }
      setEditingNotes(false);
      setBannerSuccess("Meeting notes saved.");
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setNotesBusy(false);
    }
  }

  // --- 5. Decisions Handlers ---
  async function onAddDecision(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !canEditNotesAndDecisions ||
      decisionBusy ||
      !newDecisionTitle.trim()
    ) {
      return;
    }
    setDecisionBusy(true);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(notesApiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addDecision: {
            title: newDecisionTitle.trim(),
            description:
              newDecisionDescription.trim() === ""
                ? null
                : newDecisionDescription.trim(),
          },
        }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not record decision.",
        );
        setBannerError(message);
        return;
      }

      const data = (await response.json()) as { meeting?: MeetingDto };
      if (data.meeting) {
        setMeeting(data.meeting);
      }
      setNewDecisionTitle("");
      setNewDecisionDescription("");
      setBannerSuccess("Decision recorded.");
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setDecisionBusy(false);
    }
  }

  async function onSaveEditDecision(
    event: SubmitEvent<HTMLFormElement>,
    decisionId: string,
  ) {
    event.preventDefault();
    if (
      !canEditNotesAndDecisions ||
      decisionBusy ||
      !editingDecisionTitle.trim()
    ) {
      return;
    }
    setDecisionBusy(true);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(notesApiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updateDecision: {
            id: decisionId,
            title: editingDecisionTitle.trim(),
            description:
              editingDecisionDescription.trim() === ""
                ? null
                : editingDecisionDescription.trim(),
          },
        }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not update decision.",
        );
        setBannerError(message);
        return;
      }

      const data = (await response.json()) as { meeting?: MeetingDto };
      if (data.meeting) {
        setMeeting(data.meeting);
      }
      setEditingDecisionId(null);
      setEditingDecisionTitle("");
      setEditingDecisionDescription("");
      setBannerSuccess("Decision updated.");
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setDecisionBusy(false);
    }
  }

  async function onRemoveDecision(decisionId: string) {
    if (!canEditNotesAndDecisions || decisionBusy) return;
    setDecisionBusy(true);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(notesApiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          removeDecisionId: decisionId,
        }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not remove decision.",
        );
        setBannerError(message);
        return;
      }

      const data = (await response.json()) as { meeting?: MeetingDto };
      if (data.meeting) {
        setMeeting(data.meeting);
      }
      setBannerSuccess("Decision removed.");
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setDecisionBusy(false);
    }
  }

  // --- 6. Action Items Handlers ---
  async function applyActionItemFilters(
    nextStatus: "all" | ActionItemStatus,
    nextOwner: string,
  ) {
    setActionStatusFilter(nextStatus);
    setActionOwnerFilter(nextOwner);
    setActionItemsLoading(true);
    try {
      const params = new URLSearchParams();
      if (nextStatus !== "all") {
        params.set("status", nextStatus);
      }
      if (nextOwner !== "all") {
        params.set("ownerId", nextOwner);
      }
      const query = params.toString() ? `?${params.toString()}` : "";
      const response = await fetch(`${actionItemsApiUrl}${query}`, {
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
          "Could not filter action items.",
        );
        setBannerError(message);
        return;
      }
      const data = (await response.json()) as {
        actionItems?: MeetingActionItemDto[];
      };
      setActionItems(Array.isArray(data.actionItems) ? data.actionItems : []);
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setActionItemsLoading(false);
    }
  }

  async function onCreateActionItem(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isArchived || createActionInFlight.current || !newActionTitle.trim()) {
      return;
    }
    createActionInFlight.current = true;
    setCreateActionBusy(true);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(actionItemsApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newActionTitle.trim(),
          description:
            newActionDescription.trim() === ""
              ? null
              : newActionDescription.trim(),
          ownerId: newActionOwnerId === "" ? null : newActionOwnerId,
          targetDate: newActionTargetDate === "" ? null : newActionTargetDate,
          status: newActionStatus,
        }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not create action item.",
        );
        setBannerError(message);
        return;
      }

      setNewActionTitle("");
      setNewActionDescription("");
      setNewActionOwnerId("");
      setNewActionTargetDate("");
      setNewActionStatus("open");
      setBannerSuccess("Action item created.");
      await refreshMeetingAndActionItems(actionStatusFilter, actionOwnerFilter);
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      createActionInFlight.current = false;
      setCreateActionBusy(false);
    }
  }

  function startEditingActionItem(item: MeetingActionItemDto) {
    if (isArchived) return;
    setEditingActionId(item.id);
    setEditActionTitle(item.title);
    setEditActionDescription(item.description ?? "");
    setEditActionOwnerId(item.ownerId ?? "");
    setEditActionTargetDate(isoToDateInput(item.targetDate));
    setEditActionStatus(item.status);
    setBannerError(null);
    setBannerSuccess(null);
  }

  async function onSaveEditActionItem(
    event: SubmitEvent<HTMLFormElement>,
    actionItemId: string,
  ) {
    event.preventDefault();
    if (isArchived || actionItemBusyId) return;
    setActionItemBusyId(actionItemId);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(
        `${actionItemsApiUrl}/${encodeURIComponent(actionItemId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: editActionTitle.trim(),
            description:
              editActionDescription.trim() === ""
                ? null
                : editActionDescription.trim(),
            ownerId: editActionOwnerId === "" ? null : editActionOwnerId,
            targetDate:
              editActionTargetDate === "" ? null : editActionTargetDate,
            status: editActionStatus,
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
          "Could not update action item.",
        );
        setBannerError(message);
        return;
      }

      setEditingActionId(null);
      setBannerSuccess("Action item updated.");
      await refreshMeetingAndActionItems(actionStatusFilter, actionOwnerFilter);
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setActionItemBusyId(null);
    }
  }

  async function onQuickChangeActionStatus(
    item: MeetingActionItemDto,
    nextStatus: ActionItemStatus,
  ) {
    if (isArchived || actionItemBusyId || item.status === nextStatus) return;
    setActionItemBusyId(item.id);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(
        `${actionItemsApiUrl}/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        },
      );

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not update action item status.",
        );
        setBannerError(message);
        return;
      }

      setBannerSuccess(
        `Action item "${item.title}" marked ${ACTION_ITEM_STATUS_LABELS[nextStatus]}.`,
      );
      await refreshMeetingAndActionItems(actionStatusFilter, actionOwnerFilter);
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      setActionItemBusyId(null);
    }
  }

  function canUserModifyActionItem(item: MeetingActionItemDto): boolean {
    if (isArchived) return false;
    if (canManage) return true;
    return (
      item.ownerId === currentUserId ||
      item.createdBy === currentUserId ||
      isParticipantOrCreator
    );
  }

  const activeProjects = projects.filter((p) => p.status === "active");

  function canUserConvertActionItem(item: MeetingActionItemDto): boolean {
    if (isArchived) return false;
    if (item.linkedTaskId !== null || item.linkedTask !== null) return false;
    if (!canUserModifyActionItem(item)) return false;
    if (
      !canManage &&
      item.ownerId !== null &&
      item.ownerId !== currentUserId
    ) {
      return false;
    }
    return true;
  }

  async function onConvertActionItem(
    item: MeetingActionItemDto,
    explicitProjectId?: string | null,
  ) {
    if (
      isArchived ||
      actionItemBusyId ||
      convertActionInFlight.current.has(item.id)
    ) {
      return;
    }

    const targetProjectId =
      meeting.projectId ??
      (explicitProjectId && explicitProjectId.trim() !== ""
        ? explicitProjectId.trim()
        : null);

    if (!meeting.projectId && !targetProjectId) {
      setBannerError(
        "Please select an active project before converting this action item to a task.",
      );
      return;
    }

    convertActionInFlight.current.add(item.id);
    setActionItemBusyId(item.id);
    setBannerError(null);
    setBannerSuccess(null);

    try {
      const response = await fetch(
        `${actionItemsApiUrl}/${encodeURIComponent(item.id)}/convert`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            meeting.projectId ? {} : { projectId: targetProjectId },
          ),
        },
      );

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not convert action item to task.",
        );
        setBannerError(message);
        return;
      }

      const data = (await response.json()) as {
        created?: boolean;
        actionItem?: MeetingActionItemDto;
        task?: { id: string; title: string; projectName: string };
      };

      if (data.actionItem) {
        setActionItems((prev) =>
          prev.map((row) => (row.id === item.id ? data.actionItem! : row)),
        );
      }
      setConvertingActionItemId(null);
      setBannerSuccess(
        data.created === false
          ? `Action item "${item.title}" is already linked to task "${data.task?.title ?? item.title}".`
          : `Converted action item "${item.title}" into task in project "${data.task?.projectName ?? "project"}".`,
      );
      await refreshMeetingAndActionItems(actionStatusFilter, actionOwnerFilter);
    } catch {
      setBannerError("Could not reach the server. Please try again.");
    } finally {
      convertActionInFlight.current.delete(item.id);
      setActionItemBusyId(null);
    }
  }

  function onInitiateConvertActionItem(item: MeetingActionItemDto) {
    if (meeting.projectId) {
      void onConvertActionItem(item, meeting.projectId);
      return;
    }
    setConvertingActionItemId(item.id);
    setSelectedConvertProjectId(activeProjects[0]?.id ?? "");
    setBannerError(null);
  }

  const inputClassName =
    "w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white";

  const assignableMembers = canManage
    ? members
    : members.filter((m) => m.userId === currentUserId);

  return (
    <div className="flex flex-col gap-6">
      {bannerError && (
        <p
          role="alert"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        >
          {bannerError}
        </p>
      )}
      {bannerSuccess && (
        <p
          role="status"
          className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {bannerSuccess}
        </p>
      )}

      {/* 1. Meeting Header & Metadata Section (Phase 6.1) */}
      <section
        aria-label="Meeting Details"
        className="flex flex-col gap-4 rounded border border-zinc-200 p-5 dark:border-zinc-800"
      >
        {editingMeeting ? (
          <form
            onSubmit={onSaveMeetingDetails}
            data-testid="edit-meeting-form"
            className="flex flex-col gap-4"
          >
            <h2 className="text-lg font-medium">Edit meeting details</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                <span>Meeting title *</span>
                <input
                  type="text"
                  required
                  maxLength={200}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className={inputClassName}
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span>Meeting date &amp; time *</span>
                <input
                  type="datetime-local"
                  required
                  value={editDate}
                  onChange={(e) => setEditDate(e.target.value)}
                  className={inputClassName}
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span>Status</span>
                <select
                  value={editStatus}
                  onChange={(e) =>
                    setEditStatus(e.target.value as MeetingStatus)
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
                  value={editProjectId}
                  onChange={(e) => setEditProjectId(e.target.value)}
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
                  rows={3}
                  maxLength={5000}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className={inputClassName}
                />
              </label>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={editMeetingBusy}
                className="rounded bg-black px-4 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-white dark:text-black"
              >
                {editMeetingBusy ? "Saving…" : "Save changes"}
              </button>
              <button
                type="button"
                disabled={editMeetingBusy}
                onClick={() => setEditingMeeting(false)}
                className="rounded border border-zinc-300 px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold">{meeting.title}</h1>
                  <span
                    className={`rounded px-2.5 py-0.5 text-xs font-medium ${MEETING_STATUS_CLASSES[meeting.status]}`}
                  >
                    {MEETING_STATUS_LABELS[meeting.status]}
                  </span>
                  {isArchived && (
                    <span className="rounded bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      Archived
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-500">
                  <span>
                    Scheduled for:{" "}
                    <strong className="font-medium text-zinc-800 dark:text-zinc-200">
                      {formatDateTime(meeting.meetingDate)}
                    </strong>
                  </span>
                  {meeting.projectId ? (
                    <span>
                      Project:{" "}
                      <Link
                        href={`/dashboard/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(meeting.projectId)}`}
                        className="font-medium text-zinc-800 underline dark:text-zinc-200"
                      >
                        {meeting.projectName ?? "Linked project"}
                      </Link>
                    </span>
                  ) : (
                    <span>Scope: Organization-wide</span>
                  )}
                  <span>
                    Created by{" "}
                    {meeting.createdByUser.name ??
                      meeting.createdByUser.email ??
                      meeting.createdBy}
                  </span>
                </div>
              </div>

              {canManage && (
                <div className="flex items-center gap-2">
                  {!isArchived && (
                    <button
                      type="button"
                      data-testid="edit-meeting-btn"
                      onClick={startEditingMeeting}
                      className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      Edit details
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="archive-meeting-btn"
                    disabled={archiveBusy}
                    onClick={() => void onToggleArchive(!isArchived)}
                    className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {archiveBusy
                      ? "Updating…"
                      : isArchived
                        ? "Unarchive meeting"
                        : "Archive meeting"}
                  </button>
                </div>
              )}
            </div>

            {meeting.description ? (
              <p className="whitespace-pre-wrap border-t border-zinc-100 pt-3 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
                {meeting.description}
              </p>
            ) : (
              <p className="border-t border-zinc-100 pt-3 text-xs italic text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                No meeting description or agenda provided.
              </p>
            )}
          </>
        )}
      </section>

      {/* 2. Participants Section (Phase 6.2) */}
      <section
        aria-label="Meeting Participants"
        data-testid="meeting-participants-section"
        className="flex flex-col gap-3 rounded border border-zinc-200 p-5 dark:border-zinc-800"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium">Participants</h2>
            <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {meeting.participants.length}
            </span>
          </div>

          {canManage && !isArchived && nonParticipantMembers.length > 0 && (
            <form
              onSubmit={onAddParticipant}
              className="flex items-center gap-2"
            >
              <select
                value={selectedNewParticipantId}
                onChange={(e) => setSelectedNewParticipantId(e.target.value)}
                aria-label="Add participant"
                className="rounded border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
              >
                <option value="">Select member to add…</option>
                {nonParticipantMembers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name ? `${m.name} (${m.email ?? m.userId})` : (m.email ?? m.userId)}{" "}
                    — {m.role}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={!selectedNewParticipantId || participantBusy}
                className="rounded bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black"
              >
                Add participant
              </button>
            </form>
          )}
        </div>

        {meeting.participants.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-xs text-zinc-500 dark:border-zinc-700">
            No participants recorded for this meeting yet.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {meeting.participants.map((p) => (
              <li
                key={p.userId}
                className="inline-flex items-center gap-2 rounded border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-900"
              >
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {p.name ?? p.email ?? p.userId}
                </span>
                {p.name && p.email && (
                  <span className="text-zinc-500">({p.email})</span>
                )}
                {p.role && (
                  <span className="rounded bg-zinc-200/80 px-1.5 py-0.5 text-[10px] font-medium capitalize text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {p.role}
                  </span>
                )}
                {canManage && !isArchived && (
                  <button
                    type="button"
                    disabled={participantBusy}
                    onClick={() => void onRemoveParticipant(p.userId)}
                    aria-label={`Remove ${p.name ?? p.userId}`}
                    className="ml-1 text-zinc-400 hover:text-red-600 disabled:opacity-50"
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. Discussion Points Section (Phase 6.2 — What Was Discussed) */}
      <section
        aria-label="Discussion Points"
        data-testid="meeting-discussion-points-section"
        className="flex flex-col gap-3 rounded border border-zinc-200 p-5 dark:border-zinc-800"
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-medium">Discussion Points</h2>
              <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                {meeting.discussionPoints.length}
              </span>
            </div>
            <p className="text-xs text-zinc-500">
              Key topics and observations discussed during the meeting.
            </p>
          </div>
        </div>

        {meeting.discussionPoints.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-xs text-zinc-500 dark:border-zinc-700">
            No discussion points recorded yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {meeting.discussionPoints.map((pt: MeetingDiscussionPointDto) => {
              const isEditingThis = editingPointId === pt.id;
              return (
                <li
                  key={pt.id}
                  className="flex flex-col gap-2 rounded border border-zinc-200/80 bg-zinc-50/60 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/40"
                >
                  {isEditingThis ? (
                    <form
                      onSubmit={(e) => void onSaveEditDiscussionPoint(e, pt.id)}
                      className="flex flex-col gap-2"
                    >
                      <textarea
                        rows={2}
                        required
                        maxLength={5000}
                        value={editingPointContent}
                        onChange={(e) => setEditingPointContent(e.target.value)}
                        className={inputClassName}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="submit"
                          disabled={pointBusy}
                          className="rounded bg-black px-3 py-1 text-xs font-medium text-white dark:bg-white dark:text-black"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingPointId(null);
                            setEditingPointContent("");
                          }}
                          className="rounded border border-zinc-300 px-3 py-1 text-xs dark:border-zinc-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <p className="whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">
                        {pt.content}
                      </p>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
                        <span>
                          Added by{" "}
                          {pt.authorName ?? pt.authorEmail ?? pt.authorId} ·{" "}
                          {formatDateTime(pt.updatedAt)}
                        </span>
                        {canEditNotesAndDecisions && (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={pointBusy}
                              onClick={() => {
                                setEditingPointId(pt.id);
                                setEditingPointContent(pt.content);
                              }}
                              className="text-zinc-600 underline hover:text-black dark:text-zinc-400 dark:hover:text-white"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={pointBusy}
                              onClick={() => void onRemoveDiscussionPoint(pt.id)}
                              className="text-red-600 underline hover:text-red-700 dark:text-red-400"
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {canEditNotesAndDecisions && (
          <form
            onSubmit={onAddDiscussionPoint}
            className="mt-1 flex flex-col gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800"
          >
            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Add discussion point
              <textarea
                rows={2}
                required
                maxLength={5000}
                value={newPointContent}
                onChange={(e) => setNewPointContent(e.target.value)}
                placeholder="Record a topic or point discussed…"
                className={inputClassName}
              />
            </label>
            <button
              type="submit"
              disabled={pointBusy || !newPointContent.trim()}
              className="self-start rounded bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black"
            >
              Add discussion point
            </button>
          </form>
        )}
      </section>

      {/* 4. General Meeting Notes Section (Phase 6.2) */}
      <section
        aria-label="Meeting Notes"
        data-testid="meeting-notes-section"
        className="flex flex-col gap-3 rounded border border-zinc-200 p-5 dark:border-zinc-800"
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-medium">Meeting Notes</h2>
            <p className="text-xs text-zinc-500">
              Free-form collaborative notes and context from the meeting.
            </p>
          </div>
          {canEditNotesAndDecisions && !editingNotes && (
            <button
              type="button"
              onClick={() => {
                setNotesDraft(meeting.notes ?? "");
                setEditingNotes(true);
              }}
              className="rounded border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {meeting.notes ? "Edit notes" : "Add notes"}
            </button>
          )}
        </div>

        {editingNotes ? (
          <form onSubmit={onSaveNotes} className="flex flex-col gap-2">
            <textarea
              rows={5}
              maxLength={20000}
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              placeholder="Write detailed meeting notes…"
              className={inputClassName}
            />
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={notesBusy}
                className="rounded bg-black px-3.5 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black"
              >
                {notesBusy ? "Saving…" : "Save notes"}
              </button>
              <button
                type="button"
                disabled={notesBusy}
                onClick={() => setEditingNotes(false)}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : meeting.notes ? (
          <div className="whitespace-pre-wrap rounded border border-zinc-200/80 bg-zinc-50/60 p-3.5 text-sm text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-200">
            {meeting.notes}
          </div>
        ) : (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-xs text-zinc-500 dark:border-zinc-700">
            No meeting notes recorded yet.
          </p>
        )}
      </section>

      {/* 5. Decisions Section (Phase 6.2 — What Was Agreed) */}
      <section
        aria-label="Meeting Decisions"
        data-testid="meeting-decisions-section"
        className="flex flex-col gap-3 rounded border border-zinc-200 p-5 dark:border-zinc-800"
      >
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium">Decisions</h2>
            <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300">
              {meeting.decisions.length}
            </span>
          </div>
          <p className="text-xs text-zinc-500">
            Formal agreements and decisions finalized during this meeting.
          </p>
        </div>

        {meeting.decisions.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-xs text-zinc-500 dark:border-zinc-700">
            No decisions recorded for this meeting yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {meeting.decisions.map((dec: MeetingDecisionDto) => {
              const isEditingThis = editingDecisionId === dec.id;
              return (
                <li
                  key={dec.id}
                  className="flex flex-col gap-2 rounded border border-emerald-200/80 bg-emerald-50/30 p-3.5 text-sm dark:border-emerald-900/50 dark:bg-emerald-950/20"
                >
                  {isEditingThis ? (
                    <form
                      onSubmit={(e) => void onSaveEditDecision(e, dec.id)}
                      className="flex flex-col gap-2"
                    >
                      <input
                        type="text"
                        required
                        maxLength={300}
                        value={editingDecisionTitle}
                        onChange={(e) =>
                          setEditingDecisionTitle(e.target.value)
                        }
                        placeholder="Decision summary"
                        className={inputClassName}
                      />
                      <textarea
                        rows={2}
                        maxLength={5000}
                        value={editingDecisionDescription}
                        onChange={(e) =>
                          setEditingDecisionDescription(e.target.value)
                        }
                        placeholder="Rationale or supporting details (optional)"
                        className={inputClassName}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="submit"
                          disabled={decisionBusy}
                          className="rounded bg-black px-3 py-1 text-xs font-medium text-white dark:bg-white dark:text-black"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingDecisionId(null);
                            setEditingDecisionTitle("");
                            setEditingDecisionDescription("");
                          }}
                          className="rounded border border-zinc-300 px-3 py-1 text-xs dark:border-zinc-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-medium text-zinc-900 dark:text-zinc-100">
                          {dec.title}
                        </h3>
                        <span className="shrink-0 rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                          Agreed
                        </span>
                      </div>
                      {dec.description && (
                        <p className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">
                          {dec.description}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
                        <span>
                          Recorded by{" "}
                          {dec.decidedByName ??
                            dec.decidedByEmail ??
                            dec.decidedBy}{" "}
                          · {formatDateTime(dec.updatedAt)}
                        </span>
                        {canEditNotesAndDecisions && (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={decisionBusy}
                              onClick={() => {
                                setEditingDecisionId(dec.id);
                                setEditingDecisionTitle(dec.title);
                                setEditingDecisionDescription(
                                  dec.description ?? "",
                                );
                              }}
                              className="text-zinc-600 underline hover:text-black dark:text-zinc-400 dark:hover:text-white"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={decisionBusy}
                              onClick={() => void onRemoveDecision(dec.id)}
                              className="text-red-600 underline hover:text-red-700 dark:text-red-400"
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {canEditNotesAndDecisions && (
          <form
            onSubmit={onAddDecision}
            className="mt-1 flex flex-col gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800"
          >
            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Record a decision
            </span>
            <input
              type="text"
              required
              maxLength={300}
              value={newDecisionTitle}
              onChange={(e) => setNewDecisionTitle(e.target.value)}
              placeholder="What was decided? (e.g. Adopt cursor-based pagination for activity feed)"
              className={inputClassName}
            />
            <textarea
              rows={2}
              maxLength={5000}
              value={newDecisionDescription}
              onChange={(e) => setNewDecisionDescription(e.target.value)}
              placeholder="Rationale, context, or constraints (optional)"
              className={inputClassName}
            />
            <button
              type="submit"
              disabled={decisionBusy || !newDecisionTitle.trim()}
              className="self-start rounded bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black"
            >
              Record decision
            </button>
          </form>
        )}
      </section>

      {/* 6. Action Items Section (Phase 6.3) */}
      <section
        aria-label="Meeting Action Items"
        data-testid="meeting-action-items-section"
        className="flex flex-col gap-4 rounded border border-zinc-200 p-5 dark:border-zinc-800"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-medium">Action Items</h2>
              <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {meeting.actionItemCounts.total}
              </span>
            </div>
            <p className="text-xs text-zinc-500">
              Follow-up items, owners, target dates, and completion status.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">
              Open: {meeting.actionItemCounts.open}
            </span>
            <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
              In Progress: {meeting.actionItemCounts.inProgress}
            </span>
            <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
              Completed: {meeting.actionItemCounts.completed}
            </span>
            <span className="rounded bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              Cancelled: {meeting.actionItemCounts.cancelled}
            </span>
          </div>
        </div>

        {/* Action Item Filters */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-y border-zinc-100 py-2.5 text-xs dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-zinc-600 dark:text-zinc-400">
              Status:
            </span>
            <div
              role="group"
              aria-label="Filter action items by status"
              className="flex flex-wrap items-center gap-1 rounded border border-zinc-200 p-0.5 dark:border-zinc-800"
            >
              {(
                [
                  "all",
                  "open",
                  "in_progress",
                  "completed",
                  "cancelled",
                ] as const
              ).map((st) => {
                const active = actionStatusFilter === st;
                return (
                  <button
                    key={st}
                    type="button"
                    disabled={actionItemsLoading}
                    onClick={() =>
                      void applyActionItemFilters(st, actionOwnerFilter)
                    }
                    className={`rounded px-2 py-1 transition-colors ${
                      active
                        ? "bg-black font-medium text-white dark:bg-white dark:text-black"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    }`}
                  >
                    {st === "all" ? "All" : ACTION_ITEM_STATUS_LABELS[st]}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
            <span>Owner:</span>
            <select
              value={actionOwnerFilter}
              onChange={(e) =>
                void applyActionItemFilters(actionStatusFilter, e.target.value)
              }
              aria-label="Filter action items by owner"
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
            >
              <option value="all">All owners</option>
              <option value="unassigned">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name ?? m.email ?? m.userId} ({m.role})
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Action Items List */}
        {actionItemsLoading ? (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-xs text-zinc-500 dark:border-zinc-700">
            Loading action items…
          </p>
        ) : actionItems.length === 0 ? (
          <p
            data-testid="action-items-empty-state"
            className="rounded border border-dashed border-zinc-300 p-4 text-xs text-zinc-500 dark:border-zinc-700"
          >
            No action items match the selected filters.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5" data-testid="action-items-list">
            {actionItems.map((item) => {
              const isEditingThis = editingActionId === item.id;
              const isBusy = actionItemBusyId === item.id;
              const canModify = canUserModifyActionItem(item);

              return (
                <li
                  key={item.id}
                  data-testid={`action-item-${item.id}`}
                  className="flex flex-col gap-2.5 rounded border border-zinc-200 p-3.5 text-sm dark:border-zinc-800"
                >
                  {isEditingThis ? (
                    <form
                      onSubmit={(e) => void onSaveEditActionItem(e, item.id)}
                      className="flex flex-col gap-3"
                    >
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <label className="flex flex-col gap-1 text-xs sm:col-span-3">
                          <span>Action item title *</span>
                          <input
                            type="text"
                            required
                            maxLength={300}
                            value={editActionTitle}
                            onChange={(e) => setEditActionTitle(e.target.value)}
                            className={inputClassName}
                          />
                        </label>

                        <label className="flex flex-col gap-1 text-xs">
                          <span>Owner</span>
                          <select
                            value={editActionOwnerId}
                            onChange={(e) =>
                              setEditActionOwnerId(e.target.value)
                            }
                            className={inputClassName}
                          >
                            <option value="">Unassigned</option>
                            {assignableMembers.map((m) => (
                              <option key={m.userId} value={m.userId}>
                                {m.name ?? m.email ?? m.userId} ({m.role})
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="flex flex-col gap-1 text-xs">
                          <span>Target date</span>
                          <input
                            type="date"
                            value={editActionTargetDate}
                            onChange={(e) =>
                              setEditActionTargetDate(e.target.value)
                            }
                            className={inputClassName}
                          />
                        </label>

                        <label className="flex flex-col gap-1 text-xs">
                          <span>Status</span>
                          <select
                            value={editActionStatus}
                            onChange={(e) =>
                              setEditActionStatus(
                                e.target.value as ActionItemStatus,
                              )
                            }
                            className={inputClassName}
                          >
                            <option value="open">Open</option>
                            <option value="in_progress">In Progress</option>
                            <option value="completed">Completed</option>
                            <option value="cancelled">Cancelled</option>
                          </select>
                        </label>

                        <label className="flex flex-col gap-1 text-xs sm:col-span-3">
                          <span>Description (optional)</span>
                          <textarea
                            rows={2}
                            maxLength={5000}
                            value={editActionDescription}
                            onChange={(e) =>
                              setEditActionDescription(e.target.value)
                            }
                            className={inputClassName}
                          />
                        </label>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="submit"
                          disabled={isBusy}
                          className="rounded bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
                        >
                          {isBusy ? "Saving…" : "Save changes"}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => setEditingActionId(null)}
                          className="rounded border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`font-medium ${
                                item.status === "completed"
                                  ? "line-through text-zinc-500"
                                  : item.status === "cancelled"
                                    ? "line-through text-zinc-400"
                                    : "text-zinc-900 dark:text-zinc-100"
                              }`}
                            >
                              {item.title}
                            </span>
                            <span
                              className={`rounded px-2 py-0.5 text-[11px] font-medium ${ACTION_ITEM_STATUS_CLASSES[item.status]}`}
                            >
                              {ACTION_ITEM_STATUS_LABELS[item.status]}
                            </span>
                            {(item.linkedTask || item.linkedTaskId) && (
                              <span
                                data-testid={`action-item-converted-badge-${item.id}`}
                                className="rounded bg-purple-100 px-2 py-0.5 text-[11px] font-medium text-purple-800 dark:bg-purple-950/70 dark:text-purple-300"
                              >
                                Converted to task
                              </span>
                            )}
                          </div>
                          {item.description && (
                            <p className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">
                              {item.description}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          {canUserConvertActionItem(item) && (
                            <button
                              type="button"
                              data-testid={`convert-action-item-btn-${item.id}`}
                              disabled={
                                isBusy ||
                                (meeting.projectId !== null &&
                                  meeting.projectStatus === "archived")
                              }
                              onClick={() => onInitiateConvertActionItem(item)}
                              className="rounded bg-black px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black"
                            >
                              {isBusy ? "Converting…" : "Convert to task"}
                            </button>
                          )}
                          {canModify && (
                            <>
                              <select
                                value={item.status}
                                disabled={isBusy}
                                aria-label={`Change status for ${item.title}`}
                                onChange={(e) =>
                                  void onQuickChangeActionStatus(
                                    item,
                                    e.target.value as ActionItemStatus,
                                  )
                                }
                                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
                              >
                                <option value="open">Open</option>
                                <option value="in_progress">In Progress</option>
                                <option value="completed">Completed</option>
                                <option value="cancelled">Cancelled</option>
                              </select>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => startEditingActionItem(item)}
                                className="rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                              >
                                Edit
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {convertingActionItemId === item.id &&
                        !item.linkedTaskId &&
                        !item.linkedTask && (
                          <div
                            data-testid={`convert-action-item-project-picker-${item.id}`}
                            className="flex flex-col gap-2 rounded border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-700 dark:bg-zinc-900/50"
                          >
                            <span className="font-medium text-zinc-800 dark:text-zinc-200">
                              Select target project for converted task:
                            </span>
                            {activeProjects.length === 0 ? (
                              <p className="text-zinc-500">
                                No active projects available in this
                                organization. Create or unarchive a project
                                first.
                              </p>
                            ) : (
                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  aria-label={`Target project for ${item.title}`}
                                  data-testid={`convert-action-item-project-select-${item.id}`}
                                  value={selectedConvertProjectId}
                                  onChange={(e) =>
                                    setSelectedConvertProjectId(e.target.value)
                                  }
                                  className="rounded border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
                                >
                                  {activeProjects.map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.name}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  data-testid={`confirm-convert-action-item-btn-${item.id}`}
                                  disabled={isBusy || !selectedConvertProjectId}
                                  onClick={() =>
                                    void onConvertActionItem(
                                      item,
                                      selectedConvertProjectId,
                                    )
                                  }
                                  className="rounded bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black"
                                >
                                  {isBusy ? "Converting…" : "Confirm & create task"}
                                </button>
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => setConvertingActionItemId(null)}
                                  className="rounded border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                      {item.linkedTask && (
                        <div
                          data-testid={`action-item-linked-task-${item.id}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded border border-purple-200/80 bg-purple-50/50 px-3 py-2 text-xs dark:border-purple-900/50 dark:bg-purple-950/20"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-purple-900 dark:text-purple-200">
                              Linked task:
                            </span>
                            <Link
                              href={`/dashboard/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(item.linkedTask.projectId)}`}
                              data-testid={`action-item-linked-task-link-${item.id}`}
                              className="font-medium text-zinc-900 underline hover:text-zinc-700 dark:text-zinc-100 dark:hover:text-zinc-300"
                            >
                              {item.linkedTask.title}
                            </Link>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${LINKED_TASK_STATUS_CLASSES[item.linkedTask.status]}`}
                            >
                              {LINKED_TASK_STATUS_LABELS[item.linkedTask.status]}
                            </span>
                          </div>
                          {item.linkedTask.projectName && (
                            <span className="text-zinc-600 dark:text-zinc-400">
                              Project:{" "}
                              <Link
                                href={`/dashboard/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(item.linkedTask.projectId)}`}
                                className="font-medium underline"
                              >
                                {item.linkedTask.projectName}
                              </Link>
                            </span>
                          )}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-2 text-xs text-zinc-500 dark:border-zinc-800/80">
                        <div className="flex flex-wrap items-center gap-3">
                          <span>
                            Owner:{" "}
                            <strong className="font-medium text-zinc-700 dark:text-zinc-300">
                              {item.owner
                                ? (item.owner.name ??
                                  item.owner.email ??
                                  item.owner.userId)
                                : "Unassigned"}
                            </strong>
                          </span>
                          <span>
                            Target:{" "}
                            <strong className="font-medium text-zinc-700 dark:text-zinc-300">
                              {formatDateOnly(item.targetDate)}
                            </strong>
                          </span>
                          {item.completedAt && (
                            <span>
                              Completed: {formatDateTime(item.completedAt)}
                            </span>
                          )}
                        </div>
                        <span>
                          Created by{" "}
                          {item.createdByUser.name ??
                            item.createdByUser.email ??
                            item.createdBy}
                        </span>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Create Action Item Form */}
        {!isArchived && (
          <form
            onSubmit={onCreateActionItem}
            data-testid="create-action-item-form"
            className="mt-1 flex flex-col gap-3 rounded border border-zinc-200/80 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-900/30"
          >
            <h3 className="text-sm font-medium">Add action item</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs sm:col-span-3">
                <span>Action item title *</span>
                <input
                  type="text"
                  required
                  maxLength={300}
                  value={newActionTitle}
                  onChange={(e) => setNewActionTitle(e.target.value)}
                  placeholder="Draft technical specification for Phase 6…"
                  className={inputClassName}
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Owner (optional)</span>
                <select
                  value={newActionOwnerId}
                  onChange={(e) => setNewActionOwnerId(e.target.value)}
                  className={inputClassName}
                >
                  <option value="">Unassigned</option>
                  {assignableMembers.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name ?? m.email ?? m.userId} ({m.role})
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Target date (optional)</span>
                <input
                  type="date"
                  value={newActionTargetDate}
                  onChange={(e) => setNewActionTargetDate(e.target.value)}
                  className={inputClassName}
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Initial status</span>
                <select
                  value={newActionStatus}
                  onChange={(e) =>
                    setNewActionStatus(e.target.value as ActionItemStatus)
                  }
                  className={inputClassName}
                >
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs sm:col-span-3">
                <span>Description (optional)</span>
                <textarea
                  rows={2}
                  maxLength={5000}
                  value={newActionDescription}
                  onChange={(e) => setNewActionDescription(e.target.value)}
                  placeholder="Additional details or acceptance criteria…"
                  className={inputClassName}
                />
              </label>
            </div>

            <button
              type="submit"
              disabled={createActionBusy || !newActionTitle.trim()}
              className="self-start rounded bg-black px-3.5 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {createActionBusy ? "Adding…" : "Add action item"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

