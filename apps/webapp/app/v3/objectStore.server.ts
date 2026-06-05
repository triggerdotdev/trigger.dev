import { json } from "@remix-run/server-runtime";
import { type IOPacket } from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { singleton } from "~/utils/singleton";
import {
  normalizeObjectStoreLogicalKeyPathname,
  ObjectStoreClient,
  type ObjectStoreClientConfig,
} from "./objectStoreClient.server";

/**
 * Parsed storage URI with optional protocol prefix
 * @example { protocol: "s3", path: "run_abc/payload.json" }
 * @example { protocol: undefined, path: "batch_123/item_0/payload.json" } // legacy, uses default
 */
export type ParsedStorageUri = {
  protocol?: string;
  path: string;
};

/**
 * Parse a storage URI into protocol and path components
 * @param uri Storage URI, optionally prefixed with protocol (e.g., "s3://path" or "path")
 * @returns Parsed components { protocol?, path }
 */
export function parseStorageUri(uri: string): ParsedStorageUri {
  const match = uri.match(/^([a-z0-9]+):\/\/(.+)$/);
  if (match) {
    return {
      protocol: match[1],
      path: match[2],
    };
  }
  return {
    protocol: undefined,
    path: uri,
  };
}

/**
 * Format a storage URI with optional protocol prefix
 * @param path Storage path
 * @param protocol Optional protocol to prefix (e.g., "s3", "r2")
 * @returns Formatted URI (e.g., "s3://path" or "path")
 */
export function formatStorageUri(path: string, protocol?: string): string {
  if (protocol) {
    return `${protocol}://${path}`;
  }
  return path;
}

export const INVALID_PACKET_STORAGE_PATH = "Invalid packet storage path";

export type PacketPresignFailure = {
  success: false;
  error: string;
  status?: number;
};

const PACKET_RELATIVE_PATH_BASE = "/__packet_base__";

function throwInvalidPacketStoragePath(): never {
  throw new ServiceValidationError(INVALID_PACKET_STORAGE_PATH, 400);
}

function assertRawPacketRelativePathSegments(path: string): void {
  if (!path || path.includes("\\") || path.startsWith("/")) {
    throwInvalidPacketStoragePath();
  }

  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throwInvalidPacketStoragePath();
    }

    if (segment.includes("%")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throwInvalidPacketStoragePath();
      }

      if (decoded === "." || decoded === ".." || decoded.includes("/")) {
        throwInvalidPacketStoragePath();
      }
    }
  }
}

/**
 * Normalize a packet-relative path using the same URL pathname resolution as object-store clients.
 */
export function normalizePacketRelativePath(path: string): string {
  const url = new URL("https://trigger.invalid");
  url.pathname = `${PACKET_RELATIVE_PATH_BASE}/${path.replace(/^\/+/, "")}`;

  const prefix = `${PACKET_RELATIVE_PATH_BASE}/`;
  if (!url.pathname.startsWith(prefix)) {
    throwInvalidPacketStoragePath();
  }

  return url.pathname.slice(prefix.length);
}

/**
 * Ensure a full logical object-store key resolves under the packet prefix after URL normalization.
 */
export function assertPacketObjectStoreKeyUnderPrefix(key: string, packetPrefix: string): void {
  const normalizedKeyPath = normalizeObjectStoreLogicalKeyPathname(key);
  const normalizedPrefixPath = normalizeObjectStoreLogicalKeyPathname(packetPrefix);

  if (
    normalizedKeyPath !== normalizedPrefixPath &&
    !normalizedKeyPath.startsWith(`${normalizedPrefixPath}/`)
  ) {
    throwInvalidPacketStoragePath();
  }
}

/**
 * Validate a packet-relative path and return the canonical form used for object-store keys.
 */
export function resolveSafePacketRelativePath(path: string): string {
  assertRawPacketRelativePathSegments(path);
  const normalized = normalizePacketRelativePath(path);
  assertRawPacketRelativePathSegments(normalized);
  return normalized;
}

/**
 * Reject path traversal and other unsafe packet-relative storage paths before
 * building object-store keys or presigned URLs.
 */
export function assertSafePacketRelativePath(path: string): void {
  resolveSafePacketRelativePath(path);
}

function buildPacketObjectStoreKey(
  projectRef: string,
  envSlug: string,
  relativePath: string
): string {
  const safeRelativePath = resolveSafePacketRelativePath(relativePath);
  const prefix = `packets/${projectRef}/${envSlug}`;
  const key = `${prefix}/${safeRelativePath}`;
  assertPacketObjectStoreKeyUnderPrefix(key, prefix);
  return key;
}

/** JSON response for packet presign failures (400 client error vs 500 internal). */
export function jsonPacketPresignFailure(failure: PacketPresignFailure) {
  const status = failure.status ?? 500;
  if (status === 400) {
    return json({ error: failure.error }, { status: 400 });
  }

  return json({ error: `Failed to generate presigned URL: ${failure.error}` }, { status: 500 });
}

/**
 * Get object storage configuration for a given protocol.
 * Returns a config if baseUrl is set, even without explicit credentials —
 * in that case the AWS credential chain (ECS task role, EC2 IMDS, etc.) is used,
 * and OBJECT_STORE_BUCKET must also be set.
 */
function getObjectStoreConfig(protocol?: string): ObjectStoreClientConfig | undefined {
  if (protocol) {
    // Named provider (e.g., OBJECT_STORE_S3_*)
    const prefix = `OBJECT_STORE_${protocol.toUpperCase()}_`;
    const baseUrl = process.env[`${prefix}BASE_URL`];
    if (!baseUrl) return undefined;

    return {
      baseUrl,
      bucket: process.env[`${prefix}BUCKET`] || undefined,
      accessKeyId: process.env[`${prefix}ACCESS_KEY_ID`] || undefined,
      secretAccessKey: process.env[`${prefix}SECRET_ACCESS_KEY`] || undefined,
      region: process.env[`${prefix}REGION`] || undefined,
      service: process.env[`${prefix}SERVICE`] || undefined,
    };
  }

  // Default provider (backward compatible)
  if (!env.OBJECT_STORE_BASE_URL) {
    return undefined;
  }

  return {
    baseUrl: env.OBJECT_STORE_BASE_URL,
    bucket: env.OBJECT_STORE_BUCKET || undefined,
    accessKeyId: env.OBJECT_STORE_ACCESS_KEY_ID || undefined,
    secretAccessKey: env.OBJECT_STORE_SECRET_ACCESS_KEY || undefined,
    region: env.OBJECT_STORE_REGION || undefined,
    service: env.OBJECT_STORE_SERVICE || undefined,
  };
}

/**
 * Object storage client registry. Maps protocol name to ObjectStoreClient singleton.
 * ObjectStoreClient internally uses either aws4fetch (static credentials) or the
 * AWS SDK S3Client (IAM credential chain), selected at creation time.
 */
const objectStoreClients = singleton(
  "objectStoreClients",
  () => new Map<string, ObjectStoreClient>()
);

function getObjectStoreClient(protocol?: string): ObjectStoreClient | undefined {
  const config = getObjectStoreConfig(protocol);
  if (!config) return undefined;

  // Key includes baseUrl so that config changes (e.g. different containers in tests)
  // always produce a fresh client while production usage (stable env) is effectively
  // a per-protocol singleton.
  const cacheKey = `${protocol ?? "default"}:${config.baseUrl}`;
  if (objectStoreClients.has(cacheKey)) {
    return objectStoreClients.get(cacheKey);
  }

  const client = ObjectStoreClient.create(config);
  objectStoreClients.set(cacheKey, client);
  return client;
}

export function hasObjectStoreClient(): boolean {
  const defaultConfig = getObjectStoreConfig();
  const protocolConfig = env.OBJECT_STORE_DEFAULT_PROTOCOL
    ? getObjectStoreConfig(env.OBJECT_STORE_DEFAULT_PROTOCOL)
    : undefined;
  return !!(defaultConfig || protocolConfig);
}

export async function uploadPacketToObjectStore(
  filename: string,
  data: ReadableStream | string,
  contentType: string,
  environment: AuthenticatedEnvironment,
  storageProtocol?: string
): Promise<string> {
  const protocol = storageProtocol || env.OBJECT_STORE_DEFAULT_PROTOCOL;
  const client = getObjectStoreClient(protocol);

  if (!client) {
    throw new Error(`Object store is not configured for protocol: ${protocol || "default"}`);
  }

  const { path } = parseStorageUri(filename);
  const safePath = resolveSafePacketRelativePath(path);
  const key = buildPacketObjectStoreKey(
    environment.project.externalRef,
    environment.slug,
    safePath
  );

  logger.debug("Uploading to object store", { key, protocol: protocol || "default" });

  await client.putObject(key, data, contentType);

  // Return canonical storage URI (path only in the key; protocol prefix applied here)
  return formatStorageUri(safePath, protocol);
}

export async function downloadPacketFromObjectStore(
  packet: IOPacket,
  environment: AuthenticatedEnvironment
): Promise<IOPacket> {
  if (packet.dataType !== "application/store") {
    return packet;
  }

  // There shouldn't be an offloaded packet with undefined data…
  if (!packet.data) {
    logger.error("Object store packet has undefined data", { packet, environment });
    return {
      dataType: "application/json",
      data: undefined,
    };
  }

  const { protocol, path } = parseStorageUri(packet.data);
  const key = buildPacketObjectStoreKey(
    environment.project.externalRef,
    environment.slug,
    path
  );

  const client = getObjectStoreClient(protocol);

  if (!client) {
    throw new Error(`Object store is not configured for protocol: ${protocol || "default"}`);
  }

  logger.debug("Downloading from object store", { key, protocol: protocol || "default" });

  const data = await client.getObject(key);

  return { data, dataType: "application/json" };
}

export type GeneratePacketPresignOptions = {
  /**
   * When true (v1 packet PUT only), unprefixed keys use the legacy default object store only.
   * When false/omitted (v2 packet PUT), unprefixed keys also use OBJECT_STORE_DEFAULT_PROTOCOL.
   * Ignored for GET — reads never infer protocol from env for unprefixed keys.
   */
  forceNoPrefix?: boolean;
};

/**
 * Resolve object-store protocol for packet presigns.
 * GET: never apply OBJECT_STORE_DEFAULT_PROTOCOL to unprefixed keys.
 * PUT: optional forceNoPrefix for v1 legacy upload behavior.
 */
export function resolveStoreProtocolForPacketPresign(
  filename: string,
  method: "PUT" | "GET",
  forceNoPrefix?: boolean
): { path: string; storeProtocol: string | undefined } {
  const { protocol: explicitProtocol, path } = parseStorageUri(filename);

  if (method === "GET") {
    return { path, storeProtocol: explicitProtocol };
  }

  if (explicitProtocol !== undefined) {
    return { path, storeProtocol: explicitProtocol };
  }

  if (forceNoPrefix) {
    return { path, storeProtocol: undefined };
  }

  return { path, storeProtocol: env.OBJECT_STORE_DEFAULT_PROTOCOL };
}

export async function generatePresignedRequest(
  projectRef: string,
  envSlug: string,
  filename: string,
  method: "PUT" | "GET" = "PUT",
  options?: GeneratePacketPresignOptions
): Promise<
  | PacketPresignFailure
  | {
      success: true;
      request: Request;
      /** Canonical pointer for IOPacket.data (PUT only). */
      storagePath?: string;
    }
> {
  const { path, storeProtocol } = resolveStoreProtocolForPacketPresign(
    filename,
    method,
    options?.forceNoPrefix
  );

  let safePath: string;
  try {
    safePath = resolveSafePacketRelativePath(path);
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return {
        success: false,
        error: error.message,
        status: error.status ?? 400,
      };
    }

    throw error;
  }

  const config = getObjectStoreConfig(storeProtocol);
  if (!config?.baseUrl) {
    return {
      success: false,
      error: `Object store is not configured for protocol: ${storeProtocol || "default"}`,
    };
  }

  const client = getObjectStoreClient(storeProtocol);
  if (!client) {
    return {
      success: false,
      error: `Object store is not configured for protocol: ${storeProtocol || "default"}`,
    };
  }

  const key = buildPacketObjectStoreKey(projectRef, envSlug, safePath);

  try {
    const url = await client.presign(key, method, 300); // 5 minutes

    logger.debug("Generated presigned URL", {
      url,
      projectRef,
      envSlug,
      filename,
      protocol: storeProtocol || "default",
    });

    const storagePath = method === "PUT" ? formatStorageUri(safePath, storeProtocol) : undefined;

    return {
      success: true,
      request: new Request(url, { method }),
      storagePath,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function generatePresignedUrl(
  projectRef: string,
  envSlug: string,
  filename: string,
  method: "PUT" | "GET" = "PUT",
  options?: GeneratePacketPresignOptions
): Promise<PacketPresignFailure | { success: true; url: string; storagePath?: string }> {
  const signed = await generatePresignedRequest(projectRef, envSlug, filename, method, options);

  if (!signed.success) {
    return {
      success: false,
      error: signed.error,
      status: signed.status,
    };
  }

  return {
    success: true,
    url: signed.request.url,
    storagePath: signed.storagePath,
  };
}
