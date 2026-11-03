"use client";

import Link from "next/link";
import { useState } from "react";
import type {
  MembershipRole,
  ProjectStatus,
  TaskPriority,
  TaskStatus,
} from "@/lib/schema";
import type {
  BooleanFilterValue,
  DeliverableStatusFilter,
  ProjectScopeFilter,
  SortDirection,
  SupervisionReportData,
  SupervisorOrganizationOverview,
  SupervisorProjectOverviewItem,
  TaskDeadlineState,
  TaskDeliverableStatus,
  TaskHealthSummaryCounts,
  TaskScopeFilter,
  TaskSortField,
} from "@/lib/tenancy";

export type SerializedSupervisionTask = {
  id: string;
  projectId: string;
  projectName: string;
  projectStatus: ProjectStatus;
  parentTaskId: string | null;
  parentTaskTitle: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  assignee: {
    id: string;
    name: string | null;
    email: string | null;
    role: MembershipRole | null;
  } | null;
  deadline: string | null;
  approvalRequired: boolean;
  isBlocked: boolean;
  blockerCount: number;
  dependencyCount: number;
  dependencies: {
    id: string;
    projectId: string;
    taskId: string;
    prerequisiteTaskId: string;
    prerequisiteTitle: string;
    prerequisiteStatus: TaskStatus;
    prerequisiteParentTaskId: string | null;
    isBlocking: boolean;
    createdBy: string;
    createdAt: string;
  }[];
  deliverableStatus: TaskDeliverableStatus | null;
  isOverdue: boolean;
  isDueToday: boolean;
  isDueSoon: boolean;
  deadlineState: TaskDeadlineState;
  isStale: boolean;
  lastActivityAt: string;
  daysSinceActivity: number;
  createdAt: string;
  updatedAt: string;
};

export type SerializedProjectOverview = Omit<
  SupervisorProjectOverviewItem,
  "createdAt" | "updatedAt"
> & {
  createdAt: string;
  updatedAt: string;
};

export type SerializedSupervisorDashboard = {
  config: {
    staleThresholdDays: number;
    dueSoonDays: number;
    projectScope: ProjectScopeFilter;
    countingMethod: "top_level_tasks_only";
    generatedAt: string;
  };
  overview: SupervisorOrganizationOverview;
  projects: SerializedProjectOverview[];
  overdueHighlightTasks: SerializedSupervisionTask[];
  staleHighlightTasks: SerializedSupervisionTask[];
};

export type SerializedTaskQueryResult = {
  tasks: SerializedSupervisionTask[];
  summary: TaskHealthSummaryCounts;
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
  filters: {
    projectId: string | null;
    projectStatus: ProjectScopeFilter;
    status: TaskStatus | "all";
    priority: TaskPriority | "all";
    assigneeId: string | "unassigned" | "all";
    deadlineFrom: string | null;
    deadlineTo: string | null;
    overdue: BooleanFilterValue;
    dueToday: BooleanFilterValue;
    dueSoon: BooleanFilterValue;
    stale: BooleanFilterValue;
    staleThresholdDays: number;
    blocked: BooleanFilterValue;
    deliverableStatus: DeliverableStatusFilter;
    parentTaskId: string | null;
    taskScope: TaskScopeFilter;
  };
  sort: {
    sortBy: TaskSortField;
    sortOrder: SortDirection;
  };
};

export type SerializedReportData = SupervisionReportData;

type MemberOption = {
  userId: string;
  role: MembershipRole;
  name: string | null;
  email: string | null;
};

type TaskExplorerFilterState = {
  projectId: string;
  projectStatus: ProjectScopeFilter;
  status: TaskStatus | "all";
  priority: TaskPriority | "all";
  assigneeId: string;
  deliverableStatus: DeliverableStatusFilter;
  overdue: BooleanFilterValue;
  dueToday: BooleanFilterValue;
  dueSoon: BooleanFilterValue;
  stale: BooleanFilterValue;
  staleThresholdDays: number;
  blocked: BooleanFilterValue;
  taskScope: TaskScopeFilter;
  deadlineFrom: string;
  deadlineTo: string;
  sortBy: TaskSortField;
  sortOrder: SortDirection;
  page: number;
  limit: number;
};

type ReportFilterState = {
  projectId: string;
  memberId: string;
  dateFrom: string;
  dateTo: string;
  status: TaskStatus | "all";
  priority: TaskPriority | "all";
  projectStatus: ProjectScopeFilter;
  staleThresholdDays: number;
};

const DEFAULT_TASK_FILTERS: TaskExplorerFilterState = {
  projectId: "all",
  projectStatus: "active",
  status: "all",
  priority: "all",
  assigneeId: "all",
  deliverableStatus: "all",
  overdue: "all",
  dueToday: "all",
  dueSoon: "all",
  stale: "all",
  staleThresholdDays: 7,
  blocked: "all",
  taskScope: "all",
  deadlineFrom: "",
  deadlineTo: "",
  sortBy: "createdAt",
  sortOrder: "desc",
  page: 1,
  limit: 25,
};

const DEFAULT_REPORT_FILTERS: ReportFilterState = {
  projectId: "all",
  memberId: "all",
  dateFrom: "",
  dateTo: "",
  status: "all",
  priority: "all",
  projectStatus: "active",
  staleThresholdDays: 7,
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

const DELIVERABLE_STATUS_LABELS: Record<TaskDeliverableStatus, string> = {
  needs_submission: "Needs Submission",
  in_review: "In Review",
  changes_requested: "Changes Requested",
  approved: "Approved",
};

function formatShortDate(iso: string | null): string {
  if (!iso) return "No deadline";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Invalid date";
  return d.toISOString().slice(0, 10);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function renderDeadlineBadge(task: SerializedSupervisionTask) {
  if (task.isOverdue) {
    return (
      <span
        data-testid={`task-overdue-badge-${task.id}`}
        className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800 dark:border-red-800 dark:bg-red-950/70 dark:text-red-300"
      >
        Overdue · Due {formatShortDate(task.deadline)}
      </span>
    );
  }
  if (task.isDueToday) {
    return (
      <span
        data-testid={`task-due-today-badge-${task.id}`}
        className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-300"
      >
        Due Today · {formatShortDate(task.deadline)}
      </span>
    );
  }
  if (task.isDueSoon) {
    return (
      <span
        data-testid={`task-due-soon-badge-${task.id}`}
        className="inline-flex items-center gap-1 rounded-md border border-yellow-300 bg-yellow-50 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:border-yellow-800/70 dark:bg-yellow-950/50 dark:text-yellow-300"
      >
        Due Soon · {formatShortDate(task.deadline)}
      </span>
    );
  }
  if (task.deadline) {
    return (
      <span className="inline-flex items-center rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300">
        Due {formatShortDate(task.deadline)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      No deadline
    </span>
  );
}

export function SupervisionClient({
  organizationSlug,
  organizationName,
  currentUserRole,
  initialDashboard,
  initialTaskResult,
  initialReportData,
  members,
}: {
  organizationSlug: string;
  organizationName: string;
  currentUserRole: MembershipRole;
  initialDashboard: SerializedSupervisorDashboard;
  initialTaskResult: SerializedTaskQueryResult;
  initialReportData: SerializedReportData;
  members: MemberOption[];
}) {
  const [dashboard, setDashboard] =
    useState<SerializedSupervisorDashboard>(initialDashboard);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardProjectScope, setDashboardProjectScope] =
    useState<ProjectScopeFilter>(initialDashboard.config.projectScope);
  const [dashboardStaleDays, setDashboardStaleDays] = useState<number>(
    initialDashboard.config.staleThresholdDays,
  );

  const [taskResult, setTaskResult] =
    useState<SerializedTaskQueryResult>(initialTaskResult);
  const [taskFilters, setTaskFilters] =
    useState<TaskExplorerFilterState>(DEFAULT_TASK_FILTERS);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const [reportData, setReportData] =
    useState<SerializedReportData>(initialReportData);
  const [reportFilters, setReportFilters] = useState<ReportFilterState>(
    DEFAULT_REPORT_FILTERS,
  );
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState<string | null>(null);

  async function refreshDashboard(
    nextScope: ProjectScopeFilter = dashboardProjectScope,
    nextStaleDays: number = dashboardStaleDays,
  ) {
    setDashboardLoading(true);
    setDashboardError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("projectStatus", nextScope);
      qs.set("staleThresholdDays", String(nextStaleDays));
      const res = await fetch(
        `/api/organizations/${encodeURIComponent(organizationSlug)}/supervision?${qs.toString()}`,
      );
      const data = await res.json();
      if (!res.ok) {
        setDashboardError(data.error ?? "Failed to refresh dashboard.");
        return;
      }
      setDashboard({
        config: data.config,
        overview: data.overview,
        projects: data.projects,
        overdueHighlightTasks: data.overdueHighlightTasks,
        staleHighlightTasks: data.staleHighlightTasks,
      });
    } catch {
      setDashboardError("Network error while refreshing dashboard.");
    } finally {
      setDashboardLoading(false);
    }
  }

  async function fetchFilteredTasks(nextFilters: TaskExplorerFilterState) {
    setTaskFilters(nextFilters);
    setTasksLoading(true);
    setTasksError(null);
    try {
      const qs = new URLSearchParams();
      if (nextFilters.projectId !== "all") {
        qs.set("projectId", nextFilters.projectId);
      }
      qs.set("projectStatus", nextFilters.projectStatus);
      if (nextFilters.status !== "all") {
        qs.set("status", nextFilters.status);
      }
      if (nextFilters.priority !== "all") {
        qs.set("priority", nextFilters.priority);
      }
      if (nextFilters.assigneeId !== "all") {
        qs.set("assigneeId", nextFilters.assigneeId);
      }
      if (nextFilters.deliverableStatus !== "all") {
        qs.set("deliverableStatus", nextFilters.deliverableStatus);
      }
      if (nextFilters.overdue !== "all") {
        qs.set("overdue", nextFilters.overdue);
      }
      if (nextFilters.dueToday !== "all") {
        qs.set("dueToday", nextFilters.dueToday);
      }
      if (nextFilters.dueSoon !== "all") {
        qs.set("dueSoon", nextFilters.dueSoon);
      }
      if (nextFilters.stale !== "all") {
        qs.set("stale", nextFilters.stale);
      }
      qs.set("staleThresholdDays", String(nextFilters.staleThresholdDays));
      if (nextFilters.blocked !== "all") {
        qs.set("blocked", nextFilters.blocked);
      }
      if (nextFilters.taskScope !== "all") {
        qs.set("taskScope", nextFilters.taskScope);
      }
      if (nextFilters.deadlineFrom.trim() !== "") {
        qs.set("deadlineFrom", nextFilters.deadlineFrom.trim());
      }
      if (nextFilters.deadlineTo.trim() !== "") {
        qs.set("deadlineTo", nextFilters.deadlineTo.trim());
      }
      qs.set("sortBy", nextFilters.sortBy);
      qs.set("sortOrder", nextFilters.sortOrder);
      qs.set("page", String(nextFilters.page));
      qs.set("limit", String(nextFilters.limit));

      const res = await fetch(
        `/api/organizations/${encodeURIComponent(organizationSlug)}/supervision/tasks?${qs.toString()}`,
      );
      const data = await res.json();
      if (!res.ok) {
        setTasksError(data.error ?? "Failed to load filtered tasks.");
        return;
      }
      setTaskResult(data);
    } catch {
      setTasksError("Network error while loading tasks.");
    } finally {
      setTasksLoading(false);
    }
  }

  async function fetchReports(nextReportFilters: ReportFilterState) {
    setReportFilters(nextReportFilters);
    setReportsLoading(true);
    setReportsError(null);
    try {
      const qs = new URLSearchParams();
      if (nextReportFilters.projectId !== "all") {
        qs.set("projectId", nextReportFilters.projectId);
      }
      if (nextReportFilters.memberId !== "all") {
        qs.set("memberId", nextReportFilters.memberId);
      }
      if (nextReportFilters.dateFrom.trim() !== "") {
        qs.set("dateFrom", nextReportFilters.dateFrom.trim());
      }
      if (nextReportFilters.dateTo.trim() !== "") {
        qs.set("dateTo", nextReportFilters.dateTo.trim());
      }
      if (nextReportFilters.status !== "all") {
        qs.set("status", nextReportFilters.status);
      }
      if (nextReportFilters.priority !== "all") {
        qs.set("priority", nextReportFilters.priority);
      }
      qs.set("projectStatus", nextReportFilters.projectStatus);
      qs.set(
        "staleThresholdDays",
        String(nextReportFilters.staleThresholdDays),
      );

      const res = await fetch(
        `/api/organizations/${encodeURIComponent(organizationSlug)}/supervision/reports?${qs.toString()}`,
      );
      const data = await res.json();
      if (!res.ok) {
        setReportsError(data.error ?? "Failed to load supervision reports.");
        return;
      }
      setReportData(data);
    } catch {
      setReportsError("Network error while loading supervision reports.");
    } finally {
      setReportsLoading(false);
    }
  }

  function applyQuickTaskFilter(partial: Partial<TaskExplorerFilterState>) {
    const next: TaskExplorerFilterState = {
      ...DEFAULT_TASK_FILTERS,
      projectStatus: dashboardProjectScope,
      staleThresholdDays: dashboardStaleDays,
      ...partial,
      page: 1,
    };
    void fetchFilteredTasks(next);
    const explorerEl = document.getElementById("supervision-task-explorer");
    if (explorerEl) {
      explorerEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  const { overview, projects } = dashboard;

  return (
    <div className="space-y-10">
      {/* Page Title & Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight">
              Supervision &amp; Operations Dashboard
            </h1>
            <span className="rounded-md bg-zinc-900 px-2.5 py-0.5 text-xs font-medium capitalize text-white dark:bg-zinc-100 dark:text-zinc-900">
              {currentUserRole}
            </span>
          </div>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Organization-wide project health, overdue &amp; stale task
            detection, blocker tracking, and team workload reports for{" "}
            <span className="font-medium text-zinc-900 dark:text-zinc-100">
              {organizationName}
            </span>
            .
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Project Scope:</span>
            <select
              aria-label="Dashboard Project Scope"
              value={dashboardProjectScope}
              onChange={(e) => {
                const nextScope = e.target.value as ProjectScopeFilter;
                setDashboardProjectScope(nextScope);
                void refreshDashboard(nextScope, dashboardStaleDays);
              }}
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="active">Active projects only (Default)</option>
              <option value="all">All projects (Active + Archived)</option>
              <option value="archived">Archived projects only</option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Stale Threshold:</span>
            <select
              aria-label="Dashboard Stale Threshold Days"
              value={dashboardStaleDays}
              onChange={(e) => {
                const nextDays = Number.parseInt(e.target.value, 10) || 7;
                setDashboardStaleDays(nextDays);
                void refreshDashboard(dashboardProjectScope, nextDays);
              }}
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value={3}>3 days</option>
              <option value={5}>5 days</option>
              <option value={7}>7 days (Default)</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </select>
          </label>

          <button
            type="button"
            onClick={() =>
              void refreshDashboard(dashboardProjectScope, dashboardStaleDays)
            }
            disabled={dashboardLoading}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
          >
            {dashboardLoading ? "Refreshing..." : "Refresh Overview"}
          </button>
        </div>
      </div>

      {dashboardError ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
        >
          {dashboardError}
        </div>
      ) : null}

      {/* Section 5.1: Organization Overview Metrics */}
      <section
        aria-label="Organization Overview Metrics"
        data-testid="supervision-org-overview"
        className="space-y-4"
      >
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              1. Organization Operational Overview
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Top-level task metrics across{" "}
              {dashboardProjectScope === "archived"
                ? "archived"
                : "active"}{" "}
              projects (click any metric card to filter the task explorer below).
              Subtasks are tracked separately to prevent double-counting.
            </p>
          </div>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Overall Completion:{" "}
            <strong className="font-semibold text-zinc-900 dark:text-zinc-100">
              {overview.completionPercentage}%
            </strong>{" "}
            ({overview.completedTasks} / {overview.totalActiveTasks} tasks)
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <button
            type="button"
            data-testid="overview-total-active-projects"
            onClick={() => applyQuickTaskFilter({ projectStatus: "active" })}
            className="flex flex-col justify-between rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-xs transition hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
          >
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Active Projects
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                {overview.totalActiveProjects}
              </span>
              {overview.totalArchivedProjects > 0 ? (
                <span className="text-[11px] text-zinc-400">
                  +{overview.totalArchivedProjects} archived
                </span>
              ) : null}
            </div>
          </button>

          <button
            type="button"
            data-testid="overview-total-active-tasks"
            onClick={() =>
              applyQuickTaskFilter({
                taskScope: "top_level",
              })
            }
            className="flex flex-col justify-between rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-xs transition hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
          >
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Total Active Tasks
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                {overview.totalActiveTasks}
              </span>
              <span className="text-[11px] text-zinc-500">
                {overview.openTasks} open
              </span>
            </div>
          </button>

          <button
            type="button"
            data-testid="overview-todo-tasks"
            onClick={() =>
              applyQuickTaskFilter({
                status: "todo",
                taskScope: "top_level",
              })
            }
            className="flex flex-col justify-between rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-xs transition hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
          >
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              To Do (Not Started)
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                {overview.tasksByStatus.todo}
              </span>
              <span className="text-[11px] text-zinc-400">Status: todo</span>
            </div>
          </button>

          <button
            type="button"
            data-testid="overview-in-progress-tasks"
            onClick={() =>
              applyQuickTaskFilter({
                status: "in_progress",
                taskScope: "top_level",
              })
            }
            className="flex flex-col justify-between rounded-xl border border-blue-200 bg-blue-50/40 p-4 text-left shadow-xs transition hover:border-blue-400 dark:border-blue-900/50 dark:bg-blue-950/20 dark:hover:border-blue-700"
          >
            <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
              In Progress
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-blue-900 dark:text-blue-100">
                {overview.inProgressTasks}
              </span>
              <span className="text-[11px] text-blue-600 dark:text-blue-400">
                Active work
              </span>
            </div>
          </button>

          <button
            type="button"
            data-testid="overview-completed-tasks"
            onClick={() =>
              applyQuickTaskFilter({
                status: "done",
                taskScope: "top_level",
              })
            }
            className="flex flex-col justify-between rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 text-left shadow-xs transition hover:border-emerald-400 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:hover:border-emerald-700"
          >
            <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
              Completed Tasks
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-emerald-900 dark:text-emerald-100">
                {overview.completedTasks}
              </span>
              <span className="text-[11px] text-emerald-600 dark:text-emerald-400">
                {overview.completionPercentage}% done
              </span>
            </div>
          </button>

          <button
            type="button"
            data-testid="overview-overdue-tasks"
            onClick={() =>
              applyQuickTaskFilter({
                overdue: "true",
                sortBy: "deadline",
                sortOrder: "asc",
              })
            }
            className="flex flex-col justify-between rounded-xl border border-red-200 bg-red-50/50 p-4 text-left shadow-xs transition hover:border-red-400 dark:border-red-900/50 dark:bg-red-950/25 dark:hover:border-red-700"
          >
            <span className="text-xs font-medium text-red-700 dark:text-red-300">
              Overdue Tasks
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-red-900 dark:text-red-100">
                {overview.overdueTasks}
              </span>
              <span className="text-[11px] text-red-600 dark:text-red-400">
                Past deadline
              </span>
            </div>
          </button>

          <button
            type="button"
            data-testid="overview-stale-tasks"
            onClick={() =>
              applyQuickTaskFilter({
                stale: "true",
                sortBy: "lastActivity",
                sortOrder: "asc",
              })
            }
            className="flex flex-col justify-between rounded-xl border border-amber-200 bg-amber-50/50 p-4 text-left shadow-xs transition hover:border-amber-400 dark:border-amber-900/50 dark:bg-amber-950/25 dark:hover:border-amber-700"
          >
            <span className="text-xs font-medium text-amber-800 dark:text-amber-300">
              Stale Tasks (&ge;{dashboard.config.staleThresholdDays}d)
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-amber-900 dark:text-amber-100">
                {overview.staleTasks}
              </span>
              <span className="text-[11px] text-amber-700 dark:text-amber-400">
                No recent activity
              </span>
            </div>
          </button>

          <button
            type="button"
            data-testid="overview-blocked-tasks"
            onClick={() =>
              applyQuickTaskFilter({
                blocked: "true",
              })
            }
            className="flex flex-col justify-between rounded-xl border border-rose-200 bg-rose-50/40 p-4 text-left shadow-xs transition hover:border-rose-400 dark:border-rose-900/50 dark:bg-rose-950/20 dark:hover:border-rose-700"
          >
            <span className="text-xs font-medium text-rose-700 dark:text-rose-300">
              Blocked Tasks
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-rose-900 dark:text-rose-100">
                {overview.blockedTasks}
              </span>
              <span className="text-[11px] text-rose-600 dark:text-rose-400">
                Unmet dependencies
              </span>
            </div>
          </button>

          <button
            type="button"
            data-testid="overview-awaiting-submission"
            onClick={() =>
              applyQuickTaskFilter({
                deliverableStatus: "needs_submission",
              })
            }
            className="flex flex-col justify-between rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-xs transition hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
          >
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Awaiting Submission
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                {overview.awaitingSubmissionTasks}
              </span>
              <span className="text-[11px] text-zinc-400">
                {overview.changesRequestedTasks > 0
                  ? `${overview.changesRequestedTasks} revision`
                  : "Needs deliverable"}
              </span>
            </div>
          </button>

          <button
            type="button"
            data-testid="overview-awaiting-review"
            onClick={() =>
              applyQuickTaskFilter({
                deliverableStatus: "in_review",
              })
            }
            className="flex flex-col justify-between rounded-xl border border-purple-200 bg-purple-50/40 p-4 text-left shadow-xs transition hover:border-purple-400 dark:border-purple-900/50 dark:bg-purple-950/20 dark:hover:border-purple-700"
          >
            <span className="text-xs font-medium text-purple-700 dark:text-purple-300">
              Awaiting Review
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-purple-900 dark:text-purple-100">
                {overview.awaitingReviewTasks}
              </span>
              <span className="text-[11px] text-purple-600 dark:text-purple-400">
                In review queue
              </span>
            </div>
          </button>

          <button
            type="button"
            data-testid="overview-due-today-tasks"
            onClick={() =>
              applyQuickTaskFilter({
                dueToday: "true",
                sortBy: "deadline",
                sortOrder: "asc",
              })
            }
            className="flex flex-col justify-between rounded-xl border border-orange-200 bg-orange-50/40 p-4 text-left shadow-xs transition hover:border-orange-400 dark:border-orange-900/50 dark:bg-orange-950/20 dark:hover:border-orange-700"
          >
            <span className="text-xs font-medium text-orange-800 dark:text-orange-300">
              Tasks Due Today
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-orange-900 dark:text-orange-100">
                {overview.tasksDueToday}
              </span>
              <span className="text-[11px] text-orange-700 dark:text-orange-400">
                Due today (UTC)
              </span>
            </div>
          </button>

          <button
            type="button"
            data-testid="overview-due-soon-tasks"
            onClick={() =>
              applyQuickTaskFilter({
                dueSoon: "true",
                sortBy: "deadline",
                sortOrder: "asc",
              })
            }
            className="flex flex-col justify-between rounded-xl border border-yellow-200 bg-yellow-50/40 p-4 text-left shadow-xs transition hover:border-yellow-400 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:hover:border-yellow-700"
          >
            <span className="text-xs font-medium text-yellow-800 dark:text-yellow-300">
              Due Soon (Next {dashboard.config.dueSoonDays}d)
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-yellow-900 dark:text-yellow-100">
                {overview.tasksDueSoon}
              </span>
              <span className="text-[11px] text-yellow-700 dark:text-yellow-400">
                Upcoming deadline
              </span>
            </div>
          </button>
        </div>

        {overview.subtasksSummary.totalSubtasks > 0 ? (
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-zinc-200 bg-zinc-100/70 px-4 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
            <span className="font-medium text-zinc-800 dark:text-zinc-200">
              Subtasks Breakdown (tracked separately from top-level task
              totals):
            </span>
            <span>Total: {overview.subtasksSummary.totalSubtasks}</span>
            <span>Completed: {overview.subtasksSummary.completedSubtasks}</span>
            <span>
              In Progress: {overview.subtasksSummary.inProgressSubtasks}
            </span>
            <span>To Do: {overview.subtasksSummary.notStartedSubtasks}</span>
            <span>Overdue: {overview.subtasksSummary.overdueSubtasks}</span>
            <span>Stale: {overview.subtasksSummary.staleSubtasks}</span>
            <span>Blocked: {overview.subtasksSummary.blockedSubtasks}</span>
          </div>
        ) : null}
      </section>

      {/* Section 5.1: Project Overview Metrics */}
      <section
        aria-label="Project Overview Metrics"
        data-testid="supervision-projects-overview"
        className="space-y-4"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              2. Project Health &amp; Operational Summary
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Per-project completion progress, overdue work, stale tasks, and
              blockers with direct links to project workspaces and filtered task
              views.
            </p>
          </div>
        </div>

        {projects.length === 0 ? (
          <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            No projects match the current scope ({dashboardProjectScope}).
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3">Project</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Total</th>
                  <th className="px-3 py-3 text-right">Completed</th>
                  <th className="px-3 py-3 text-right">In Progress</th>
                  <th className="px-3 py-3 text-right">Blocked</th>
                  <th className="px-3 py-3 text-right">Overdue</th>
                  <th className="px-3 py-3 text-right">Stale</th>
                  <th className="px-4 py-3">Completion %</th>
                  <th className="px-4 py-3 text-right">Quick Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {projects.map((proj) => (
                  <tr
                    key={proj.projectId}
                    data-testid={`supervision-project-row-${proj.projectId}`}
                    className="hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/${organizationSlug}/projects/${proj.projectId}`}
                        className="font-semibold text-zinc-900 hover:underline dark:text-zinc-100"
                      >
                        {proj.name}
                      </Link>
                      {proj.description ? (
                        <p className="line-clamp-1 text-xs text-zinc-500 dark:text-zinc-400">
                          {proj.description}
                        </p>
                      ) : null}
                      {proj.subtasksCount > 0 ? (
                        <span className="text-[11px] text-zinc-400">
                          +{proj.subtasksCount} subtasks (
                          {proj.completedSubtasksCount} done)
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ${
                          proj.status === "active"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                            : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                        }`}
                      >
                        {proj.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right font-medium">
                      {proj.totalTasks}
                    </td>
                    <td className="px-3 py-3 text-right text-emerald-700 dark:text-emerald-400">
                      {proj.completedTasks}
                    </td>
                    <td className="px-3 py-3 text-right text-blue-700 dark:text-blue-400">
                      {proj.inProgressTasks}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {proj.blockedTasks > 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            applyQuickTaskFilter({
                              projectId: proj.projectId,
                              projectStatus: proj.status,
                              blocked: "true",
                            })
                          }
                          className="inline-flex items-center rounded-md bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800 hover:bg-rose-200 dark:bg-rose-950/60 dark:text-rose-300"
                        >
                          {proj.blockedTasks}
                        </button>
                      ) : (
                        <span className="text-zinc-400">0</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {proj.overdueTasks > 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            applyQuickTaskFilter({
                              projectId: proj.projectId,
                              projectStatus: proj.status,
                              overdue: "true",
                              sortBy: "deadline",
                              sortOrder: "asc",
                            })
                          }
                          className="inline-flex items-center rounded-md bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800 hover:bg-red-200 dark:bg-red-950/60 dark:text-red-300"
                        >
                          {proj.overdueTasks}
                        </button>
                      ) : (
                        <span className="text-zinc-400">0</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {proj.staleTasks > 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            applyQuickTaskFilter({
                              projectId: proj.projectId,
                              projectStatus: proj.status,
                              stale: "true",
                              sortBy: "lastActivity",
                              sortOrder: "asc",
                            })
                          }
                          className="inline-flex items-center rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 hover:bg-amber-200 dark:bg-amber-950/60 dark:text-amber-300"
                        >
                          {proj.staleTasks}
                        </button>
                      ) : (
                        <span className="text-zinc-400">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                          <div
                            className="h-full rounded-full bg-emerald-600 dark:bg-emerald-500"
                            style={{
                              width: `${Math.min(100, Math.max(0, proj.completionPercentage))}%`,
                            }}
                          />
                        </div>
                        <span className="text-xs font-semibold">
                          {proj.completionPercentage}%
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            applyQuickTaskFilter({
                              projectId: proj.projectId,
                              projectStatus: proj.status,
                            })
                          }
                          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          Filter Tasks
                        </button>
                        <Link
                          href={`/dashboard/${organizationSlug}/projects/${proj.projectId}`}
                          className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                        >
                          Open Project
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 5.3 & 5.4: Overdue & Stale Attention Panels */}
      <section
        aria-label="Immediate Attention: Overdue and Stale Tasks"
        className="grid grid-cols-1 gap-6 lg:grid-cols-2"
      >
        {/* Overdue Tasks Callout */}
        <div
          data-testid="supervision-overdue-panel"
          className="rounded-xl border border-red-200 bg-white p-5 shadow-xs dark:border-red-900/40 dark:bg-zinc-900"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-red-900 dark:text-red-200">
                Overdue Tasks Attention Queue ({overview.overdueTasks})
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Active tasks with a passed deadline and status not Done.
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                applyQuickTaskFilter({
                  overdue: "true",
                  sortBy: "deadline",
                  sortOrder: "asc",
                })
              }
              className="rounded-lg border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-800 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300"
            >
              View All Overdue
            </button>
          </div>

          {dashboard.overdueHighlightTasks.length === 0 ? (
            <p className="mt-4 rounded-lg bg-zinc-50 p-4 text-xs text-zinc-500 dark:bg-zinc-800/40 dark:text-zinc-400">
              No overdue tasks across active projects.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-zinc-200 dark:divide-zinc-800">
              {dashboard.overdueHighlightTasks.slice(0, 5).map((t) => (
                <li key={t.id} className="py-2.5 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <Link
                        href={`/dashboard/${organizationSlug}/projects/${t.projectId}`}
                        className="font-semibold text-zinc-900 hover:underline dark:text-zinc-100"
                      >
                        {t.title}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-zinc-500 dark:text-zinc-400">
                        <span>Project: {t.projectName}</span>
                        <span>·</span>
                        <span>
                          Assignee:{" "}
                          {t.assignee?.name ??
                            t.assignee?.email ??
                            t.assigneeId ??
                            "Unassigned"}
                        </span>
                      </div>
                    </div>
                    {renderDeadlineBadge(t)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Stale Tasks Callout */}
        <div
          data-testid="supervision-stale-panel"
          className="rounded-xl border border-amber-200 bg-white p-5 shadow-xs dark:border-amber-900/40 dark:bg-zinc-900"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-amber-900 dark:text-amber-200">
                Stale Tasks Attention Queue ({overview.staleTasks})
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Active incomplete tasks with no meaningful activity for &ge;
                {dashboard.config.staleThresholdDays} days.
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                applyQuickTaskFilter({
                  stale: "true",
                  sortBy: "lastActivity",
                  sortOrder: "asc",
                })
              }
              className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
            >
              View All Stale
            </button>
          </div>

          {dashboard.staleHighlightTasks.length === 0 ? (
            <p className="mt-4 rounded-lg bg-zinc-50 p-4 text-xs text-zinc-500 dark:bg-zinc-800/40 dark:text-zinc-400">
              No stale tasks exceeding the {dashboard.config.staleThresholdDays}
              -day inactivity threshold.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-zinc-200 dark:divide-zinc-800">
              {dashboard.staleHighlightTasks.slice(0, 5).map((t) => (
                <li key={t.id} className="py-2.5 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <Link
                        href={`/dashboard/${organizationSlug}/projects/${t.projectId}`}
                        className="font-semibold text-zinc-900 hover:underline dark:text-zinc-100"
                      >
                        {t.title}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-zinc-500 dark:text-zinc-400">
                        <span>Project: {t.projectName}</span>
                        <span>·</span>
                        <span>
                          Assignee:{" "}
                          {t.assignee?.name ??
                            t.assignee?.email ??
                            t.assigneeId ??
                            "Unassigned"}
                        </span>
                        <span>·</span>
                        <span>
                          Last activity: {formatDateTime(t.lastActivityAt)}
                        </span>
                      </div>
                    </div>
                    <span className="inline-flex shrink-0 items-center rounded-md border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-300">
                      Stale · {t.daysSinceActivity}d inactive
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Section 5.2, 5.3, 5.4: Advanced Task Filter & Explorer */}
      <section
        id="supervision-task-explorer"
        aria-label="Advanced Project and Task Explorer"
        data-testid="supervision-task-explorer"
        className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-xs dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              3. Advanced Project &amp; Task Explorer
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Combine filters across project, status, priority, assignee,
              deadline range, overdue, stale, blocked, deliverable status, and
              task hierarchy.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="reset-task-filters-button"
              onClick={() => void fetchFilteredTasks(DEFAULT_TASK_FILTERS)}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              Reset filters
            </button>
          </div>
        </div>

        {/* Filter Grid */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Project</span>
            <select
              aria-label="Filter by Project"
              data-testid="filter-project-select"
              value={taskFilters.projectId}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  projectId: e.target.value,
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All Projects</option>
              {dashboard.projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name} ({p.status})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Project Scope</span>
            <select
              aria-label="Filter by Project Scope"
              data-testid="filter-project-scope-select"
              value={taskFilters.projectStatus}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  projectStatus: e.target.value as ProjectScopeFilter,
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="active">Active Projects Only</option>
              <option value="all">Active + Archived</option>
              <option value="archived">Archived Only</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Task Status</span>
            <select
              aria-label="Filter by Task Status"
              data-testid="filter-status-select"
              value={taskFilters.status}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  status: e.target.value as TaskStatus | "all",
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All Statuses</option>
              <option value="todo">To Do</option>
              <option value="in_progress">In Progress</option>
              <option value="done">Done</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Priority</span>
            <select
              aria-label="Filter by Priority"
              data-testid="filter-priority-select"
              value={taskFilters.priority}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  priority: e.target.value as TaskPriority | "all",
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All Priorities</option>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Assignee</span>
            <select
              aria-label="Filter by Assignee"
              data-testid="filter-assignee-select"
              value={taskFilters.assigneeId}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  assigneeId: e.target.value,
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All Assignees</option>
              <option value="unassigned">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name ?? m.email ?? m.userId} ({m.role})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Overdue Status</span>
            <select
              aria-label="Filter by Overdue Status"
              data-testid="filter-overdue-select"
              value={taskFilters.overdue}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  overdue: e.target.value as BooleanFilterValue,
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All</option>
              <option value="true">Overdue Only</option>
              <option value="false">Not Overdue</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Stale Status</span>
            <select
              aria-label="Filter by Stale Status"
              data-testid="filter-stale-select"
              value={taskFilters.stale}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  stale: e.target.value as BooleanFilterValue,
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All</option>
              <option value="true">
                Stale Only (&ge;{taskFilters.staleThresholdDays}d)
              </option>
              <option value="false">Active Recently (Not Stale)</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Blocked Status</span>
            <select
              aria-label="Filter by Blocked Status"
              data-testid="filter-blocked-select"
              value={taskFilters.blocked}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  blocked: e.target.value as BooleanFilterValue,
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All</option>
              <option value="true">Blocked Only</option>
              <option value="false">Unblocked Only</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Deliverable Status</span>
            <select
              aria-label="Filter by Deliverable Status"
              data-testid="filter-deliverable-select"
              value={taskFilters.deliverableStatus}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  deliverableStatus: e.target.value as DeliverableStatusFilter,
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All Deliverable States</option>
              <option value="needs_submission">Needs Submission</option>
              <option value="in_review">In Review</option>
              <option value="changes_requested">Changes Requested</option>
              <option value="approved">Approved</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Task Hierarchy</span>
            <select
              aria-label="Filter by Task Hierarchy"
              data-testid="filter-task-scope-select"
              value={taskFilters.taskScope}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  taskScope: e.target.value as TaskScopeFilter,
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All Tasks &amp; Subtasks</option>
              <option value="top_level">Parent / Top-Level Tasks Only</option>
              <option value="subtasks">Subtasks Only</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Deadline From</span>
            <input
              type="date"
              aria-label="Filter by Deadline From"
              data-testid="filter-deadline-from-input"
              value={taskFilters.deadlineFrom}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  deadlineFrom: e.target.value,
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Deadline To</span>
            <input
              type="date"
              aria-label="Filter by Deadline To"
              data-testid="filter-deadline-to-input"
              value={taskFilters.deadlineTo}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  deadlineTo: e.target.value,
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Due Today / Soon</span>
            <select
              aria-label="Filter by Due Window"
              value={
                taskFilters.dueToday === "true"
                  ? "due_today"
                  : taskFilters.dueSoon === "true"
                    ? "due_soon"
                    : "all"
              }
              onChange={(e) => {
                const v = e.target.value;
                void fetchFilteredTasks({
                  ...taskFilters,
                  dueToday: v === "due_today" ? "true" : "all",
                  dueSoon: v === "due_soon" ? "true" : "all",
                  page: 1,
                });
              }}
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">Any Due Window</option>
              <option value="due_today">Due Today Only</option>
              <option value="due_soon">Due Soon (Next 7 Days)</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Sort By</span>
            <select
              aria-label="Sort Tasks By"
              data-testid="sort-by-select"
              value={taskFilters.sortBy}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  sortBy: e.target.value as TaskSortField,
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="createdAt">Created Date</option>
              <option value="deadline">Deadline</option>
              <option value="priority">Priority</option>
              <option value="lastActivity">Last Meaningful Activity</option>
              <option value="status">Task Status</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Sort Direction</span>
            <select
              aria-label="Sort Direction"
              data-testid="sort-order-select"
              value={taskFilters.sortOrder}
              onChange={(e) =>
                void fetchFilteredTasks({
                  ...taskFilters,
                  sortOrder: e.target.value as SortDirection,
                  page: 1,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="asc">Ascending (asc)</option>
              <option value="desc">Descending (desc)</option>
            </select>
          </label>
        </div>

        {tasksError ? (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            {tasksError}
          </div>
        ) : null}

        {/* Matching Summary Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-300">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Matching Tasks:{" "}
              <strong className="font-semibold text-zinc-900 dark:text-zinc-100">
                {taskResult.pagination.total}
              </strong>
            </span>
            <span>·</span>
            <span>Completed: {taskResult.summary.completedTasks}</span>
            <span>·</span>
            <span>In Progress: {taskResult.summary.inProgressTasks}</span>
            <span>·</span>
            <span>To Do: {taskResult.summary.notStartedTasks}</span>
            <span>·</span>
            <span className="font-medium text-red-700 dark:text-red-400">
              Overdue: {taskResult.summary.overdueTasks}
            </span>
            <span>·</span>
            <span className="font-medium text-amber-700 dark:text-amber-400">
              Stale: {taskResult.summary.staleTasks}
            </span>
            <span>·</span>
            <span className="font-medium text-rose-700 dark:text-rose-400">
              Blocked: {taskResult.summary.blockedTasks}
            </span>
          </div>
          {tasksLoading ? (
            <span className="font-medium text-blue-600 dark:text-blue-400">
              Updating results...
            </span>
          ) : null}
        </div>

        {/* Task List */}
        {taskResult.tasks.length === 0 ? (
          <div
            data-testid="supervision-tasks-empty"
            className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
          >
            No tasks match the selected filters. Use{" "}
            <button
              type="button"
              onClick={() => void fetchFilteredTasks(DEFAULT_TASK_FILTERS)}
              className="font-semibold text-zinc-900 underline dark:text-zinc-100"
            >
              Reset filters
            </button>{" "}
            to view all active tasks.
          </div>
        ) : (
          <div className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {taskResult.tasks.map((task) => (
              <div
                key={task.id}
                data-testid={`supervision-task-item-${task.id}`}
                className="flex flex-col gap-3 p-4 transition hover:bg-zinc-50/70 sm:flex-row sm:items-start sm:justify-between dark:hover:bg-zinc-800/30"
              >
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/dashboard/${organizationSlug}/projects/${task.projectId}`}
                      className="text-sm font-semibold text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {task.title}
                    </Link>

                    <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      Project: {task.projectName}
                      {task.projectStatus === "archived" ? " (Archived)" : ""}
                    </span>

                    {task.parentTaskId ? (
                      <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
                        Subtask
                        {task.parentTaskTitle
                          ? ` of "${task.parentTaskTitle}"`
                          : ""}
                      </span>
                    ) : null}

                    <span
                      className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                        task.status === "done"
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                          : task.status === "in_progress"
                            ? "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300"
                            : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                      }`}
                    >
                      {STATUS_LABELS[task.status]}
                    </span>

                    <span
                      className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                        task.priority === "high"
                          ? "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300"
                          : task.priority === "medium"
                            ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                            : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                      }`}
                    >
                      Priority: {PRIORITY_LABELS[task.priority]}
                    </span>

                    {task.isBlocked ? (
                      <span
                        data-testid={`task-blocked-badge-${task.id}`}
                        className="rounded-md border border-rose-300 bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-800 dark:border-rose-800 dark:bg-rose-950/70 dark:text-rose-300"
                      >
                        Blocked ({task.blockerCount})
                      </span>
                    ) : null}

                    {task.deliverableStatus ? (
                      <span className="rounded-md border border-purple-200 bg-purple-50 px-2 py-0.5 text-[11px] font-medium text-purple-800 dark:border-purple-800/60 dark:bg-purple-950/40 dark:text-purple-300">
                        {DELIVERABLE_STATUS_LABELS[task.deliverableStatus]}
                      </span>
                    ) : null}
                  </div>

                  {task.description ? (
                    <p className="line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">
                      {task.description}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
                    <span>
                      Assignee:{" "}
                      <strong className="font-medium text-zinc-800 dark:text-zinc-200">
                        {task.assignee?.name ??
                          task.assignee?.email ??
                          task.assigneeId ??
                          "Unassigned"}
                      </strong>
                    </span>
                    <span>·</span>
                    <span data-testid={`task-last-activity-${task.id}`}>
                      Last meaningful activity:{" "}
                      <strong className="font-medium text-zinc-700 dark:text-zinc-300">
                        {formatDateTime(task.lastActivityAt)}
                      </strong>{" "}
                      ({task.daysSinceActivity}d ago)
                    </span>
                    <span>·</span>
                    <span>Created: {formatShortDate(task.createdAt)}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                  <div className="flex flex-wrap items-center gap-2">
                    {renderDeadlineBadge(task)}
                    {task.isStale ? (
                      <span
                        data-testid={`task-stale-badge-${task.id}`}
                        className="inline-flex items-center rounded-md border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-300"
                      >
                        Stale · {task.daysSinceActivity}d inactive
                      </span>
                    ) : null}
                  </div>
                  <Link
                    href={`/dashboard/${organizationSlug}/projects/${task.projectId}`}
                    className="text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    Open in Project &rarr;
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination Controls */}
        {taskResult.pagination.totalPages > 1 ? (
          <div className="flex items-center justify-between pt-2 text-xs text-zinc-600 dark:text-zinc-400">
            <span>
              Page {taskResult.pagination.page} of{" "}
              {taskResult.pagination.totalPages} ({taskResult.pagination.total}{" "}
              tasks)
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={taskResult.pagination.page <= 1 || tasksLoading}
                onClick={() =>
                  void fetchFilteredTasks({
                    ...taskFilters,
                    page: Math.max(1, taskFilters.page - 1),
                  })
                }
                className="rounded-lg border border-zinc-300 px-3 py-1 font-medium disabled:opacity-40 dark:border-zinc-700"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!taskResult.pagination.hasMore || tasksLoading}
                onClick={() =>
                  void fetchFilteredTasks({
                    ...taskFilters,
                    page: taskFilters.page + 1,
                  })
                }
                className="rounded-lg border border-zinc-300 px-3 py-1 font-medium disabled:opacity-40 dark:border-zinc-700"
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* Section 5.5: Progress Monitoring and Reports */}
      <section
        aria-label="Progress Monitoring and Reports"
        data-testid="supervision-reports-section"
        className="space-y-6 rounded-xl border border-zinc-200 bg-white p-6 shadow-xs dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              4. Progress Monitoring, Team Workload &amp; Time Reports
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {reportData.countingMethod.description}
            </p>
          </div>
          <button
            type="button"
            data-testid="reset-report-filters-button"
            onClick={() => void fetchReports(DEFAULT_REPORT_FILTERS)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
          >
            Reset report filters
          </button>
        </div>

        {/* Reporting Filters */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Report Project</span>
            <select
              aria-label="Report Project Filter"
              data-testid="report-project-select"
              value={reportFilters.projectId}
              onChange={(e) =>
                void fetchReports({
                  ...reportFilters,
                  projectId: e.target.value,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All Projects</option>
              {dashboard.projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Team Member</span>
            <select
              aria-label="Report Team Member Filter"
              data-testid="report-member-select"
              value={reportFilters.memberId}
              onChange={(e) =>
                void fetchReports({
                  ...reportFilters,
                  memberId: e.target.value,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All Members</option>
              <option value="unassigned">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name ?? m.email ?? m.userId}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Task Status</span>
            <select
              aria-label="Report Task Status Filter"
              data-testid="report-status-select"
              value={reportFilters.status}
              onChange={(e) =>
                void fetchReports({
                  ...reportFilters,
                  status: e.target.value as TaskStatus | "all",
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All Statuses</option>
              <option value="todo">To Do</option>
              <option value="in_progress">In Progress</option>
              <option value="done">Done</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Priority</span>
            <select
              aria-label="Report Priority Filter"
              data-testid="report-priority-select"
              value={reportFilters.priority}
              onChange={(e) =>
                void fetchReports({
                  ...reportFilters,
                  priority: e.target.value as TaskPriority | "all",
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="all">All Priorities</option>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Date Range From</span>
            <input
              type="date"
              aria-label="Report Date Range From"
              data-testid="report-date-from-input"
              value={reportFilters.dateFrom}
              onChange={(e) =>
                void fetchReports({
                  ...reportFilters,
                  dateFrom: e.target.value,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <span>Date Range To</span>
            <input
              type="date"
              aria-label="Report Date Range To"
              data-testid="report-date-to-input"
              value={reportFilters.dateTo}
              onChange={(e) =>
                void fetchReports({
                  ...reportFilters,
                  dateTo: e.target.value,
                })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </label>
        </div>

        {reportsError ? (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            {reportsError}
          </div>
        ) : null}

        {reportsLoading ? (
          <p className="text-xs font-medium text-blue-600 dark:text-blue-400">
            Updating reports...
          </p>
        ) : null}

        {/* Formula Callout */}
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-800/40 dark:text-zinc-400">
          <strong className="font-semibold text-zinc-900 dark:text-zinc-200">
            Counting Method:
          </strong>{" "}
          <code>{reportData.countingMethod.formula}</code> — Top-level tasks are
          counted for project completion percentages so subtasks are never
          double-counted.
        </div>

        {/* 4A. Project Progress Report Table */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Project Progress Summary
          </h3>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table
              data-testid="report-project-progress-table"
              className="w-full text-left text-xs"
            >
              <thead className="border-b border-zinc-200 bg-zinc-50 font-semibold uppercase text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2.5">Project</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5 text-right">Total Tasks</th>
                  <th className="px-3 py-2.5 text-right">Completed</th>
                  <th className="px-3 py-2.5 text-right">In Progress</th>
                  <th className="px-3 py-2.5 text-right">Not Started</th>
                  <th className="px-3 py-2.5 text-right">Blocked</th>
                  <th className="px-3 py-2.5 text-right">Overdue</th>
                  <th className="px-3 py-2.5 text-right">Stale</th>
                  <th className="px-3 py-2.5">Completion %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {reportData.projectProgress.map((row) => (
                  <tr key={row.projectId}>
                    <td className="px-3 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">
                      <Link
                        href={`/dashboard/${organizationSlug}/projects/${row.projectId}`}
                        className="hover:underline"
                      >
                        {row.projectName}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 capitalize">
                      {row.projectStatus}
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium">
                      {row.totalTasks}
                    </td>
                    <td className="px-3 py-2.5 text-right text-emerald-700 dark:text-emerald-400">
                      {row.completedTasks}
                    </td>
                    <td className="px-3 py-2.5 text-right text-blue-700 dark:text-blue-400">
                      {row.inProgressTasks}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {row.notStartedTasks}
                    </td>
                    <td className="px-3 py-2.5 text-right text-rose-700 dark:text-rose-400">
                      {row.blockedTasks}
                    </td>
                    <td className="px-3 py-2.5 text-right text-red-700 dark:text-red-400">
                      {row.overdueTasks}
                    </td>
                    <td className="px-3 py-2.5 text-right text-amber-700 dark:text-amber-400">
                      {row.staleTasks}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                          <div
                            className="h-full rounded-full bg-emerald-600 dark:bg-emerald-500"
                            style={{
                              width: `${Math.min(100, Math.max(0, row.completionPercentage))}%`,
                            }}
                          />
                        </div>
                        <span className="font-semibold">
                          {row.completionPercentage}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 4B. Team Workload Overview Table */}
        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Team Workload Overview
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Task distribution across organization members based on current
              report filters.
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table
              data-testid="report-team-workload-table"
              className="w-full text-left text-xs"
            >
              <thead className="border-b border-zinc-200 bg-zinc-50 font-semibold uppercase text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2.5">Member</th>
                  <th className="px-3 py-2.5">Role</th>
                  <th className="px-3 py-2.5 text-right">Assigned</th>
                  <th className="px-3 py-2.5 text-right">Completed</th>
                  <th className="px-3 py-2.5 text-right">In Progress</th>
                  <th className="px-3 py-2.5 text-right">Not Started</th>
                  <th className="px-3 py-2.5 text-right">Blocked</th>
                  <th className="px-3 py-2.5 text-right">Overdue</th>
                  <th className="px-3 py-2.5 text-right">Stale</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {reportData.teamWorkload.map((member) => (
                  <tr key={member.userId ?? "__unassigned__"}>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">
                        {member.isUnassigned
                          ? "Unassigned"
                          : (member.name ?? member.email ?? member.userId)}
                      </div>
                      {member.email && member.name ? (
                        <div className="text-[11px] text-zinc-500">
                          {member.email}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 capitalize text-zinc-600 dark:text-zinc-400">
                      {member.role ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold">
                      {member.assignedTasks}
                    </td>
                    <td className="px-3 py-2.5 text-right text-emerald-700 dark:text-emerald-400">
                      {member.completedTasks}
                    </td>
                    <td className="px-3 py-2.5 text-right text-blue-700 dark:text-blue-400">
                      {member.inProgressTasks}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {member.notStartedTasks}
                    </td>
                    <td className="px-3 py-2.5 text-right text-rose-700 dark:text-rose-400">
                      {member.blockedTasks}
                    </td>
                    <td className="px-3 py-2.5 text-right text-red-700 dark:text-red-400">
                      {member.overdueTasks}
                    </td>
                    <td className="px-3 py-2.5 text-right text-amber-700 dark:text-amber-400">
                      {member.staleTasks}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 4C. Time-Based Reporting */}
        <div
          data-testid="report-time-summary"
          className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-800/30"
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Time-Based Activity &amp; Completion Report
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Derived from task creation timestamps and{" "}
                <code>task.status_changed</code> completion activity records
                (with <code>updatedAt</code> fallback for older completed
                tasks).
              </p>
            </div>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Window:{" "}
              {reportData.timeReport.dateFrom
                ? formatShortDate(reportData.timeReport.dateFrom)
                : "Start"}{" "}
              &rarr;{" "}
              {reportData.timeReport.dateTo
                ? formatShortDate(reportData.timeReport.dateTo)
                : "Present"}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="text-xs text-zinc-500">
                Tasks Created in Range
              </div>
              <div
                data-testid="report-tasks-created-in-range"
                className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-100"
              >
                {reportData.timeReport.tasksCreatedCount}
              </div>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="text-xs text-zinc-500">
                Tasks Completed in Range
              </div>
              <div
                data-testid="report-tasks-completed-in-range"
                className="mt-1 text-xl font-bold text-emerald-700 dark:text-emerald-400"
              >
                {reportData.timeReport.tasksCompletedCount}
              </div>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="text-xs text-zinc-500">
                Currently Overdue Tasks
              </div>
              <div
                data-testid="report-overdue-tasks-count"
                className="mt-1 text-xl font-bold text-red-700 dark:text-red-400"
              >
                {reportData.timeReport.overdueTasksCount}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
