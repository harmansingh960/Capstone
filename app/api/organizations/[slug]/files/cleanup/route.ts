import { connection } from "next/server";
import { cleanupExpiredPendingUploads } from "@/lib/files";
import { getCollections } from "@/lib/collections";
import {
  requireMembership,
  MANAGER_ROLES,
  TenantAccessError,
} from "@/lib/tenancy";
import { enforceRateLimit, RATE_LIMIT_PROFILES } from "@/lib/rate-limit";

/**
 * POST /api/organizations/[slug]/files/cleanup
 *
 * Authenticated scheduled/maintenance endpoint for discovering expired pending
 * upload records and safely deleting corresponding orphaned Backblaze B2 S3 storage objects
 * before marking metadata records as deleted.
 *
 * Authorization:
 * - External cron runner via `x-orchestr-cron-secret` or `Authorization: Bearer <secret>`
 *   matching `process.env.ORCHESTR_CRON_SECRET` or `process.env.CRON_SECRET`.
 * - Authenticated organization admin or manager session.
 * - Anonymous or unprivileged requests are strictly rejected (401 / 403).
 *
 * Security:
 * - Rate-limited using batch profile.
 * - Strictly restricted to expired pending records. Does NOT accept arbitrary file IDs
 *   or storage keys from request body.
 * - Returns sanitized counts only; never reveals storage keys, credentials, or presigned URLs.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  await connection();
  try {
    const { slug } = await params;

    const rateLimitError = await enforceRateLimit(
      request,
      `files-cleanup:${slug}`,
      RATE_LIMIT_PROFILES.batch,
    );
    if (rateLimitError) {
      return rateLimitError;
    }

    const { organizations } = await getCollections();
    const organization = await organizations.findOne({ slug });
    if (!organization) {
      return Response.json(
        { error: "Organization not found." },
        { status: 404 },
      );
    }

    const cronSecret =
      process.env.ORCHESTR_CRON_SECRET || process.env.CRON_SECRET;
    const reqCronSecret = request.headers.get("x-orchestr-cron-secret");
    const authHeader = request.headers.get("authorization");
    const bearerSecret = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    const isCronAuthorized =
      Boolean(cronSecret) &&
      (reqCronSecret === cronSecret || bearerSecret === cronSecret);

    if (!isCronAuthorized) {
      try {
        await requireMembership(
          organization._id,
          MANAGER_ROLES,
          request.headers,
        );
      } catch (error) {
        if (error instanceof TenantAccessError) {
          return Response.json({ error: error.message }, { status: 403 });
        }
        return Response.json({ error: "Unauthorized." }, { status: 401 });
      }
    }

    let batchSize = 50;
    const { searchParams } = new URL(request.url);

    if (searchParams.has("batchSize")) {
      const parsed = parseInt(searchParams.get("batchSize") || "", 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 200) {
        batchSize = parsed;
      } else {
        return Response.json(
          { error: "Invalid batchSize query parameter; expected integer between 1 and 200." },
          { status: 400 },
        );
      }
    }

    const contentType = request.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      try {
        const body = await request.json();
        if (body && typeof body === "object" && "batchSize" in body) {
          const parsed = parseInt(String(body.batchSize), 10);
          if (Number.isInteger(parsed) && parsed > 0 && parsed <= 200) {
            batchSize = parsed;
          } else {
            return Response.json(
              { error: "Invalid batchSize field in body; expected integer between 1 and 200." },
              { status: 400 },
            );
          }
        }
      } catch {
        // Non-JSON or empty body is allowed for POST trigger endpoints
      }
    }

    const result = await cleanupExpiredPendingUploads(
      organization._id,
      request.headers,
      {
        isCronAuthorized,
        batchSize,
      },
    );

    return Response.json(
      {
        success: true,
        cleanedCount: result.cleanedCount,
        deletedS3Count: result.deletedS3Count,
        retryableErrorCount: result.retryableErrorCount,
      },
      { status: 200 },
    );
  } catch (error) {
    const isProd = process.env.NODE_ENV === "production";
    const message = isProd
      ? "Internal server error."
      : error instanceof Error
      ? error.message
      : "Internal server error.";
    return Response.json({ error: message }, { status: 500 });
  }
}

