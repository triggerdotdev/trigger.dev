import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService } from "./baseService.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BuildServerMetadata } from "@trigger.dev/core/v3";
import { customAlphabet } from "nanoid";
import { errAsync, fromPromise, okAsync } from "neverthrow";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";

const nanoid = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 24);
const objectStoreClient =
  env.ARTIFACTS_OBJECT_STORE_ACCESS_KEY_ID &&
  env.ARTIFACTS_OBJECT_STORE_SECRET_ACCESS_KEY &&
  env.ARTIFACTS_OBJECT_STORE_BASE_URL
    ? new S3Client({
        credentials: {
          accessKeyId: env.ARTIFACTS_OBJECT_STORE_ACCESS_KEY_ID,
          secretAccessKey: env.ARTIFACTS_OBJECT_STORE_SECRET_ACCESS_KEY,
        },
        region: env.ARTIFACTS_OBJECT_STORE_REGION,
        endpoint: env.ARTIFACTS_OBJECT_STORE_BASE_URL,
        forcePathStyle: true,
      })
    : new S3Client();

const artifactKeyPrefixByType = {
  deployment_context: "deployments",
  // The key prefix is the one bundle signal that survives schema skew
  deployment_bundle: "bundles",
} as const;
const artifactBytesSizeLimitByType = {
  deployment_context: env.DEPLOYMENT_CONTEXT_ARTIFACT_SIZE_LIMIT_BYTES,
  deployment_bundle: env.DEPLOYMENT_BUNDLE_ARTIFACT_SIZE_LIMIT_BYTES,
} as const;

export type ArtifactOwner = Pick<AuthenticatedEnvironment, "id" | "slug" | "type"> & {
  project: { externalRef: string };
};

const ArtifactKeyMetadata = BuildServerMetadata.pick({ artifactKey: true });

export function isArtifactKeyOwnedBy(owner: ArtifactOwner, key: string): boolean {
  const [prefix, projectRef, envSlug, file, ...rest] = key.split("/");
  return (
    rest.length === 0 &&
    Object.values<string>(artifactKeyPrefixByType).includes(prefix) &&
    projectRef === owner.project.externalRef &&
    envSlug === owner.slug &&
    !!file
  );
}

export class ArtifactsService extends BaseService {
  private readonly client: S3Client;
  private readonly bucket: string | undefined;
  private readonly downloadUrlTtlSeconds: number;

  constructor(options?: {
    prisma?: PrismaClientOrTransaction;
    client?: S3Client;
    bucket?: string;
    downloadUrlTtlSeconds?: number;
  }) {
    super(options?.prisma);
    this.client = options?.client ?? objectStoreClient;
    this.bucket = options?.bucket ?? env.ARTIFACTS_OBJECT_STORE_BUCKET;
    this.downloadUrlTtlSeconds =
      options?.downloadUrlTtlSeconds ?? env.DEPLOYMENT_ARTIFACT_DOWNLOAD_URL_TTL_SECONDS;
  }

  public createArtifact(
    type: "deployment_context" | "deployment_bundle",
    authenticatedEnv: AuthenticatedEnvironment,
    contentLength?: number
  ) {
    const limit = artifactBytesSizeLimitByType[type];

    // this is just a validation using client-side data
    // the actual limit will be enforced by S3
    if (contentLength && contentLength > limit) {
      return errAsync({
        type: "artifact_size_exceeds_limit" as const,
        contentLength,
        sizeLimit: limit,
      });
    }

    const uniqueId = nanoid();
    const key = `${artifactKeyPrefixByType[type]}/${authenticatedEnv.project.externalRef}/${authenticatedEnv.slug}/${uniqueId}.tar.gz`;

    return this.createPresignedPost(key, limit, contentLength).map((result) => ({
      artifactKey: key,
      uploadUrl: result.url,
      uploadFields: result.fields,
      expiresAt: result.expiresAt,
    }));
  }

  public createDeploymentDownloadUrl(
    authenticatedEnv: ArtifactOwner,
    deploymentFriendlyId: string
  ) {
    if (authenticatedEnv.type === "DEVELOPMENT") {
      return errAsync({ type: "development_environment" as const });
    }

    return fromPromise(
      this._prisma.workerDeployment.findFirst({
        where: { friendlyId: deploymentFriendlyId, environmentId: authenticatedEnv.id },
        select: { buildServerMetadata: true },
      }),
      (error) => ({ type: "other" as const, cause: error })
    )
      .andThen((deployment) =>
        deployment ? okAsync(deployment) : errAsync({ type: "deployment_not_found" as const })
      )
      .andThen((deployment) => {
        const key = ArtifactKeyMetadata.safeParse(deployment.buildServerMetadata).data?.artifactKey;
        return key ? okAsync(key) : errAsync({ type: "artifact_not_found" as const });
      })
      .andThen((key) => this.createDownloadUrl(authenticatedEnv, key));
  }

  private createDownloadUrl(owner: ArtifactOwner, key: string) {
    if (!this.bucket) {
      return errAsync({
        type: "artifacts_bucket_not_configured" as const,
      });
    }

    if (!isArtifactKeyOwnedBy(owner, key)) {
      return errAsync({ type: "artifact_key_not_owned" as const, key: key.slice(0, 200) });
    }

    const bucket = this.bucket;
    const ttlSeconds = this.downloadUrlTtlSeconds;
    const signedAt = Date.now();

    return fromPromise(
      this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
      (error) => error
    )
      .mapErr((error) => {
        const status = httpStatusOf(error);
        // 403 is also what S3 answers for a missing key without s3:ListBucket
        if (status === 403) {
          logger.warn("Artifact HEAD returned 403; treating as missing", { key });
        }
        return status === 404 || status === 403
          ? { type: "artifact_not_found" as const }
          : { type: "failed_to_check_artifact" as const, cause: error };
      })
      .andThen(() =>
        fromPromise(
          getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
            expiresIn: ttlSeconds,
          }),
          (error) => ({
            type: "failed_to_create_download_url" as const,
            cause: error,
          })
        )
      )
      .map((url) => ({ url, expiresAt: new Date(signedAt + ttlSeconds * 1000) }));
  }

  private createPresignedPost(key: string, sizeLimit: number, contentLength?: number) {
    if (!this.bucket) {
      return errAsync({
        type: "artifacts_bucket_not_configured" as const,
      });
    }

    const ttlSeconds = 300; // 5 minutes
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    return fromPromise(
      createPresignedPost(this.client, {
        Bucket: this.bucket,
        Key: key,
        Conditions: [["content-length-range", 0, sizeLimit]],
        Fields: {
          "Content-Type": "application/gzip",
        },
        Expires: ttlSeconds,
      }),
      (error) => ({
        type: "failed_to_create_presigned_post" as const,
        cause: error,
      })
    ).map((result) => ({
      ...result,
      expiresAt,
    }));
  }
}

function httpStatusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}
