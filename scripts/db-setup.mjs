// Applies the Orchestr collection validators and indexes (lib/schema.ts).
// Idempotent and additive: never drops collections/indexes or edits documents.
//
// On the host (loads .env.local automatically if present):
//   npm run db:setup
// In Docker (env already loaded from .env.local by Compose):
//   docker compose exec web npm run db:setup
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { ensureSchema, resolveMongoDbName } from "../lib/schema.ts";

// Fallback for direct `node scripts/db-setup.mjs` invocations on the host.
// Existing environment variables (e.g. from Docker Compose) are never overwritten.
const envLocalPath = fileURLToPath(new URL("../.env.local", import.meta.url));
if (existsSync(envLocalPath)) {
  process.loadEnvFile?.(envLocalPath);
}

function redactSecrets(text) {
  return String(text ?? "").replace(
    /mongodb(?:\+srv)?:\/\/[^\s@]+@/gi,
    "mongodb://<redacted>@",
  );
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set.");
  process.exit(1);
}
const dbName = resolveMongoDbName(process.env);

const client = new MongoClient(uri);
try {
  const results = await ensureSchema(client.db(dbName));
  for (const r of results) {
    console.log(`${r.collection}: ${r.action}; indexes: ${r.indexes.join(", ")}`);
  }
} catch (error) {
  const codeName = error?.codeName ? `${error.codeName} ` : "";
  const message = redactSecrets(error?.message ?? error);
  console.error(`Schema setup failed: ${codeName}${message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
