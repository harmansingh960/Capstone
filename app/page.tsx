import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Orchestr</h1>
      <nav className="flex gap-4 underline">
        <Link href="/signup">Sign up</Link>
        <Link href="/login">Log in</Link>
        <Link href="/dashboard">Dashboard</Link>
      </nav>
    </main>
  );
}
