"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  // Synchronous guard: state updates are async, so a fast double-click could
  // otherwise start two sign-out requests before `disabled` takes effect.
  const inFlight = useRef(false);

  async function onClick() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      await authClient.signOut();
      router.push("/login");
      router.refresh();
    } catch {
      // Stay on the page; the button becomes usable again below.
    } finally {
      // With Cache Components, a route we navigate away from can be kept alive
      // (hidden) with its state, so this component is not guaranteed to
      // unmount. Always reset so it is never stuck on "Signing out…".
      inFlight.current = false;
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="rounded border border-zinc-400 px-3 py-2 disabled:opacity-60"
    >
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
