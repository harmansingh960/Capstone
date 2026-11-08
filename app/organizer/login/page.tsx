import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/tenancy";
import { AuthForm } from "@/app/auth-form";

export const metadata = {
  title: "Organizer Log In | Orchestr",
  description: "Platform administrator portal for organization creation and management.",
};

async function OrganizerLogin() {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });

  // If already authenticated as the Platform Admin, proceed directly to dashboard
  if (session) {
    const isOrganizer = await isPlatformAdmin(requestHeaders);
    if (isOrganizer) {
      redirect("/dashboard");
    }
  }

  return <AuthForm portal="organizer" mode="login" />;
}

export default function OrganizerLoginPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
          <p className="text-sm text-zinc-500">Loading…</p>
        </main>
      }
    >
      <OrganizerLogin />
    </Suspense>
  );
}

