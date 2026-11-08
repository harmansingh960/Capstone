// Designates the single global Platform Admin in Orchestr.
// Idempotent and fails safe if another user is already Platform Admin.
//
// Usage:
//   node scripts/bootstrap-platform-admin.mjs [email]
// Or set PLATFORM_ADMIN_EMAIL in .env.local
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { resolveMongoDbName } from "../lib/schema.ts";

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

const targetEmail = (process.argv[2] || process.env.PLATFORM_ADMIN_EMAIL || "").trim().toLowerCase();

if (!targetEmail) {
  console.error("Error: Target email is required.");
  console.error("Usage: node scripts/bootstrap-platform-admin.mjs <email>");
  console.error("Or set PLATFORM_ADMIN_EMAIL in your environment or .env.local.");
  process.exit(1);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("Error: MONGODB_URI is not set.");
  process.exit(1);
}

const dbName = resolveMongoDbName(process.env);
console.log(`Connecting to database: "${dbName}"...`);

const client = new MongoClient(uri);

try {
  await client.connect();
  const db = client.db(dbName);
  const users = db.collection("user");

  // 1. Ensure the unique partial index exists on user.platformRole
  try {
    await users.createIndex(
      { platformRole: 1 },
      {
        name: "single_platform_admin_unique",
        unique: true,
        partialFilterExpression: { platformRole: "platform_admin" },
      },
    );
  } catch (err) {
    console.warn("Index notice:", redactSecrets(err?.message ?? err));
  }

  // 2. Check if a platform admin already exists
  const existingAdmin = await users.findOne({ platformRole: "platform_admin" });
  if (existingAdmin) {
    const existingEmail = String(existingAdmin.email || "").toLowerCase();
    if (existingEmail === targetEmail) {
      console.log(`User "${targetEmail}" is already designated as the Platform Admin. No change needed.`);
      process.exit(0);
    } else {
      console.error(
        `Security Error: Another user ("${existingEmail}") is already the Platform Admin.`,
      );
      console.error(
        "Only ONE Platform Admin is allowed across the entire website.",
      );
      console.error(
        "To reassign, remove the platformRole from the current admin before assigning a new one.",
      );
      process.exit(1);
    }
  }

  // 3. Find the target user by email
  const user = await users.findOne({
    email: { $regex: `^${targetEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
  });

  if (!user) {
    console.error(`Error: User with email "${targetEmail}" was not found in the user collection.`);
    console.error("The user must register an account first before being designated as Platform Admin.");
    process.exit(1);
  }

  // 4. Assign the platform_admin role
  await users.updateOne(
    { _id: user._id },
    { $set: { platformRole: "platform_admin", updatedAt: new Date() } },
  );

  console.log(`Success: Designated "${targetEmail}" as the single Platform Admin.`);
} catch (error) {
  console.error("Bootstrap failed:", redactSecrets(error?.message ?? error));
  process.exitCode = 1;
} finally {
  await client.close();
}

