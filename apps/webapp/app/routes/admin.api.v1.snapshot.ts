import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { type DataFunctionArgs } from "@remix-run/node";
import v8 from "v8";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { logger } from "~/services/logger.server";

// Use 100MB parts for faster parallel uploads of large snapshots
const PART_SIZE = 100 * 1024 * 1024;
// Use high parallelism to maximize upload speed
const QUEUE_SIZE = 8;

// Format date as yyyy-MM-dd HH_mm_ss_SSS
function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const milliseconds = date.getMilliseconds();

  return `${year}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")} ${hours
    .toString()
    .padStart(2, "0")}_${minutes.toString().padStart(2, "0")}_${seconds
    .toString()
    .padStart(2, "0")}_${milliseconds.toString().padStart(3, "0")}`;
}

function getS3Config() {
  const bucket = process.env.SNAPSHOT_S3_BUCKET;
  const region = process.env.SNAPSHOT_S3_REGION ?? "us-east-1";

  if (!bucket) {
    return undefined;
  }

  // Optional - only needed for non-AWS S3 (MinIO, R2, etc.) or local dev
  const endpoint = process.env.SNAPSHOT_S3_ENDPOINT;
  const accessKeyId = process.env.SNAPSHOT_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SNAPSHOT_S3_SECRET_ACCESS_KEY;

  // If explicit credentials provided, use them (local dev / non-AWS)
  // Otherwise, SDK uses default credential chain (IAM role, env vars, etc.)
  const credentials =
    accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;

  return {
    bucket,
    region,
    endpoint,
    credentials,
  };
}

export async function loader({ request }: DataFunctionArgs) {
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    throw new Response("You must be an admin to perform this action", { status: 403 });
  }

  const user = await prisma.user.findFirst({
    where: {
      id: authenticationResult.userId,
    },
  });

  if (!user?.admin) {
    throw new Response("You must be an admin to perform this action", { status: 403 });
  }

  const s3Config = getS3Config();

  if (!s3Config) {
    throw new Response(
      "S3 is not configured. Set SNAPSHOT_S3_ENDPOINT, SNAPSHOT_S3_BUCKET, SNAPSHOT_S3_ACCESS_KEY_ID, and SNAPSHOT_S3_SECRET_ACCESS_KEY.",
      { status: 500 }
    );
  }

  const s3Client = new S3Client({
    region: s3Config.region,
    ...(s3Config.credentials && { credentials: s3Config.credentials }),
    ...(s3Config.endpoint && { endpoint: s3Config.endpoint, forcePathStyle: true }),
  });

  const filename = `${getTaskIdentifier()}-${formatDate(new Date())}.heapsnapshot`;
  const s3Key = `snapshots/${filename}`;

  logger.info("Taking heap snapshot and streaming to S3", {
    bucket: s3Config.bucket,
    key: s3Key,
  });

  try {
    const startTime = Date.now();
    const snapshotStream = v8.getHeapSnapshot();

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: s3Config.bucket,
        Key: s3Key,
        Body: snapshotStream,
        ContentType: "application/octet-stream",
      },
      queueSize: QUEUE_SIZE,
      partSize: PART_SIZE,
      leavePartsOnError: false,
    });

    let totalBytes = 0;
    upload.on("httpUploadProgress", (progress) => {
      totalBytes = progress.loaded ?? totalBytes;
      logger.info("Upload progress", {
        loaded: progress.loaded,
        part: progress.part,
      });
    });

    await upload.done();
    const duration = Date.now() - startTime;

    logger.info("Heap snapshot uploaded to S3", {
      bucket: s3Config.bucket,
      key: s3Key,
      durationMs: duration,
      durationSec: Math.round(duration / 1000),
      totalBytes,
      uploadSpeedMBps: totalBytes > 0 ? Math.round((totalBytes / 1024 / 1024 / (duration / 1000)) * 10) / 10 : 0,
    });

    return new Response(
      JSON.stringify({
        success: true,
        bucket: s3Config.bucket,
        key: s3Key,
        sizeBytes: totalBytes,
        durationMs: duration,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    logger.error("Failed to upload heap snapshot to S3", {
      error: error instanceof Error ? error.message : String(error),
      bucket: s3Config.bucket,
      key: s3Key,
    });

    throw new Response(
      `Failed to upload snapshot to S3: ${error instanceof Error ? error.message : String(error)}`,
      { status: 500 }
    );
  }
}

function getTaskIdentifier() {
  if (!process.env.ECS_CONTAINER_METADATA_URI) {
    return "local";
  }

  const url = new URL(process.env.ECS_CONTAINER_METADATA_URI);

  return url.pathname.split("/")[2].split("-")[0];
}
