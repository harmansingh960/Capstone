"use server";

import { headers } from "next/headers";
import { isPlatformAdmin } from "@/lib/tenancy";

/**
 * Server-side verification for the Organizer portal.
 * Reads the session cookie from incoming request headers and asserts whether
 * the user holds the single global platform_admin role.
 * Never trusts client assertions or client-supplied role values.
 */
export async function verifyOrganizerAction(): Promise<{ isOrganizer: boolean }> {
  const reqHeaders = await headers();
  const isOrganizer = await isPlatformAdmin(reqHeaders);
  return { isOrganizer };
}

