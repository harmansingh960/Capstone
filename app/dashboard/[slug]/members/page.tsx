import { Suspense } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getAuth } from "@/lib/auth";
import {
  getOrganizationBySlug,
  isPlatformAdmin,
  listOrganizationMembers,
  TenantAccessError,
  type UserOrganization,
} from "@/lib/tenancy";
import { SignOutButton } from "../../sign-out-button";
import { NotificationBell } from "../notification-bell";
import { MembersClient, type MemberSummary } from "./members-client";

export const instant = false;

export default function OrganizationMembersPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 p-6">
      <Suspense fallback={<p>Loading…</p>}>
        <OrganizationMembersWorkspace params={params} />
      </Suspense>
    </main>
  );
}

async function OrganizationMembersWorkspace({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await connection();
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

  const [rawMembers, userIsPlatformAdmin] = await Promise.all([
    listOrganizationMembers(organization._id, requestHeaders),
    isPlatformAdmin(requestHeaders),
  ]);
  const initialMembers: MemberSummary[] = rawMembers.map((m) => ({
    userId: m.userId,
    role: m.role,
    name: m.name ?? null,
    email: m.email ?? null,
  }));

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <Link
          href={`/dashboard/${encodeURIComponent(organization.slug)}`}
          className="text-sm underline"
        >
          ← Back to {organization.name}
        </Link>
        <div className="flex items-center gap-3">
          <NotificationBell organizationSlug={organization.slug} />
          <SignOutButton />
        </div>
      </div>

      <header className="flex items-center justify-between gap-4">
        <div>
          <span className="text-xs text-zinc-500">
            {organization.name} (/{organization.slug})
          </span>
          <h1 className="text-2xl font-semibold">Organization members</h1>
        </div>
        <span className="rounded bg-zinc-100 px-2.5 py-1 text-xs font-medium capitalize text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          Role: {organization.role}
        </span>
      </header>

      <MembersClient
        organizationSlug={organization.slug}
        currentUserRole={organization.role}
        currentUserId={session.user.id}
        initialMembers={initialMembers}
        isPlatformAdmin={userIsPlatformAdmin}
      />
    </>
  );
}

