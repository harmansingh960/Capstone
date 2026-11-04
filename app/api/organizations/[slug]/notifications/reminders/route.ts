import { connection } from "next/server";
import { generateDeadlineRemindersForOrganization } from "@/lib/notifications";
import { getCollections } from "@/lib/collections";
import {
  requireMembership,
  MANAGER_ROLES,
  TenantAccessError,
} from "@/lib/tenancy";

/**
 * POST /api/organizations/[slug]/notifications/reminders
 *
 * Protected server-side endpoint for triggering idempotent deadline reminder
 * notifications for incomplete tasks with deadlines in non-archived projects.
 *
 * Supports optional `dryRun` (via query param `?dryRun=true` / `?dry_run=true` or
 * JSON body `{ "dryRun": true }` / `{ "dry_run": true }`).
 *
 * Authorization:
 * - External cron runner via `x-orchestr-cron-secret` or `Authorization: Bearer <secret>`
 *   matching `process.env.ORCHESTR_CRON_SECRET` or `process.env.CRON_SECRET`.
 * - Authenticated organization admin or manager session.
 * - Anonymous or unprivileged member requests are strictly rejected (401 / 403).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  await connection();
  try {
    const { slug } = await params;
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

    let dryRun = false;
    const { searchParams } = new URL(request.url);

    if (searchParams.has("dryRun")) {
      const val = searchParams.get("dryRun");
      if (val === "true" || val === "1") {
        dryRun = true;
      } else if (val === "false" || val === "0" || val === "") {
        dryRun = false;
      } else {
        return Response.json(
          { error: "Invalid dryRun parameter; expected boolean." },
          { status: 400 },
        );
      }
    } else if (searchParams.has("dry_run")) {
      const val = searchParams.get("dry_run");
      if (val === "true" || val === "1") {
        dryRun = true;
      } else if (val === "false" || val === "0" || val === "") {
        dryRun = false;
      } else {
        return Response.json(
          { error: "Invalid dry_run parameter; expected boolean." },
          { status: 400 },
        );
      }
    }

    const contentType = request.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      try {
        const body = await request.json();
        if (body && typeof body === "object") {
          if ("dryRun" in body) {
            if (typeof body.dryRun === "boolean") {
              dryRun = body.dryRun;
            } else if (body.dryRun === "true" || body.dryRun === "1") {
              dryRun = true;
            } else if (body.dryRun === "false" || body.dryRun === "0") {
              dryRun = false;
            } else {
              return Response.json(
                { error: "Invalid dryRun field in body; expected boolean." },
                { status: 400 },
              );
            }
          } else if ("dry_run" in body) {
            if (typeof body.dry_run === "boolean") {
              dryRun = body.dry_run;
            } else if (body.dry_run === "true" || body.dry_run === "1") {
              dryRun = true;
            } else if (body.dry_run === "false" || body.dry_run === "0") {
              dryRun = false;
            } else {
              return Response.json(
                { error: "Invalid dry_run field in body; expected boolean." },
                { status: 400 },
              );
            }
          }
        }
      } catch {
        // Empty or non-JSON body is allowed for POST trigger endpoints
      }
    }

    const result = await generateDeadlineRemindersForOrganization(
      organization._id,
      { dryRun },
    );

    return Response.json(
      {
        matchedTasks: result.matchedTasks,
        generated: result.generated,
        skipped: result.skipped,
        dryRun: result.dryRun,
        referenceDate: result.referenceDate,
        organizationId: result.organizationId,
        scannedTasksCount: result.scannedTasksCount,
        remindersCreated: result.remindersCreated,
        remindersSkipped: result.remindersSkipped,
      },
      { status: 200 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}

