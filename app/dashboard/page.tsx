import { Suspense } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/tenancy";
import type { MembershipRole } from "@/lib/schema";
import { CreateOrganizationForm } from "./create-organization-form";
import { SignOutButton } from "./sign-out-button";

type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  role: MembershipRole;
};

export const instant = false;

export default function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 p-6">
      <Suspense fallback={<p>Loading…</p>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}

async function fetchOrganizations(requestHeaders: Headers): Promise<OrganizationSummary[]> {
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const cookie = requestHeaders.get("cookie") ?? "";

  const response = await fetch(`${protocol}://${host}/api/organizations`, {
    headers: cookie ? { cookie } : undefined,
    cache: "no-store",
  });

  if (response.status === 401) {
    redirect("/member/login");
  }
  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as { organizations?: OrganizationSummary[] };
  return Array.isArray(data.organizations) ? data.organizations : [];
}

async function Dashboard() {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) redirect("/member/login");

  const [organizations, userIsPlatformAdmin] = await Promise.all([
    fetchOrganizations(requestHeaders),
    isPlatformAdmin(requestHeaders),
  ]);
  const { name, email } = session.user;

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Signed in as <strong>{name}</strong> ({email})
          </p>
        </div>
        <SignOutButton />
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Your organizations</h2>
        {organizations.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
            {userIsPlatformAdmin
              ? "You do not belong to any organizations yet. Create one below to get started."
              : "You do not belong to any organizations yet. Please contact the platform administrator to be assigned to an organization."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {organizations.map((org) => (
              <li key={org.id}>
                <Link
                  href={`/dashboard/${org.slug}`}
                  className="flex items-center justify-between rounded border border-zinc-200 px-4 py-3 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">{org.name}</span>
                    <span className="text-xs text-zinc-500">/{org.slug}</span>
                  </div>
                  <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium capitalize text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {org.role}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {userIsPlatformAdmin && <CreateOrganizationForm />}
    </>
  );
}
