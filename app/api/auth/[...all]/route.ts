import { toNextJsHandler } from "better-auth/next-js";
import { connection } from "next/server";
import { getAuth } from "@/lib/auth";

// Better Auth catch-all handler. Evaluated at request time only.
export async function GET(request: Request) {
  await connection();
  return toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request) {
  await connection();
  return toNextJsHandler(getAuth()).POST(request);
}
