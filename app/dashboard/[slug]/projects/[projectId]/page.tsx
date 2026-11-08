import { Suspense } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { ObjectId } from "mongodb";
import { getAuth } from "@/lib/auth";
import type { ProjectDoc } from "@/lib/schema";
import {
  getOrganizationBySlug,
  getProjectById,
  listOrganizationMembers,
  parseObjectId,
  queryProjectTasks,
  serializeTaskAssignee,
  TenantAccessError,
  type EnrichedTaskItem,
  type UserOrganization,
} from "@/lib/tenancy";
import { SignOutButton } from "../../../sign-out-button";
import { NotificationBell } from "../../notification-bell";
import {
  TasksClient,
  type TaskSummary,
  type TaskWithSubtasks,
} from "./tasks-client";

export const instant = false;

export default function ProjectTasksWorkspacePage({
  params,
}: {
  params: Promise<{ slug: string; projectId: string }>;
}) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 p-6">
      <Suspense fallback={<p>Loading…</p>}>
        <ProjectTasksWorkspace params={params} />
      </Suspense>
    </main>
  );
}

function serializeTaskSummary(item: EnrichedTaskItem): TaskSummary {
  return {
    id: item.id,
    projectId: item.projectId,
    parentTaskId: item.parentTaskId,
    title: item.title,
    description: item.description,
    status: item.status,
    priority: item.priority,
    assigneeId: item.assigneeId,
    assignee: serializeTaskAssignee(item.assignee),
    deadline: item.deadline ? item.deadline.toISOString() : null,
    approvalRequired: item.approvalRequired,
    deliverableStatus: item.deliverableStatus,
    isBlocked: item.isBlocked,
    blockerCount: item.blockerCount,
    dependencyCount: item.dependencyCount,
    dependencies: (item.dependencies ?? []).map((dep) => ({
      id: dep.id,
      projectId: dep.projectId,
      taskId: dep.taskId,
      prerequisiteTaskId: dep.prerequisiteTaskId,
      prerequisiteTitle: dep.prerequisiteTitle,
      prerequisiteStatus: dep.prerequisiteStatus,
      prerequisiteParentTaskId: dep.prerequisiteParentTaskId,
      isBlocking: dep.isBlocking,
      createdBy: dep.createdBy,
      createdAt:
        dep.createdAt instanceof Date
          ? dep.createdAt.toISOString()
          : String(dep.createdAt),
    })),
    isOverdue: item.isOverdue,
    isDueToday: item.isDueToday,
    isDueSoon: item.isDueSoon,
    deadlineState: item.deadlineState,
    isStale: item.isStale,
    lastActivityAt: item.lastActivityAt.toISOString(),
    daysSinceActivity: item.daysSinceActivity,
    sourceMeetingId: item.sourceMeetingId,
    sourceMeetingTitle: item.sourceMeetingTitle,
    sourceActionItemId: item.sourceActionItemId,
    sourceActionItemTitle: item.sourceActionItemTitle,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

async function fetchInitialTaskTree(
  organizationId: ObjectId,
  projectId: ObjectId,
  requestHeaders: Headers,
): Promise<TaskWithSubtasks[]> {
  try {
    const topLevelResult = await queryProjectTasks(
      organizationId,
      projectId,
      undefined,
      requestHeaders,
    );
    const topLevelTasks = topLevelResult.tasks.map(serializeTaskSummary);

    return await Promise.all(
      topLevelTasks.map(async (parentTask) => {
        try {
          const subResult = await queryProjectTasks(
            organizationId,
            projectId,
            { parentTaskId: parentTask.id },
            requestHeaders,
          );
          return {
            ...parentTask,
            subtasks: subResult.tasks.map(serializeTaskSummary),
          };
        } catch {
          return { ...parentTask, subtasks: [] };
        }
      }),
    );
  } catch (error) {
    if (
      error instanceof TenantAccessError &&
      error.message === "Authentication required."
    ) {
      redirect("/login");
    }
    return [];
  }
}

async function ProjectTasksWorkspace({
  params,
}: {
  params: Promise<{ slug: string; projectId: string }>;
}) {
  await connection();
  const { slug, projectId } = await params;
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) redirect("/login");

  let organization: UserOrganization | null = null;
  try {
    organization = await getOrganizationBySlug(slug, requestHeaders);
  } catch (error) {
    if (!(error instanceof TenantAccessError)) {
      throw error;
    }
  }

  if (!organization) {
    return (
      <>
        <div>
          <Link href="/dashboard" className="text-sm underline">
            ← Back to dashboard
          </Link>
        </div>
        <h1 className="text-2xl font-semibold">Organization unavailable</h1>
        <p className="text-sm text-zinc-500">
          This organization does not exist or you do not have access to it.
        </p>
      </>
    );
  }

  const parsedProjectId = parseObjectId(projectId);
  let project: ProjectDoc | null = null;
  if (parsedProjectId) {
    project = await getProjectById(
      organization._id,
      parsedProjectId,
      requestHeaders,
    );
  }

  if (!project) {
    return (
      <>
        <div>
          <Link
            href={`/dashboard/${encodeURIComponent(organization.slug)}`}
            className="text-sm underline"
          >
            ← Back to {organization.name}
          </Link>
        </div>
        <h1 className="text-2xl font-semibold">Project unavailable</h1>
        <p className="text-sm text-zinc-500">
          This project does not exist or does not belong to this organization.
        </p>
      </>
    );
  }

  const projectHexId = project._id.toHexString();
  const [members, initialTasks] = await Promise.all([
    listOrganizationMembers(organization._id, requestHeaders),
    fetchInitialTaskTree(organization._id, project._id, requestHeaders),
  ]);

  const isArchived = project.status === "archived";

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            href={`/dashboard/${encodeURIComponent(organization.slug)}`}
            className="text-sm underline"
          >
            ← Back to {organization.name}
          </Link>
          {organization.role === "admin" ||
          organization.role === "manager" ? (
            <Link
              href={`/dashboard/${encodeURIComponent(organization.slug)}/supervision`}
              data-testid="project-supervision-link"
              className="rounded border border-zinc-300 px-2.5 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Supervision &amp; Reports
            </Link>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <NotificationBell organizationSlug={organization.slug} />
          <SignOutButton />
        </div>
      </div>

      <header className="flex flex-col gap-2 rounded border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-zinc-500">
              {organization.name} (/{organization.slug})
            </span>
            <h1 className="text-2xl font-semibold">{project.name}</h1>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${
                isArchived
                  ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                  : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
              }`}
            >
              {project.status}
            </span>
            <span className="rounded bg-zinc-100 px-2.5 py-1 text-xs font-medium capitalize text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              Role: {organization.role}
            </span>
          </div>
        </div>
        {project.description ? (
          <p className="whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">
            {project.description}
          </p>
        ) : (
          <p className="text-xs italic text-zinc-400 dark:text-zinc-500">
            No project description provided.
          </p>
        )}
      </header>

      <TasksClient
        key={`${organization.slug}:${projectHexId}:${session.user.id}:${organization.role}`}
        organizationSlug={organization.slug}
        projectId={projectHexId}
        projectStatus={project.status}
        role={organization.role}
        currentUserId={session.user.id}
        members={members}
        initialTasks={initialTasks}
      />
    </>
  );
}

