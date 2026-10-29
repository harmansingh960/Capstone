import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { SignOutButton } from "./sign-out-button";

export default function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-4 p-6">
      <Suspense fallback={<p>Loading…</p>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}

async function Dashboard() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const { name, email } = session.user;
  return (
    <>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p>
        Signed in as <strong>{name}</strong> ({email})
      </p>
      <p className="text-sm text-zinc-500">Placeholder — features coming soon.</p>
      <div>
        <SignOutButton />
      </div>
    </>
  );
}
