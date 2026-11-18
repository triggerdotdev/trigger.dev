import { createHash } from "node:crypto";
import {
  BatchGetImageCommand,
  ECRClient,
  GetDownloadUrlForLayerCommand,
} from "@aws-sdk/client-ecr";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { DeploymentCheckImage } from "@trigger.dev/plugins";
import { logger } from "~/services/logger.server";
import { isEcrRegistry, parseEcrRegistryDomain } from "../getDeploymentImageRef.server";
import { type RegistryConfig } from "../registryConfig.server";
import { parseEcrImageReference } from "./verifyDeploymentImage.server";

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

/** Single-image manifests only: a check reads one image, not an index. */
const SINGLE_IMAGE_MANIFESTS = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];

// Caps on a supplied image, so a check is never handed more than it can take.
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LAYERS = 128;
const MAX_URL_BYTES = 8 * 1024;

/** Download URLs asked for at once. */
const URL_CONCURRENCY = 8;

/** The whole read, assume-role included; past it the check goes ahead without the image. */
const READ_TIMEOUT_MS = 20_000;

/** Credentials for the read role's session. */
type ReadRoleCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};
/**
 * Where the STS and ECR calls go, and what the STS call signs with. Unset in production (AWS and
 * the task's own credentials); tests point the real clients at a local endpoint.
 */
type AwsTarget = {
  endpoint: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
};
type Seams = { aws?: AwsTarget };

/** A read-only registry role, assumed per read with the project ref as a session tag. */
type DeploymentCheckReadRole = { roleArn: string; externalId: string };

type ReadInput = {
  imageReference: string;
  imageDigest: string;
  projectRef: string;
  registryConfig: RegistryConfig;
  /** Without one, nothing is read: the check runs without the image. */
  readRole?: DeploymentCheckReadRole;
};

/**
 * Reads a deployment's image for a deployment check: the manifest by digest, and a fresh download
 * URL for the config and every layer, so the checker reads exactly this image and needs no registry
 * access of its own. Reads as the read role, scoped to the project's own repository. Call it per
 * attempt: ECR doesn't say how long the URLs last.
 *
 * Returns null when the image can't be read this way. Silently when this isn't configured: no read
 * role, or not an ECR registry. With a warning when it should have worked: a reference it can't
 * parse, another project's repository, an STS or ECR error (its message names roles or the
 * repository at most), a timeout, or an image over the caps. Never throws, and never logs a URL.
 */
export async function readDeploymentCheckImage(
  input: ReadInput,
  { timeoutMs = READ_TIMEOUT_MS, ...seams }: Seams & { timeoutMs?: number } = {}
): Promise<DeploymentCheckImage | null> {
  // Aborting stops the STS and ECR calls still in flight, so a timed-out read doesn't keep going.
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      logger.warn("Deployment check image not read", {
        imageDigest: input.imageDigest,
        reason: `timed out after ${timeoutMs} ms`,
      });
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([readImage(input, seams, abort.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function readImage(
  { imageReference, imageDigest, projectRef, registryConfig, readRole }: ReadInput,
  { aws }: Seams,
  abortSignal: AbortSignal
): Promise<DeploymentCheckImage | null> {
  if (!readRole || !SHA256_DIGEST.test(imageDigest) || !isEcrRegistry(registryConfig.host)) {
    return null;
  }
  const parsed = parseEcrImageReference(imageReference, registryConfig.host);
  if (!parsed) {
    logger.warn("Deployment check image not read", {
      imageDigest,
      reason: "unparseable reference",
    });
    return null;
  }
  const { repositoryName } = parsed;
  const { accountId: registryId, region } = parseEcrRegistryDomain(registryConfig.host);
  const fail = (reason: string) => {
    logger.warn("Deployment check image not read", { repositoryName, imageDigest, reason });
    return null;
  };
  // The image must be the project's own: the read role is scoped to that project's repository,
  // and nothing else should be read on its behalf.
  if (repositoryName.split("/").pop() !== projectRef)
    return fail("repository is not the project's");

  // Both clients live for this read only, and are closed at the end.
  const sts = new STSClient({
    region,
    ...(aws ? { endpoint: aws.endpoint, credentials: aws.credentials } : {}),
  });
  let ownEcr: ECRClient | undefined;
  try {
    const credentials = await assumeReadRole(sts, readRole, projectRef, abortSignal);
    const ecr = new ECRClient({
      region,
      credentials,
      ...(aws ? { endpoint: aws.endpoint } : {}),
    });
    ownEcr = ecr;

    const out = await ecr.send(
      new BatchGetImageCommand({
        registryId,
        repositoryName,
        imageIds: [{ imageDigest }],
        acceptedMediaTypes: SINGLE_IMAGE_MANIFESTS,
      }),
      { abortSignal }
    );
    const images = out.images ?? [];
    const first = images[0];
    if (!first?.imageManifest || !first.imageManifestMediaType) return fail("no manifest");
    // ECR returns one entry per tag when a digest has several; they must all be the same image.
    if (
      images.some(
        (im) =>
          im.imageManifest !== first.imageManifest ||
          im.imageManifestMediaType !== first.imageManifestMediaType
      )
    ) {
      return fail("different manifests for one digest");
    }
    const manifest = first.imageManifest;
    const mediaType = first.imageManifestMediaType;
    if (!SINGLE_IMAGE_MANIFESTS.includes(mediaType)) return fail("not a single-image manifest");
    if (Buffer.byteLength(manifest, "utf8") > MAX_MANIFEST_BYTES) return fail("manifest too large");
    if (`sha256:${createHash("sha256").update(manifest, "utf8").digest("hex")}` !== imageDigest) {
      return fail("manifest digest does not match");
    }

    const blobs = blobDigests(manifest);
    if (!blobs) return fail("manifest blobs unreadable or over the cap");

    const blobUrls: Record<string, string> = {};
    for (let i = 0; i < blobs.length; i += URL_CONCURRENCY) {
      await Promise.all(
        blobs.slice(i, i + URL_CONCURRENCY).map(async (layerDigest) => {
          const res = await ecr.send(
            new GetDownloadUrlForLayerCommand({ registryId, repositoryName, layerDigest }),
            { abortSignal }
          );
          const url = res.downloadUrl;
          if (
            res.layerDigest !== layerDigest ||
            !url ||
            !url.startsWith("https://") ||
            url.length > MAX_URL_BYTES
          ) {
            throw new BlobUrlError();
          }
          blobUrls[layerDigest] = url;
        })
      );
    }
    return { manifest, mediaType, blobUrls };
  } catch (error) {
    // Aborted on the time limit, which has already said so.
    if (abortSignal.aborted) return null;
    // STS and ECR errors name roles, the repository or the digest at most, never a URL.
    return fail(error instanceof BlobUrlError ? error.message : errorName(error));
  } finally {
    sts.destroy();
    ownEcr?.destroy();
  }
}

/** Credentials for the read role, for this project only (the ProjectRef session tag). */
async function assumeReadRole(
  sts: STSClient,
  { roleArn, externalId }: DeploymentCheckReadRole,
  projectRef: string,
  abortSignal: AbortSignal
): Promise<ReadRoleCredentials> {
  const { Credentials: c } = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      ExternalId: externalId,
      // The project in the session name too, so CloudTrail ties each read to it.
      RoleSessionName: `dc-${projectRef}-${Date.now()}`.slice(0, 64),
      DurationSeconds: 900,
      Tags: [{ Key: "ProjectRef", Value: projectRef }],
    }),
    { abortSignal }
  );
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new Error("STS returned no credentials");
  }
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
  };
}

class BlobUrlError extends Error {
  constructor() {
    super("ECR returned an unusable download URL");
  }
}

/** The config and layer digests a manifest names, without repeats, or null if it's malformed. */
function blobDigests(manifest: string): string[] | null {
  let json: unknown;
  try {
    json = JSON.parse(manifest);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const { config, layers } = json as { config?: { digest?: unknown }; layers?: unknown };
  if (!Array.isArray(layers) || layers.length === 0 || layers.length > MAX_LAYERS) return null;
  const digests = [
    config?.digest,
    ...layers.map((layer) => (layer as { digest?: unknown })?.digest),
  ];
  if (!digests.every((d): d is string => typeof d === "string" && SHA256_DIGEST.test(d))) {
    return null;
  }
  return [...new Set(digests)];
}

function errorName(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
