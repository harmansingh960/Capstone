import type {
  ActionItemStatus,
  MeetingStatus,
  MembershipRole,
  ProjectStatus,
  TaskPriority,
  TaskStatus,
} from "@/lib/schema";
import type {
  MeetingActionItemCounts,
  MeetingActionItemEnriched,
  MeetingEnriched,
} from "@/lib/tenancy";

export type MeetingActionItemLinkedTaskDto = {
  id: string;
  projectId: string;
  projectName: string | null;
  projectStatus: ProjectStatus | null;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
};

export type MeetingParticipantDto = {
  userId: string;
  name: string | null;
  email: string | null;
  role: MembershipRole | null;
};

export type MeetingDiscussionPointDto = {
  id: string;
  content: string;
  authorId: string;
  authorName: string | null;
  authorEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MeetingDecisionDto = {
  id: string;
  title: string;
  description: string | null;
  decidedBy: string;
  decidedByName: string | null;
  decidedByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MeetingActionItemDto = {
  id: string;
  organizationId: string;
  meetingId: string;
  title: string;
  description: string | null;
  ownerId: string | null;
  owner: {
    userId: string;
    name: string | null;
    email: string | null;
    role: MembershipRole | null;
  } | null;
  targetDate: string | null;
  status: ActionItemStatus;
  createdBy: string;
  createdByUser: {
    userId: string;
    name: string | null;
    email: string | null;
  };
  completedAt: string | null;
  linkedTaskId: string | null;
  linkedTask: MeetingActionItemLinkedTaskDto | null;
  createdAt: string;
  updatedAt: string;
};

export type MeetingDto = {
  id: string;
  organizationId: string;
  projectId: string | null;
  projectName: string | null;
  projectStatus: ProjectStatus | null;
  title: string;
  meetingDate: string;
  description: string | null;
  status: MeetingStatus;
  participantIds: string[];
  participants: MeetingParticipantDto[];
  notes: string | null;
  discussionPoints: MeetingDiscussionPointDto[];
  decisions: MeetingDecisionDto[];
  actionItemCounts: MeetingActionItemCounts;
  createdBy: string;
  createdByUser: {
    userId: string;
    name: string | null;
    email: string | null;
  };
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toMeetingDto(meeting: MeetingEnriched): MeetingDto {
  return {
    id: meeting.id,
    organizationId: meeting.organizationId.toHexString(),
    projectId: meeting.projectId ? meeting.projectId.toHexString() : null,
    projectName: meeting.projectName,
    projectStatus: meeting.projectStatus,
    title: meeting.title,
    meetingDate: meeting.meetingDate.toISOString(),
    description: meeting.description,
    status: meeting.status,
    participantIds: meeting.participantIds,
    participants: meeting.participants,
    notes: meeting.notes,
    discussionPoints: meeting.discussionPoints.map((pt) => ({
      id: pt.id,
      content: pt.content,
      authorId: pt.authorId,
      authorName: pt.authorName,
      authorEmail: pt.authorEmail,
      createdAt: pt.createdAt.toISOString(),
      updatedAt: pt.updatedAt.toISOString(),
    })),
    decisions: meeting.decisions.map((dec) => ({
      id: dec.id,
      title: dec.title,
      description: dec.description,
      decidedBy: dec.decidedBy,
      decidedByName: dec.decidedByName,
      decidedByEmail: dec.decidedByEmail,
      createdAt: dec.createdAt.toISOString(),
      updatedAt: dec.updatedAt.toISOString(),
    })),
    actionItemCounts: meeting.actionItemCounts,
    createdBy: meeting.createdBy,
    createdByUser: meeting.createdByUser,
    archivedAt: meeting.archivedAt ? meeting.archivedAt.toISOString() : null,
    createdAt: meeting.createdAt.toISOString(),
    updatedAt: meeting.updatedAt.toISOString(),
  };
}

export function toMeetingActionItemDto(
  item: MeetingActionItemEnriched,
): MeetingActionItemDto {
  return {
    id: item.id,
    organizationId: item.organizationId.toHexString(),
    meetingId: item.meetingId.toHexString(),
    title: item.title,
    description: item.description,
    ownerId: item.ownerId,
    owner: item.owner,
    targetDate: item.targetDate ? item.targetDate.toISOString() : null,
    status: item.status,
    createdBy: item.createdBy,
    createdByUser: item.createdByUser,
    completedAt: item.completedAt ? item.completedAt.toISOString() : null,
    linkedTaskId: item.linkedTaskId ? item.linkedTaskId.toHexString() : null,
    linkedTask: item.linkedTask,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

