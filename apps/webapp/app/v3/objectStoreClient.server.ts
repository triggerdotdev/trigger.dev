import { AwsClient } from "aws4fetch";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Normalize a logical object-store key the same way Aws4FetchClient assigns URL pathnames.
 * Decodes percent-escapes and resolves `.` / `..` segments before the request is signed.
 */
export function normalizeObjectStoreLogicalKeyPathname(logicalKey: string): string {
  const url = new URL("https://trigger.invalid");
  url.pathname = `/${logicalKey.replace(/^\/+/, "")}`;
  return url.pathname;
}

/**
 * One ranged read: the requested bytes, plus the object's total size so a
 * caller that fetched a suffix knows where its window sits in the object.
 */
export type ObjectRange = {
  bytes: Uint8Array;
  totalSize: number;
  /** The object's stored media type, so a caller can branch on its format. */
  contentType: string | undefined;
  /**
   * The version this range came from. A caller stitching several ranges into
   * one answer passes it back as `ifMatch` so a rewrite between requests fails
   * the later read instead of mixing two versions of the object.
   */
  etag: string | undefined;
};

interface IObjectStoreClient {
  putObject(key: string, body: ReadableStream | string, contentType: string): Promise<string>;
  getObject(key: string): Promise<string>;
  getObjectRange(
    key: string,
    range: { suffixLength: number } | { start: number; end: number },
    opts?: { ifMatch?: string }
  ): Promise<ObjectRange>;
  presign(key: string, method: "PUT" | "GET", expiresIn: number): Promise<string>;
}

/**
 * The object was rewritten between two ranged reads of the same answer, so the
 * offsets a caller planned no longer describe the bytes it would get.
 */
export class ObjectVersionChangedError extends Error {
  constructor(key: string) {
    super(`Object changed while reading ranges: ${key}`);
    this.name = "ObjectVersionChangedError";
  }
}

/** `Range` header value for a byte range or a suffix. */
function rangeHeader(range: { suffixLength: number } | { start: number; end: number }): string {
  return "suffixLength" in range
    ? `bytes=-${range.suffixLength}`
    : `bytes=${range.start}-${range.end - 1}`;
}

/** Total object size from a `Content-Range: bytes X-Y/TOTAL` response header. */
function totalSizeFromContentRange(header: string | null, fallback: number): number {
  const total = header?.split("/")[1];
  const parsed = total ? Number(total) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

type Aws4FetchConfig = {
  baseUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  service?: string;
};

class Aws4FetchClient implements IObjectStoreClient {
  private readonly awsClient: AwsClient;

  constructor(private readonly config: Aws4FetchConfig) {
    this.awsClient = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      // We set the default value to "s3" in the schema to enhance interoperability with various
      // S3-compatible services. Setting this env var to an empty string restores the old behaviour.
      service: config.service || undefined,
    });
  }

  private buildUrl(key: string): string {
    const url = new URL(this.config.baseUrl);
    url.pathname = normalizeObjectStoreLogicalKeyPathname(key);
    return url.toString();
  }

  async putObject(
    key: string,
    body: ReadableStream | string,
    contentType: string
  ): Promise<string> {
    const objectUrl = this.buildUrl(key);
    const response = await this.awsClient.fetch(objectUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    });
    if (!response.ok) {
      throw new Error(`Failed to upload to object store: ${response.statusText}`);
    }
    return objectUrl;
  }

  async getObject(key: string): Promise<string> {
    const response = await this.awsClient.fetch(this.buildUrl(key));
    if (!response.ok) {
      throw new Error(`Failed to download from object store: ${response.statusText}`);
    }
    return response.text();
  }

  async getObjectRange(
    key: string,
    range: { suffixLength: number } | { start: number; end: number },
    opts?: { ifMatch?: string }
  ): Promise<ObjectRange> {
    const response = await this.awsClient.fetch(this.buildUrl(key), {
      headers: {
        range: rangeHeader(range),
        ...(opts?.ifMatch ? { "if-match": opts.ifMatch } : {}),
      },
    });
    if (response.status === 412) {
      throw new ObjectVersionChangedError(key);
    }
    if (!response.ok) {
      throw new Error(`Failed to download range from object store: ${response.statusText}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      totalSize: totalSizeFromContentRange(response.headers.get("content-range"), bytes.byteLength),
      contentType: response.headers.get("content-type") ?? undefined,
      etag: response.headers.get("etag") ?? undefined,
    };
  }

  async presign(key: string, method: "PUT" | "GET", expiresIn: number): Promise<string> {
    const url = new URL(this.config.baseUrl);
    url.pathname = normalizeObjectStoreLogicalKeyPathname(key);
    url.searchParams.set("X-Amz-Expires", String(expiresIn));

    const signed = await this.awsClient.sign(new Request(url, { method }), {
      aws: { signQuery: true },
    });
    return signed.url;
  }
}

type AwsSdkConfig = {
  bucket: string;
  baseUrl: string;
  region?: string;
};

class AwsSdkClient implements IObjectStoreClient {
  private readonly s3Client: S3Client;

  constructor(private readonly config: AwsSdkConfig) {
    this.s3Client = new S3Client({
      endpoint: config.baseUrl,
      forcePathStyle: true,
      ...(config.region ? { region: config.region } : {}),
    });
  }

  /**
   * Callers use a single logical key (same as aws4fetch path: `bucket/object/...`).
   * S3 APIs take Bucket + Key where Key must not repeat the bucket name.
   */
  private toS3ObjectKey(logicalKey: string): string {
    const prefix = `${this.config.bucket}/`;
    if (logicalKey.startsWith(prefix)) {
      return logicalKey.slice(prefix.length);
    }
    return logicalKey;
  }

  private logicalObjectUrl(logicalKey: string): string {
    const url = new URL(this.config.baseUrl);
    url.pathname = normalizeObjectStoreLogicalKeyPathname(logicalKey);
    return url.href;
  }

  async putObject(
    key: string,
    body: ReadableStream | string,
    contentType: string
  ): Promise<string> {
    const s3Key = this.toS3ObjectKey(key);
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: s3Key,
        Body: body,
        ContentType: contentType,
      })
    );
    return this.logicalObjectUrl(key);
  }

  async getObject(key: string): Promise<string> {
    const s3Key = this.toS3ObjectKey(key);
    const response = await this.s3Client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: s3Key })
    );
    if (!response.Body) {
      throw new Error(`Empty response body from object store for key: ${key}`);
    }
    return response.Body.transformToString();
  }

  async getObjectRange(
    key: string,
    range: { suffixLength: number } | { start: number; end: number },
    opts?: { ifMatch?: string }
  ): Promise<ObjectRange> {
    const s3Key = this.toS3ObjectKey(key);
    let response;
    try {
      response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: s3Key,
          Range: rangeHeader(range),
          ...(opts?.ifMatch ? { IfMatch: opts.ifMatch } : {}),
        })
      );
    } catch (error) {
      if ((error as { name?: string }).name === "PreconditionFailed") {
        throw new ObjectVersionChangedError(key);
      }
      throw error;
    }
    if (!response.Body) {
      throw new Error(`Empty response body from object store for key: ${key}`);
    }
    const bytes = await response.Body.transformToByteArray();
    return {
      bytes,
      totalSize: totalSizeFromContentRange(response.ContentRange ?? null, bytes.byteLength),
      contentType: response.ContentType ?? undefined,
      etag: response.ETag ?? undefined,
    };
  }

  async presign(key: string, method: "PUT" | "GET", expiresIn: number): Promise<string> {
    const s3Key = this.toS3ObjectKey(key);
    const command =
      method === "PUT"
        ? new PutObjectCommand({ Bucket: this.config.bucket, Key: s3Key })
        : new GetObjectCommand({ Bucket: this.config.bucket, Key: s3Key });

    return getSignedUrl(this.s3Client, command, { expiresIn });
  }
}

export type ObjectStoreClientConfig = {
  baseUrl: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  service?: string;
};

export class ObjectStoreClient implements IObjectStoreClient {
  private constructor(
    private readonly impl: IObjectStoreClient,
    /** When set, logical keys may start with `${bucket}/…`; AwsSdkClient strips that prefix for S3 APIs. */
    readonly bucket: string | undefined
  ) {}

  static create(config: ObjectStoreClientConfig): ObjectStoreClient {
    if (config.accessKeyId && config.secretAccessKey) {
      return new ObjectStoreClient(
        new Aws4FetchClient({
          baseUrl: config.baseUrl,
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          region: config.region,
          service: config.service,
        }),
        config.bucket
      );
    }

    // IAM credential chain — AWS SDK S3Client handles credential refresh automatically
    if (!config.bucket) {
      throw new Error(
        "OBJECT_STORE_BUCKET is required when not using access key credentials (IAM mode)"
      );
    }

    return new ObjectStoreClient(
      new AwsSdkClient({
        bucket: config.bucket,
        baseUrl: config.baseUrl,
        region: config.region,
      }),
      config.bucket
    );
  }

  putObject(key: string, body: ReadableStream | string, contentType: string): Promise<string> {
    return this.impl.putObject(key, body, contentType);
  }

  getObject(key: string): Promise<string> {
    return this.impl.getObject(key);
  }

  getObjectRange(
    key: string,
    range: { suffixLength: number } | { start: number; end: number },
    opts?: { ifMatch?: string }
  ): Promise<ObjectRange> {
    return this.impl.getObjectRange(key, range, opts);
  }

  presign(key: string, method: "PUT" | "GET", expiresIn: number): Promise<string> {
    return this.impl.presign(key, method, expiresIn);
  }
}
