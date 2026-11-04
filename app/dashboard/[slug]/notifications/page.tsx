import { Suspense } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getAuth } from "@/lib/auth";
import { toNotificationDto } from "@/lib/notification-dto";
import {
  getUnreadNotificationCount,
  listNotifications,
} from "@/lib/notifications";
import {
  getOrganizationBySlug,
  TenantAccessError,
  type UserOrganization,
} from "@/lib/tenancy";
import { NotificationBell } from "../notification-bell";
import { SignOutButton } from "../../sign-out-button";
import { NotificationsClient } from "./notifications-client";

export default function OrganizationNotificationsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">
      <Suspense
        fallback={
          <p className="text-sm text-zinc-500">Loading notifications…</p>
        }
      >
        <NotificationsWorkspace params={params} />
      </Suspense>
    </main>
  );
}

async function NotificationsWorkspace({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await connection();
  const { slug } = await params;
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) {
    redirect("/login");
  }

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

  const [initialPage, initialUnreadCount] = await Promise.all([
    listNotifications(
      organization._id,
      { limit: 20, status: "all" },
      requestHeaders,
    ),
    getUnreadNotificationCount(organization._id, requestHeaders),
  ]);

  const initialNotifications = initialPage.notifications.map((n) =>
    toNotificationDto(n, organization.slug),
  );

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 text-sm">
          <Link
            href={`/dashboard/${encodeURIComponent(organization.slug)}`}
            className="underline"
          >
            ← Back to {organization.name}
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <NotificationBell organizationSlug={organization.slug} />
          <SignOutButton />
        </div>
      </div>

      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-semibold">Notifications</h1>
          <p className="text-xs text-zinc-500">
            {organization.name} (/{organization.slug}) — In-app notification
            center
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/dashboard/${encodeURIComponent(organization.slug)}`}
            className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Projects
          </Link>
          <Link
            href={`/dashboard/${encodeURIComponent(organization.slug)}/meetings`}
            className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Meetings
          </Link>
          <Link
            href={`/dashboard/${encodeURIComponent(organization.slug)}/members`}
            className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Members
          </Link>
          {organization.role === "admin" || organization.role === "manager" ? (
            <Link
              href={`/dashboard/${encodeURIComponent(organization.slug)}/supervision`}
              className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Supervision &amp; Reports
            </Link>
          ) : null}
          <span className="rounded bg-zinc-100 px-2.5 py-1 text-xs font-medium capitalize text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            Role: {organization.role}
          </span>
        </div>
      </header>

      <NotificationsClient
        organizationSlug={organization.slug}
        initialNotifications={initialNotifications}
        initialHasMore={initialPage.hasMore}
        initialNextCursor={initialPage.nextCursor}
        initialUnreadCount={initialUnreadCount}
      />
    </>
  );
}

