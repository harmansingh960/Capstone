import "server-only";

export type LogLevel = "info" | "warn" | "error";

export interface LogEvent {
  event: string;
  level?: LogLevel;
  userId?: string | null;
  organizationId?: string | null;
  slug?: string | null;
  path?: string | null;
  method?: string | null;
  status?: number;
  durationMs?: number;
  details?: Record<string, unknown>;
  error?: string;
  [key: string]: unknown;
}

const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "cookie",
  "authorization",
  "cronSecret",
  "cron_secret",
  "connectionString",
]);

function sanitizeObject(obj: unknown, depth = 0): unknown {
  if (depth > 4 || obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, depth + 1));
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey) || lowerKey.includes("password") || lowerKey.includes("secret")) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = sanitizeObject(val, depth + 1);
    }
  }
  return sanitized;
}

/**
 * Structured, non-sensitive operational logger for serverless and container runtimes.
 * Never logs credentials, cookies, tokens, or raw secrets.
 */
export function logOperational(event: LogEvent): void {
  const level = event.level || "info";
  const payload = {
    ...event,
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || "development",
  };

  const cleanPayload = sanitizeObject(payload) as Record<string, unknown>;
  const line = JSON.stringify(cleanPayload);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

