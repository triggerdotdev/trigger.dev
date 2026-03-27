import { AwsClient } from "aws4fetch";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

interface IObjectStoreClient {
  putObject(key: string, body: ReadableStream | string, contentType: string): Promise<void>;
  getObject(key: string): Promise<string>;
  presign(key: string, method: "PUT" | "GET", expiresIn: number): Promise<string>;
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
    url.pathname = `/${key}`;
    return url.toString();
  }

  async putObject(key: string, body: ReadableStream | string, contentType: string): Promise<void> {
    const response = await this.awsClient.fetch(this.buildUrl(key), {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    });
    if (!response.ok) {
      throw new Error(`Failed to upload to object store: ${response.statusText}`);
    }
  }

  async getObject(key: string): Promise<string> {
    const response = await this.awsClient.fetch(this.buildUrl(key));
    if (!response.ok) {
      throw new Error(`Failed to download from object store: ${response.statusText}`);
    }
    return response.text();
  }

  async presign(key: string, method: "PUT" | "GET", expiresIn: number): Promise<string> {
    const url = new URL(this.config.baseUrl);
    url.pathname = `/${key}`;
    url.searchParams.set("X-Amz-Expires", String(expiresIn));

    const signed = await this.awsClient.sign(new Request(url, { method }), {
      aws: { signQuery: true },
    });
    return signed.url;
  }
}

type AwsSdkConfig = {
  bucket: string;
  baseUrl?: string;
  region?: string;
};

class AwsSdkClient implements IObjectStoreClient {
  private readonly s3Client: S3Client;

  constructor(private readonly config: AwsSdkConfig) {
    this.s3Client = new S3Client({
      ...(config.baseUrl ? { endpoint: config.baseUrl, forcePathStyle: true } : {}),
      ...(config.region ? { region: config.region } : {}),
    });
  }

  async putObject(key: string, body: ReadableStream | string, contentType: string): Promise<void> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body as string,
        ContentType: contentType,
      })
    );
  }

  async getObject(key: string): Promise<string> {
    const response = await this.s3Client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key })
    );
    if (!response.Body) {
      throw new Error(`Empty response body from object store for key: ${key}`);
    }
    return response.Body.transformToString();
  }

  async presign(key: string, method: "PUT" | "GET", expiresIn: number): Promise<string> {
    const command =
      method === "PUT"
        ? new PutObjectCommand({ Bucket: this.config.bucket, Key: key })
        : new GetObjectCommand({ Bucket: this.config.bucket, Key: key });

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

export class ObjectStoreClient {
  private constructor(private readonly impl: IObjectStoreClient) {}

  static create(config: ObjectStoreClientConfig): ObjectStoreClient {
    if (config.accessKeyId && config.secretAccessKey) {
      return new ObjectStoreClient(
        new Aws4FetchClient({
          baseUrl: config.baseUrl,
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          region: config.region,
          service: config.service,
        })
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
      })
    );
  }

  putObject(key: string, body: ReadableStream | string, contentType: string): Promise<void> {
    return this.impl.putObject(key, body, contentType);
  }

  getObject(key: string): Promise<string> {
    return this.impl.getObject(key);
  }

  presign(key: string, method: "PUT" | "GET", expiresIn: number): Promise<string> {
    return this.impl.presign(key, method, expiresIn);
  }
}
