import "server-only";
import { MongoClient, type Db } from "mongodb";
import { resolveMongoDbName } from "@/lib/schema";

// Reuse one client per runtime. In dev, hot reload re-evaluates modules, so the
// client is cached on globalThis. On Vercel, it is reused across invocations of
// the same function instance.
const globalForMongo = globalThis as unknown as {
  _mongoClient?: MongoClient;
  _mongoClientPromise?: Promise<MongoClient>;
};

// The single shared client instance (not yet awaited). The driver connects
// lazily on first operation, so this is safe to hand to libraries that need a
// client synchronously (e.g. Better Auth's MongoDB adapter).
export function getMongoClient(): MongoClient {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Copy .env.example to .env.local and add your Atlas connection string.",
    );
  }
  globalForMongo._mongoClient ??= new MongoClient(uri);
  return globalForMongo._mongoClient;
}

export function getDbName(): string {
  return resolveMongoDbName(process.env);
}

function getClientPromise(): Promise<MongoClient> {
  globalForMongo._mongoClientPromise ??= getMongoClient().connect();
  return globalForMongo._mongoClientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getClientPromise();
  return client.db(getDbName());
}

