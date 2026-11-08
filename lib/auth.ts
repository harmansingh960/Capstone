import "server-only";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { getDbName, getMongoClient } from "@/lib/db";

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

function resolveAuthBaseUrl(): string {
  const rawUrl = process.env.BETTER_AUTH_URL?.trim();
  if (rawUrl) {
    return rawUrl.replace(/\/+$/, "");
  }

  // Fallbacks for Vercel deployment environments
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  if (process.env.NEXT_PUBLIC_APP_URL?.trim()) {
    return process.env.NEXT_PUBLIC_APP_URL.trim().replace(/\/+$/, "");
  }

  throw new Error(
    "BETTER_AUTH_URL is not set. Use http://localhost:3000 locally and your canonical HTTPS origin (e.g. https://your-domain.com or https://your-app.vercel.app) in production.",
  );
}

import {
  resolveTrustedOrigins,
  validateAndNormalizeOrigin,
  isTrustedOrigin,
} from "@/lib/origin";

export { isTrustedOrigin, resolveTrustedOrigins, validateAndNormalizeOrigin };

function createAuth() {
  const client = getMongoClient();
  const baseURL = resolveAuthBaseUrl();
  const isHttps = baseURL.startsWith("https://");
  const isProduction = process.env.NODE_ENV === "production";

  // Prevent development fallback URLs from silently running in production
  if (
    isProduction &&
    (baseURL.startsWith("http://localhost") ||
      baseURL.startsWith("http://127.0.0.1"))
  ) {
    throw new Error(
      "Invalid BETTER_AUTH_URL: Development localhost origin cannot silently be used in production.",
    );
  }

  const secret = requireEnv(
    "BETTER_AUTH_SECRET",
    "Generate one with `openssl rand -base64 32` and set it in your environment variables.",
  );

  // Validate production secret strength
  if (isProduction && (secret.length < 32 || secret.includes("<generate"))) {
    throw new Error(
      "Insecure BETTER_AUTH_SECRET: Production requires a secure random secret of at least 32 characters.",
    );
  }

  return betterAuth({
    secret,
    baseURL,
    trustedOrigins: resolveTrustedOrigins(baseURL),
    advanced: {
      useSecureCookies: isHttps,
    },
    database: mongodbAdapter(client.db(getDbName()), { client }),
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        platformRole: {
          type: "string",
          required: false,
          defaultValue: null,
          input: false, // Prevents client from setting or modifying this during signup or user update
        },
      },
    },
  });
}

type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { _auth?: Auth };

// Built lazily so importing this module never touches env vars or the database
// at build time. Reuses the shared MongoDB client from lib/db.ts.
export function getAuth(): Auth {
  globalForAuth._auth ??= createAuth();
  return globalForAuth._auth;
}
