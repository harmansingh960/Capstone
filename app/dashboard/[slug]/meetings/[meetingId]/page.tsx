import { Suspense } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getAuth } from "@/lib/auth";
import { toMeetingActionItemDto, toMeetingDto } from "@/lib/meeting-dto";
import {
  getMeetingById,
  getOrganizationBySlug,
  listMeetingActionItems,
  listOrganizationMembers,
  listProjects,
  parseObjectId,
  TenantAccessError,
  type UserOrganization,
} from "@/lib/tenancy";
import { SignOutButton } from "../../../sign-out-button";
import { NotificationBell } from "../../notification-bell";
import { MeetingDetailClient } from "./meeting-detail-client";

export default function MeetingDetailPage({
  params,
}: {
  params: Promise<{ slug: string; meetingId: string }>;
}) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading meeting details…</p>}>
        <MeetingDetailWorkspace params={params} />
      </Suspense>
    </main>
  );
}

async function MeetingDetailWorkspace({
  params,
}: {
  params: Promise<{ slug: string; meetingId: string }>;
}) {
  await connection();
  const { slug, meetingId } = await params;
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

  const parsedMeetingId = parseObjectId(meetingId);
  if (!parsedMeetingId) {
    return (
      <>
        <div>
          <Link
            href={`/dashboard/${encodeURIComponent(organization.slug)}/meetings`}
            className="text-sm underline"
          >
            ← Back to meetings
          </Link>
        </div>
        <h1 className="text-2xl font-semibold">Meeting not found</h1>
        <p className="text-sm text-zinc-500">
          The requested meeting ID is not valid.
        </p>
      </>
    );
  }

  const [meeting, actionItems, projects, members] = await Promise.all([
    getMeetingById(organization._id, parsedMeetingId, requestHeaders),
    listMeetingActionItems(
      organization._id,
      parsedMeetingId,
      undefined,
      requestHeaders,
    ).catch(() => []),
    listProjects(organization._id, undefined, requestHeaders),
    listOrganizationMembers(organization._id, requestHeaders),
  ]);

  if (!meeting) {
    return (
      <>
        <div>
          <Link
            href={`/dashboard/${encodeURIComponent(organization.slug)}/meetings`}
            className="text-sm underline"
          >
            ← Back to meetings
          </Link>
        </div>
        <h1 className="text-2xl font-semibold">Meeting not found</h1>
        <p className="text-sm text-zinc-500">
          This meeting does not exist in {organization.name} or you do not have
          access to it.
        </p>
      </>
    );
  }

  const projectOptions = projects.map((p) => ({
    id: p._id.toHexString(),
    name: p.name,
    status: p.status,
  }));

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link
            href={`/dashboard/${encodeURIComponent(organization.slug)}/meetings`}
            className="underline"
          >
            ← Back to meetings
          </Link>
          <span className="text-zinc-400">·</span>
          <Link
            href={`/dashboard/${encodeURIComponent(organization.slug)}`}
            className="text-zinc-600 hover:underline dark:text-zinc-400"
          >
            {organization.name}
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <NotificationBell organizationSlug={organization.slug} />
          <SignOutButton />
        </div>
      </div>

      <MeetingDetailClient
        organizationSlug={organization.slug}
        organizationName={organization.name}
        role={organization.role}
        currentUserId={session.user.id}
        initialMeeting={toMeetingDto(meeting)}
        initialActionItems={actionItems.map(toMeetingActionItemDto)}
        projects={projectOptions}
        members={members}
      />
    </>
  );
}

