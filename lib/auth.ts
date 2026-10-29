import "server-only";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { getDbName, getMongoClient } from "@/lib/db";

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

function createAuth() {
  const client = getMongoClient();
  return betterAuth({
    secret: requireEnv(
      "BETTER_AUTH_SECRET",
      "Generate one with `openssl rand -base64 32` and add it to .env.local.",
    ),
    baseURL: requireEnv(
      "BETTER_AUTH_URL",
      "Use http://localhost:3000 locally and your deployed origin in production.",
    ),
    database: mongodbAdapter(client.db(getDbName()), { client }),
    emailAndPassword: { enabled: true },
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
