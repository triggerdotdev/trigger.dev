import { postgresAndMinioTest } from "@internal/testcontainers";
import { type IOPacket } from "@trigger.dev/core/v3";
import { PrismaClient } from "@trigger.dev/database";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  downloadPacketFromObjectStore,
  formatStorageUri,
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

// Mock env module for testing
const originalEnv = process.env;

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
      // Set up env for default provider
      process.env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      process.env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
      process.env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      process.env.OBJECT_STORE_REGION = minioConfig.region;
      process.env.OBJECT_STORE_SERVICE = "s3";
      delete process.env.OBJECT_STORE_DEFAULT_PROTOCOL;

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
      // Set up env for named provider
      process.env.OBJECT_STORE_S3_BASE_URL = minioConfig.baseUrl;
      process.env.OBJECT_STORE_S3_ACCESS_KEY_ID = minioConfig.accessKeyId;
      process.env.OBJECT_STORE_S3_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      process.env.OBJECT_STORE_S3_REGION = minioConfig.region;
      process.env.OBJECT_STORE_S3_SERVICE = "s3";
      process.env.OBJECT_STORE_DEFAULT_PROTOCOL = "s3";

      const environment = await createTestEnvironment(prisma);

      const testData = JSON.stringify({ test: "protocol-data", value: 456 });
      const filename = "test_run2/payload.json";

      // Upload with protocol
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
      process.env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      process.env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
      process.env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      process.env.OBJECT_STORE_REGION = minioConfig.region;
      process.env.OBJECT_STORE_SERVICE = "s3";
      delete process.env.OBJECT_STORE_DEFAULT_PROTOCOL;

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
      process.env.OBJECT_STORE_DEFAULT_PROTOCOL = "s3";

      // Step 3: Upload new data with protocol
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

  // Cleanup env after all tests
  afterAll(() => {
    process.env = originalEnv;
  });
});
