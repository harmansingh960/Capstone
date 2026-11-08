import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/tenancy";
import { AuthForm } from "@/app/auth-form";

export const metadata = {
  title: "Member Log In | Orchestr",
  description: "Sign in to access your organization workspaces and projects.",
};

async function MemberLogin() {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });

  // If already authenticated as a regular member/manager, proceed directly to dashboard.
  // Platform admins must not enter through the Member portal.
  if (session) {
    const isAdmin = await isPlatformAdmin(requestHeaders);
    if (!isAdmin) {
      redirect("/dashboard");
    }
  }

  return <AuthForm portal="member" mode="login" />;
}

export default function MemberLoginPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
          <p className="text-sm text-zinc-500">Loading…</p>
        </main>
      }
    >
      <MemberLogin />
    </Suspense>
  );
}

