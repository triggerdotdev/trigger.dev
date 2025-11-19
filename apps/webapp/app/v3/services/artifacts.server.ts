import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService } from "./baseService.server";
import { env } from "~/env.server";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { S3Client } from "@aws-sdk/client-s3";
import { customAlphabet } from "nanoid";
import { errAsync, fromPromise } from "neverthrow";

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
} as const;
const artifactBytesSizeLimitByType = {
  deployment_context: 100 * 1024 * 1024, // 100MB
} as const;

export class ArtifactsService extends BaseService {
  private readonly bucket = env.ARTIFACTS_OBJECT_STORE_BUCKET;

  public createArtifact(
    type: "deployment_context",
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

  private createPresignedPost(key: string, sizeLimit: number, contentLength?: number) {
    const ttlSeconds = 300; // 5 minutes
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    return fromPromise(
      createPresignedPost(objectStoreClient, {
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
