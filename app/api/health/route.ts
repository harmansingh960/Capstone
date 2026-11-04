import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { logOperational } from "@/lib/logger";

// Connectivity check for local setup and Vercel. Returns no data or secrets.
export async function GET() {
  await connection(); // always evaluate at request time, never at build time
  const start = Date.now();
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    const latencyMs = Date.now() - start;
    return Response.json({
      status: "healthy",
      ok: true,
      database: "connected",
      latencyMs,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logOperational({
      event: "health_check_failed",
      level: "error",
      error:
        error instanceof Error ? error.message : "Database connection failed",
    });
    return Response.json(
      {
        status: "unhealthy",
        ok: false,
        database: "unreachable",
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
