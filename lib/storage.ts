import "server-only";
import { S3Client } from "@aws-sdk/client-s3";

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucketName: string;
  keyId: string;
  applicationKey: string;
}

export class StorageConfigurationError extends Error {
  constructor(message = "File storage service is not configured or unavailable.") {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

const DEFAULT_B2_ENDPOINT = "https://s3.eu-central-003.backblazeb2.com";
const DEFAULT_B2_REGION = "eu-central-003";
const DEFAULT_B2_BUCKET = "orchestr-files";

const globalForStorage = globalThis as unknown as {
  _s3Client?: S3Client;
};

/**
 * Returns true if Backblaze B2 storage credentials are configured in the environment.
 */
export function isStorageConfigured(): boolean {
  const keyId =
    process.env.B2_KEY_ID?.trim() ||
    process.env.B2_APPLICATION_KEY_ID?.trim();
  const applicationKey =
    process.env.B2_APPLICATION_KEY?.trim() ||
    process.env.B2_APPLICATION_KEY_SECRET?.trim();
  return Boolean(keyId && applicationKey);
}

/**
 * Returns the configured Backblaze B2 bucket name without requiring credentials.
 */
export function getStorageBucketName(): string {
  const isProduction = process.env.NODE_ENV === "production";
  const rawBucket = process.env.B2_BUCKET_NAME?.trim();
  if (isProduction && !rawBucket) {
    throw new StorageConfigurationError(
      "Backblaze B2 storage configuration error: B2_BUCKET_NAME environment variable is required in production.",
    );
  }
  return rawBucket || DEFAULT_B2_BUCKET;
}

/**
 * Resolves and validates the Backblaze B2 storage configuration.
 * Throws a sanitized configuration error if required environment variables are missing or invalid.
 */
export function getStorageConfig(): StorageConfig {
  const keyId =
    process.env.B2_KEY_ID?.trim() ||
    process.env.B2_APPLICATION_KEY_ID?.trim();
  const applicationKey =
    process.env.B2_APPLICATION_KEY?.trim() ||
    process.env.B2_APPLICATION_KEY_SECRET?.trim();

  if (!keyId || !applicationKey) {
    throw new StorageConfigurationError(
      "Backblaze B2 storage configuration error: Missing required environment variable B2_KEY_ID or B2_APPLICATION_KEY. Ensure storage credentials are set in environment variables.",
    );
  }

  const isProduction = process.env.NODE_ENV === "production";

  const rawBucket = process.env.B2_BUCKET_NAME?.trim();
  if (isProduction && !rawBucket) {
    throw new StorageConfigurationError(
      "Backblaze B2 storage configuration error: B2_BUCKET_NAME environment variable is required in production.",
    );
  }
  const bucketName = rawBucket || DEFAULT_B2_BUCKET;

  const rawRegion = process.env.B2_REGION?.trim();
  if (isProduction && !rawRegion) {
    throw new StorageConfigurationError(
      "Backblaze B2 storage configuration error: B2_REGION environment variable is required in production.",
    );
  }
  const region = rawRegion || DEFAULT_B2_REGION;

  const rawEndpoint = process.env.B2_ENDPOINT?.trim();
  if (isProduction && !rawEndpoint) {
    throw new StorageConfigurationError(
      "Backblaze B2 storage configuration error: B2_ENDPOINT environment variable is required in production.",
    );
  }
  const endpointString = rawEndpoint || DEFAULT_B2_ENDPOINT;

  let endpoint: string;
  try {
    const parsed = new URL(endpointString);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new StorageConfigurationError(`Unsupported protocol "${parsed.protocol}"`);
    }
    endpoint =
      parsed.origin +
      (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""));
  } catch (err) {
    if (err instanceof StorageConfigurationError) {
      throw err;
    }
    throw new StorageConfigurationError(
      `Backblaze B2 storage configuration error: Invalid B2_ENDPOINT "${endpointString}". Must be a valid absolute HTTP or HTTPS URL.`,
    );
  }

  return {
    endpoint,
    region,
    bucketName,
    keyId,
    applicationKey,
  };
}

/**
 * Returns the shared S3Client singleton for Backblaze B2 operations.
 * Caches on globalThis in development to avoid redundant instances across hot-reloads,
 * and reuses the instance across serverless function invocations in production.
 */
export function getStorageClient(): S3Client {
  if (!globalForStorage._s3Client) {
    const config = getStorageConfig();
    globalForStorage._s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.keyId,
        secretAccessKey: config.applicationKey,
      },
      forcePathStyle: process.env.B2_FORCE_PATH_STYLE !== "false",
    });
  }
  return globalForStorage._s3Client;
}

