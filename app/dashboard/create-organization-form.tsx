"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type SubmitEvent } from "react";

function normalizeSlugDraft(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "");
}

function finalizeSlug(value: string): string {
  return normalizeSlugDraft(value).replace(/^-+|-+$/g, "");
}

export function CreateOrganizationForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setLoading(true);

    const trimmedName = name.trim();
    const normalizedSlug = finalizeSlug(slug);
    const payload: { name: string; slug?: string } = { name: trimmedName };
    if (normalizedSlug !== "") {
      payload.slug = normalizedSlug;
    }

    try {
      const response = await fetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        let message = "Could not create organization. Please try again.";
        try {
          const data = (await response.json()) as { error?: unknown };
          if (typeof data?.error === "string" && data.error.trim() !== "") {
            message = data.error;
          }
        } catch {
          // Use fallback message if response is not JSON.
        }
        setError(message);
        return;
      }

      setName("");
      setSlug("");
      router.refresh();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  const inputClassName =
    "w-full rounded border border-zinc-300 px-3 py-2 text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white";

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-lg font-medium">Create organization</h2>
      <label className="flex flex-col gap-1 text-sm">
        Organization name
        <input
          name="name"
          type="text"
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Acme Design"
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>
          Slug <span className="text-zinc-500">(optional)</span>
        </span>
        <input
          name="slug"
          type="text"
          maxLength={50}
          value={slug}
          onChange={(event) => setSlug(normalizeSlugDraft(event.target.value))}
          onBlur={() => setSlug((current) => finalizeSlug(current))}
          placeholder="acme-design"
          className={inputClassName}
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
        className="self-start rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-60 dark:bg-white dark:text-black"
      >
        {loading ? "Creating organization…" : "Create organization"}
      </button>
    </form>
  );
}

