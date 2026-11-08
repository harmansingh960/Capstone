"use server";

import { headers } from "next/headers";
import { isPlatformAdmin } from "@/lib/tenancy";

/**
 * Server-side verification for the Member portal.
 * Reads the session cookie from incoming request headers and checks whether
 * the authenticated user holds the platform_admin role.
 * Platform admins must not enter through the Member portal.
 * Never trusts client assertions or client-supplied role values.
 */
export async function verifyMemberAction(): Promise<{ isPlatformAdmin: boolean }> {
  const reqHeaders = await headers();
  const isAdmin = await isPlatformAdmin(reqHeaders);
  return { isPlatformAdmin: isAdmin };
}

