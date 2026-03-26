import { AwsClient } from "aws4fetch";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { startActiveSpan } from "./tracer.server";
import { IOPacket } from "@trigger.dev/core/v3";

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
 * Object storage client configuration
 */
type ObjectStoreConfig = {
  baseUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  service?: string;
};

/**
 * Get object storage configuration for a given protocol
 * @param protocol Protocol name (e.g., "s3", "r2"), or undefined for default
 * @returns Configuration object or undefined if not configured
 */
function getObjectStoreConfig(protocol?: string): ObjectStoreConfig | undefined {
  if (protocol) {
    // Named provider (e.g., OBJECT_STORE_S3_*)
    const prefix = `OBJECT_STORE_${protocol.toUpperCase()}_`;
    const baseUrl = process.env[`${prefix}BASE_URL`];
    const accessKeyId = process.env[`${prefix}ACCESS_KEY_ID`];
    const secretAccessKey = process.env[`${prefix}SECRET_ACCESS_KEY`];
    const region = process.env[`${prefix}REGION`];
    const service = process.env[`${prefix}SERVICE`];

    if (!baseUrl || !accessKeyId || !secretAccessKey) {
      return undefined;
    }

    return {
      baseUrl,
      accessKeyId,
      secretAccessKey,
      region,
      service,
    };
  }

  // Default provider (backward compatible)
  if (
    !env.OBJECT_STORE_BASE_URL ||
    !env.OBJECT_STORE_ACCESS_KEY_ID ||
    !env.OBJECT_STORE_SECRET_ACCESS_KEY
  ) {
    return undefined;
  }

  return {
    baseUrl: env.OBJECT_STORE_BASE_URL,
    accessKeyId: env.OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORE_SECRET_ACCESS_KEY,
    region: env.OBJECT_STORE_REGION,
    service: env.OBJECT_STORE_SERVICE,
  };
}

/**
 * Object storage clients registry
 * Maps protocol name to AwsClient instance
 */
const objectStoreClients = singleton(
  "objectStoreClients",
  () => new Map<string | undefined, AwsClient>()
);

/**
 * Get or create an object storage client for a given protocol
 * @param protocol Protocol name (e.g., "s3", "r2"), or undefined for default
 * @returns AwsClient instance or undefined if not configured
 */
function getObjectStoreClient(protocol?: string): AwsClient | undefined {
  const key = protocol;

  if (objectStoreClients.has(key)) {
    return objectStoreClients.get(key);
  }

  const config = getObjectStoreConfig(protocol);
  if (!config) {
    return undefined;
  }

  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    // We now set the default value to "s3" in the schema to enhance interoperability with various S3-compatible services.
    // Setting this env var to an empty string will restore the previous behavior of not setting a service.
    service: config.service ? config.service : undefined,
  });

  objectStoreClients.set(key, client);
  return client;
}

export function hasObjectStoreClient(): boolean {
  return getObjectStoreClient() !== undefined;
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
      throw new Error(
        `Object store credentials are not set for protocol: ${protocol || "default"}`
      );
    }

    const config = getObjectStoreConfig(protocol);
    if (!config?.baseUrl) {
      throw new Error(`Object store base URL is not set for protocol: ${protocol || "default"}`);
    }

    span.setAttributes({
      projectRef: environment.project.externalRef,
      environmentSlug: environment.slug,
      filename: filename,
      protocol: protocol || "default",
    });

    const url = new URL(config.baseUrl);
    url.pathname = `/packets/${environment.project.externalRef}/${environment.slug}/${filename}`;

    logger.debug("Uploading to object store", { url: url.href, protocol: protocol || "default" });

    const response = await client.fetch(url.toString(), {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
      },
      body: data,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload output to ${url}: ${response.statusText}`);
    }

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
      throw new Error(
        `Object store credentials are not set for protocol: ${protocol || "default"}`
      );
    }

    const config = getObjectStoreConfig(protocol);
    if (!config?.baseUrl) {
      throw new Error(`Object store base URL is not set for protocol: ${protocol || "default"}`);
    }

    span.setAttributes({
      projectRef: environment.project.externalRef,
      environmentSlug: environment.slug,
      filename: packet.data,
      protocol: protocol || "default",
    });

    const url = new URL(config.baseUrl);
    url.pathname = `/packets/${environment.project.externalRef}/${environment.slug}/${path}`;

    logger.debug("Downloading from object store", {
      url: url.href,
      protocol: protocol || "default",
    });

    const response = await client.fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Failed to download input from ${url}: ${response.statusText}`);
    }

    const data = await response.text();

    const rawPacket = {
      data,
      dataType: "application/json",
    };

    return rawPacket;
  });
}

export async function uploadDataToObjectStore(
  filename: string,
  data: string,
  contentType: string,
  prefix?: string,
  storageProtocol?: string
): Promise<string> {
  return await startActiveSpan("uploadDataToObjectStore()", async (span) => {
    const protocol = storageProtocol || env.OBJECT_STORE_DEFAULT_PROTOCOL;
    const client = getObjectStoreClient(protocol);

    if (!client) {
      throw new Error(
        `Object store credentials are not set for protocol: ${protocol || "default"}`
      );
    }

    const config = getObjectStoreConfig(protocol);
    if (!config?.baseUrl) {
      throw new Error(`Object store base URL is not set for protocol: ${protocol || "default"}`);
    }

    span.setAttributes({
      prefix,
      filename,
      protocol: protocol || "default",
    });

    const url = new URL(config.baseUrl);
    url.pathname = `${prefix}/${filename}`;

    logger.debug("Uploading to object store", { url: url.href, protocol: protocol || "default" });

    const response = await client.fetch(url.toString(), {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
      },
      body: data,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload data to ${url}: ${response.statusText}`);
    }

    return url.href;
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
      error: `Object store base URL is not set for protocol: ${protocol || "default"}`,
    };
  }

  const client = getObjectStoreClient(protocol);
  if (!client) {
    return {
      success: false,
      error: `Object store client is not initialized for protocol: ${protocol || "default"}`,
    };
  }

  const url = new URL(config.baseUrl);
  url.pathname = `/packets/${projectRef}/${envSlug}/${path}`;
  url.searchParams.set("X-Amz-Expires", "300"); // 5 minutes

  const signed = await client.sign(
    new Request(url, {
      method,
    }),
    {
      aws: { signQuery: true },
    }
  );

  logger.debug("Generated presigned URL", {
    url: signed.url,
    headers: Object.fromEntries(signed.headers),
    projectRef,
    envSlug,
    filename,
    protocol: protocol || "default",
  });

  return {
    success: true,
    request: signed,
  };
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
