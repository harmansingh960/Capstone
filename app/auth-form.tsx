"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type SubmitEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { verifyOrganizerAction } from "@/app/organizer/login/actions";
import { verifyMemberAction } from "@/app/member/login/actions";

export function AuthForm({
  mode,
  portal = "member",
}: {
  mode: "signup" | "login";
  portal?: "organizer" | "manager" | "member";
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [errorLink, setErrorLink] = useState<{ href: string; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const isSignup = mode === "signup";
  const isOrganizer = portal === "organizer";
  const isManager = portal === "manager";

  // Synchronous guard: state updates are async, so a fast double-submit could
  // otherwise start two requests before `disabled` takes effect.
  const inFlight = useRef(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setErrorLink(null);
    setLoading(true);

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const password = String(form.get("password") ?? "");

    try {
      if (isSignup) {
        if (isOrganizer || isManager) {
          setError("Public registration is only available through the Member Portal.");
          return;
        }

        const { error } = await authClient.signUp.email({
          name: String(form.get("name") ?? "").trim(),
          email,
          password,
        });

        if (error) {
          setError(error.message || "Something went wrong. Please try again.");
          return;
        }
      } else {
        const { error } = await authClient.signIn.email({ email, password });

        if (error) {
          // Generic error message to prevent account enumeration
          setError("Invalid email or password.");
          return;
        }

        // If authenticating via the Organizer portal, verify platform administrator status server-side
        if (isOrganizer) {
          const { isOrganizer: verifiedAdmin } = await verifyOrganizerAction();
          if (!verifiedAdmin) {
            // Revoke the session immediately; normal users are forbidden from the Organizer portal
            await authClient.signOut();
            setError("Access restricted. This portal is for the global platform organizer only.");
            return;
          }
        } else {
          // If authenticating via the Member portal, check if user is a platform administrator
          const { isPlatformAdmin: userIsAdmin } = await verifyMemberAction();
          if (userIsAdmin) {
            // Revoke the session immediately; platform admin must use the Organizer portal
            await authClient.signOut();
            setError("This account belongs to the Organizer Portal. Please sign in through Organizer Login.");
            setErrorLink({ href: "/organizer/login", text: "Organizer Login" });
            return;
          }
        }
      }

      // With Cache Components this page may be kept alive (hidden) after we
      // navigate away, so clear the typed credentials too.
      formElement.reset();
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  const input =
    "w-full rounded border border-zinc-300 px-3 py-2 text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white";

  const title = isOrganizer
    ? "Organizer Log In"
    : isManager
      ? "Manager Log In"
      : isSignup
        ? "Create Member Account"
        : "Member Log In";

  const subtitle = isOrganizer
    ? "Sign in to access global platform administration."
    : isManager
      ? "Sign in to manage organization projects, tasks, and deliverable reviews."
      : isSignup
        ? "Register to join projects and collaborate with your team."
        : "Sign in to access your organization workspaces.";

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        {isSignup && (
          <label className="flex flex-col gap-1 text-sm">
            Name
            <input name="name" type="text" required autoComplete="name" className={input} />
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" type="email" required autoComplete="email" className={input} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete={isSignup ? "new-password" : "current-password"}
            className={input}
          />
        </label>
        {error && (
          <div role="alert" className="text-sm text-red-600 flex flex-col gap-1">
            <p>{error}</p>
            {errorLink && (
              <p>
                <Link
                  href={errorLink.href}
                  className="underline font-medium text-black dark:text-white"
                >
                  {errorLink.text}
                </Link>
              </p>
            )}
          </div>
        )}
        <button
          type="submit"
          disabled={loading}
          className="rounded bg-black px-3 py-2 text-white disabled:opacity-60 dark:bg-white dark:text-black font-medium"
        >
          {loading
            ? isSignup
              ? "Creating account…"
              : "Logging in…"
            : isSignup
              ? "Create account"
              : isOrganizer
                ? "Log in as Organizer"
                : isManager
                  ? "Log in as Manager"
                  : "Log in"}
        </button>
      </form>

      {isOrganizer ? (
        <p className="text-sm text-zinc-500">
          Are you a regular member?{" "}
          <Link href="/member/login" className="underline text-black dark:text-white">
            Member portal
          </Link>
        </p>
      ) : isManager ? (
        <div className="flex flex-col gap-2 text-sm text-zinc-500">
          <p>
            Regular team member?{" "}
            <Link href="/member/login" className="underline text-black dark:text-white">
              Member portal
            </Link>
          </p>
          <p>
            Platform organizer?{" "}
            <Link href="/organizer/login" className="underline text-black dark:text-white">
              Organizer portal
            </Link>
          </p>
        </div>
      ) : isSignup ? (
        <p className="text-sm">
          Already have an account?{" "}
          <Link href="/member/login" className="underline">
            Log in
          </Link>
        </p>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <p>
            No account yet?{" "}
            <Link href="/member/signup" className="underline">
              Sign up
            </Link>
          </p>
          <p className="text-zinc-500">
            Platform organizer?{" "}
            <Link href="/organizer/login" className="underline text-black dark:text-white">
              Organizer portal
            </Link>
          </p>
        </div>
      )}
    </main>
  );
}
