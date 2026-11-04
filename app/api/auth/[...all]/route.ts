import { toNextJsHandler } from "better-auth/next-js";
import { connection } from "next/server";
import { getAuth } from "@/lib/auth";
import { enforceRateLimit, RATE_LIMIT_PROFILES } from "@/lib/rate-limit";

// Better Auth catch-all handler. Evaluated at request time only.
export async function GET(request: Request) {
  await connection();
  return toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request) {
  await connection();
  const rateLimitError = await enforceRateLimit(
    request,
    "auth",
    RATE_LIMIT_PROFILES.auth,
  );
  if (rateLimitError) {
    return rateLimitError;
  }
  return toNextJsHandler(getAuth()).POST(request);
}
