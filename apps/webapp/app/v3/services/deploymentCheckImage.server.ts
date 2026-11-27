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
import { manifestMediaType, parseEcrImageReference } from "./verifyDeploymentImage.server";

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

/** Error names STS and ECR give when the read role may not do what it asked. */
const ACCESS_DENIED: ReadonlySet<string> = new Set(["AccessDenied", "AccessDeniedException"]);

/** Download URLs asked for at once. */
const URL_CONCURRENCY = 8;

/** The whole read, assume-role included. Past it the read counts as one worth trying again. */
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
  /** Without one, nothing is read: the read is `not_configured`. */
  readRole?: DeploymentCheckReadRole;
};

/**
 * What a read gave. Only `read` has an image. The rest say whether asking again can help:
 * - `retry`: it may work next time (a timeout, another STS or ECR error, an unusable URL, an image
 *   ECR can't find).
 * - `unreadable`: this image never will (not a single image, over the caps, a manifest that
 *   doesn't match its digest, or another project's repository).
 * - `not_configured`: this host can't read it (no read role, access refused, not an ECR registry,
 *   or a reference for another registry). Another host may, so it is worth asking again.
 */
export type DeploymentCheckImageRead =
  | { kind: "read"; image: DeploymentCheckImage }
  | DeploymentCheckNotRead;

/** A read or lookup that gave no answer, and whether asking again can help (see above). */
export type DeploymentCheckNotRead = {
  kind: "retry" | "unreadable" | "not_configured";
  reason: string;
};

/**
 * What the reference's tag points to: the digest of whatever manifest it names, an index or an
 * image over the caps included, since only the digest is read.
 */
export type DeploymentCheckTagLookup = { kind: "found"; digest: string } | DeploymentCheckNotRead;

/**
 * Reads a deployment's image for a deployment check: the manifest by digest, and a fresh download
 * URL for the config and every layer, so the checker reads exactly this image and needs no registry
 * access of its own. Reads as the read role, scoped to the project's own repository. Call it per
 * attempt: ECR doesn't say how long the URLs last.
 *
 * Every read that gives no image logs a warning with the reason: an STS or ECR error names roles or
 * the repository at most. Never throws, and never logs a URL.
 */
export async function readDeploymentCheckImage(
  input: ReadInput,
  { timeoutMs = READ_TIMEOUT_MS, ...seams }: Seams & { timeoutMs?: number } = {}
): Promise<DeploymentCheckImageRead> {
  return withTimeLimit(
    (signal) => readImage(input, seams, signal),
    timeoutMs,
    "Deployment check image not read",
    { imageDigest: input.imageDigest }
  );
}

/**
 * Looks up the digest the reference's tag points to, as the read role, without reading the image
 * or asking for any URL. Logs a warning when it can't, like a read. Never throws.
 */
export async function lookupDeploymentCheckTag(
  input: Omit<ReadInput, "imageDigest">,
  { timeoutMs = READ_TIMEOUT_MS, ...seams }: Seams & { timeoutMs?: number } = {}
): Promise<DeploymentCheckTagLookup> {
  return withTimeLimit(
    (signal) => lookupTag(input, seams, signal),
    timeoutMs,
    "Deployment check tag not looked up",
    { imageReference: input.imageReference }
  );
}

/**
 * Runs `work` for at most `timeoutMs`. Aborting stops the STS and ECR calls still in flight, so a
 * timed-out read doesn't keep going; past the limit the answer is one worth trying again.
 */
async function withTimeLimit<T>(
  work: (signal: AbortSignal) => Promise<T | DeploymentCheckNotRead>,
  timeoutMs: number,
  message: string,
  fields: Record<string, unknown>
): Promise<T | DeploymentCheckNotRead> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DeploymentCheckNotRead>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      const reason = `timed out after ${timeoutMs} ms`;
      logger.warn(message, { ...fields, kind: "retry", reason });
      resolve({ kind: "retry", reason });
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(abort.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

type ReadSession = {
  ecr: ECRClient;
  registryId: string;
  repositoryName: string;
  /** The tag in the reference. */
  tag: string;
  unreadable: (reason: string) => DeploymentCheckNotRead;
  retry: (reason: string) => DeploymentCheckNotRead;
};

/**
 * The checks every read and lookup share, then `run` as the read role on the project's own
 * repository. Both clients live for this call only, and are closed at the end. STS and ECR errors
 * are classified here; nothing throws.
 */
async function withReadSession<T>(
  { imageReference, projectRef, registryConfig, readRole }: Omit<ReadInput, "imageDigest">,
  { aws }: Seams,
  abortSignal: AbortSignal,
  notRead: (
    kind: DeploymentCheckNotRead["kind"],
    reason: string,
    repositoryName?: string
  ) => DeploymentCheckNotRead,
  refuse: () => DeploymentCheckNotRead | undefined,
  run: (session: ReadSession) => Promise<T | DeploymentCheckNotRead>
): Promise<T | DeploymentCheckNotRead> {
  if (!readRole) return notRead("not_configured", "no read role");
  if (!isEcrRegistry(registryConfig.host)) return notRead("not_configured", "not an ECR registry");
  const refused = refuse();
  if (refused) return refused;
  const parsed = parseEcrImageReference(imageReference, registryConfig.host);
  // A reference this host's registry settings can't parse is a mismatch of settings.
  if (!parsed) return notRead("not_configured", "reference not in the configured registry");
  const { repositoryName, tag } = parsed;
  const { accountId: registryId, region } = parseEcrRegistryDomain(registryConfig.host);
  const unreadable = (reason: string) => notRead("unreadable", reason, repositoryName);
  const retry = (reason: string) => notRead("retry", reason, repositoryName);
  // The image must be the project's own: the read role is scoped to that project's repository,
  // and nothing else should be read on its behalf.
  if (repositoryName.split("/").pop() !== projectRef)
    return unreadable("repository is not the project's");

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
    return await run({ ecr, registryId, repositoryName, tag, unreadable, retry });
  } catch (error) {
    // Aborted on the time limit, which has already logged and answered; this value is never used.
    if (abortSignal.aborted) return { kind: "retry", reason: "aborted" };
    // STS and ECR errors name roles, the repository or the digest at most, never a URL. Access
    // refused is this host's setup (the read role or its trust): reading again at once won't
    // change it, though another host may manage.
    const detail = error instanceof BlobUrlError ? error.message : errorName(error);
    if (error instanceof Error && ACCESS_DENIED.has(awsErrorCode(error))) {
      return notRead("not_configured", detail, repositoryName);
    }
    return retry(detail);
  } finally {
    sts.destroy();
    ownEcr?.destroy();
  }
}

/**
 * Why ECR gave no manifest. An image ECR can't find may be one it can't see yet (a later read finds
 * it) or one deleted since (a new deploy is the answer). Its failure codes go in the reason, so the
 * logs tell these apart from an ECR or KMS fault.
 */
function noManifest(out: { failures?: Array<{ failureCode?: string }> }): string {
  const codes = new Set(
    (out.failures ?? []).flatMap((f) => (f.failureCode ? [f.failureCode] : []))
  );
  return codes.size > 0 ? `no manifest (${[...codes].join(", ")})` : "no manifest";
}

async function readImage(
  input: ReadInput,
  seams: Seams,
  abortSignal: AbortSignal
): Promise<DeploymentCheckImageRead> {
  const { imageDigest } = input;
  const notRead = (
    kind: DeploymentCheckNotRead["kind"],
    reason: string,
    repositoryName?: string
  ): DeploymentCheckNotRead => {
    logger.warn("Deployment check image not read", { repositoryName, imageDigest, kind, reason });
    return { kind, reason };
  };
  return withReadSession<DeploymentCheckImageRead>(
    input,
    seams,
    abortSignal,
    notRead,
    () =>
      SHA256_DIGEST.test(imageDigest) ? undefined : notRead("unreadable", "not a sha256 digest"),
    async ({ ecr, registryId, repositoryName, unreadable, retry }) => {
      // No acceptedMediaTypes, as in ecrImageExists: ECR then returns the manifest as stored, so an
      // index comes back as an index (refused below) instead of as a failure.
      const out = await ecr.send(
        new BatchGetImageCommand({ registryId, repositoryName, imageIds: [{ imageDigest }] }),
        { abortSignal }
      );
      const images = out.images ?? [];
      const first = images[0];
      if (!first?.imageManifest) return retry(noManifest(out));
      // ECR returns one entry per tag when a digest has several; they must all be the same image.
      if (
        images.some(
          (im) =>
            im.imageManifest !== first.imageManifest ||
            im.imageManifestMediaType !== first.imageManifestMediaType
        )
      ) {
        return unreadable("different manifests for one digest");
      }
      const manifest = first.imageManifest;
      // Before the manifest is parsed for its media type.
      if (Buffer.byteLength(manifest, "utf8") > MAX_MANIFEST_BYTES) {
        return unreadable("manifest too large");
      }
      // The manifest's own media type when ECR leaves it out, as the digest lookup does; the digest
      // check below pins the bytes either way.
      const mediaType = first.imageManifestMediaType ?? manifestMediaType(manifest);
      if (!mediaType || !SINGLE_IMAGE_MANIFESTS.includes(mediaType)) {
        return unreadable("not a single-image manifest");
      }
      if (`sha256:${createHash("sha256").update(manifest, "utf8").digest("hex")}` !== imageDigest) {
        return unreadable("manifest digest does not match");
      }

      const blobs = blobDigests(manifest);
      if (!blobs) return unreadable("manifest blobs unreadable or over the cap");

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
      return { kind: "read", image: { manifest, mediaType, blobUrls } };
    }
  );
}

async function lookupTag(
  input: Omit<ReadInput, "imageDigest">,
  seams: Seams,
  abortSignal: AbortSignal
): Promise<DeploymentCheckTagLookup> {
  let imageTag: string | undefined;
  const notRead = (
    kind: DeploymentCheckNotRead["kind"],
    reason: string,
    repositoryName?: string
  ): DeploymentCheckNotRead => {
    logger.warn("Deployment check tag not looked up", {
      imageReference: input.imageReference,
      repositoryName,
      imageTag,
      kind,
      reason,
    });
    return { kind, reason };
  };
  return withReadSession<DeploymentCheckTagLookup>(
    input,
    seams,
    abortSignal,
    notRead,
    () => undefined,
    async ({ ecr, registryId, repositoryName, tag, retry }) => {
      imageTag = tag;
      const out = await ecr.send(
        new BatchGetImageCommand({ registryId, repositoryName, imageIds: [{ imageTag: tag }] }),
        { abortSignal }
      );
      const first = out.images?.[0];
      if (!first) return retry(noManifest(out));
      // ECR's own digest for what the tag names. The manifest's hash doesn't stand in for it: bytes
      // ECR sent in another form would hash to another digest, a mismatch that isn't there.
      const digest = first.imageId?.imageDigest;
      // An answer with no usable digest is ECR's fault, not the image's: worth asking again.
      if (!digest || !SHA256_DIGEST.test(digest)) return retry("no sha256 digest for the tag");
      return { kind: "found", digest };
    }
  );
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
  return error instanceof Error ? `${awsErrorCode(error)}: ${error.message}` : String(error);
}

/**
 * The AWS error code. The ECR client can deserialise its errors to a plain Error named "Error",
 * with the code only on `__type` (see isRepositoryAlreadyExistsError); STS errors carry it as the
 * name.
 */
function awsErrorCode(error: Error): string {
  const type = (error as { __type?: unknown }).__type;
  if (typeof type !== "string") return error.name;
  return type.split(":")[0].split("#").pop() || error.name;
}
