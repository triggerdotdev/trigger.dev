import { BatchGetImageCommand, type BatchGetImageCommandOutput } from "@aws-sdk/client-ecr";
import { tryCatch } from "@trigger.dev/core";
import { logger } from "~/services/logger.server";
import {
  type AssumeRoleConfig,
  createEcrClient,
  isEcrRegistry,
  parseEcrRegistryDomain,
} from "../getDeploymentImageRef.server";
import { type RegistryConfig } from "../registryConfig.server";

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

export type ImageLookupResult = "found" | "missing" | "unknown";

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
  return ecr.send(
    new BatchGetImageCommand({
      repositoryName,
      registryId,
      imageIds,
      // We only care whether the manifest exists, not its contents.
      acceptedMediaTypes: [
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
      ],
    })
  );
};

/**
 * Pre-promotion backstop: check the deployment image actually exists in ECR.
 *
 * Returns "unknown" for non-ECR registries or any error we can't read as a
 * definitive miss - callers treat "unknown" as "proceed", so a verifier failure
 * never becomes a deploy outage. `_send` is a test seam.
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

  const [error, response] = await tryCatch(
    _send({
      region,
      assumeRole: registryConfig.ecrAssumeRoleArn
        ? {
            roleArn: registryConfig.ecrAssumeRoleArn,
            externalId: registryConfig.ecrAssumeRoleExternalId,
          }
        : undefined,
      registryId: accountId,
      repositoryName: parsed.repositoryName,
      imageIds: [imageId],
    })
  );

  if (error) {
    logger.error("Failed to verify deployment image in ECR", {
      imageReference,
      repositoryName: parsed.repositoryName,
      error: error.message,
    });
    return "unknown";
  }

  return interpretBatchGetImageResponse(response);
}
