import { postgresAndMinioTest } from "@internal/testcontainers";
import { type IOPacket } from "@trigger.dev/core/v3";
import { type PrismaClient } from "@trigger.dev/database";
import { afterAll, describe, expect, it, vi } from "vitest";
import { env } from "~/env.server";
import {
  downloadPacketFromObjectStore,
  formatStorageUri,
  generatePresignedRequest,
  generatePresignedUrl,
  hasObjectStoreClient,
  parseStorageUri,
  uploadPacketToObjectStore,
} from "~/v3/objectStore.server";

// Extend the timeout for container tests
vi.setConfig({ testTimeout: 60_000 });

// Helper to create a test environment
async function createTestEnvironment(prisma: PrismaClient) {
  const suffix = Date.now().toString(36);

  const org = await prisma.organization.create({
    data: {
      title: `Test Org ${suffix}`,
      slug: `test-org-${suffix}`,
    },
  });

  const project = await prisma.project.create({
    data: {
      name: `Test Project ${suffix}`,
      slug: `test-project-${suffix}`,
      externalRef: `proj_test${suffix}`,
      organizationId: org.id,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "dev",
      type: "DEVELOPMENT",
      organizationId: org.id,
      projectId: project.id,
      apiKey: `test_key_${suffix}`,
      pkApiKey: `test_pk_key_${suffix}`,
      shortcode: suffix.slice(0, 4),
    },
    include: {
      project: true,
      organization: true,
    },
  });

  return environment;
}

// Save original env values for restoration in afterAll
const originalEnv = process.env;
const originalEnvObj = {
  OBJECT_STORE_BASE_URL: env.OBJECT_STORE_BASE_URL,
  OBJECT_STORE_BUCKET: env.OBJECT_STORE_BUCKET,
  OBJECT_STORE_ACCESS_KEY_ID: env.OBJECT_STORE_ACCESS_KEY_ID,
  OBJECT_STORE_SECRET_ACCESS_KEY: env.OBJECT_STORE_SECRET_ACCESS_KEY,
  OBJECT_STORE_REGION: env.OBJECT_STORE_REGION,
  OBJECT_STORE_DEFAULT_PROTOCOL: env.OBJECT_STORE_DEFAULT_PROTOCOL,
};

describe("Object Storage", () => {
  describe("URI parsing functions", () => {
    it("should parse URI with protocol", () => {
      const result = parseStorageUri("s3://run_abc123/payload.json");
      expect(result).toEqual({
        protocol: "s3",
        path: "run_abc123/payload.json",
      });
    });

    it("should parse URI with R2 protocol", () => {
      const result = parseStorageUri("r2://batch_xyz/item_0/payload.json");
      expect(result).toEqual({
        protocol: "r2",
        path: "batch_xyz/item_0/payload.json",
      });
    });

    it("should parse legacy URI without protocol", () => {
      const result = parseStorageUri("run_abc123/payload.json");
      expect(result).toEqual({
        protocol: undefined,
        path: "run_abc123/payload.json",
      });
    });

    it("should format URI with protocol", () => {
      const result = formatStorageUri("run_abc123/payload.json", "s3");
      expect(result).toBe("s3://run_abc123/payload.json");
    });

    it("should format URI without protocol", () => {
      const result = formatStorageUri("run_abc123/payload.json");
      expect(result).toBe("run_abc123/payload.json");
    });
  });

  postgresAndMinioTest(
    "should upload and download data without protocol (legacy)",
    async ({ minioConfig, prisma }) => {
      // Override env directly for the default provider
      env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
      env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      env.OBJECT_STORE_REGION = minioConfig.region;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

      const environment = await createTestEnvironment(prisma);

      const testData = JSON.stringify({ test: "data", value: 123 });
      const filename = "test_run/payload.json";

      // Upload
      const uploadedFilename = await uploadPacketToObjectStore(
        filename,
        testData,
        "application/json",
        environment as any
      );

      // Should return filename without protocol (legacy)
      expect(uploadedFilename).toBe(filename);

      // Download
      const packet: IOPacket = {
        data: uploadedFilename,
        dataType: "application/store",
      };

      const downloadedPacket = await downloadPacketFromObjectStore(packet, environment as any);

      expect(downloadedPacket.dataType).toBe("application/json");
      expect(downloadedPacket.data).toBe(testData);

      // Cleanup
      await prisma.runtimeEnvironment.delete({ where: { id: environment.id } });
      await prisma.project.delete({ where: { id: environment.projectId } });
      await prisma.organization.delete({ where: { id: environment.organizationId } });
    }
  );

  postgresAndMinioTest(
    "should upload and download data with protocol prefix",
    async ({ minioConfig, prisma }) => {
      // Named provider — controlled via process.env (read dynamically)
      process.env.OBJECT_STORE_S3_BASE_URL = minioConfig.baseUrl;
      process.env.OBJECT_STORE_S3_ACCESS_KEY_ID = minioConfig.accessKeyId;
      process.env.OBJECT_STORE_S3_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      process.env.OBJECT_STORE_S3_REGION = minioConfig.region;
      process.env.OBJECT_STORE_S3_SERVICE = "s3";

      const environment = await createTestEnvironment(prisma);

      const testData = JSON.stringify({ test: "protocol-data", value: 456 });
      const filename = "test_run2/payload.json";

      // Upload with explicit protocol — bypasses env.OBJECT_STORE_DEFAULT_PROTOCOL
      const uploadedFilename = await uploadPacketToObjectStore(
        filename,
        testData,
        "application/json",
        environment as any,
        "s3"
      );

      // Should return filename with s3:// protocol
      expect(uploadedFilename).toBe("s3://test_run2/payload.json");

      // Download
      const packet: IOPacket = {
        data: uploadedFilename,
        dataType: "application/store",
      };

      const downloadedPacket = await downloadPacketFromObjectStore(packet, environment as any);

      expect(downloadedPacket.dataType).toBe("application/json");
      expect(downloadedPacket.data).toBe(testData);

      // Cleanup
      await prisma.runtimeEnvironment.delete({ where: { id: environment.id } });
      await prisma.project.delete({ where: { id: environment.projectId } });
      await prisma.organization.delete({ where: { id: environment.organizationId } });
    }
  );

  postgresAndMinioTest(
    "should support migration from default provider to named provider",
    async ({ minioConfig, prisma }) => {
      const environment = await createTestEnvironment(prisma);

      // Step 1: Upload old data without protocol (using default provider)
      env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
      env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      env.OBJECT_STORE_REGION = minioConfig.region;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

      const oldData = JSON.stringify({ legacy: true });
      const oldFilename = "old_run/payload.json";

      const uploadedOldFilename = await uploadPacketToObjectStore(
        oldFilename,
        oldData,
        "application/json",
        environment as any
      );

      expect(uploadedOldFilename).toBe(oldFilename); // No protocol

      // Step 2: Configure new provider (S3) and set default protocol
      process.env.OBJECT_STORE_S3_BASE_URL = minioConfig.baseUrl; // Same MinIO for testing
      process.env.OBJECT_STORE_S3_ACCESS_KEY_ID = minioConfig.accessKeyId;
      process.env.OBJECT_STORE_S3_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      process.env.OBJECT_STORE_S3_REGION = minioConfig.region;
      process.env.OBJECT_STORE_S3_SERVICE = "s3";

      // Step 3: Upload new data with explicit protocol
      const newData = JSON.stringify({ new: true });
      const newFilename = "new_run/payload.json";

      const uploadedNewFilename = await uploadPacketToObjectStore(
        newFilename,
        newData,
        "application/json",
        environment as any,
        "s3"
      );

      expect(uploadedNewFilename).toBe("s3://new_run/payload.json"); // Has protocol

      // Step 4: Verify both can be downloaded
      // Old data (no protocol, uses default provider)
      const oldPacket: IOPacket = {
        data: uploadedOldFilename,
        dataType: "application/store",
      };
      const downloadedOld = await downloadPacketFromObjectStore(oldPacket, environment as any);
      expect(downloadedOld.data).toBe(oldData);

      // New data (with protocol, uses named provider)
      const newPacket: IOPacket = {
        data: uploadedNewFilename,
        dataType: "application/store",
      };
      const downloadedNew = await downloadPacketFromObjectStore(newPacket, environment as any);
      expect(downloadedNew.data).toBe(newData);

      // Cleanup
      await prisma.runtimeEnvironment.delete({ where: { id: environment.id } });
      await prisma.project.delete({ where: { id: environment.projectId } });
      await prisma.organization.delete({ where: { id: environment.organizationId } });
    }
  );

  postgresAndMinioTest(
    "should upload and download using IAM credential chain (AWS SDK path)",
    async ({ minioConfig, prisma }) => {
      // IAM mode: override env with bucket but no access keys.
      // We put the credentials in AWS_* env vars so the S3Client credential
      // chain picks them up (same as it would from an ECS task role in production).
      env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      env.OBJECT_STORE_BUCKET = "packets";
      env.OBJECT_STORE_REGION = minioConfig.region;
      env.OBJECT_STORE_ACCESS_KEY_ID = undefined;
      env.OBJECT_STORE_SECRET_ACCESS_KEY = undefined;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

      process.env.AWS_ACCESS_KEY_ID = minioConfig.accessKeyId;
      process.env.AWS_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      process.env.AWS_REGION = minioConfig.region;

      const environment = await createTestEnvironment(prisma);

      const testData = JSON.stringify({ iam: true, value: 789 });
      const filename = "iam_test_run/payload.json";

      const uploadedFilename = await uploadPacketToObjectStore(
        filename,
        testData,
        "application/json",
        environment as any
      );

      expect(uploadedFilename).toBe(filename);

      const packet: IOPacket = {
        data: uploadedFilename,
        dataType: "application/store",
      };

      const downloadedPacket = await downloadPacketFromObjectStore(packet, environment as any);

      expect(downloadedPacket.dataType).toBe("application/json");
      expect(downloadedPacket.data).toBe(testData);

      // Cleanup
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AWS_REGION;

      await prisma.runtimeEnvironment.delete({ where: { id: environment.id } });
      await prisma.project.delete({ where: { id: environment.projectId } });
      await prisma.organization.delete({ where: { id: environment.organizationId } });
    }
  );

  describe("hasObjectStoreClient", () => {
    it("returns false when no store is configured", () => {
      env.OBJECT_STORE_BASE_URL = undefined;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;
      delete process.env.OBJECT_STORE_NOTCONFIGURED_BASE_URL;
      expect(hasObjectStoreClient()).toBe(false);
    });

    it("returns true when default provider base URL is set", () => {
      env.OBJECT_STORE_BASE_URL = "http://localhost:9000";
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;
      expect(hasObjectStoreClient()).toBe(true);
      env.OBJECT_STORE_BASE_URL = undefined;
    });

    it("returns true when named protocol base URL is set", () => {
      env.OBJECT_STORE_BASE_URL = undefined;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = "s3";
      process.env.OBJECT_STORE_S3_BASE_URL = "http://localhost:9000";
      expect(hasObjectStoreClient()).toBe(true);
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;
      delete process.env.OBJECT_STORE_S3_BASE_URL;
    });
  });

  postgresAndMinioTest(
    "generatePresignedUrl - PUT then GET round-trip (static credentials / aws4fetch path)",
    async ({ minioConfig }) => {
      env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
      env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      env.OBJECT_STORE_REGION = minioConfig.region;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

      const projectRef = "proj_presign_test";
      const envSlug = "dev";
      const filename = "presigned-static/payload.json";
      const data = JSON.stringify({ presigned: "static" });

      // Upload via presigned PUT
      const putResult = await generatePresignedUrl(projectRef, envSlug, filename, "PUT");
      expect(putResult.success).toBe(true);
      if (!putResult.success) throw new Error(putResult.error);

      const putResponse = await fetch(putResult.url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: data,
      });
      expect(putResponse.ok).toBe(true);

      // Download via presigned GET
      const getResult = await generatePresignedUrl(projectRef, envSlug, filename, "GET");
      expect(getResult.success).toBe(true);
      if (!getResult.success) throw new Error(getResult.error);

      const getResponse = await fetch(getResult.url);
      expect(getResponse.ok).toBe(true);
      expect(await getResponse.text()).toBe(data);
    }
  );

  postgresAndMinioTest(
    "generatePresignedUrl - PUT then GET round-trip (IAM credential chain / AWS SDK path)",
    async ({ minioConfig }) => {
      env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      env.OBJECT_STORE_BUCKET = "packets";
      env.OBJECT_STORE_REGION = minioConfig.region;
      env.OBJECT_STORE_ACCESS_KEY_ID = undefined;
      env.OBJECT_STORE_SECRET_ACCESS_KEY = undefined;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

      process.env.AWS_ACCESS_KEY_ID = minioConfig.accessKeyId;
      process.env.AWS_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      process.env.AWS_REGION = minioConfig.region;

      const projectRef = "proj_presign_iam";
      const envSlug = "dev";
      const filename = "presigned-iam/payload.json";
      const data = JSON.stringify({ presigned: "iam" });

      // Upload via presigned PUT
      const putResult = await generatePresignedUrl(projectRef, envSlug, filename, "PUT");
      expect(putResult.success).toBe(true);
      if (!putResult.success) throw new Error(putResult.error);

      const putResponse = await fetch(putResult.url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: data,
      });
      expect(putResponse.ok).toBe(true);

      // Download via presigned GET
      const getResult = await generatePresignedUrl(projectRef, envSlug, filename, "GET");
      expect(getResult.success).toBe(true);
      if (!getResult.success) throw new Error(getResult.error);

      const getResponse = await fetch(getResult.url);
      expect(getResponse.ok).toBe(true);
      expect(await getResponse.text()).toBe(data);

      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AWS_REGION;
    }
  );

  postgresAndMinioTest(
    "generatePresignedRequest - returns a signed Request object",
    async ({ minioConfig }) => {
      env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
      env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      env.OBJECT_STORE_REGION = minioConfig.region;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

      const result = await generatePresignedRequest(
        "proj_req_test",
        "dev",
        "req-test/file.json",
        "GET"
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);

      // URL should point at the right key and contain SigV4 query params
      expect(result.request.url).toContain("packets/proj_req_test/dev/req-test/file.json");
      expect(result.request.url).toContain("X-Amz-");
      expect(result.request.method).toBe("GET");
    }
  );

  // Restore env after all tests
  afterAll(() => {
    process.env = originalEnv;
    env.OBJECT_STORE_BASE_URL = originalEnvObj.OBJECT_STORE_BASE_URL;
    env.OBJECT_STORE_BUCKET = originalEnvObj.OBJECT_STORE_BUCKET;
    env.OBJECT_STORE_ACCESS_KEY_ID = originalEnvObj.OBJECT_STORE_ACCESS_KEY_ID;
    env.OBJECT_STORE_SECRET_ACCESS_KEY = originalEnvObj.OBJECT_STORE_SECRET_ACCESS_KEY;
    env.OBJECT_STORE_REGION = originalEnvObj.OBJECT_STORE_REGION;
    env.OBJECT_STORE_DEFAULT_PROTOCOL = originalEnvObj.OBJECT_STORE_DEFAULT_PROTOCOL;
  });
});
