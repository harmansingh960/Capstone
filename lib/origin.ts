/**
 * Origin validation and CORS helpers.
 * Shared between Server Route Handlers and Next.js Proxy.
 */

export function validateAndNormalizeOrigin(rawOrigin: string): string {
  const trimmed = rawOrigin.trim();
  if (!trimmed) {
    throw new Error(
      "Invalid BETTER_AUTH_TRUSTED_ORIGINS configuration: Empty origin entry.",
    );
  }

  if (trimmed.includes("*")) {
    throw new Error(
      `Invalid origin "${trimmed}" in BETTER_AUTH_TRUSTED_ORIGINS: Wildcard origins are not permitted.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid origin "${trimmed}" in BETTER_AUTH_TRUSTED_ORIGINS: Must be a valid absolute URL (e.g. "https://example.com" or "http://localhost:3000").`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid origin "${trimmed}" in BETTER_AUTH_TRUSTED_ORIGINS: Unsupported protocol "${parsed.protocol}". Only "http:" and "https:" are allowed.`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error(
      `Invalid origin "${trimmed}" in BETTER_AUTH_TRUSTED_ORIGINS: User credentials are not allowed in origins.`,
    );
  }

  if (parsed.search || parsed.hash) {
    throw new Error(
      `Invalid origin "${trimmed}" in BETTER_AUTH_TRUSTED_ORIGINS: Query strings and hash fragments are not allowed in origins.`,
    );
  }

  if (parsed.pathname && parsed.pathname !== "/") {
    throw new Error(
      `Invalid origin "${trimmed}" in BETTER_AUTH_TRUSTED_ORIGINS: Path segments ("${parsed.pathname}") are not allowed in origins.`,
    );
  }

  return parsed.origin;
}

export function resolveTrustedOrigins(baseURL: string): string[] {
  const origins = new Set<string>();
  if (baseURL) {
    origins.add(baseURL.replace(/\/+$/, ""));
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    origins.add(
      `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`.replace(/\/+$/, ""),
    );
  }
  if (process.env.VERCEL_URL) {
    origins.add(`https://${process.env.VERCEL_URL}`.replace(/\/+$/, ""));
  }
  if (process.env.BETTER_AUTH_TRUSTED_ORIGINS) {
    for (const rawOrigin of process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(",")) {
      const trimmed = rawOrigin.trim();
      if (!trimmed) continue;
      const normalized = validateAndNormalizeOrigin(trimmed);
      origins.add(normalized);
    }
  }
  return Array.from(origins);
}

/**
 * Checks whether an incoming origin header is an explicitly trusted origin or same-origin.
 */
export function isTrustedOrigin(
  origin: string,
  requestOrigin?: string,
): boolean {
  if (!origin) return true; // Same-origin or non-browser request
  const normalizedOrigin = origin.trim().replace(/\/+$/, "");

  if (requestOrigin && normalizedOrigin === requestOrigin.replace(/\/+$/, "")) {
    return true; // Exactly matches request host origin
  }

  const baseURL = process.env.BETTER_AUTH_URL?.trim() || "";
  const allowed = resolveTrustedOrigins(baseURL);
  return allowed.includes(normalizedOrigin);
}

