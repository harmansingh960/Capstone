import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { AuthForm } from "@/app/auth-form";

export const metadata = {
  title: "Create Member Account | Orchestr",
  description: "Register a regular member account to join projects and collaborate.",
};

async function MemberSignup() {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });

  // If already authenticated, proceed directly to dashboard
  if (session) {
    redirect("/dashboard");
  }

  return <AuthForm portal="member" mode="signup" />;
}

export default function MemberSignupPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
          <p className="text-sm text-zinc-500">Loading…</p>
        </main>
      }
    >
      <MemberSignup />
    </Suspense>
  );
}

