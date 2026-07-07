import {
  BatchGetImageCommand,
  type BatchGetImageCommandOutput,
  RepositoryNotFoundException,
} from "@aws-sdk/client-ecr";
import { tryCatch } from "@trigger.dev/core";
import pRetry, { AbortError } from "p-retry";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import {
  type AssumeRoleConfig,
  createEcrClient,
  isEcrRegistry,
  parseEcrRegistryDomain,
} from "../getDeploymentImageRef.server";
import { type RegistryConfig } from "../registryConfig.server";

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

export type ImageLookupResult = "found" | "missing" | "unknown" | "nonconformant";

// A zstd layer carried in a Docker (v2s2) manifest rather than an OCI manifest is
// unpullable by cri-o/containerd/podman. OCI zstd (...tar+zstd) is fine - only this
// Docker media type is rejected. An outdated CLI that predates OCI-media-type output
// can emit it when reusing zstd layers from a prior build or the registry cache.
const UNPULLABLE_LAYER_MEDIA_TYPE = "application/vnd.docker.image.rootfs.diff.tar.zstd";

// Nested indexes are exotic (index -> per-platform image manifests is depth 1); cap the
// walk so a pathological manifest can't fan out unbounded.
const MAX_MANIFEST_DEPTH = 3;

// Lenient: we only read what we need. An image manifest carries layers[]; a manifest list
// / OCI index carries manifests[] (per-platform child pointers). Both optional so either
// shape parses cleanly.
const ManifestSchema = z.object({
  layers: z.array(z.object({ mediaType: z.string().optional() })).optional(),
  manifests: z.array(z.object({ digest: z.string() })).optional(),
});

// Inspect one raw manifest: does it directly carry an unpullable layer, and (if it's an
// index) which child manifests should be walked. Fails open to empty on anything we can't
// parse, so an unreadable manifest never blocks a deploy.
export function inspectManifest(rawManifest: string | undefined): {
  hasUnpullableLayer: boolean;
  childDigests: string[];
} {
  const empty = { hasUnpullableLayer: false, childDigests: [] };

  if (!rawManifest) {
    return empty;
  }

  let json: unknown;
  try {
    json = JSON.parse(rawManifest);
  } catch {
    return empty;
  }

  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    return empty;
  }

  return {
    hasUnpullableLayer:
      parsed.data.layers?.some((layer) => layer.mediaType === UNPULLABLE_LAYER_MEDIA_TYPE) ?? false,
    childDigests: parsed.data.manifests?.map((child) => child.digest) ?? [],
  };
}

// Walk a manifest and, for a multi-arch index, its child manifests (fetched by digest).
// Returns true if any layer anywhere in the tree uses the unpullable media type. A child
// that can't be fetched (undefined) is treated as conformant - fail open.
export async function treeHasUnpullableLayer(
  rawManifest: string | undefined,
  fetchManifest: (digest: string) => Promise<string | undefined>,
  depth = 0
): Promise<boolean> {
  const { hasUnpullableLayer, childDigests } = inspectManifest(rawManifest);

  if (hasUnpullableLayer) {
    return true;
  }

  if (depth >= MAX_MANIFEST_DEPTH) {
    return false;
  }

  for (const digest of childDigests) {
    const childManifest = await fetchManifest(digest);
    if (await treeHasUnpullableLayer(childManifest, fetchManifest, depth + 1)) {
      return true;
    }
  }

  return false;
}

/**
 * Split a stored ECR image reference into repository + tag.
 *
 * Trust boundary: the ref is platform-generated, but we still bind the lookup to
 * our configured host (region/account come from the env host) and only parse refs
 * that sit under it. Returns null otherwise.
 */
export function parseEcrImageReference(
  imageReference: string,
  registryHost: string
): { repositoryName: string; tag: string } | null {
  const prefix = `${registryHost}/`;
  if (!imageReference.startsWith(prefix)) {
    return null;
  }

  // namespace/projectRef:tag, optionally @sha256:... which we drop here
  const remainder = imageReference.slice(prefix.length).split("@")[0];
  const lastColon = remainder.lastIndexOf(":");

  if (lastColon <= 0) {
    return null;
  }

  const repositoryName = remainder.slice(0, lastColon);
  const tag = remainder.slice(lastColon + 1);

  if (!repositoryName || !tag || tag.includes("/")) {
    return null;
  }

  return { repositoryName, tag };
}

export function interpretBatchGetImageResponse(
  response: BatchGetImageCommandOutput
): ImageLookupResult {
  if (response.images && response.images.length > 0) {
    return "found";
  }

  if (response.failures?.some((failure) => failure.failureCode === "ImageNotFound")) {
    return "missing";
  }

  // No image and no explicit not-found failure (some other failure code) -
  // we can't say it's missing, so don't block the deploy on it.
  return "unknown";
}

type BatchGetImageInput = {
  region: string;
  assumeRole?: AssumeRoleConfig;
  registryId?: string;
  repositoryName: string;
  imageIds: { imageTag?: string; imageDigest?: string }[];
};

type BatchGetImageSender = (input: BatchGetImageInput) => Promise<BatchGetImageCommandOutput>;

const sendBatchGetImage: BatchGetImageSender = async ({
  region,
  assumeRole,
  registryId,
  repositoryName,
  imageIds,
}) => {
  const ecr = await createEcrClient({ region, assumeRole });
  // Intentionally no acceptedMediaTypes: ECR returns the manifest as stored - which we
  // rely on for the layer-media-type check - and omitting it avoids a multi-arch index
  // being reported as a failure (i.e. misread as missing). BatchGetImage populates
  // imageManifest by default when the image exists; the check fails open if it's absent.
  return ecr.send(new BatchGetImageCommand({ repositoryName, registryId, imageIds }));
};

/**
 * Pre-promotion backstop: check the deployment image actually exists in ECR.
 *
 * "found"/"missing" are definitive (a nonexistent repo counts as missing).
 * "unknown" means we couldn't determine it - non-ECR registry, unparseable ref, or
 * an API error; the caller decides what to do with each. `_send` is a test seam.
 */
export async function ecrImageExists(
  {
    imageReference,
    imageDigest,
    registryConfig,
  }: {
    imageReference: string;
    imageDigest?: string;
    registryConfig: RegistryConfig;
  },
  _send: BatchGetImageSender = sendBatchGetImage
): Promise<ImageLookupResult> {
  if (!isEcrRegistry(registryConfig.host)) {
    return "unknown";
  }

  const parsed = parseEcrImageReference(imageReference, registryConfig.host);

  if (!parsed) {
    logger.warn("Could not parse deployment image reference for verification", { imageReference });
    return "unknown";
  }

  const { accountId, region } = parseEcrRegistryDomain(registryConfig.host);

  // imageDigest is supplied by the CLI request body - validate before trusting it.
  // Prefer it when valid (catches a tag that resolves to a different image), else
  // fall back to the platform-generated tag.
  const validDigest =
    imageDigest && SHA256_DIGEST.test(imageDigest.trim()) ? imageDigest.trim() : undefined;
  const imageId = validDigest ? { imageDigest: validDigest } : { imageTag: parsed.tag };

  const assumeRole = registryConfig.ecrAssumeRoleArn
    ? {
        roleArn: registryConfig.ecrAssumeRoleArn,
        externalId: registryConfig.ecrAssumeRoleExternalId,
      }
    : undefined;

  // Retry transient ECR failures (throttling/network) before giving up, so a blip
  // doesn't fail an otherwise-fine deploy. A missing repo is definitive - don't retry.
  const [error, response] = await tryCatch(
    pRetry(
      () =>
        _send({
          region,
          assumeRole,
          registryId: accountId,
          repositoryName: parsed.repositoryName,
          imageIds: [imageId],
        }).catch((err) => {
          if (err instanceof RepositoryNotFoundException) {
            throw new AbortError(err);
          }
          throw err;
        }),
      {
        retries: 2,
        minTimeout: 200,
        maxTimeout: 1000,
        onFailedAttempt: (e) => {
          logger.warn("Retrying ECR image verification", {
            imageReference,
            attempt: e.attemptNumber,
            error: e.message,
          });
        },
      }
    )
  );

  if (error) {
    // A missing repo is a definitive miss, not an ambiguous error.
    if (error instanceof RepositoryNotFoundException) {
      return "missing";
    }

    logger.error("Failed to verify deployment image in ECR", {
      imageReference,
      repositoryName: parsed.repositoryName,
      error: error.message,
    });
    return "unknown";
  }

  const result = interpretBatchGetImageResponse(response);

  if (result !== "found") {
    return result;
  }

  // Image exists - now confirm the runtime can actually pull it. Follow index children by
  // digest so multi-arch deploys are covered, not just single image manifests.
  const fetchManifest = async (digest: string): Promise<string | undefined> => {
    const [fetchError, childResponse] = await tryCatch(
      _send({
        region,
        assumeRole,
        registryId: accountId,
        repositoryName: parsed.repositoryName,
        imageIds: [{ imageDigest: digest }],
      })
    );

    if (fetchError) {
      logger.warn("Could not fetch child manifest for conformance check", {
        imageReference,
        digest,
        error: fetchError.message,
      });
      return undefined; // fail open on this child
    }

    return childResponse.images?.[0]?.imageManifest;
  };

  const topManifest = response.images?.[0]?.imageManifest;

  if (await treeHasUnpullableLayer(topManifest, fetchManifest)) {
    logger.error("Deployment image has a runtime-incompatible layer media type", {
      imageReference,
      repositoryName: parsed.repositoryName,
    });
    return "nonconformant";
  }

  return "found";
}
