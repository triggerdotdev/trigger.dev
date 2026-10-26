import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip as gunzipCallback, gzip as gzipCallback } from "node:zlib";
import { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import type { PrismaClientOrTransaction, WorkerDeployment } from "@trigger.dev/database";
import { z } from "zod";
import { env } from "~/env.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { FEATURE_FLAG } from "./featureFlags";
import pRetry from "p-retry";
import { makeFlag } from "./featureFlags.server";
import { formatStorageUri, getObjectStoreClient, parseStorageUri } from "./objectStore.server";
import { ObjectStoreClient, type ObjectStoreClientConfig } from "./objectStoreClient.server";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

export const DEPLOYMENT_INDEX_FORMAT_VERSION = 1;

/**
 * The full indexing payload of one deployment, as registration parsed it, plus
 * the identity it was captured under. Versions, runtime and every declared
 * resource live in `request.metadata`.
 */
export const DeploymentIndexEnvelope = z.object({
  formatVersion: z.literal(DEPLOYMENT_INDEX_FORMAT_VERSION),
  projectId: z.string(),
  projectRef: z.string(),
  environmentId: z.string(),
  environmentSlug: z.string(),
  environmentType: z.string(),
  deploymentId: z.string(),
  deploymentVersion: z.string(),
  request: CreateBackgroundWorkerRequestBody,
});

export type DeploymentIndexEnvelope = z.infer<typeof DeploymentIndexEnvelope>;

/** What a deployment row stores to find and verify its snapshot. */
export type DeploymentIndexReference = {
  indexObjectKey: string;
  indexSha256: string;
  indexFormatVersion: number;
};

export class DeploymentIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentIndexError";
  }
}

const CONTENT_TYPE = "application/gzip";

type DeploymentIndexStoreOptions = {
  /** The logical key's first segment: the dedicated bucket, or the packet root. */
  root: string;
  /** The object-store protocol new snapshots are written with, recorded on their reference. */
  protocol?: string;
  /** The client for a protocol; a reference is read back through the protocol it records. */
  clientFor: (protocol: string | undefined) => ObjectStoreClient | undefined;
  maxAttempts: number;
  minRetryTimeoutMs?: number;
};

/**
 * Immutable snapshots, one object per deployment and content. The key ends in
 * the sha256 of the uncompressed JSON, so a retried upload of the same index
 * lands on the same key and a create-only write can never replace it.
 */
export class DeploymentIndexStore {
  private readonly prefix: string;

  constructor(private readonly options: DeploymentIndexStoreOptions) {
    this.prefix = `${options.root}/deployment-indexes`;
  }

  async put(envelope: DeploymentIndexEnvelope): Promise<DeploymentIndexReference> {
    const { protocol } = this.options;
    const client = this.#client(protocol);
    const json = JSON.stringify(envelope);
    const sha256 = createHash("sha256").update(json).digest("hex");
    const key = [
      this.prefix,
      envelope.projectRef,
      envelope.environmentSlug,
      envelope.deploymentId,
      `${sha256}.json.gz`,
    ].join("/");
    const body = await gzip(json);

    const result = await pRetry(() => client.putObjectIfAbsent(key, body, CONTENT_TYPE), {
      retries: this.options.maxAttempts - 1,
      minTimeout: this.options.minRetryTimeoutMs ?? 250,
      maxTimeout: 2000,
      factor: 2,
      onFailedAttempt: (error) => {
        logger.warn("Deployment index upload failed, retrying", {
          key,
          attempt: error.attemptNumber,
          error: error.message,
        });
      },
    });

    logger.debug("Stored deployment index", { key, result, bytes: body.byteLength });

    return {
      indexObjectKey: formatStorageUri(key, protocol),
      indexSha256: sha256,
      indexFormatVersion: envelope.formatVersion,
    };
  }

  async get(
    reference: DeploymentIndexReference,
    owner: { projectId: string }
  ): Promise<DeploymentIndexEnvelope> {
    const { protocol, path: key } = parseStorageUri(reference.indexObjectKey);

    if (!key.startsWith(`${this.prefix}/`)) {
      throw new DeploymentIndexError("Deployment index is not in this store");
    }

    if (reference.indexFormatVersion !== DEPLOYMENT_INDEX_FORMAT_VERSION) {
      throw new DeploymentIndexError(
        `Unsupported deployment index format version ${reference.indexFormatVersion}`
      );
    }

    const response = await this.#client(protocol).getObjectResponse(key);
    const json = (await gunzip(Buffer.from(await response.arrayBuffer()))).toString("utf8");
    const sha256 = createHash("sha256").update(json).digest("hex");

    if (sha256 !== reference.indexSha256) {
      throw new DeploymentIndexError("Deployment index checksum mismatch");
    }

    const parsed = DeploymentIndexEnvelope.safeParse(JSON.parse(json));

    if (!parsed.success) {
      throw new DeploymentIndexError("Deployment index does not match its format version");
    }

    if (parsed.data.projectId !== owner.projectId) {
      throw new DeploymentIndexError("Deployment index belongs to a different project");
    }

    return parsed.data;
  }

  #client(protocol: string | undefined): ObjectStoreClient {
    const client = this.options.clientFor(protocol);
    if (!client) {
      throw new DeploymentIndexError(
        `No object store is configured for protocol ${protocol ?? "default"}`
      );
    }
    return client;
  }
}

/** Packet keys live under this root, so shared-store snapshots sit beside them. */
const SHARED_STORE_ROOT = "packets";

export type DeploymentIndexStoreConfig = {
  /** A dedicated store for snapshots (DEPLOYMENT_INDEX_OBJECT_STORE_*). */
  dedicated?: ObjectStoreClientConfig & { bucket: string };
  /** The protocol new packet uploads use, when snapshots share the packet store. */
  sharedProtocol?: string;
  /** The packet store's client for a protocol. */
  sharedClientFor: (protocol: string | undefined) => ObjectStoreClient | undefined;
  maxAttempts: number;
};

/**
 * The dedicated store when one is configured, otherwise the packet store's
 * provider for new uploads, otherwise undefined (no snapshots).
 */
export function createDeploymentIndexStore(
  config: DeploymentIndexStoreConfig
): DeploymentIndexStore | undefined {
  const { dedicated, sharedProtocol, sharedClientFor, maxAttempts } = config;

  if (dedicated) {
    const client = ObjectStoreClient.create(dedicated);
    return new DeploymentIndexStore({
      root: dedicated.bucket,
      clientFor: () => client,
      maxAttempts,
    });
  }

  if (!sharedClientFor(sharedProtocol)) {
    return undefined;
  }

  return new DeploymentIndexStore({
    root: SHARED_STORE_ROOT,
    protocol: sharedProtocol,
    clientFor: sharedClientFor,
    maxAttempts,
  });
}

/** The store configured by DEPLOYMENT_INDEX_OBJECT_STORE_* and OBJECT_STORE_*. */
export const getDeploymentIndexStore = (): DeploymentIndexStore | undefined =>
  singleton("deploymentIndexStore", () => {
    const baseUrl = env.DEPLOYMENT_INDEX_OBJECT_STORE_BASE_URL;
    const bucket = env.DEPLOYMENT_INDEX_OBJECT_STORE_BUCKET;

    return createDeploymentIndexStore({
      dedicated:
        baseUrl && bucket
          ? {
              baseUrl,
              bucket,
              accessKeyId: env.DEPLOYMENT_INDEX_OBJECT_STORE_ACCESS_KEY_ID || undefined,
              secretAccessKey: env.DEPLOYMENT_INDEX_OBJECT_STORE_SECRET_ACCESS_KEY || undefined,
              region: env.DEPLOYMENT_INDEX_OBJECT_STORE_REGION || undefined,
              service: env.DEPLOYMENT_INDEX_OBJECT_STORE_SERVICE || undefined,
            }
          : undefined,
      sharedProtocol: env.OBJECT_STORE_DEFAULT_PROTOCOL,
      sharedClientFor: getObjectStoreClient,
      maxAttempts: env.DEPLOYMENT_INDEX_UPLOAD_MAX_ATTEMPTS,
    });
  });

/**
 * Store the deployment's index before registration mutates anything. Returns
 * undefined when no store is configured or capture is switched off, and throws
 * once the bounded retries are spent.
 */
export async function captureDeploymentIndex(
  environment: AuthenticatedEnvironment,
  deployment: Pick<WorkerDeployment, "friendlyId" | "version">,
  body: CreateBackgroundWorkerRequestBody,
  store: DeploymentIndexStore | undefined,
  prisma: PrismaClientOrTransaction
): Promise<DeploymentIndexReference | undefined> {
  if (!store) {
    return undefined;
  }

  const enabled = await makeFlag(prisma)({
    key: FEATURE_FLAG.deploymentIndexCaptureEnabled,
    defaultValue: env.DEPLOYMENT_INDEX_CAPTURE_ENABLED,
  });

  if (!enabled) {
    return undefined;
  }

  return store.put({
    formatVersion: DEPLOYMENT_INDEX_FORMAT_VERSION,
    projectId: environment.projectId,
    projectRef: environment.project.externalRef,
    environmentId: environment.id,
    environmentSlug: environment.slug,
    environmentType: environment.type,
    deploymentId: deployment.friendlyId,
    deploymentVersion: deployment.version,
    request: body,
  });
}
