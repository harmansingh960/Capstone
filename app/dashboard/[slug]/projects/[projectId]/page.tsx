import { Suspense } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import type { ProjectDoc } from "@/lib/schema";
import {
  getOrganizationBySlug,
  getProjectById,
  listOrganizationMembers,
  parseObjectId,
  TenantAccessError,
  type UserOrganization,
} from "@/lib/tenancy";
import { SignOutButton } from "../../../sign-out-button";
import { NotificationBell } from "../../notification-bell";
import {
  TasksClient,
  type TaskSummary,
  type TaskWithSubtasks,
} from "./tasks-client";

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

async function fetchInitialTaskTree(
  slug: string,
  projectId: string,
  requestHeaders: Headers,
): Promise<TaskWithSubtasks[]> {
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  const cookie = requestHeaders.get("cookie") ?? "";
  const baseUrl = `${protocol}://${host}/api/organizations/${encodeURIComponent(slug)}/projects/${encodeURIComponent(projectId)}/tasks`;

  const response = await fetch(baseUrl, {
    headers: cookie ? { cookie } : undefined,
    cache: "no-store",
  });

  if (response.status === 401) {
    redirect("/login");
  }
  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as { tasks?: TaskSummary[] };
  const topLevelTasks = Array.isArray(data.tasks) ? data.tasks : [];

  return Promise.all(
    topLevelTasks.map(async (parentTask) => {
      const subRes = await fetch(
        `${baseUrl}?parentTaskId=${encodeURIComponent(parentTask.id)}`,
        {
          headers: cookie ? { cookie } : undefined,
          cache: "no-store",
        },
      );
      if (!subRes.ok) {
        return { ...parentTask, subtasks: [] };
      }
      const subData = (await subRes.json()) as { tasks?: TaskSummary[] };
      return {
        ...parentTask,
        subtasks: Array.isArray(subData.tasks) ? subData.tasks : [],
      };
    }),
  );
}

async function ProjectTasksWorkspace({
  params,
}: {
  params: Promise<{ slug: string; projectId: string }>;
}) {
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
    fetchInitialTaskTree(organization.slug, projectHexId, requestHeaders),
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

