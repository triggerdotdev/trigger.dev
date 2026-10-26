import {
  minioTest,
  postgresAndMinioTest,
  type MinIOConnectionConfig,
} from "@internal/testcontainers";
import type { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  captureDeploymentIndex,
  createDeploymentIndexStore,
  DEPLOYMENT_INDEX_FORMAT_VERSION,
  DeploymentIndexError,
  DeploymentIndexStore,
  type DeploymentIndexEnvelope,
} from "~/v3/deploymentIndex.server";
import { ObjectStoreClient } from "~/v3/objectStoreClient.server";

vi.setConfig({ testTimeout: 60_000 });

const BUCKET = "packets";

function clientFor(minioConfig: MinIOConnectionConfig) {
  return ObjectStoreClient.create({ ...minioConfig, bucket: BUCKET, service: "s3" });
}

function storeFor(minioConfig: MinIOConnectionConfig, bucket = BUCKET, maxAttempts = 3) {
  const client = ObjectStoreClient.create({ ...minioConfig, bucket, service: "s3" });
  return new DeploymentIndexStore({
    root: bucket,
    clientFor: () => client,
    maxAttempts,
    minRetryTimeoutMs: 1,
  });
}

function requestBody(): CreateBackgroundWorkerRequestBody {
  return {
    localOnly: false,
    engine: "V2",
    supportsLazyAttempts: true,
    metadata: {
      packageVersion: "4.8.1",
      cliPackageVersion: "4.8.1",
      contentHash: "hash_1",
      runtime: "node",
      runtimeVersion: "24.18.0",
      tasks: [
        {
          id: "nightly",
          filePath: "src/trigger/nightly.ts",
          exportName: "nightly",
          schedule: { cron: "0 3 * * *", timezone: "UTC" },
        },
      ],
      queues: [{ name: "imports", concurrencyLimit: 5 }],
      prompts: [{ id: "summarize", filePath: "src/trigger/prompts.ts", content: "Summarize" }],
      sourceFiles: [
        {
          filePath: "src/trigger/nightly.ts",
          contents: "export const nightly = schedules.task({})",
          contentHash: "file_1",
          taskIds: ["nightly"],
        },
      ],
    },
  };
}

function envelope(overrides: Partial<DeploymentIndexEnvelope> = {}): DeploymentIndexEnvelope {
  return {
    formatVersion: DEPLOYMENT_INDEX_FORMAT_VERSION,
    projectId: "project_1",
    projectRef: "proj_abc",
    environmentId: "env_1",
    environmentSlug: "prod",
    environmentType: "PRODUCTION",
    deploymentId: "deployment_1",
    deploymentVersion: "20261023.1",
    request: requestBody(),
    ...overrides,
  };
}

describe("DeploymentIndexStore", () => {
  minioTest("round-trips the full index through the store", async ({ minioConfig }) => {
    const store = storeFor(minioConfig);
    const original = envelope();

    const reference = await store.put(original);

    expect(reference.indexObjectKey).toMatch(
      /^packets\/deployment-indexes\/proj_abc\/prod\/deployment_1\/[0-9a-f]{64}\.json\.gz$/
    );
    expect(reference.indexFormatVersion).toBe(1);
    expect(await store.get(reference, { projectId: "project_1" })).toEqual(original);
  });

  minioTest("a retried upload of the same index keeps one object", async ({ minioConfig }) => {
    const store = storeFor(minioConfig);

    const first = await store.put(envelope());
    const second = await store.put(envelope());

    expect(second).toEqual(first);
    expect(await store.get(second, { projectId: "project_1" })).toEqual(envelope());
  });

  minioTest("never replaces an object that already exists", async ({ minioConfig }) => {
    const client = clientFor(minioConfig);
    const key = `${BUCKET}/proj_abc/prod/deployment_1/existing.json.gz`;

    expect(await client.putObjectIfAbsent(key, gzipSync("first"), "application/gzip")).toBe(
      "created"
    );
    expect(await client.putObjectIfAbsent(key, gzipSync("second"), "application/gzip")).toBe(
      "exists"
    );
    const stored = Buffer.from(await (await client.getObjectResponse(key)).arrayBuffer());
    expect(stored.equals(gzipSync("first"))).toBe(true);
  });

  minioTest("rejects an object whose checksum does not match", async ({ minioConfig }) => {
    const store = storeFor(minioConfig);
    const reference = await store.put(envelope());

    await expect(
      store.get({ ...reference, indexSha256: "0".repeat(64) }, { projectId: "project_1" })
    ).rejects.toThrow("Deployment index checksum mismatch");
  });

  minioTest("refuses to read another project's index", async ({ minioConfig }) => {
    const store = storeFor(minioConfig);
    const reference = await store.put(envelope());

    await expect(store.get(reference, { projectId: "project_2" })).rejects.toThrow(
      "Deployment index belongs to a different project"
    );
  });

  minioTest("rejects unsupported format versions and foreign keys", async ({ minioConfig }) => {
    const store = storeFor(minioConfig);
    const reference = await store.put(envelope());

    await expect(
      store.get({ ...reference, indexFormatVersion: 2 }, { projectId: "project_1" })
    ).rejects.toBeInstanceOf(DeploymentIndexError);
    await expect(
      store.get(
        { ...reference, indexObjectKey: reference.indexObjectKey.replace(BUCKET, "other") },
        { projectId: "project_1" }
      )
    ).rejects.toThrow("Deployment index is not in this store");
  });

  minioTest("throws once the bounded retries are spent", async ({ minioConfig }) => {
    const store = storeFor(minioConfig, "missing-bucket", 2);

    await expect(store.put(envelope())).rejects.toThrow("Failed to upload to object store");
  });
});

describe("captureDeploymentIndex", () => {
  function authenticatedEnvironment(projectId: string) {
    return {
      id: "env_1",
      slug: "prod",
      type: "PRODUCTION",
      projectId,
      project: { externalRef: "proj_abc" },
    } as unknown as AuthenticatedEnvironment;
  }

  const deployment = { friendlyId: "deployment_1", version: "20261023.1" };

  postgresAndMinioTest("stores the parsed request body", async ({ prisma, minioConfig }) => {
    await prisma.featureFlag.create({
      data: { key: "deploymentIndexCaptureEnabled", value: true },
    });
    const store = storeFor(minioConfig);

    const reference = await captureDeploymentIndex(
      authenticatedEnvironment("project_1"),
      deployment,
      requestBody(),
      store,
      prisma
    );

    expect(reference).toBeDefined();
    const stored = await store.get(reference!, { projectId: "project_1" });
    expect(stored.request).toEqual(requestBody());
    expect(stored.deploymentId).toBe("deployment_1");
  });

  postgresAndMinioTest("skips capture without a store", async ({ prisma }) => {
    expect(
      await captureDeploymentIndex(
        authenticatedEnvironment("project_1"),
        deployment,
        requestBody(),
        undefined,
        prisma
      )
    ).toBeUndefined();
  });

  postgresAndMinioTest("skips capture unless it is turned on", async ({ prisma, minioConfig }) => {
    const reference = await captureDeploymentIndex(
      authenticatedEnvironment("project_1"),
      deployment,
      requestBody(),
      storeFor(minioConfig),
      prisma
    );

    expect(reference).toBeUndefined();
  });
});

describe("createDeploymentIndexStore", () => {
  minioTest("uses the dedicated store when one is configured", async ({ minioConfig }) => {
    const store = createDeploymentIndexStore({
      dedicated: { ...minioConfig, bucket: BUCKET, service: "s3" },
      sharedClientFor: () => undefined,
      maxAttempts: 1,
    });

    const reference = await store!.put(envelope());
    expect(reference.indexObjectKey.startsWith("packets/deployment-indexes/proj_abc/")).toBe(true);
    expect(await store!.get(reference, { projectId: "project_1" })).toEqual(envelope());
  });

  minioTest(
    "shares the packet store's provider for new uploads and records it on the reference",
    async ({ minioConfig }) => {
      const s3 = clientFor(minioConfig);
      const store = createDeploymentIndexStore({
        sharedProtocol: "s3",
        sharedClientFor: (protocol) => (protocol === "s3" ? s3 : undefined),
        maxAttempts: 1,
      });

      const reference = await store!.put(envelope());
      expect(reference.indexObjectKey.startsWith("s3://packets/deployment-indexes/proj_abc/")).toBe(
        true
      );
      expect(await store!.get(reference, { projectId: "project_1" })).toEqual(envelope());
    }
  );

  it("keeps no snapshots when no object store is configured", () => {
    expect(
      createDeploymentIndexStore({ sharedClientFor: () => undefined, maxAttempts: 1 })
    ).toBeUndefined();
  });
});
