import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Orchestr</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Organizational project and deliverable management platform.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="rounded border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-base font-medium">Member Portal</h2>
          <p className="text-xs text-zinc-500 mb-3">
            Access assigned organizations, projects, and deliverables.
          </p>
          <div className="flex gap-3">
            <Link
              href="/member/login"
              className="rounded bg-black px-3 py-1.5 text-sm text-white hover:opacity-90 dark:bg-white dark:text-black"
            >
              Member Log In
            </Link>
            <Link
              href="/member/signup"
              className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Create Account
            </Link>
          </div>
        </div>

        <div className="rounded border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-base font-medium">Manager Portal</h2>
          <p className="text-xs text-zinc-500 mb-3">
            Manage organization projects, tasks, team workflows, and deliverable reviews.
          </p>
          <Link
            href="/login"
            className="inline-block rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Manager Log In
          </Link>
        </div>

        <div className="rounded border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-base font-medium">Organizer Portal</h2>
          <p className="text-xs text-zinc-500 mb-3">
            Platform administrator portal for organization creation and governance.
          </p>
          <Link
            href="/organizer/login"
            className="inline-block rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Organizer Log In
          </Link>
        </div>
      </div>
    </main>
  );
}
