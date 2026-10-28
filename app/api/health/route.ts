import { connection } from "next/server";
import { getDb } from "@/lib/db";

// Connectivity check for local setup and Vercel. Returns no data or secrets.
export async function GET() {
  await connection(); // always evaluate at request time, never at build time
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return Response.json({ ok: true, database: "connected" });
  } catch (error) {
    console.error("Health check failed:", error);
    return Response.json({ ok: false, database: "unreachable" }, { status: 503 });
  }
}

