import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { startActiveSpan } from "./tracer.server";
import { IOPacket } from "@trigger.dev/core/v3";
import { ObjectStoreClient, type ObjectStoreClientConfig } from "./objectStoreClient.server";

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
  return await startActiveSpan("uploadPacketToObjectStore()", async (span) => {
    const protocol = storageProtocol || env.OBJECT_STORE_DEFAULT_PROTOCOL;
    const client = getObjectStoreClient(protocol);

    if (!client) {
      throw new Error(`Object store is not configured for protocol: ${protocol || "default"}`);
    }

    span.setAttributes({
      projectRef: environment.project.externalRef,
      environmentSlug: environment.slug,
      filename,
      protocol: protocol || "default",
    });

    const key = `packets/${environment.project.externalRef}/${environment.slug}/${filename}`;

    logger.debug("Uploading to object store", { key, protocol: protocol || "default" });

    await client.putObject(key, data, contentType);

    // Return filename with protocol prefix if specified
    return formatStorageUri(filename, protocol);
  });
}

export async function downloadPacketFromObjectStore(
  packet: IOPacket,
  environment: AuthenticatedEnvironment
): Promise<IOPacket> {
  if (packet.dataType !== "application/store") {
    return packet;
  }

  return await startActiveSpan("downloadPacketFromObjectStore()", async (span) => {
    // There shouldn't be an offloaded packet with undefined data…
    if (!packet.data) {
      logger.error("Object store packet has undefined data", { packet, environment });
      return {
        dataType: "application/json",
        data: undefined,
      };
    }

    const { protocol, path } = parseStorageUri(packet.data);
    const client = getObjectStoreClient(protocol);

    if (!client) {
      throw new Error(`Object store is not configured for protocol: ${protocol || "default"}`);
    }

    span.setAttributes({
      projectRef: environment.project.externalRef,
      environmentSlug: environment.slug,
      filename: packet.data,
      protocol: protocol || "default",
    });

    const key = `packets/${environment.project.externalRef}/${environment.slug}/${path}`;

    logger.debug("Downloading from object store", { key, protocol: protocol || "default" });

    const data = await client.getObject(key);

    return { data, dataType: "application/json" };
  });
}

export async function generatePresignedRequest(
  projectRef: string,
  envSlug: string,
  filename: string,
  method: "PUT" | "GET" = "PUT"
): Promise<
  | {
      success: false;
      error: string;
    }
  | {
      success: true;
      request: Request;
    }
> {
  const { protocol, path } = parseStorageUri(filename);

  const config = getObjectStoreConfig(protocol);
  if (!config?.baseUrl) {
    return {
      success: false,
      error: `Object store is not configured for protocol: ${protocol || "default"}`,
    };
  }

  const client = getObjectStoreClient(protocol);
  if (!client) {
    return {
      success: false,
      error: `Object store is not configured for protocol: ${protocol || "default"}`,
    };
  }

  const key = `packets/${projectRef}/${envSlug}/${path}`;

  try {
    const url = await client.presign(key, method, 300); // 5 minutes

    logger.debug("Generated presigned URL", {
      url,
      projectRef,
      envSlug,
      filename,
      protocol: protocol || "default",
    });

    return {
      success: true,
      request: new Request(url, { method }),
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to generate presigned URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function generatePresignedUrl(
  projectRef: string,
  envSlug: string,
  filename: string,
  method: "PUT" | "GET" = "PUT"
): Promise<
  | {
      success: false;
      error: string;
    }
  | {
      success: true;
      url: string;
    }
> {
  const signed = await generatePresignedRequest(projectRef, envSlug, filename, method);

  if (!signed.success) {
    return {
      success: false,
      error: signed.error,
    };
  }

  return {
    success: true,
    url: signed.request.url,
  };
}
