import "server-only";
import { isIP } from "node:net";
import { getDb } from "@/lib/db";
import { COLLECTIONS, type RateLimitDoc } from "@/lib/schema";
import { logOperational } from "@/lib/logger";

export type RateLimitFailurePolicy = "fail-closed" | "fail-open";

export interface RateLimitConfig {
  /** Maximum number of allowed requests in the window */
  max: number;
  /** Window duration in milliseconds (default: 60,000 ms = 1 minute) */
  windowMs: number;
  /**
   * Behavior when MongoDB is unreachable:
   * - "fail-closed": Denies request with HTTP 503 to protect sensitive endpoints (auth, batch/reminders).
   * - "fail-open": Permits request to avoid user disruption for regular mutations.
   */
  failurePolicy?: RateLimitFailurePolicy;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
  backendError?: boolean;
  failurePolicyApplied?: RateLimitFailurePolicy;
}

function parseEnvInt(val: string | undefined, defaultVal: number): number {
  if (!val) return defaultVal;
  const parsed = parseInt(val, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultVal;
}

function parseEnvPolicy(
  val: string | undefined,
  defaultPolicy: RateLimitFailurePolicy,
): RateLimitFailurePolicy {
  if (!val) return defaultPolicy;
  const normalized = val.trim().toLowerCase();
  if (normalized === "fail-closed" || normalized === "fail-open") {
    return normalized as RateLimitFailurePolicy;
  }
  return defaultPolicy;
}

/** Configurable rate limit profiles for different sensitivity tiers */
export const RATE_LIMIT_PROFILES = {
  /** Authentication endpoints (sign-in, sign-up): strict anti-brute-force. Defaults to fail-closed */
  auth: {
    max: parseEnvInt(process.env.RATE_LIMIT_AUTH_MAX, 10),
    windowMs: 60 * 1000,
    failurePolicy: parseEnvPolicy(
      process.env.RATE_LIMIT_AUTH_FAILURE_POLICY,
      "fail-closed",
    ),
  },
  /** Mutation operations (task creation, updates, deliverables, reviews, members). Defaults to fail-open */
  mutation: {
    max: parseEnvInt(process.env.RATE_LIMIT_MUTATION_MAX, 60),
    windowMs: 60 * 1000,
    failurePolicy: parseEnvPolicy(
      process.env.RATE_LIMIT_MUTATION_FAILURE_POLICY,
      "fail-open",
    ),
  },
  /** Batch & heavy tasks (reminders, reports, exports). Defaults to fail-closed */
  batch: {
    max: parseEnvInt(process.env.RATE_LIMIT_BATCH_MAX, 10),
    windowMs: 60 * 1000,
    failurePolicy: parseEnvPolicy(
      process.env.RATE_LIMIT_BATCH_FAILURE_POLICY,
      "fail-closed",
    ),
  },
  /** Standard API reads. Defaults to fail-open */
  api: {
    max: parseEnvInt(process.env.RATE_LIMIT_API_MAX, 120),
    windowMs: 60 * 1000,
    failurePolicy: "fail-open" as RateLimitFailurePolicy,
  },
} as const;

/**
 * Extracts and validates an IP address from a header value (e.g. "203.0.113.195" or "203.0.113.195, 10.0.0.1").
 * Returns the validated IP string if it is a valid IPv4 or IPv6 address, or null otherwise.
 */
function extractValidIp(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const candidate = headerValue.split(",")[0]?.trim();
  if (!candidate) return null;

  // Node's isIP returns 4 for IPv4, 6 for IPv6, 0 for invalid string
  if (isIP(candidate) !== 0) {
    return candidate;
  }

  // Handle possible IPv4 address with port (e.g., "192.168.1.1:8080")
  if (candidate.includes(":") && !candidate.includes("::")) {
    const [host] = candidate.split(":");
    if (host && isIP(host) === 4) {
      return host;
    }
  }

  return null;
}

/**
 * Derives a rate limit client identifier:
 * 1. If userId is present: scopes strictly to the authenticated user ("user:<userId>")
 *    so user sessions are never cross-contaminated with IP addresses or other tenants.
 * 2. If TRUSTED_CLIENT_IP_HEADER is explicitly configured by the infrastructure operator,
 *    reads and validates the IP from that header.
 * 3. Checks platform-verified headers injected by edge proxies:
 *    - "x-vercel-forwarded-for" (Vercel Edge network)
 *    - "cf-connecting-ip" (Cloudflare Edge)
 * 4. In development or test environments (NODE_ENV !== "production"):
 *    Falls back to "x-real-ip", "x-forwarded-for", or "127.0.0.1".
 * 5. In production environments:
 *    Arbitrary client-supplied "x-forwarded-for" or "x-real-ip" headers are NOT trusted
 *    to prevent identity spoofing / rate-limit rotation attacks. Requests lacking a
 *    verified platform IP collapse into a shared "ip:unverified" limit pool.
 */
export function getClientIdentifier(
  request: Request,
  userId?: string | null,
): string {
  if (userId && typeof userId === "string" && userId.trim()) {
    return `user:${userId.trim()}`;
  }

  // Check operator-configured trusted proxy header if present
  const trustedHeader = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (trustedHeader) {
    const customIp = extractValidIp(request.headers.get(trustedHeader));
    if (customIp) {
      return `ip:${customIp}`;
    }
  }

  // Check authoritative platform-verified proxy headers
  const vercelIp = extractValidIp(request.headers.get("x-vercel-forwarded-for"));
  if (vercelIp) {
    return `ip:${vercelIp}`;
  }

  const cfIp = extractValidIp(request.headers.get("cf-connecting-ip"));
  if (cfIp) {
    return `ip:${cfIp}`;
  }

  const isProduction = process.env.NODE_ENV === "production";
  if (!isProduction) {
    const realIp = extractValidIp(request.headers.get("x-real-ip"));
    if (realIp) {
      return `ip:${realIp}`;
    }

    const forwardedFor = extractValidIp(request.headers.get("x-forwarded-for"));
    if (forwardedFor) {
      return `ip:${forwardedFor}`;
    }

    return "ip:127.0.0.1";
  }

  // Safe fallback in production: do not trust unverified client-controlled headers
  return "ip:unverified";
}

/**
 * Checks and increments rate limit using atomic MongoDB operations across
 * distributed serverless instances. Documents self-expire via TTL index.
 */
export async function checkRateLimit(
  scopeAndIdentifier: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const windowMs = config.windowMs || 60000;
  const max = config.max || 60;
  const failurePolicy: RateLimitFailurePolicy = config.failurePolicy || "fail-open";
  const now = Date.now();
  const windowIndex = Math.floor(now / windowMs);
  const resetAt = new Date((windowIndex + 1) * windowMs);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((resetAt.getTime() - now) / 1000),
  );

  // Allow disabling rate limiting via environment variable (e.g. for offline dev or automated testing)
  if (process.env.RATE_LIMIT_DISABLED === "true") {
    return {
      success: true,
      limit: max,
      remaining: max,
      resetAt,
      retryAfterSeconds,
    };
  }

  const key = `${scopeAndIdentifier}:${windowIndex}`;

  try {
    const db = await getDb();
    const collection = db.collection<RateLimitDoc>(COLLECTIONS.rateLimits);

    const doc = await collection.findOneAndUpdate(
      { key },
      {
        $inc: { count: 1 },
        $setOnInsert: {
          key,
          resetAt,
          createdAt: new Date(),
        },
      },
      {
        upsert: true,
        returnDocument: "after",
      },
    );

    const count = doc?.count ?? 1;
    const remaining = Math.max(0, max - count);
    const success = count <= max;

    if (!success) {
      logOperational({
        event: "rate_limit_exceeded",
        level: "warn",
        details: {
          key: scopeAndIdentifier,
          count,
          limit: max,
          retryAfterSeconds,
        },
      });
    }

    return {
      success,
      limit: max,
      remaining,
      resetAt,
      retryAfterSeconds,
    };
  } catch (error) {
    const isFailClosed = failurePolicy === "fail-closed";

    logOperational({
      event: "rate_limit_backend_failure",
      level: isFailClosed ? "error" : "warn",
      error: error instanceof Error ? error.message : "Unknown error",
      details: {
        key: scopeAndIdentifier,
        failurePolicy,
      },
    });

    if (isFailClosed) {
      return {
        success: false,
        limit: max,
        remaining: 0,
        resetAt,
        retryAfterSeconds: 30,
        backendError: true,
        failurePolicyApplied: "fail-closed",
      };
    }

    return {
      success: true,
      limit: max,
      remaining: max,
      resetAt,
      retryAfterSeconds,
      backendError: true,
      failurePolicyApplied: "fail-open",
    };
  }
}

/**
 * Standard HTTP error response formatting with RateLimit headers.
 * - HTTP 503 with safe non-sensitive error when backend rate limit check fails closed.
 * - HTTP 429 when client exceeds request limit.
 * Avoids exposing internal system or database details.
 */
export function rateLimitResponse(result: RateLimitResult): Response {
  if (result.backendError) {
    return Response.json(
      {
        error: "Service Temporarily Unavailable",
        message:
          "Rate-limiting service is temporarily unavailable. Please retry shortly.",
      },
      {
        status: 503,
        headers: {
          "Retry-After": String(result.retryAfterSeconds || 30),
        },
      },
    );
  }

  return Response.json(
    {
      error: "Too Many Requests",
      message: "Rate limit exceeded. Please try again later.",
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.floor(result.resetAt.getTime() / 1000)),
      },
    },
  );
}

/**
 * Convenient helper to enforce a rate limit on an incoming request.
 * Returns a 429 or 503 Response if rate limit is exceeded or fails closed, or null if allowed.
 */
export async function enforceRateLimit(
  request: Request,
  scope: string,
  config: RateLimitConfig,
  userId?: string | null,
): Promise<Response | null> {
  const identifier = getClientIdentifier(request, userId);
  const result = await checkRateLimit(`${scope}:${identifier}`, config);
  if (!result.success) {
    return rateLimitResponse(result);
  }
  return null;
}
