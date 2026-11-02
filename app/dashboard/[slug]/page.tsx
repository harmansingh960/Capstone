import { Suspense } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import {
  getOrganizationBySlug,
  TenantAccessError,
  type UserOrganization,
} from "@/lib/tenancy";
import { SignOutButton } from "../sign-out-button";
import { ProjectsClient, type ProjectSummary } from "./projects-client";

export default function OrganizationWorkspacePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 p-6">
      <Suspense fallback={<p>Loading…</p>}>
        <OrganizationWorkspace params={params} />
      </Suspense>
    </main>
  );
}

async function fetchInitialProjects(
  slug: string,
  requestHeaders: Headers,
): Promise<ProjectSummary[]> {
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

  const response = await fetch(
    `${protocol}://${host}/api/organizations/${encodeURIComponent(slug)}/projects?status=active`,
    {
      headers: cookie ? { cookie } : undefined,
      cache: "no-store",
    },
  );

  if (response.status === 401) {
    redirect("/login");
  }
  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as { projects?: ProjectSummary[] };
  return Array.isArray(data.projects) ? data.projects : [];
}

async function OrganizationWorkspace({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
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

  const initialProjects = await fetchInitialProjects(
    organization.slug,
    requestHeaders,
  );

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <Link href="/dashboard" className="text-sm underline">
          ← Back to dashboard
        </Link>
        <SignOutButton />
      </div>

      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{organization.name}</h1>
          <p className="text-xs text-zinc-500">/{organization.slug}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/dashboard/${encodeURIComponent(organization.slug)}/members`}
            className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Members
          </Link>
          <span className="rounded bg-zinc-100 px-2.5 py-1 text-xs font-medium capitalize text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            Role: {organization.role}
          </span>
        </div>
      </header>

      <ProjectsClient
        organizationSlug={organization.slug}
        role={organization.role}
        initialProjects={initialProjects}
      />
    </>
  );
}

