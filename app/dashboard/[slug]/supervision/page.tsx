import { Suspense } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getAuth } from "@/lib/auth";
import { SignOutButton } from "../../sign-out-button";
import { NotificationBell } from "../notification-bell";
import {
  getOrganizationBySlug,
  getSupervisionReports,
  getSupervisorDashboard,
  listOrganizationMembers,
  queryOrganizationTasks,
  serializeTaskAssignee,
  TenantAccessError,
  type OrganizationMember,
  type UserOrganization,
} from "@/lib/tenancy";
import {
  SupervisionClient,
  type SerializedReportData,
  type SerializedSupervisorDashboard,
  type SerializedTaskQueryResult,
} from "./supervision-client";

export default function SupervisionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-7xl px-6 py-8">
          <p className="text-sm text-zinc-500">
            Loading supervision dashboard…
          </p>
        </main>
      }
    >
      <SupervisionWorkspace params={params} />
    </Suspense>
  );
}

async function SupervisionWorkspace({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await connection();
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({
    headers: requestHeaders,
  });

  if (!session) {
    redirect("/login");
  }

  const { slug } = await params;

  let organization: UserOrganization;
  try {
    organization = await getOrganizationBySlug(slug, requestHeaders);
  } catch (error) {
    if (error instanceof TenantAccessError) {
      notFound();
    }
    throw error;
  }

  const isSupervisor =
    organization.role === "admin" || organization.role === "manager";

  if (!isSupervisor) {
    return (
      <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
        <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              <Link
                href="/dashboard"
                className="text-lg font-semibold tracking-tight hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                Orchestr
              </Link>
              <span className="text-zinc-300 dark:text-zinc-700">/</span>
              <Link
                href={`/dashboard/${organization.slug}`}
                className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                {organization.name}
              </Link>
              <span className="text-zinc-300 dark:text-zinc-700">/</span>
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Supervision
              </span>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                {session.user.email}
              </span>
              <NotificationBell organizationSlug={organization.slug} />
              <SignOutButton />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-3xl px-6 py-16">
          <div
            data-testid="supervision-access-denied"
            className="rounded-xl border border-red-200 bg-white p-8 shadow-xs dark:border-red-900/50 dark:bg-zinc-900"
          >
            <span className="inline-flex items-center rounded-md bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950/60 dark:text-red-300">
              403 Forbidden
            </span>
            <h1 className="mt-3 text-xl font-semibold tracking-tight">
              Supervisor Access Required
            </h1>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              The Supervision Dashboard and organization-wide operational
              reports are restricted to organization Administrators and
              Managers. Your current role is{" "}
              <span className="font-medium capitalize">{organization.role}</span>.
            </p>
            <div className="mt-6">
              <Link
                href={`/dashboard/${organization.slug}`}
                className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Return to Organization Workspace
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  let dashboardRaw: Awaited<ReturnType<typeof getSupervisorDashboard>>;
  let tasksRaw: Awaited<ReturnType<typeof queryOrganizationTasks>>;
  let reportsRaw: Awaited<ReturnType<typeof getSupervisionReports>>;
  let members: OrganizationMember[];

  try {
    [dashboardRaw, tasksRaw, reportsRaw, members] = await Promise.all([
      getSupervisorDashboard(organization._id, undefined, requestHeaders),
      queryOrganizationTasks(organization._id, undefined, requestHeaders),
      getSupervisionReports(organization._id, undefined, requestHeaders),
      listOrganizationMembers(organization._id, requestHeaders),
    ]);
  } catch (error) {
    if (error instanceof TenantAccessError) {
      notFound();
    }
    throw error;
  }

  function serializeTask(item: (typeof tasksRaw.tasks)[number]) {
    return {
      id: item.id,
      projectId: item.projectId,
      projectName: item.projectName,
      projectStatus: item.projectStatus,
      parentTaskId: item.parentTaskId,
      parentTaskTitle: item.parentTaskTitle,
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
      assigneeId: item.assigneeId,
      assignee: serializeTaskAssignee(item.assignee),
      deadline: item.deadline ? item.deadline.toISOString() : null,
      approvalRequired: item.approvalRequired,
      sourceMeetingId: item.sourceMeetingId,
      sourceMeetingTitle: item.sourceMeetingTitle,
      sourceActionItemId: item.sourceActionItemId,
      sourceActionItemTitle: item.sourceActionItemTitle,
      isBlocked: item.isBlocked,
      blockerCount: item.blockerCount,
      dependencyCount: item.dependencyCount,
      dependencies: item.dependencies.map((dep) => ({
        ...dep,
        createdAt: dep.createdAt.toISOString(),
      })),
      deliverableStatus: item.deliverableStatus,
      isOverdue: item.isOverdue,
      isDueToday: item.isDueToday,
      isDueSoon: item.isDueSoon,
      deadlineState: item.deadlineState,
      isStale: item.isStale,
      lastActivityAt: item.lastActivityAt.toISOString(),
      daysSinceActivity: item.daysSinceActivity,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  const initialDashboard: SerializedSupervisorDashboard = {
    config: {
      ...dashboardRaw.config,
      generatedAt: dashboardRaw.config.generatedAt.toISOString(),
    },
    overview: dashboardRaw.overview,
    projects: dashboardRaw.projects.map((p) => ({
      ...p,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    })),
    overdueHighlightTasks:
      dashboardRaw.overdueHighlightTasks.map(serializeTask),
    staleHighlightTasks: dashboardRaw.staleHighlightTasks.map(serializeTask),
  };

  const initialTaskResult: SerializedTaskQueryResult = {
    tasks: tasksRaw.tasks.map(serializeTask),
    summary: tasksRaw.summary,
    pagination: tasksRaw.pagination,
    filters: tasksRaw.filters,
    sort: tasksRaw.sort,
  };

  const initialReportData: SerializedReportData = reportsRaw;

  const serializedMembers = members.map((m) => ({
    userId: m.userId,
    role: m.role,
    name: m.name,
    email: m.email,
  }));

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="text-lg font-semibold tracking-tight hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              Orchestr
            </Link>
            <span className="text-zinc-300 dark:text-zinc-700">/</span>
            <Link
              href={`/dashboard/${organization.slug}`}
              className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {organization.name}
            </Link>
            <span className="text-zinc-300 dark:text-zinc-700">/</span>
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Supervision &amp; Reports
            </span>
            <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium capitalize text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {organization.role}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href={`/dashboard/${organization.slug}`}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Projects Workspace
            </Link>
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              {session.user.email}
            </span>
            <NotificationBell organizationSlug={organization.slug} />
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <SupervisionClient
          organizationSlug={organization.slug}
          organizationName={organization.name}
          currentUserRole={organization.role}
          initialDashboard={initialDashboard}
          initialTaskResult={initialTaskResult}
          initialReportData={initialReportData}
          members={serializedMembers}
        />
      </main>
    </div>
  );
}
