"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type SubmitEvent } from "react";
import { authClient } from "@/lib/auth-client";

export function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isSignup = mode === "signup";
  // Synchronous guard: state updates are async, so a fast double-submit could
  // otherwise start two requests before `disabled` takes effect.
  const inFlight = useRef(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setLoading(true);

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    try {
      const { error } = isSignup
        ? await authClient.signUp.email({
            name: String(form.get("name") ?? ""),
            email,
            password,
          })
        : await authClient.signIn.email({ email, password });

      if (error) {
        setError(error.message || "Something went wrong. Please try again.");
        return;
      }
      // With Cache Components this page may be kept alive (hidden) after we
      // navigate away, so clear the typed credentials too.
      formElement.reset();
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      // This component is not guaranteed to unmount on navigation, so always
      // reset instead of relying on a remount.
      inFlight.current = false;
      setLoading(false);
    }
  }

  const input =
    "w-full rounded border border-zinc-300 px-3 py-2 text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white";

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">
        {isSignup ? "Create your account" : "Log in"}
      </h1>
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
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="rounded bg-black px-3 py-2 text-white disabled:opacity-60 dark:bg-white dark:text-black"
        >
          {loading
            ? isSignup
              ? "Creating account…"
              : "Logging in…"
            : isSignup
              ? "Sign up"
              : "Log in"}
        </button>
      </form>
      <p className="text-sm">
        {isSignup ? (
          <>
            Already have an account? <Link href="/login" className="underline">Log in</Link>
          </>
        ) : (
          <>
            No account yet? <Link href="/signup" className="underline">Sign up</Link>
          </>
        )}
      </p>
    </main>
  );
}
